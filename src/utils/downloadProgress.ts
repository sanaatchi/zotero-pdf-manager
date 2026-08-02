// @ajan: cursor · @etiket: katman-2, download-progress, multi-job
/**
 * Format / throttle PDF download progress for ProgressWindow + OA Search status.
 * Concurrent fetches use progressJob ids → separate ProgressWindow lines.
 */

import { config } from "../../package.json";

export type DownloadProgress = {
  loaded: number;
  total: number;
  /** 0–100 when total known; otherwise null. */
  percent: number | null;
  jobId?: string;
};

type Handler = (p: DownloadProgress) => void;
type JobHandler = (jobId: string, p: DownloadProgress) => void;

let handler: Handler | null = null;
const jobListeners = new Set<JobHandler>();

export function setDownloadProgressHandler(h: Handler | null): void {
  handler = h;
}

export function addJobProgressListener(fn: JobHandler): () => void {
  jobListeners.add(fn);
  return () => {
    jobListeners.delete(fn);
  };
}

export function newDownloadJobId(): string {
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function reportDownloadProgress(
  loaded: number,
  total: number,
  jobId?: string,
): DownloadProgress {
  const t = total > 0 ? total : 0;
  const percent =
    t > 0 ? Math.min(100, Math.max(0, Math.round((loaded / t) * 100))) : null;
  const info: DownloadProgress = {
    loaded: Math.max(0, loaded | 0),
    total: t,
    percent,
    jobId,
  };
  try {
    if (jobId) {
      for (const fn of jobListeners) fn(jobId, info);
      updateDownloadJobLine(jobId, info);
    }
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

type JobMeta = { source: string; title: string };

type ProgressBoard = {
  win: any;
  lineIdx: Map<string, number>;
  meta: Map<string, JobMeta>;
  active: number;
  nextIdx: number;
};

let board: ProgressBoard | null = null;

function ensureBoard(): ProgressBoard {
  if (board?.win) return board;
  const win = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  });
  win.show();
  board = {
    win,
    lineIdx: new Map(),
    meta: new Map(),
    active: 0,
    nextIdx: 0,
  };
  return board;
}

function lineText(meta: JobMeta, p: DownloadProgress | null): string {
  const pct = p ? formatDownloadPercent(p) : "…";
  // Keep source + % visible; Zotero ProgressWindow crops with ellipsis
  // (crop=end) but long titles still push the % off on narrow popups.
  const src = (meta.source || "…").slice(0, 12);
  const title = (meta.title || "").slice(0, 28);
  return `[${src}] ${pct} — ${title}`;
}

/** Register a ProgressWindow line for a concurrent download job. */
export function registerDownloadJob(jobId: string, meta: JobMeta): void {
  const b = ensureBoard();
  b.meta.set(jobId, {
    source: meta.source || "…",
    title: meta.title || "",
  });
  if (!b.lineIdx.has(jobId)) {
    b.win.createLine({
      text: lineText(b.meta.get(jobId)!, null),
      type: "default",
      progress: 0,
    });
    b.lineIdx.set(jobId, b.nextIdx++);
    b.active++;
  }
}

export function updateDownloadJobLine(
  jobId: string,
  p: DownloadProgress,
  metaPatch?: Partial<JobMeta>,
): void {
  if (!board) return;
  const prev = board.meta.get(jobId) || { source: "…", title: "" };
  if (metaPatch) {
    board.meta.set(jobId, {
      source: metaPatch.source ?? prev.source,
      title: metaPatch.title ?? prev.title,
    });
  }
  const meta = board.meta.get(jobId) || prev;
  let idx = board.lineIdx.get(jobId);
  if (idx == null) {
    registerDownloadJob(jobId, meta);
    idx = board.lineIdx.get(jobId);
  }
  if (idx == null) return;
  board.win.changeLine({
    idx,
    text: lineText(meta, p),
    type: "default",
    progress: p.percent != null ? p.percent : 0,
  });
}

export function finishDownloadJob(
  jobId: string,
  opts: { ok: boolean; text?: string } = { ok: true },
): void {
  if (!board) return;
  const meta = board.meta.get(jobId) || { source: "…", title: "" };
  const idx = board.lineIdx.get(jobId);
  if (idx != null) {
    board.win.changeLine({
      idx,
      text:
        opts.text ||
        `${opts.ok ? "✓" : "✗"} [${meta.source.slice(0, 12)}] ${meta.title.slice(0, 28)}`,
      type: opts.ok ? "success" : "fail",
      progress: 100,
    });
  }
  board.meta.delete(jobId);
  board.lineIdx.delete(jobId);
  board.active = Math.max(0, board.active - 1);
  if (board.active <= 0) {
    board.win.startCloseTimer(4500);
    board = null;
  }
}

/**
 * Poll bridge GET /pdf-fetch-progress while POST /pdf-fetch runs.
 * Pass jobId for concurrent isolation; omit to poll legacy aggregate.
 */
export function startBridgeFetchProgressPoll(
  bridgeBase: string,
  onProgress: Handler,
  opts: { jobId?: string; intervalMs?: number } = {},
): () => void {
  const throttled = throttleProgress(onProgress, 150);
  const jobId = opts.jobId || "";
  const intervalMs = opts.intervalMs ?? 250;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const q = jobId ? `?job=${encodeURIComponent(jobId)}` : "";
      const xhr = await (Zotero.HTTP as any).request(
        "GET",
        `${bridgeBase.replace(/\/+$/, "")}/pdf-fetch-progress${q}`,
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
        jobs?: Record<
          string,
          {
            active?: boolean;
            loaded?: number;
            total?: number;
            percent?: number | null;
          }
        >;
      };
      const applyOne = (
        id: string | undefined,
        loaded: number,
        total: number,
        percent: number | null,
      ) => {
        const info: DownloadProgress = {
          loaded,
          total,
          percent,
          jobId: id,
        };
        throttled(info);
        reportDownloadProgress(loaded, total, id);
      };

      if (jobId) {
        if (body.active === false) return;
        const loaded = Number(body.loaded || 0);
        const total = Number(body.total || 0);
        const percent =
          body.percent != null && Number.isFinite(Number(body.percent))
            ? Math.round(Number(body.percent))
            : total > 0
              ? Math.round((loaded / total) * 100)
              : null;
        applyOne(jobId, loaded, total, percent);
        return;
      }
      const jobs = body.jobs || {};
      for (const [id, j] of Object.entries(jobs)) {
        if (!j || j.active === false) continue;
        const loaded = Number(j.loaded || 0);
        const total = Number(j.total || 0);
        const percent =
          j.percent != null && Number.isFinite(Number(j.percent))
            ? Math.round(Number(j.percent))
            : total > 0
              ? Math.round((loaded / total) * 100)
              : null;
        applyOne(id, loaded, total, percent);
      }
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

/** Bounded parallel map (concurrent downloads). */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}
