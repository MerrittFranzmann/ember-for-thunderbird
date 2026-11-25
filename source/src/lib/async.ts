/** Bound waits on Thunderbird APIs that may leave a stream pending while offline. */
export class RequestTimeout extends Error {
  constructor(label: string) { super(`${label} took too long. Thunderbird may be offline or busy.`); this.name = "RequestTimeout"; }
}
export function withDeadline<T>(work: Promise<T>, milliseconds = 15000, signal?: AbortSignal, label = "Request"): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error: unknown, value?: T) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new DOMException("Stopped", "AbortError"));
    const timer = setTimeout(() => finish(new RequestTimeout(label)), milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    work.then((value) => finish(null, value), (error) => finish(error));
  });
}
