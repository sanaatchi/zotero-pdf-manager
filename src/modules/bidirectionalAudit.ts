// @ajan: cursor · @etiket: katman-2, bidirectional-audit, item-pdf-cross, type-mismatch, match-suggest, apply
/**
 * Unified two-ended PDF control report:
 *   item → PDF  (linked / broken / missing / type conflict / mismatch tags)
 *   PDF  → item (linked / orphan / cross-folder same basename+size)
 *
 * Reuses diskAudit helpers for roots, type tags, and cross-folder grouping.
 * Structural only (no per-file content bridge) — fast enough for full Kaynaklar.
 */
import { config } from "../../package.json";
import { writeJsonAtomic } from "../utils/atomicJson";
import {
  CrossFolderFile,
  crossFolderUnlinkedLosers,
  extractFilenameItemTypeTag,
  filenameItemTypeMismatch,
  groupCrossFolderDuplicates,
  isDiskAuditDryRun,
  isUnderDisinda,
  movePathToQuarantine,
  normalizeDiskAuditRoots,
} from "./diskAudit";
import { parseFilenameMetadata } from "./filenameMetadata";
import { getPref } from "../utils/prefs";

declare const IOUtils: any;
declare const PathUtils: any;
declare const Services: any;

export type BidirItemStatus = "linked" | "broken" | "missing" | "multi";
export type BidirPdfStatus = "linked" | "orphan";

export interface BidirItemRow {
  itemID: number;
  key: string;
  title: string;
  itemType: string;
  status: BidirItemStatus;
  paths: string[];
  accessibleCount: number;
  brokenCount: number;
  typeConflict: boolean;
  filenameType: string | null;
  conflictPath?: string;
  hasMismatchTag: boolean;
  hasReviewTag: boolean;
  alternatePaths: string[];
}

export interface BidirPdfRow {
  path: string;
  file: string;
  status: BidirPdfStatus;
  size: number;
  filenameType: string | null;
  crossFolderPeers: string[];
}

export interface BidirAuditSummary {
  kind: "bidirectional";
  generatedAt: string;
  roots: string[];
  reportPath: string;
  items: {
    scanned: number;
    linked: number;
    broken: number;
    missing: number;
    multi: number;
    typeConflict: number;
    mismatchTagged: number;
  };
  pdfs: {
    scanned: number;
    linked: number;
    orphan: number;
    crossFolderGroups: number;
    crossFolderUnlinkedLosers: number;
  };
  samples: {
    typeConflicts: BidirItemRow[];
    broken: BidirItemRow[];
    missing: BidirItemRow[];
    orphans: BidirPdfRow[];
    crossFolder: Array<{
      basename: string;
      size: number;
      paths: string[];
    }>;
    clearMatches?: BidirMatchSuggestion[];
  };
  matchSuggestions?: {
    total: number;
    clear: number;
    weak: number;
  };
}

function pathKey(p: string): string {
  return PathUtils.normalize(p).normalize("NFC").toLowerCase();
}

function includeDisindaPref(): boolean {
  try {
    return !!getPref("pdf.diskAudit.includeDisinda");
  } catch {
    return false;
  }
}

async function resolveReportDir(): Promise<string> {
  const custom = String(getPref("pdf.diskAudit.reportDir") || "").trim();
  if (custom) {
    try {
      await IOUtils.makeDirectory(custom, {
        ignoreExisting: true,
        createAncestors: true,
      });
      return custom;
    } catch {
      /* fall through */
    }
  }
  const dir = PathUtils.join(
    (Zotero as any).DataDirectory.dir,
    "zpdfmanager-disk-audit",
  );
  await IOUtils.makeDirectory(dir, {
    ignoreExisting: true,
    createAncestors: true,
  });
  return dir;
}

async function writeBidirReport(payload: unknown): Promise<string> {
  const dir = await resolveReportDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = PathUtils.join(dir, `disk-audit-bidirectional-${stamp}.json`);
  await writeJsonAtomic(path, payload as any);
  try {
    await writeJsonAtomic(
      PathUtils.join(dir, "last-bidirectional.json"),
      payload as any,
    );
  } catch {
    /* ignore */
  }
  return path;
}

