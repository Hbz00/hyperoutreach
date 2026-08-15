import { ChatGptDesktopError } from "@/lib/chatgpt-desktop/errors";

export type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export type CdpResponse = {
  id?: number;
  error?: { message?: string };
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string } };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTargets(payload: unknown): CdpTarget[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { id, type, title, url, webSocketDebuggerUrl } = entry;
    if (typeof id !== "string" || typeof type !== "string") return [];
    if (typeof url !== "string") return [];
    return [
      {
        id,
        type,
        title: typeof title === "string" ? title : "",
        url,
        ...(typeof webSocketDebuggerUrl === "string"
          ? { webSocketDebuggerUrl }
          : {}),
      },
    ];
  });
}

export async function listCdpTargets(
  port: number,
  timeoutMs = 5_000,
): Promise<CdpTarget[]> {
  let payload: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    payload = await response.json();
  } catch (error) {
    throw new ChatGptDesktopError(
      "ChatGPT desktop debug endpoint is unreachable",
      "app_unreachable",
      error instanceof Error ? error.message : undefined,
    );
  }
  return parseTargets(payload);
}

export async function isCdpPortOpen(
  port: number,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * One websocket per call. The desktop app keeps its renderer alive across
 * requests, so a session is cheap to open and closing it leaves no trace in
 * the app's own devtools state.
 */
export class CdpSession {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly socket: WebSocket) {}

  static async attach(
    webSocketDebuggerUrl: string,
    timeoutMs = 10_000,
  ): Promise<CdpSession> {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const session = new CdpSession(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(
          new ChatGptDesktopError(
            "ChatGPT desktop devtools socket did not open",
            "timeout",
          ),
        );
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          // Without this the half-open socket keeps the event loop alive and a
          // CLI run that failed to attach never exits.
          try {
            socket.close();
          } catch {
            // Already closing.
          }
          reject(
            new ChatGptDesktopError(
              "ChatGPT desktop devtools socket failed",
              "app_unreachable",
            ),
          );
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => session.receive(event.data));
    socket.addEventListener("close", () => session.rejectAll("socket closed"));
    socket.addEventListener("error", () => session.rejectAll("socket error"));
    return session;
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== "number") return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    waiter.resolve(message as CdpResponse);
  }

  private rejectAll(reason: string): void {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(
        new ChatGptDesktopError(
          "ChatGPT desktop devtools connection dropped",
          "app_unreachable",
          reason,
        ),
      );
    }
  }

  command(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<CdpResponse> {
    const id = ++this.nextId;
    return new Promise<CdpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ChatGptDesktopError(
            `ChatGPT desktop devtools call timed out (${method})`,
            "timeout",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string, timeoutMs: number): Promise<T> {
    const response = await this.command(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
    if (response.error) {
      throw new ChatGptDesktopError(
        "ChatGPT desktop rejected the devtools evaluation",
        "evaluate",
        response.error.message,
      );
    }
    const exception = response.result?.exceptionDetails;
    if (exception) {
      throw new ChatGptDesktopError(
        "ChatGPT desktop evaluation threw",
        "evaluate",
        exception.exception?.description,
      );
    }
    return response.result?.result?.value as T;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // The socket is already gone; nothing to release.
    }
  }
}
