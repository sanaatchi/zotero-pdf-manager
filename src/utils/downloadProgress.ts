// @ajan: cursor · @etiket: katman-2, download-progress, oa-fetch
/**
 * Format / throttle PDF download progress for ProgressWindow + OA Search status.
 */

export type DownloadProgress = {
  loaded: number;
  total: number;
  /** 0–100 when total known; otherwise null. */
  percent: number | null;
};

type Handler = (p: DownloadProgress) => void;

let handler: Handler | null = null;

export function setDownloadProgressHandler(h: Handler | null): void {
  handler = h;
}

export function reportDownloadProgress(
  loaded: number,
  total: number,
): DownloadProgress {
  const t = total > 0 ? total : 0;
  const percent =
    t > 0 ? Math.min(100, Math.max(0, Math.round((loaded / t) * 100))) : null;
  const info: DownloadProgress = {
    loaded: Math.max(0, loaded | 0),
    total: t,
    percent,
  };
  try {
    handler?.(info);
  } catch {
    /* UI must never break the download */
  }
  return info;
}

/** "47%" or "1.2 MB" / "380 KB" when length unknown. */
export function formatDownloadPercent(p: DownloadProgress): string {
  if (p.percent != null) return `${p.percent}%`;
  const n = p.loaded;
  if (n <= 0) return "…";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function throttleProgress(fn: Handler, minIntervalMs = 200): Handler {
  let lastAt = 0;
  let lastPct = -1;
  return (p) => {
    const now = Date.now();
    const pct = p.percent ?? -1;
    const force =
      pct === 100 ||
      (pct >= 0 && Math.abs(pct - lastPct) >= 1) ||
      now - lastAt >= minIntervalMs;
    if (!force) return;
    lastAt = now;
    lastPct = pct;
    fn(p);
  };
}

/**
 * Poll bridge GET /pdf-fetch-progress while POST /pdf-fetch runs
 * (upstream stream progress is invisible on the XHR until the body arrives).
 */
export function startBridgeFetchProgressPoll(
  bridgeBase: string,
  onProgress: Handler,
  intervalMs = 250,
): () => void {
  const throttled = throttleProgress(onProgress, 150);
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const xhr = await (Zotero.HTTP as any).request(
        "GET",
        `${bridgeBase.replace(/\/+$/, "")}/pdf-fetch-progress`,
        {
          responseType: "text",
          timeout: 5000,
          successCodes: false,
        },
      );
      if (stopped) return;
      const status = Number(xhr?.status || 0);
      if (status && (status < 200 || status >= 300)) return;
      const raw =
        typeof xhr?.responseText === "string"
          ? xhr.responseText
          : xhr?.response
            ? String(xhr.response)
            : "";
      const body = JSON.parse(raw || "{}") as {
        active?: boolean;
        loaded?: number;
        total?: number;
        percent?: number | null;
      };
      if (!body || body.active === false) return;
      const loaded = Number(body.loaded || 0);
      const total = Number(body.total || 0);
      const percent =
        body.percent != null && Number.isFinite(Number(body.percent))
          ? Math.round(Number(body.percent))
          : total > 0
            ? Math.round((loaded / total) * 100)
            : null;
      throttled({ loaded, total, percent });
      reportDownloadProgress(loaded, total);
    } catch {
      /* ignore poll errors */
    }
  };
  const id = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
