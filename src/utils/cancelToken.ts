// @ajan: cursor · @etiket: katman-2, p2, cancel, abort, xhr
/**
 * Run-scoped abort helpers for reconciler / OA.
 * Prefer passing AbortSignal explicitly; getActiveAbortSignal is a fallback
 * for call sites that cannot thread the signal yet.
 */

export class RunAbortedError extends Error {
  readonly name = "RunAbortedError";
  constructor(message = "PDF Manager run aborted") {
    super(message);
  }
}

let activeSignal: AbortSignal | null = null;

export function getActiveAbortSignal(): AbortSignal | null {
  return activeSignal;
}

export function throwIfRunAborted(signal?: AbortSignal | null): void {
  const s = signal ?? activeSignal;
  if (s?.aborted) throw new RunAbortedError();
}

export function isRunAborted(signal?: AbortSignal | null): boolean {
  return !!(signal ?? activeSignal)?.aborted;
}

export async function runWithAbortSignal<T>(
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = activeSignal;
  activeSignal = signal;
  try {
    throwIfRunAborted(signal);
    return await fn();
  } finally {
    activeSignal = prev;
  }
}

/**
 * Race a promise against abort. Optional `onAbort` must cancel the underlying
 * work (e.g. Zotero.HTTP canceller / XHR.abort).
 */
export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null,
  onAbort?: () => void,
): Promise<T> {
  const s = signal ?? activeSignal;
  if (!s) return promise;
  if (s.aborted) {
    try {
      onAbort?.();
    } catch {
      /* ignore */
    }
    return Promise.reject(new RunAbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbortEvent = () => {
      try {
        onAbort?.();
      } catch {
        /* ignore */
      }
      reject(new RunAbortedError());
    };
    s.addEventListener("abort", onAbortEvent, { once: true });
    promise.then(
      (value) => {
        s.removeEventListener("abort", onAbortEvent);
        resolve(value);
      },
      (err) => {
        s.removeEventListener("abort", onAbortEvent);
        reject(err);
      },
    );
  });
}
