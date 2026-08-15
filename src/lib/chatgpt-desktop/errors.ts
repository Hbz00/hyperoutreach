export type ChatGptDesktopFailureCode =
  | "app_not_installed"
  | "app_without_debug_port"
  | "app_unreachable"
  | "renderer_missing"
  | "evaluate"
  | "timeout"
  | "request"
  | "stream";

export class ChatGptDesktopError extends Error {
  override readonly name = "ChatGptDesktopError";

  constructor(
    message: string,
    readonly code: ChatGptDesktopFailureCode,
    readonly detail?: string,
  ) {
    super(message);
  }
}
