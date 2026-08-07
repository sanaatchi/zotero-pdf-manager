// @ajan: cursor · @etiket: katman-2, disk-audit, orphan, name-content, multi-attach
/**
 * Prefs «Disk / ek denetimi» — P0 report-only surface.
 * Apply / quarantine intentionally out of scope (dry-run default).
 */
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { writeJsonAtomic } from "../utils/atomicJson";
import { classifyOrphanTree } from "./attachmentScanner";
import { getWatchRoots, DEFAULT_WATCH_ROOT } from "./folderIndex";
import { parseFilenameMetadata } from "./filenameMetadata";
import { validateContentViaBridge } from "./oaPdfBridge";

declare const IOUtils: any;
declare const PathUtils: any;

const DISINDA_TOKEN = "_zotero_disinda";
const FALLBACK_KAYNAKLAR = "D:\\OneDrive\\1A_E_KAYNAKLARIM\\Zotero Kaynaklar";

export type DiskAuditKind = "orphan" | "nameContent" | "copy";

export interface DiskAuditProgress {
  text: string;
  progress?: number;
}

export interface DiskAuditSummary {
  kind: DiskAuditKind;
  dryRun: true;
  roots: string[];
  reportPath: string;
  orphanCount?: number;
  linkedHint?: number;
  multiAttachParents?: number;
  siblingFolders?: number;
  nameContent?: {
    scanned: number;
    ok: number;
    mismatch: number;
    weak: number;
    unverifiable: number;
    clearMismatch: number;
    renameProposals: number;
  };
  samples?: unknown[];
  error?: string;
}

function defaultKaynaklarPath(): string {
  try {
    if (typeof PathUtils !== "undefined" && PathUtils?.join) {
      return PathUtils.join(DEFAULT_WATCH_ROOT, "Zotero Kaynaklar");
    }
  } catch {
    /* ignore */
  }
  return FALLBACK_KAYNAKLAR;
}

