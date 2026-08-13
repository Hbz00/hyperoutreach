import { spawn } from "node:child_process";

export type ProcessRequest = {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
  environment: Record<string, string>;
};

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export type ProcessExecutionErrorCode = "spawn" | "timeout" | "output_limit";

const TERMINATION_GRACE_MS = 250;

export class ProcessExecutionError extends Error {
  override readonly name = "ProcessExecutionError";

  constructor(
    message: string,
    readonly code: ProcessExecutionErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const CHILD_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export function codexChildEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export class NodeProcessRunner implements ProcessRunner {
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  run(request: ProcessRequest): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(request.executable, request.args, {
          cwd: request.cwd,
          env: request.environment as NodeJS.ProcessEnv,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(
          new ProcessExecutionError(
            "Child process could not be started",
            "spawn",
          ),
        );
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let terminalError: ProcessExecutionError | null = null;
      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | null = null;

      const onStdout = (chunk: Buffer) => capture(stdout, chunk);
      const onStderr = (chunk: Buffer) => capture(stderr, chunk);
      const onStdinError = () => {
        // A fast-exiting child can close stdin before the write completes. The
        // exit code remains the authoritative process result.
      };

      const cleanup = () => {
        clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        child.stdin.removeListener("error", onStdinError);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
      };

      const settleError = (
        error: ProcessExecutionError,
        abandonChild = false,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (abandonChild) {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
        reject(error);
      };

      const terminate = (error: ProcessExecutionError) => {
        if (terminalError || settled) return;
        terminalError = error;
        try {
          child.kill("SIGTERM");
        } catch {
          // Escalation below still enforces a hard settlement bound.
        }
        if (settled) return;
        escalation = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // The caller must still receive the sanitized primary failure.
          }
          settleError(error, true);
        }, TERMINATION_GRACE_MS);
      };

      const timeout = setTimeout(() => {
        terminate(
          new ProcessExecutionError("Child process timed out", "timeout"),
        );
      }, request.timeoutMs);

      const capture = (target: Buffer[], chunk: Buffer | string) => {
        if (terminalError) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > request.maxOutputBytes) {
          terminate(
            new ProcessExecutionError(
              "Child process output limit exceeded",
              "output_limit",
            ),
          );
          return;
        }
        target.push(buffer);
      };

      const onError = () => {
        if (terminalError) {
          settleError(terminalError, true);
          return;
        }
        settleError(
          new ProcessExecutionError(
            "Child process could not be started",
            "spawn",
          ),
        );
      };
      const onClose = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminalError) {
          reject(terminalError);
          return;
        }
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
      child.stdin.once("error", onStdinError);
      child.stdin.end(request.stdin);
    });
  }
}
