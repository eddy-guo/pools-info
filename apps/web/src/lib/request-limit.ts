import { DATA_UNAVAILABLE, retryAfterMilliseconds } from "./use-product";

/** How long a refused visitor keeps waiting in all: the proxy's admission
    line is a per-minute allowance, so a refusal that would still stand a
    minute after the first request is reported rather than waited out. */
export const REQUEST_LIMIT_CEILING_MS = 60000;

/** Whether a response is the proxy's per-visitor refusal (`503
    data_unavailable` with `reason: "request_limit"`), the one 503 whose
    Retry-After says when the same read will be answered. */
export async function isRequestLimited(response: Response) {
  if (response.status !== 503) return false;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return (
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { reason?: unknown }).reason === "request_limit"
  );
}

function wait(delay: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Run a read, and while the proxy answers it with a per-visitor refusal,
 * wait that answer's own Retry-After and run it again, for as long as the
 * wait still lands inside `REQUEST_LIMIT_CEILING_MS` of the first request.
 * The caller's figures stay where they are meanwhile: a refusal is a
 * pending read, not an outage. A refusal that outlasts the ceiling, or one
 * whose Retry-After is missing or malformed, throws the shared unavailable
 * sentence; every other response is returned to the caller as it came.
 */
export async function fetchPastRequestLimit(
  request: () => Promise<Response>,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  const deadline = now() + REQUEST_LIMIT_CEILING_MS;
  for (;;) {
    const response = await request();
    if (!(await isRequestLimited(response))) return response;
    const delay = retryAfterMilliseconds(
      response.headers.get("retry-after"),
      now(),
    );
    if (delay === null || now() + delay > deadline)
      throw Error(DATA_UNAVAILABLE);
    await wait(delay, signal);
  }
}