/** Walk watch roots → PDF entries (path, basename, size, dir). */
export async function walkPdfEntries(
  roots: string[],
  opts?: { includeDisinda?: boolean; maxDepth?: number },
): Promise<CrossFolderFile[]> {
  const includeDisinda = opts?.includeDisinda ?? includeDisindaPref();
  const maxDepth = opts?.maxDepth ?? 8;
  const out: CrossFolderFile[] = [];

  const walk = async (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    if (!includeDisinda && isUnderDisinda(dir)) return;
    let children: string[] = [];
    try {
      children = await IOUtils.getChildren(dir);
    } catch {
      return;
    }
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
      if (!String(child).toLowerCase().endsWith(".pdf")) continue;
      const size = Number(st?.size || 0);
      out.push({
        path: child,
        basename: PathUtils.filename(child),
        size: size > 0 ? size : 0,
        dir,
      });
    }
  };

  for (const root of roots) {
    await walk(root, 0);
  }
  return out;
}

/**
 * Pure: suggest alternate absolute paths for a broken attachment using
 * basename match against a disk inventory (same name elsewhere under roots).
 */
export function suggestAlternatePaths(
  brokenBasename: string,
  diskFiles: Array<{ path: string; basename: string }>,
  limit = 5,
): string[] {
  const want = String(brokenBasename || "").toLowerCase();
  if (!want) return [];
  const hits: string[] = [];
  for (const f of diskFiles) {
    if (String(f.basename || "").toLowerCase() !== want) continue;
    hits.push(f.path);
    if (hits.length >= limit) break;
  }
  return hits;
}

