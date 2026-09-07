export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 408 | 413) {
    super(
      status === 413
        ? "Request body is too large"
        : status === 408
          ? "Request body timed out"
          : "Invalid request body",
    );
  }
}

/** Bound bytes before invoking JSON or multipart parsers. Copy each chunk
 * immediately into a geometrically grown buffer: arbitrarily fragmented or
 * reused transport buffers must not amplify retained memory or alter input. */
export async function readRequestBody(
  request: Request,
  maxBytes: number,
  timeoutMs = 10_000,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Invalid request body limit");
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  const reader = request.body?.getReader();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader?.cancel().catch(() => undefined);
  };
  const checkAbort = () => {
    if (signal.aborted)
      throw new RequestBodyError(
        signal.reason?.name === "TimeoutError" ? 408 : 400,
      );
  };
  let completed = false;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    checkAbort();
    const advertised = request.headers.get("content-length");
    if (advertised && /^\d+$/.test(advertised) && Number(advertised) > maxBytes)
      throw new RequestBodyError(413);
    let bytes = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
    let length = 0;
    while (reader) {
      const { done, value } = await reader.read();
      checkAbort();
      if (done) {
        completed = true;
        break;
      }
      const nextLength = length + value.byteLength;
      if (nextLength > maxBytes) throw new RequestBodyError(413);
      if (nextLength > bytes.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(maxBytes, Math.max(nextLength, bytes.length * 2)),
        );
        bytes.copy(grown, 0, 0, length);
        bytes = grown;
      }
      bytes.set(value, length);
      length = nextLength;
    }
    return bytes.subarray(0, length);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!completed) cancel();
    reader?.releaseLock();
  }
}

export async function readLimitedFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  const bytes = await readRequestBody(request, maxBytes);
  return new Response(bytes as unknown as BodyInit, {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  }).formData();
}

export async function readLimitedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  return JSON.parse(
    (await readRequestBody(request, maxBytes)).toString("utf8"),
  );
}

export function bodyErrorResponse(
  error: unknown,
  fallbackMessage: string,
): Response {
  return Response.json(
    {
      error:
        error instanceof RequestBodyError ? error.message : fallbackMessage,
    },
    { status: error instanceof RequestBodyError ? error.status : 400 },
  );
}