export function normalizeDiskAuditRoots(opts?: {
  useWatchRoots?: boolean;
  rootsPref?: string;
  includeDisinda?: boolean;
}): string[] {
  const useWatch =
    opts?.useWatchRoots ?? getPref("pdf.diskAudit.useWatchRoots") !== false;
  const includeDisinda =
    opts?.includeDisinda ?? !!getPref("pdf.diskAudit.includeDisinda");
  let roots: string[] = [];
  if (useWatch) {
    roots = getWatchRoots().slice();
  } else {
    const raw = String(
      opts?.rootsPref ?? getPref("pdf.diskAudit.roots") ?? "",
    ).trim();
    roots = raw
      ? raw
          .split(/[;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [defaultKaynaklarPath()];
  }
  if (!roots.length) roots = [defaultKaynaklarPath()];
  if (!includeDisinda) {
    roots = roots.filter(
      (r) => !r.toLowerCase().includes(DISINDA_TOKEN.toLowerCase()),
    );
  }
  return roots;
}

export function isUnderDisinda(path: string): boolean {
  return (
    path.replace(/\\/g, "/").toLowerCase().includes(`/${DISINDA_TOKEN}/`) ||
    path.replace(/\\/g, "/").toLowerCase().includes(`/${DISINDA_TOKEN}`)
  );
}

export function proposeAttangerRename(
  currentName: string,
  contentTitle: string,
  contentAuthor?: string,
  contentYear?: string,
): string | null {
  const title = String(contentTitle || "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length < 4) return null;
  const meta = parseFilenameMetadata(currentName);
  const author =
    (contentAuthor || "").split(/[;,]/)[0].trim() ||
    (meta.authors && meta.authors[0]) ||
    "Unknown";
  const year = String(contentYear || meta.year || "")
    .replace(/\D/g, "")
    .slice(0, 4);
  const yearPart = year.length === 4 ? ` (${year})` : "";
  const itemType = meta.itemType ? ` [${meta.itemType}]` : "";
  const pub = meta.publisher ? ` ${meta.publisher}` : "";
  let stem = `${author}${yearPart} ${title}${itemType}${pub}`
    .replace(/\s+/g, " ")
    .trim();
  stem = stem
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stem.length > 180) stem = stem.slice(0, 180).trim();
  const proposed = `${stem}.pdf`;
  if (proposed.toLowerCase() === currentName.toLowerCase()) return null;
  return proposed;
}

export function classifyNameContentFromBridge(
  result: {
    verdict?: string;
    confidence?: number;
    reason?: string;
  } | null,
): {
  class: string;
  clearMismatch: boolean;
} {
  if (!result || !result.verdict) {
    return { class: "unverifiable", clearMismatch: false };
  }
  const v = String(result.verdict).toLowerCase();
  if (v === "match" || v === "ok") {
    return { class: "ok", clearMismatch: false };
  }
  if (v === "weak" || v === "review") {
    return { class: "weak", clearMismatch: false };
  }
  if (v === "mismatch") {
    const conf = Number(result.confidence || 0);
    const clear = conf >= 0.75;
    return { class: "mismatch", clearMismatch: clear };
  }
  return { class: "unverifiable", clearMismatch: false };
}

async function resolveReportDir(): Promise<string> {
  const pref = String(getPref("pdf.diskAudit.reportDir") || "").trim();
  if (pref) {
    try {
      if (!(await IOUtils.exists(pref))) await IOUtils.makeDirectory(pref);
      return pref;
    } catch {
      /* fall through */
    }
  }
  try {
    const dir = PathUtils.join(
      (Zotero as any).DataDirectory.dir,
      "zpdfmanager-disk-audit",
    );
    if (!(await IOUtils.exists(dir))) await IOUtils.makeDirectory(dir);
    return dir;
  } catch {
    return "";
  }
}

async function writeReport(kind: string, payload: unknown): Promise<string> {
  const dir = await resolveReportDir();
  if (!dir) return "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = PathUtils.join(dir, `disk-audit-${kind}-${stamp}.json`);
  await writeJsonAtomic(path, payload as any);
  return path;
}

async function collectReferencedPaths(): Promise<Set<string>> {
  const referenced = new Set<string>();
  try {
    const rows =
      (await Zotero.DB.queryAsync(
        `SELECT itemID FROM items WHERE itemTypeID=${Zotero.ItemTypes.getID("attachment")} ` +
          `AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
      )) || [];
    for (const row of rows) {
      const attachment = await Zotero.Items.getAsync(row.itemID);
      if (!attachment?.isFileAttachment()) continue;
      const path = await attachment.getFilePathAsync().catch(() => "");
      if (path) {
        referenced.add(
          PathUtils.normalize(path).normalize("NFC").toLowerCase(),
        );
      }
    }
  } catch (e) {
    ztoolkit.log("diskAudit referenced paths failed", e);
  }
  return referenced;
}

function showProgress(text: string, closeMs = 6000) {
  try {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: closeMs })
      .createLine({ text, type: "default" })
      .show();
  } catch {
    /* headless */
  }
}

export async function runOrphanDiskAudit(opts?: {
  onProgress?: (p: DiskAuditProgress) => void;
}): Promise<DiskAuditSummary> {
  const roots = normalizeDiskAuditRoots();
  opts?.onProgress?.({ text: "Scanning orphans…", progress: 10 });
  const referenced = await collectReferencedPaths();
  const includeDisinda = !!getPref("pdf.diskAudit.includeDisinda");
  const { orphanFiles, emptyDirs } = await classifyOrphanTree(
    roots,
    referenced,
    {
      getChildren: (dir) => IOUtils.getChildren(dir),
      statType: async (path) => {
        const stat = await IOUtils.stat(path).catch(() => null);
        return stat?.type ?? null;
      },
    },
    (path) => PathUtils.normalize(path).normalize("NFC").toLowerCase(),
    (path) => PathUtils.filename(path),
  );
  const filtered = includeDisinda
    ? orphanFiles
    : orphanFiles.filter((p) => !isUnderDisinda(p));
  const payload = {
    kind: "orphan",
    dryRun: true as const,
    generatedAt: new Date().toISOString(),
    roots,
    includeDisinda,
    orphanCount: filtered.length,
    emptyDirs: emptyDirs.length,
    orphanFiles: filtered.slice(0, 2000),
    emptyDirSamples: emptyDirs.slice(0, 200),
  };
  const reportPath = await writeReport("orphan", payload);
  const summary: DiskAuditSummary = {
    kind: "orphan",
    dryRun: true,
    roots,
    reportPath,
    orphanCount: filtered.length,
    samples: filtered.slice(0, 8),
  };
  showProgress(
    `Orphan report: ${filtered.length} file(s)` +
      (reportPath ? ` → ${PathUtils.filename(reportPath)}` : ""),
  );
  return summary;
}

export async function runNameContentDiskAudit(opts?: {
  onProgress?: (p: DiskAuditProgress) => void;
  maxFiles?: number;
}): Promise<DiskAuditSummary> {
  const roots = normalizeDiskAuditRoots();
  const maxFiles = Math.max(1, Number(opts?.maxFiles || 400));
  opts?.onProgress?.({
    text: "Collecting orphans for name↔content…",
    progress: 5,
  });
  const referenced = await collectReferencedPaths();
  const includeDisinda = !!getPref("pdf.diskAudit.includeDisinda");
  const { orphanFiles } = await classifyOrphanTree(
    roots,
    referenced,
    {
      getChildren: (dir) => IOUtils.getChildren(dir),
      statType: async (path) => {
        const stat = await IOUtils.stat(path).catch(() => null);
        return stat?.type ?? null;
      },
    },
    (path) => PathUtils.normalize(path).normalize("NFC").toLowerCase(),
    (path) => PathUtils.filename(path),
  );
  let targets = orphanFiles.filter((p) => p.toLowerCase().endsWith(".pdf"));
  if (!includeDisinda) targets = targets.filter((p) => !isUnderDisinda(p));
  // Prefer Kaynaklar orphans when present under roots
  const kaynaklarPref = targets.filter((p) =>
    p.toLowerCase().includes("zotero kaynaklar"),
  );
  if (kaynaklarPref.length) targets = kaynaklarPref;
  targets = targets.slice(0, maxFiles);

  const counts = {
    scanned: 0,
    ok: 0,
    mismatch: 0,
    weak: 0,
    unverifiable: 0,
    clearMismatch: 0,
    renameProposals: 0,
  };
  const items: unknown[] = [];
  const clearMismatch: unknown[] = [];

  for (let i = 0; i < targets.length; i++) {
    const path = targets[i];
    const name = PathUtils.filename(path);
    opts?.onProgress?.({
      text: `Name↔content ${i + 1}/${targets.length}`,
      progress: Math.round(10 + (80 * i) / Math.max(1, targets.length)),
    });
    const parsed = parseFilenameMetadata(name);
    const title = parsed.title || name.replace(/\.pdf$/i, "");
    const creators = (parsed.authors || []).join("; ");
    let bridge: Awaited<ReturnType<typeof validateContentViaBridge>> = null;
    try {
      bridge = await validateContentViaBridge({
        title,
        creators,
        year: String(parsed.year || ""),
        doi: "",
        isbn: String(parsed.isbn || ""),
        itemType: String(parsed.itemType || ""),
        pdfPath: path,
        allowOcr: false,
      });
    } catch {
      bridge = null;
    }
    const verdict = classifyNameContentFromBridge(
      bridge
        ? {
            verdict: (bridge as any).verdict || (bridge as any).decision,
            confidence: (bridge as any).confidence,
            reason: (bridge as any).reason,
          }
        : null,
    );
    counts.scanned += 1;
    if (verdict.class === "ok") counts.ok += 1;
    else if (verdict.class === "mismatch") counts.mismatch += 1;
    else if (verdict.class === "weak") counts.weak += 1;
    else counts.unverifiable += 1;

    const contentTitle =
      String(
        (bridge as any)?.guessed_title || (bridge as any)?.content_title || "",
      ) || "";
    let proposed: string | null = null;
    if (verdict.clearMismatch) {
      counts.clearMismatch += 1;
      proposed = proposeAttangerRename(
        name,
        contentTitle || title,
        creators,
        String(parsed.year || ""),
      );
      if (proposed) counts.renameProposals += 1;
    }
    const row = {
      path,
      file: name,
      class: verdict.class,
      clear_mismatch: verdict.clearMismatch,
      proposed_rename: proposed,
      applied: false,
      dry_run: true,
      bridge_verdict: (bridge as any)?.verdict || null,
      content_title: contentTitle || null,
    };
    items.push(row);
    if (verdict.clearMismatch) clearMismatch.push(row);
    if (i % 5 === 0) await Zotero.Promise.delay(0);
  }

  const payload = {
    kind: "nameContent",
    dryRun: true as const,
    generatedAt: new Date().toISOString(),
    roots,
    scope: "orphans_only",
    apply: false,
    counts,
    clear_mismatch: clearMismatch,
    items,
  };
  const reportPath = await writeReport("name-content", payload);
  const summary: DiskAuditSummary = {
    kind: "nameContent",
    dryRun: true,
    roots,
    reportPath,
    nameContent: counts,
    samples: clearMismatch.slice(0, 8),
  };
  showProgress(
    `Name↔content: ${counts.clearMismatch} clear_mismatch / ${counts.scanned} scanned` +
      (reportPath ? ` → ${PathUtils.filename(reportPath)}` : ""),
    8000,
  );
  return summary;
}

export async function listMultiAttachParents(limit = 50): Promise<{
  count: number;
  samples: Array<{
    parentKey: string;
    parentTitle: string;
    pdfCount: number;
    paths: string[];
  }>;
}> {
  const samples: Array<{
    parentKey: string;
    parentTitle: string;
    pdfCount: number;
    paths: string[];
  }> = [];
  let count = 0;
  try {
    const parents =
      (await Zotero.DB.queryAsync(
        `SELECT DISTINCT ia.parentItemID AS parentItemID
         FROM itemAttachments ia
         JOIN items i ON i.itemID = ia.itemID
         WHERE ia.parentItemID IS NOT NULL
           AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
           AND (
             ia.contentType = 'application/pdf'
             OR LOWER(COALESCE(ia.path, '')) LIKE '%.pdf'
           )`,
      )) || [];
    for (const row of parents) {
      const parent = await Zotero.Items.getAsync(row.parentItemID);
      if (!parent || parent.isAttachment()) continue;
      const children = parent.getAttachments?.() || [];
      const pdfs: string[] = [];
      for (const cid of children) {
        const att = await Zotero.Items.getAsync(cid);
        if (!att || att.deleted) continue;
        const ct = String(att.attachmentContentType || "").toLowerCase();
        const path =
          (await att.getFilePathAsync?.().catch(() => "")) ||
          String(att.attachmentPath || "");
        if (ct.includes("pdf") || /\.pdf$/i.test(path)) {
          pdfs.push(path || String(att.key));
        }
      }
      if (pdfs.length >= 2) {
        count += 1;
        if (samples.length < limit) {
          samples.push({
            parentKey: parent.key,
            parentTitle:
              parent.getDisplayTitle?.() || parent.getField?.("title") || "",
            pdfCount: pdfs.length,
            paths: pdfs,
          });
        }
      }
    }
  } catch (e) {
    ztoolkit.log("listMultiAttachParents failed", e);
  }
  return { count, samples };
}

export async function runCopyDiskAudit(opts?: {
  onProgress?: (p: DiskAuditProgress) => void;
}): Promise<DiskAuditSummary> {
  opts?.onProgress?.({ text: "Scanning multi-attach parents…", progress: 15 });
  const multi = await listMultiAttachParents(50);
  opts?.onProgress?.({ text: "Scanning disk siblings…", progress: 55 });
  const roots = normalizeDiskAuditRoots();
  const referenced = await collectReferencedPaths();
  const siblingFolders: Array<{
    dir: string;
    pdfCount: number;
    linked: number;
    unlinked: number;
    unlinkedSamples: string[];
  }> = [];

  for (const root of roots) {
    const walk = async (dir: string, depth: number) => {
      if (depth > 8) return;
      if (!includeDisindaPref() && isUnderDisinda(dir)) return;
      let children: string[] = [];
      try {
        children = await IOUtils.getChildren(dir);
      } catch {
        return;
      }
      const pdfs: string[] = [];
      for (const child of children) {
        let st: any = null;
        try {
          st = await IOUtils.stat(child);
        } catch {
          continue;
        }
        if (st?.type === "directory") {
          await walk(child, depth + 1);
          continue;
        }
        if (String(child).toLowerCase().endsWith(".pdf")) pdfs.push(child);
      }
      if (pdfs.length < 2) return;
      let linked = 0;
      const unlinked: string[] = [];
      for (const p of pdfs) {
        const key = PathUtils.normalize(p).normalize("NFC").toLowerCase();
        if (referenced.has(key)) linked += 1;
        else unlinked.push(p);
      }
      if (linked >= 1 && unlinked.length >= 1) {
        siblingFolders.push({
          dir,
          pdfCount: pdfs.length,
          linked,
          unlinked: unlinked.length,
          unlinkedSamples: unlinked.slice(0, 5),
        });
      }
    };
    await walk(root, 0);
  }

  const payload = {
    kind: "copy",
    dryRun: true as const,
    apply: false,
    generatedAt: new Date().toISOString(),
    roots,
    multiAttach: {
      count: multi.count,
      samples: multi.samples,
    },
    diskSibling: {
      folderCount: siblingFolders.length,
      unlinkedSum: siblingFolders.reduce((a, f) => a + f.unlinked, 0),
      samples: siblingFolders.slice(0, 30),
    },
  };
  const reportPath = await writeReport("copy", payload);
  const summary: DiskAuditSummary = {
    kind: "copy",
    dryRun: true,
    roots,
    reportPath,
    multiAttachParents: multi.count,
    siblingFolders: siblingFolders.length,
    samples: multi.samples.slice(0, 4),
  };
  showProgress(
    `Copy report: ${multi.count} multi-attach parent(s), ${siblingFolders.length} sibling folder(s)` +
      (reportPath ? ` → ${PathUtils.filename(reportPath)}` : ""),
    8000,
  );
  return summary;
}

function includeDisindaPref(): boolean {
  try {
    return !!getPref("pdf.diskAudit.includeDisinda");
  } catch {
    return false;
  }
}

export async function runDiskAuditWithProgress(
  kind: DiskAuditKind,
): Promise<DiskAuditSummary> {
  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  });
  progress
    .createLine({
      text: `Disk audit (${kind}) — report only…`,
      type: "default",
      progress: 5,
    })
    .show();
  const onProgress = (p: DiskAuditProgress) => {
    try {
      progress.changeLine({
        text: p.text,
        type: "default",
        progress: p.progress ?? 50,
        idx: 0,
      });
    } catch {
      /* ignore */
    }
  };
  try {
    let summary: DiskAuditSummary;
    if (kind === "orphan") summary = await runOrphanDiskAudit({ onProgress });
    else if (kind === "nameContent")
      summary = await runNameContentDiskAudit({ onProgress });
    else summary = await runCopyDiskAudit({ onProgress });
    progress.changeLine({
      text: summarizeLine(summary),
      type: "success",
      progress: 100,
      idx: 0,
    });
    progress.startCloseTimer(6000);
    return summary;
  } catch (e) {
    ztoolkit.log("diskAudit failed", e);
    progress.changeLine({
      text: `Disk audit failed: ${String((e as Error)?.message || e)}`,
      type: "fail",
      progress: 100,
      idx: 0,
    });
    progress.startCloseTimer(8000);
    return {
      kind,
      dryRun: true,
      roots: [],
      reportPath: "",
      error: String((e as Error)?.message || e),
    };
  }
}

function summarizeLine(s: DiskAuditSummary): string {
  if (s.kind === "orphan")
    return `Orphans: ${s.orphanCount ?? 0} (report only)`;
  if (s.kind === "nameContent") {
    const n = s.nameContent;
    return `Name↔content: clear_mismatch ${n?.clearMismatch ?? 0} / ${n?.scanned ?? 0} (dry-run)`;
  }
  return `Copy: multi-attach ${s.multiAttachParents ?? 0}, siblings ${s.siblingFolders ?? 0} (report)`;
}