export function titleTokens(value: string): Set<string> {
  return new Set(
    (value || "")
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

/** Token overlap using min(|a|,|b|) denominator + shared count. */
export function titleOverlapDetail(
  a: string,
  b: string,
): { score: number; shared: number; shortSize: number } {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.size || !tb.size) return { score: 0, shared: 0, shortSize: 0 };
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const shortSize = Math.min(ta.size, tb.size);
  return { score: shared / shortSize, shared, shortSize };
}

export function titleOverlapScore(a: string, b: string): number {
  return titleOverlapDetail(a, b).score;
}

export type BidirMatchSuggestion = {
  kind: "orphan_to_missing";
  score: number;
  clear: boolean;
  itemID: number;
  itemKey: string;
  itemTitle: string;
  itemType: string;
  pdfPath: string;
  pdfFile: string;
  filenameType: string | null;
  typeOk: boolean;
};

/**
 * Pair PDF-less parents with orphan files by filename title overlap.
 * One orphan and one item each get at most one best clear/weak hit.
 */
export function suggestOrphanToMissingMatches(
  missing: Array<{
    itemID: number;
    key: string;
    title: string;
    itemType: string;
  }>,
  orphans: Array<{ path: string; file: string; filenameType: string | null }>,
  opts?: { minScore?: number; clearScore?: number; minShared?: number },
): BidirMatchSuggestion[] {
  // Clear needs ≥2 shared tokens + high coverage — single-word overlaps
  // ("tarihi", "sanat") produced false positives at 0.55 in live Kaynaklar.
  const minScore = opts?.minScore ?? 0.5;
  const clearScore = opts?.clearScore ?? 0.75;
  const minShared = opts?.minShared ?? 2;
  type Cand = BidirMatchSuggestion;
  const all: Cand[] = [];
  for (const item of missing) {
    for (const pdf of orphans) {
      const meta = parseFilenameMetadata(pdf.file);
      const pdfTitle = String(meta.title || pdf.file.replace(/\.pdf$/i, ""));
      const detail = titleOverlapDetail(item.title, pdfTitle);
      let score = detail.score;
      const typeOk =
        !pdf.filenameType ||
        !item.itemType ||
        pdf.filenameType.toLowerCase() === item.itemType.toLowerCase();
      if (typeOk && score >= 0.5 && detail.shared >= minShared) {
        score = Math.min(1, score + 0.05);
      }
      if (!typeOk) score *= 0.75;
      if (detail.shared < 1 || score < minScore) continue;
      const clear = typeOk && detail.shared >= minShared && score >= clearScore;
      all.push({
        kind: "orphan_to_missing",
        score: Math.round(score * 1000) / 1000,
        clear,
        itemID: item.itemID,
        itemKey: item.key,
        itemTitle: item.title,
        itemType: item.itemType,
        pdfPath: pdf.path,
        pdfFile: pdf.file,
        filenameType: pdf.filenameType,
        typeOk,
      });
    }
  }
  all.sort((a, b) => b.score - a.score);
  const usedItems = new Set<number>();
  const usedPdfs = new Set<string>();
  const out: Cand[] = [];
  for (const c of all) {
    if (usedItems.has(c.itemID) || usedPdfs.has(c.pdfPath.toLowerCase())) {
      continue;
    }
    usedItems.add(c.itemID);
    usedPdfs.add(c.pdfPath.toLowerCase());
    out.push(c);
  }
  return out;
}

/** Sibling ``downloads`` next to Zotero Kaynaklar — for cross-folder copy detection. */
export function siblingDownloadsRoots(primaryRoots: string[]): string[] {
  const extra: string[] = [];
  const seen = new Set(primaryRoots.map((r) => r.toLowerCase()));
  for (const root of primaryRoots) {
    const parent = PathUtils.parent?.(root);
    if (!parent) continue;
    const downloads = PathUtils.join(parent, "downloads");
    const key = String(downloads).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(downloads);
  }
  return extra;
}

function itemHasTag(item: Zotero.Item, tag: string): boolean {
  try {
    if (item.hasTag?.(tag)) return true;
    const tags = item.getTags?.() || [];
    const needle = tag.replace(/^#/, "").toLowerCase();
    return tags.some(
      (t: any) =>
        String(t?.tag || t || "")
          .replace(/^#/, "")
          .toLowerCase() === needle,
    );
  } catch {
    return false;
  }
}

/**
 * Item → PDF pass + PDF → item pass → one JSON report.
 */
export async function runBidirectionalAudit(opts?: {
  onProgress?: (p: { text: string; progress?: number }) => void;
}): Promise<BidirAuditSummary> {
  const roots = normalizeDiskAuditRoots();
  opts?.onProgress?.({ text: "Disk PDF envanteri…", progress: 8 });
  const primaryFiles = await walkPdfEntries(roots);
  const downloadRoots = siblingDownloadsRoots(roots);
  let downloadFiles: CrossFolderFile[] = [];
  for (const dr of downloadRoots) {
    try {
      if (await IOUtils.exists(dr)) {
        downloadFiles = downloadFiles.concat(
          await walkPdfEntries([dr], { includeDisinda: true }),
        );
      }
    } catch {
      /* ignore */
    }
  }
  // Primary inventory for orphan detection; union for cross-folder copies.
  const diskFiles = primaryFiles;
  const crossGroups = groupCrossFolderDuplicates(
    [...primaryFiles, ...downloadFiles].filter((f) => f.size > 0),
  );
  const crossPeerMap = new Map<string, string[]>();
  for (const g of crossGroups) {
    for (const p of g.paths) {
      crossPeerMap.set(
        pathKey(p),
        g.paths.filter((x) => pathKey(x) !== pathKey(p)),
      );
    }
  }

  opts?.onProgress?.({ text: "Zotero ekleri taranıyor…", progress: 25 });
  const referenced = new Set<string>();
  const itemRows: BidirItemRow[] = [];
  const counts = {
    scanned: 0,
    linked: 0,
    broken: 0,
    missing: 0,
    multi: 0,
    typeConflict: 0,
    mismatchTagged: 0,
  };

  const libraryID = Zotero.Libraries.userLibraryID;
  let itemIDs: number[] = [];
  try {
    const rows =
      (await Zotero.DB.queryAsync(
        `SELECT itemID FROM items WHERE libraryID=${libraryID} ` +
          `AND itemTypeID != ${Zotero.ItemTypes.getID("attachment")} ` +
          `AND itemTypeID != ${Zotero.ItemTypes.getID("annotation")} ` +
          `AND itemTypeID != ${Zotero.ItemTypes.getID("note")} ` +
          `AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
      )) || [];
    itemIDs = rows.map((r: any) => Number(r.itemID)).filter(Number.isFinite);
  } catch (e) {
    ztoolkit.log("bidirectionalAudit item list failed", e);
    itemIDs = [];
  }

  for (let i = 0; i < itemIDs.length; i++) {
    if (i % 40 === 0) {
      opts?.onProgress?.({
        text: `Öğe ${i + 1}/${itemIDs.length}`,
        progress: 25 + Math.round((45 * i) / Math.max(1, itemIDs.length)),
      });
      await Zotero.Promise.delay(0);
    }
    const item = await Zotero.Items.getAsync(itemIDs[i]);
    if (!item || item.deleted || !item.isRegularItem?.()) continue;
    if ((item as any).isFeedItem) continue;

    counts.scanned += 1;
    const itemType = String(item.itemType || "");
    const title =
      item.getDisplayTitle?.() || item.getField?.("title") || item.key;
    const childIds = item.getAttachments?.() || [];
    const paths: string[] = [];
    let accessible = 0;
    let broken = 0;
    let typeConflict = false;
    let filenameType: string | null = null;
    let conflictPath: string | undefined;
    const rawPaths: string[] = [];

    for (const cid of childIds) {
      const att = await Zotero.Items.getAsync(cid);
      if (!att || att.deleted || !att.isFileAttachment?.()) continue;
      const ct = String(att.attachmentContentType || "").toLowerCase();
      const attPath =
        (await att.getFilePathAsync?.().catch(() => "")) ||
        String(att.attachmentPath || "");
      const isPdf = ct.includes("pdf") || /\.pdf$/i.test(attPath);
      if (!isPdf) continue;

      let resolved = "";
      try {
        resolved = (await att.getFilePathAsync?.()) || "";
      } catch {
        resolved = "";
      }
      const exists = resolved
        ? await IOUtils.exists(resolved).catch(() => false)
        : false;

      if (resolved && exists) {
        accessible += 1;
        paths.push(resolved);
        referenced.add(pathKey(resolved));
        const tm = filenameItemTypeMismatch(
          itemType,
          PathUtils.filename(resolved),
        );
        if (tm.mismatch) {
          typeConflict = true;
          filenameType = tm.filenameType;
          conflictPath = resolved;
        } else if (!filenameType) {
          filenameType = tm.filenameType;
        }
      } else {
        broken += 1;
        const raw = String(att.attachmentPath || attPath || "");
        rawPaths.push(raw);
        const base = PathUtils.filename(raw) || raw.split(/[\\/]/).pop() || "";
        if (base) {
          const tm = filenameItemTypeMismatch(itemType, base);
          if (tm.mismatch) {
            typeConflict = true;
            filenameType = tm.filenameType;
            conflictPath = raw;
          }
        }
      }
    }

    const hasMismatchTag = itemHasTag(item, "#pdf-mismatch");
    const hasReviewTag = itemHasTag(item, "#pdf-review");
    if (hasMismatchTag) counts.mismatchTagged += 1;
    if (typeConflict) counts.typeConflict += 1;

    let status: BidirItemStatus;
    if (accessible === 0 && broken === 0) {
      status = "missing";
      counts.missing += 1;
    } else if (accessible === 0 && broken > 0) {
      status = "broken";
      counts.broken += 1;
    } else if (accessible >= 2) {
      status = "multi";
      counts.multi += 1;
    } else if (broken > 0) {
      status = "broken";
      counts.broken += 1;
    } else {
      status = "linked";
      counts.linked += 1;
    }

    const alternatePaths: string[] = [];
    if (status === "broken" || status === "missing") {
      for (const raw of rawPaths) {
        const base = PathUtils.filename(raw) || raw.split(/[\\/]/).pop() || "";
        for (const alt of suggestAlternatePaths(base, diskFiles)) {
          if (!alternatePaths.includes(alt)) alternatePaths.push(alt);
        }
      }
    }

    if (
      status !== "linked" ||
      typeConflict ||
      hasMismatchTag ||
      hasReviewTag ||
      alternatePaths.length
    ) {
      itemRows.push({
        itemID: item.id,
        key: item.key,
        title: String(title).slice(0, 200),
        itemType,
        status,
        paths,
        accessibleCount: accessible,
        brokenCount: broken,
        typeConflict,
        filenameType,
        conflictPath,
        hasMismatchTag,
        hasReviewTag,
        alternatePaths: alternatePaths.slice(0, 5),
      });
    }
  }

  opts?.onProgress?.({ text: "PDF → öğe eşlemesi…", progress: 78 });
  const pdfRows: BidirPdfRow[] = [];
  let pdfLinked = 0;
  let pdfOrphan = 0;
  for (const f of diskFiles) {
    const key = pathKey(f.path);
    const linked = referenced.has(key);
    if (linked) pdfLinked += 1;
    else pdfOrphan += 1;
    const peers = crossPeerMap.get(key) || [];
    if (!linked || peers.length) {
      pdfRows.push({
        path: f.path,
        file: f.basename,
        status: linked ? "linked" : "orphan",
        size: f.size,
        filenameType: extractFilenameItemTypeTag(f.basename),
        crossFolderPeers: peers,
      });
    }
  }

  const unlinkedLosers = crossFolderUnlinkedLosers(
    crossGroups,
    referenced,
    pathKey,
  );

  const missingForMatch = itemRows
    .filter((r) => r.status === "missing")
    .map((r) => ({
      itemID: r.itemID,
      key: r.key,
      title: r.title,
      itemType: r.itemType,
    }));
  // Also include missing parents that were counted but not pushed? missing always pushed.
  const orphanForMatch = pdfRows
    .filter((r) => r.status === "orphan")
    .map((r) => ({
      path: r.path,
      file: r.file,
      filenameType: r.filenameType,
    }));
  const matchSuggestions = suggestOrphanToMissingMatches(
    missingForMatch,
    orphanForMatch,
  );
  const clearMatches = matchSuggestions.filter((m) => m.clear);

  const payload = {
    kind: "bidirectional" as const,
    generatedAt: new Date().toISOString(),
    roots,
    downloadRoots,
    includeDisinda: includeDisindaPref(),
    items: counts,
    pdfs: {
      scanned: diskFiles.length,
      linked: pdfLinked,
      orphan: pdfOrphan,
      crossFolderGroups: crossGroups.length,
      crossFolderUnlinkedLosers: unlinkedLosers.length,
      downloadFilesScanned: downloadFiles.length,
    },
    matchSuggestions: {
      total: matchSuggestions.length,
      clear: clearMatches.length,
      weak: matchSuggestions.length - clearMatches.length,
      rows: matchSuggestions.slice(0, 200),
    },
    itemRows,
    pdfRows: pdfRows.filter(
      (r) => r.status === "orphan" || r.crossFolderPeers.length,
    ),
    crossFolderGroups: crossGroups.slice(0, 100).map((g) => ({
      basename: g.basename,
      size: g.size,
      paths: g.paths,
      dirs: g.dirs,
    })),
    crossFolderUnlinkedLosers: unlinkedLosers.slice(0, 500),
  };

  const reportPath = await writeBidirReport(payload);
  const summary: BidirAuditSummary = {
    kind: "bidirectional",
    generatedAt: payload.generatedAt,
    roots,
    reportPath,
    items: counts,
    pdfs: payload.pdfs,
    matchSuggestions: {
      total: matchSuggestions.length,
      clear: clearMatches.length,
      weak: matchSuggestions.length - clearMatches.length,
    },
    samples: {
      typeConflicts: itemRows.filter((r) => r.typeConflict).slice(0, 12),
      broken: itemRows.filter((r) => r.status === "broken").slice(0, 12),
      missing: itemRows.filter((r) => r.status === "missing").slice(0, 12),
      orphans: pdfRows.filter((r) => r.status === "orphan").slice(0, 12),
      crossFolder: payload.crossFolderGroups.slice(0, 8),
      clearMatches: clearMatches.slice(0, 12),
    },
  };

  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: 10000,
  });
  progress
    .createLine({
      text:
        `İki uçlu: öğe L${counts.linked}/B${counts.broken}/M${counts.missing}` +
        ` · tür≠${counts.typeConflict}` +
        ` · PDF orphan ${pdfOrphan}` +
        ` · eşleşme ${clearMatches.length}/${matchSuggestions.length}` +
        ` · çapraz ${crossGroups.length}` +
        (reportPath ? ` → ${PathUtils.filename(reportPath)}` : ""),
      type: "success",
      progress: 100,
    })
    .show();
  return summary;
}

export async function openLastBidirectionalReport(): Promise<void> {
  const dir = await resolveReportDir();
  const last = PathUtils.join(dir, "last-bidirectional.json");
  if (!(await IOUtils.exists(last).catch(() => false))) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 5000 })
      .createLine({
        text: "Önce «İki uçlu denetim Tara» çalıştırın",
        type: "fail",
      })
      .show();
    return;
  }
  try {
    await Zotero.launchFile?.(last);
  } catch {
    try {
      (Zotero as any).FileLauncher?.launch?.(last);
    } catch (e) {
      ztoolkit.log("openLastBidirectionalReport failed", e);
    }
  }
}

export async function applyBidirectionalSuggestions(opts?: {
  onProgress?: (p: { text: string; progress?: number }) => void;
  skipConfirm?: boolean;
  clearOnly?: boolean;
}): Promise<{
  dryRun: boolean;
  linked: number;
  quarantined: number;
  planned: number;
  failed: number;
  detail?: string;
}> {
  const dryRun = isDiskAuditDryRun();
  const dir = await resolveReportDir();
  const last = PathUtils.join(dir, "last-bidirectional.json");
  if (!(await IOUtils.exists(last).catch(() => false))) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 5000 })
      .createLine({
        text: "Önce «İki uçlu denetim Tara» çalıştırın",
        type: "fail",
      })
      .show();
    return {
      dryRun,
      linked: 0,
      quarantined: 0,
      planned: 0,
      failed: 1,
      detail: "no-report",
    };
  }
  let report: any = null;
  try {
    const raw = await IOUtils.readUTF8(last);
    report = JSON.parse(raw);
  } catch (e) {
    ztoolkit.log("applyBidirectionalSuggestions read failed", e);
    return {
      dryRun,
      linked: 0,
      quarantined: 0,
      planned: 0,
      failed: 1,
      detail: "bad-report",
    };
  }
  const rows = (
    (report?.matchSuggestions?.rows as BidirMatchSuggestion[]) || []
  ).filter((r) => r && r.kind === "orphan_to_missing");
  const targets =
    opts?.clearOnly !== false ? rows.filter((r) => r.clear) : rows;
  const losers: string[] = report?.crossFolderUnlinkedLosers || [];

  if (!targets.length && !losers.length) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 5000 })
      .createLine({
        text: "Uygulanacak net eşleşme / çapraz kopya yok",
        type: "default",
      })
      .show();
    return {
      dryRun,
      linked: 0,
      quarantined: 0,
      planned: 0,
      failed: 0,
      detail: "empty",
    };
  }

  const msg = dryRun
    ? `${targets.length} net eşleşme + ${losers.length} çapraz kopya için PLAN yazılsın mı?`
    : `${targets.length} kayıtsız PDF ilgili öğeye bağlansın ve ${losers.length} çapraz kopya karantinaya alınsın mı?`;
  if (!opts?.skipConfirm) {
    const ok =
      typeof Services !== "undefined"
        ? (Services as any).prompt.confirm(null, config.addonName, msg)
        : confirm(msg);
    if (!ok) {
      return {
        dryRun,
        linked: 0,
        quarantined: 0,
        planned: 0,
        failed: 0,
        detail: "cancelled",
      };
    }
  }

  let linked = 0;
  let quarantined = 0;
  let planned = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    opts?.onProgress?.({
      text: `Eşleştir ${i + 1}/${targets.length}`,
      progress: Math.round((70 * i) / Math.max(1, targets.length)),
    });
    try {
      if (!(await IOUtils.exists(row.pdfPath))) {
        failed += 1;
        continue;
      }
      const item = await Zotero.Items.getAsync(row.itemID);
      if (!item || item.deleted || !item.isRegularItem?.()) {
        failed += 1;
        continue;
      }
      // Skip if parent already has an accessible PDF.
      let hasPdf = false;
      for (const cid of item.getAttachments?.() || []) {
        const att = await Zotero.Items.getAsync(cid);
        if (!att?.isFileAttachment?.()) continue;
        const p = await att.getFilePathAsync?.().catch(() => "");
        if (p && (await IOUtils.exists(p).catch(() => false))) {
          hasPdf = true;
          break;
        }
      }
      if (hasPdf) {
        failed += 1;
        continue;
      }
      if (dryRun) {
        planned += 1;
        continue;
      }
      await Zotero.Attachments.linkFromFile({
        file: row.pdfPath,
        parentItemID: item.id,
      });
      linked += 1;
    } catch (e) {
      ztoolkit.log("bidir link failed", row, e);
      failed += 1;
    }
    if (i % 5 === 0) await Zotero.Promise.delay(0);
  }

  for (let i = 0; i < losers.length; i++) {
    const p = losers[i];
    opts?.onProgress?.({
      text: `Karantina ${i + 1}/${losers.length}`,
      progress: 70 + Math.round((25 * i) / Math.max(1, losers.length)),
    });
    const moved = await movePathToQuarantine(p, "copies", dryRun);
    if (moved.ok && moved.planned) planned += 1;
    else if (moved.ok) quarantined += 1;
    else failed += 1;
  }

  try {
    await writeBidirReport({
      kind: "bidirectional-apply",
      generatedAt: new Date().toISOString(),
      dryRun,
      linked,
      quarantined,
      planned,
      failed,
      targets,
      losers,
    });
  } catch {
    /* ignore */
  }

  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 8000 })
    .createLine({
      text: dryRun
        ? `Plan: ${planned} işlem`
        : `Çözüldü: ${linked} bağlandı, ${quarantined} karantina, ${failed} hata`,
      type: failed && !linked && !quarantined ? "fail" : "success",
    })
    .show();
  return { dryRun, linked, quarantined, planned, failed };
}

export async function runBidirectionalApplyWithProgress(): Promise<void> {
  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  });
  progress
    .createLine({
      text: "İki uçlu öneriler uygulanıyor…",
      type: "default",
      progress: 5,
    })
    .show();
  try {
    await applyBidirectionalSuggestions({
      onProgress: (p) => {
        try {
          progress.changeLine({ text: p.text, progress: p.progress ?? 50 });
        } catch {
          /* ignore */
        }
      },
    });
  } finally {
    progress.close();
  }
}

export async function runBidirectionalAuditWithProgress(): Promise<BidirAuditSummary> {
  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  });
  progress
    .createLine({
      text: "İki uçlu PDF denetimi…",
      type: "default",
      progress: 5,
    })
    .show();
  try {
    const summary = await runBidirectionalAudit({
      onProgress: (p) => {
        try {
          progress.changeLine({
            text: p.text,
            progress: p.progress ?? 50,
          });
        } catch {
          /* ignore */
        }
      },
    });
    progress.close();
    return summary;
  } catch (e) {
    ztoolkit.log("runBidirectionalAudit failed", e);
    try {
      progress.changeLine({
        text: `İki uçlu denetim hata: ${String(e).slice(0, 120)}`,
        type: "fail",
        progress: 100,
      });
    } catch {
      /* ignore */
    }
    progress.close();
    throw e;
  }
}
