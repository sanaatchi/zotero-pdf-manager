// @ajan: cursor · @etiket: katman-2, bidirectional-audit, item-pdf-cross, type-mismatch, match-suggest, apply, hash-verify, broken-repair, pathutils-safe, human-md-report
/**
 * Unified two-ended PDF control report:
 *   item → PDF  (linked / broken / missing / type conflict / mismatch tags)
 *   PDF  → item (linked / orphan / cross-folder same basename+size)
 *
 * Reuses diskAudit helpers for roots, type tags, and cross-folder grouping.
 * Structural only (no per-file content bridge) — fast enough for full Kaynaklar.
 * JSON is machine-facing; last-bidirectional.md is the human summary.
 */
import { config } from "../../package.json";
import { writeJsonAtomic, writeUtf8Atomic } from "../utils/atomicJson";
import {
  CrossFolderFile,
  crossFolderUnlinkedLosers,
  extractFilenameItemTypeTag,
  filenameItemTypeMismatch,
  filterHashVerifiedLosers,
  groupCrossFolderDuplicates,
  isDiskAuditDryRun,
  isUnderDisinda,
  movePathToQuarantine,
  normalizeDiskAuditRoots,
  sameDirLinkedKeepers,
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

/**
 * PathUtils.filename/normalize throw NS_ERROR_FILE_UNRECOGNIZED_PATH on
 * empty, relative, or ``attachments:…`` strings. Never call them raw.
 */
export function safeFilename(path: string): string {
  const raw = String(path || "").trim();
  if (!raw) return "";
  try {
    // Strip Zotero linked-attachment prefix before PathUtils.
    const stripped = raw.replace(/^attachments:/i, "");
    if (/^[a-zA-Z]:[\\/]/.test(stripped) || stripped.startsWith("\\\\")) {
      return String(PathUtils.filename(stripped) || "");
    }
  } catch {
    /* fall through */
  }
  const parts = raw.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || raw;
}

export function safePathKey(p: string): string {
  const raw = String(p || "").trim();
  if (!raw) return "";
  try {
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
      return PathUtils.normalize(raw).normalize("NFC").toLowerCase();
    }
  } catch {
    /* fall through */
  }
  return raw.normalize("NFC").toLowerCase().replace(/\\/g, "/");
}

export function safeParent(path: string): string | null {
  const raw = String(path || "").trim();
  if (!raw) return null;
  try {
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
      return PathUtils.parent?.(raw) || null;
    }
  } catch {
    /* fall through */
  }
  const norm = raw.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : null;
}

function pathKey(p: string): string {
  return safePathKey(p);
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

/** True when path sits under quarantine (warn in human summary). */
export function pathLooksQuarantined(p: string): boolean {
  return /_pdf_quarantine/i.test(String(p || ""));
}

function mdEsc(s: string): string {
  return String(s || "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * Pure: Turkish Markdown summary from a bidirectional JSON payload.
 * Keeps JSON for machines; humans open this text.
 */
export function formatBidirectionalMarkdown(payload: any): string {
  const generatedAt = String(payload?.generatedAt || new Date().toISOString());
  const items = payload?.items || {};
  const pdfs = payload?.pdfs || {};
  const hash = payload?.hashVerify || {};
  const matchMeta = payload?.matchSuggestions || {};
  const rows: BidirMatchSuggestion[] = Array.isArray(matchMeta.rows)
    ? matchMeta.rows
    : [];
  const clear = rows.filter((r) => r && r.clear);
  const weak = rows.filter((r) => r && !r.clear);
  const clearCount = Number(matchMeta.clear ?? clear.length) || 0;
  const weakCount =
    Number(matchMeta.weak ?? weak.length) ||
    Math.max(0, rows.length - clear.length);
  const brokenSamples: any[] = Array.isArray(payload?.itemRows)
    ? payload.itemRows.filter((r: any) => r?.status === "broken").slice(0, 8)
    : [];
  const missingSamples: any[] = Array.isArray(payload?.itemRows)
    ? payload.itemRows.filter((r: any) => r?.status === "missing").slice(0, 8)
    : [];
  const orphanSamples: any[] = Array.isArray(payload?.pdfRows)
    ? payload.pdfRows.filter((r: any) => r?.status === "orphan").slice(0, 8)
    : [];
  const roots = Array.isArray(payload?.roots) ? payload.roots : [];

  const lines: string[] = [];
  lines.push("# İki uçlu PDF denetimi — özet");
  lines.push("");
  lines.push(`Oluşturulma: \`${generatedAt}\``);
  if (roots.length) {
    lines.push(`Kökler: ${roots.map((r: string) => `\`${r}\``).join(", ")}`);
  }
  lines.push("");
  lines.push("> Makine raporu: `last-bidirectional.json` (aynı klasör).");
  lines.push("");
  lines.push("## Özet sayılar");
  lines.push("");
  lines.push("| Metrik | Sayı |");
  lines.push("| --- | ---: |");
  lines.push(`| Öğeler tarandı | ${Number(items.scanned) || 0} |`);
  lines.push(`| Bağlı (linked) | ${Number(items.linked) || 0} |`);
  lines.push(`| Kırık (broken) | ${Number(items.broken) || 0} |`);
  lines.push(`| PDF’siz (missing) | ${Number(items.missing) || 0} |`);
  lines.push(`| Çoklu ek (multi) | ${Number(items.multi) || 0} |`);
  lines.push(`| Tür çatışması | ${Number(items.typeConflict) || 0} |`);
  lines.push(`| PDF orphan | ${Number(pdfs.orphan) || 0} |`);
  lines.push(
    `| Çapraz klasör grubu | ${Number(pdfs.crossFolderGroups) || 0} |`,
  );
  lines.push(
    `| Çapraz kopya (unlinked) | ${Number(pdfs.crossFolderUnlinkedLosers) || 0} |`,
  );
  lines.push(`| Net eşleşme (clear) | ${clearCount} |`);
  lines.push(`| Zayıf öneri (weak) | ${weakCount} |`);
  lines.push("");
  lines.push("## Hash doğrulama");
  lines.push("");
  if (hash.skipped) {
    lines.push(
      `- Hash atlandı / kullanılamadı — ad+boyut adayları tutuldu (aday ${Number(hash.candidates) || 0}).`,
    );
  } else {
    lines.push(
      `- Aday: **${Number(hash.candidates) || 0}** · doğrulandı: **${Number(hash.verified) || 0}** · reddedildi: **${Number(hash.rejected) || 0}**`,
    );
  }
  lines.push("");
  lines.push("## Net eşleşmeler");
  lines.push("");
  if (!clear.length) {
    lines.push("_Net eşleşme yok._");
  } else {
    lines.push("| Key | Başlık | PDF | Skor | Not |");
    lines.push("| --- | --- | --- | ---: | --- |");
    for (const r of clear.slice(0, 40)) {
      const warn = pathLooksQuarantined(r.pdfPath)
        ? "⚠ `_pdf_quarantine`"
        : r.kind === "orphan_to_broken" || r.kind === "broken_alt_path"
          ? "kırık onarım"
          : "";
      lines.push(
        `| \`${mdEsc(r.itemKey)}\` | ${mdEsc(r.itemTitle).slice(0, 80)} | \`${mdEsc(r.pdfFile || safeFilename(r.pdfPath))}\` | ${r.score} | ${warn} |`,
      );
    }
    if (clear.length > 40) {
      lines.push("");
      lines.push(`_… ve ${clear.length - 40} net eşleşme daha (JSON’da)._`);
    }
  }
  lines.push("");
  lines.push("## Zayıf öneriler (ilk ~10)");
  lines.push("");
  if (!weak.length) {
    lines.push("_Zayıf öneri yok._");
  } else {
    for (const r of weak.slice(0, 10)) {
      const q = pathLooksQuarantined(r.pdfPath) ? " ⚠ quarantine" : "";
      lines.push(
        `- \`${mdEsc(r.itemKey)}\` · ${mdEsc(r.itemTitle).slice(0, 60)} ↔ \`${mdEsc(r.pdfFile || safeFilename(r.pdfPath))}\` (skor ${r.score})${q}`,
      );
    }
    if (weak.length > 10) {
      lines.push(`- _… +${weak.length - 10} zayıf (JSON)._`);
    }
  }
  lines.push("");
  lines.push("## Kırık / missing örnekleri");
  lines.push("");
  if (!brokenSamples.length && !missingSamples.length) {
    lines.push("_Kırık veya PDF’siz örnek yok (veya satırlar raporda yok)._");
  } else {
    if (brokenSamples.length) {
      lines.push("**Kırık ekler:**");
      for (const r of brokenSamples) {
        const p0 =
          Array.isArray(r.paths) && r.paths[0] ? safeFilename(r.paths[0]) : "—";
        lines.push(
          `- \`${mdEsc(r.key)}\` · ${mdEsc(r.title).slice(0, 70)} · \`${mdEsc(p0)}\``,
        );
      }
      lines.push("");
    }
    if (missingSamples.length) {
      lines.push("**PDF’siz öğeler:**");
      for (const r of missingSamples) {
        lines.push(`- \`${mdEsc(r.key)}\` · ${mdEsc(r.title).slice(0, 70)}`);
      }
      lines.push("");
    }
    if (orphanSamples.length) {
      lines.push("**Orphan PDF örnekleri:**");
      for (const r of orphanSamples) {
        lines.push(`- \`${mdEsc(r.file || safeFilename(r.path))}\``);
      }
    }
  }
  lines.push("");
  lines.push("## Ne yapmalı");
  lines.push("");
  const actions: string[] = [];
  if (clearCount > 0) {
    actions.push(
      "Tercihler → **İki uçlu denetim → Çöz**: net eşleşmeleri bağla (gerekirse dry-run açık bırak).",
    );
  }
  if ((Number(pdfs.crossFolderUnlinkedLosers) || 0) > 0) {
    actions.push(
      "Çöz ayrıca hash-doğrulanmış çapraz kopyaları `_pdf_quarantine/copies` altına taşır.",
    );
  }
  if ((Number(items.broken) || 0) > 0 && clearCount === 0) {
    actions.push(
      "Kırık ekler için alternatif yol / orphan eşleşmesi yoksa dosyayı Kaynaklar’da elle kontrol et.",
    );
  }
  if ((Number(items.missing) || 0) > 0 && clearCount === 0) {
    actions.push(
      "PDF’siz öğeler için OA ara veya diskte doğru dosyayı bulup bağla.",
    );
  }
  if (!actions.length) {
    actions.push("Özet temiz görünüyor — ek işlem gerekmeyebilir.");
  }
  actions.push(
    "Ham veri / otomasyon için aynı klasördeki `last-bidirectional.json` dosyasını kullan.",
  );
  for (const a of actions) lines.push(`- ${a}`);
  lines.push("");
  return lines.join("\n");
}

async function writeBidirMarkdown(
  dir: string,
  payload: unknown,
  stampedJsonPath: string,
): Promise<string> {
  const md = formatBidirectionalMarkdown(payload);
  const lastMd = PathUtils.join(dir, "last-bidirectional.md");
  const stampedMd = String(stampedJsonPath || "").replace(/\.json$/i, ".md");
  try {
    await writeUtf8Atomic(lastMd, md);
  } catch (e) {
    ztoolkit.log("writeBidirReport last-bidirectional.md failed", e);
    try {
      await IOUtils.writeUTF8(lastMd, md);
    } catch (e2) {
      ztoolkit.log("writeBidirReport md fallback failed", e2);
    }
  }
  if (stampedMd && stampedMd !== stampedJsonPath) {
    try {
      await writeUtf8Atomic(stampedMd, md);
    } catch (e) {
      ztoolkit.log("writeBidirReport stamped md failed", e);
    }
  }
  return lastMd;
}

async function writeBidirReport(payload: unknown): Promise<string> {
  const dir = await resolveReportDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = PathUtils.join(dir, `disk-audit-bidirectional-${stamp}.json`);
  await writeJsonAtomic(path, payload as any);
  const last = PathUtils.join(dir, "last-bidirectional.json");
  try {
    await writeJsonAtomic(last, payload as any);
  } catch (e) {
    ztoolkit.log("writeBidirReport last-bidirectional failed", last, e);
    // Best-effort copy via UTF8 so openLast still works.
    try {
      const raw = await IOUtils.readUTF8(path);
      await IOUtils.writeUTF8(last, raw);
    } catch (e2) {
      ztoolkit.log("writeBidirReport last fallback failed", e2);
    }
  }
  await writeBidirMarkdown(dir, payload, path);
  return path;
}

async function launchReportFile(target: string): Promise<void> {
  try {
    await Zotero.launchFile?.(target);
    return;
  } catch {
    /* fall through */
  }
  try {
    (Zotero as any).FileLauncher?.launch?.(target);
  } catch (e) {
    ztoolkit.log("launchReportFile failed", target, e);
  }
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
        basename: safeFilename(child),
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
export function basenameSoftVariants(name: string): string[] {
  const n = String(name || "").toLowerCase();
  if (!n) return [];
  const out = [n];
  // downloads often append " 3.pdf" / " 6.pdf"
  const stripped = n.replace(/ \d+(?=\.pdf$)/i, "");
  if (stripped !== n) out.push(stripped);
  return out;
}

export function suggestAlternatePaths(
  brokenBasename: string,
  diskFiles: Array<{ path: string; basename: string }>,
  limit = 5,
): string[] {
  const wants = new Set(basenameSoftVariants(brokenBasename));
  if (!wants.size) return [];
  const hits: string[] = [];
  for (const f of diskFiles) {
    const base = String(f.basename || "").toLowerCase();
    const variants = basenameSoftVariants(base);
    if (![...wants].some((w) => variants.includes(w) || base === w)) continue;
    hits.push(f.path);
    if (hits.length >= limit) break;
  }
  return hits;
}

export function titleTokens(value: string): Set<string> {
  const raw = value || "";
  try {
    return new Set(
      raw
        .normalize("NFKD")
        .replace(/\p{Mark}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  } catch {
    // Some chrome contexts reject Unicode property escapes — ASCII/TR fallback.
    return new Set(
      raw
        .toLowerCase()
        .replace(/[^a-z0-9ğüşıöçâîûäëïöü\s]/gi, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  }
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
  kind: "orphan_to_missing" | "orphan_to_broken" | "broken_alt_path";
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
  itemStatus?: "missing" | "broken";
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
    status?: "missing" | "broken";
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
      try {
        let pdfTitle = String(pdf.file || "").replace(/\.pdf$/i, "");
        try {
          const meta = parseFilenameMetadata(pdf.file);
          pdfTitle = String(meta.title || pdfTitle);
        } catch {
          /* keep stem */
        }
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
        const clear =
          typeOk && detail.shared >= minShared && score >= clearScore;
        all.push({
          kind:
            item.status === "broken" ? "orphan_to_broken" : "orphan_to_missing",
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
          itemStatus: item.status || "missing",
        });
      } catch {
        /* skip bad pair */
      }
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
    const parent = safeParent(root);
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
        const tm = filenameItemTypeMismatch(itemType, safeFilename(resolved));
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
        const base = safeFilename(raw) || raw.split(/[\\/]/).pop() || "";
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
        const base = safeFilename(raw) || raw.split(/[\\/]/).pop() || "";
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
    .filter((r) => r.status === "missing" || r.status === "broken")
    .map((r) => ({
      itemID: r.itemID,
      key: r.key,
      title: r.title,
      itemType: r.itemType,
      status: r.status as "missing" | "broken",
    }));
  const orphanForMatch = pdfRows
    .filter((r) => r.status === "orphan")
    .map((r) => ({
      path: r.path,
      file: r.file,
      filenameType: r.filenameType,
    }));

  let matchSuggestions: BidirMatchSuggestion[] = [];
  let clearMatches: BidirMatchSuggestion[] = [];
  let verifiedLosers = unlinkedLosers.slice();
  let hashRejectedLosers: string[] = [];
  let hashSkipped = false;
  let matchError = "";

  try {
    matchSuggestions = suggestOrphanToMissingMatches(
      missingForMatch,
      orphanForMatch,
    );
    const usedItems = new Set(matchSuggestions.map((m) => m.itemID));
    const usedPdfs = new Set(
      matchSuggestions.map((m) => m.pdfPath.toLowerCase()),
    );
    for (const row of itemRows) {
      if (row.status !== "broken" || !row.alternatePaths.length) continue;
      if (usedItems.has(row.itemID)) continue;
      const alt = row.alternatePaths[0];
      if (!alt || usedPdfs.has(alt.toLowerCase())) continue;
      usedItems.add(row.itemID);
      usedPdfs.add(alt.toLowerCase());
      matchSuggestions.push({
        kind: "broken_alt_path",
        score: 1,
        clear: true,
        itemID: row.itemID,
        itemKey: row.key,
        itemTitle: row.title,
        itemType: row.itemType,
        pdfPath: alt,
        pdfFile: safeFilename(alt),
        filenameType: extractFilenameItemTypeTag(safeFilename(alt)),
        typeOk: true,
        itemStatus: "broken",
      });
    }
    matchSuggestions.sort((a, b) => b.score - a.score);
    clearMatches = matchSuggestions.filter((m) => m.clear);
  } catch (e) {
    matchError = String((e as Error)?.message || e).slice(0, 200);
    ztoolkit.log("bidir matchSuggestions failed", e);
  }

  // Hash verify is best-effort and can be slow; never block the report.
  try {
    if (unlinkedLosers.length) {
      opts?.onProgress?.({
        text: "Çapraz kopyalar hash doğrulanıyor…",
        progress: 90,
      });
      const keepersByLoser = new Map<string, string[]>();
      for (const loser of unlinkedLosers) {
        const keepers: string[] = [];
        for (const g of crossGroups) {
          if (!g.paths.some((p) => pathKey(p) === pathKey(loser))) continue;
          for (const p of g.paths) {
            if (referenced.has(pathKey(p))) keepers.push(p);
          }
        }
        for (const k of await sameDirLinkedKeepers(
          loser,
          referenced,
          pathKey,
        )) {
          if (!keepers.some((x) => pathKey(x) === pathKey(k))) keepers.push(k);
        }
        keepersByLoser.set(loser, keepers);
      }
      const filtered = await filterHashVerifiedLosers(
        unlinkedLosers,
        keepersByLoser,
      );
      verifiedLosers = filtered.verified;
      hashRejectedLosers = filtered.rejected;
      // If every fingerprint failed (crypto unavailable), keep name+size losers.
      if (
        !verifiedLosers.length &&
        hashRejectedLosers.length === unlinkedLosers.length &&
        unlinkedLosers.length > 0
      ) {
        hashSkipped = true;
        verifiedLosers = unlinkedLosers.slice();
        hashRejectedLosers = [];
      }
    }
  } catch (e) {
    hashSkipped = true;
    verifiedLosers = unlinkedLosers.slice();
    ztoolkit.log("bidir hash verify failed — using name+size losers", e);
  }

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
      crossFolderUnlinkedLosers: verifiedLosers.length,
      crossFolderHashRejected: hashRejectedLosers.length,
      downloadFilesScanned: downloadFiles.length,
    },
    hashVerify: {
      candidates: unlinkedLosers.length,
      verified: verifiedLosers.length,
      rejected: hashRejectedLosers.length,
      skipped: hashSkipped,
    },
    matchError: matchError || undefined,
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
    crossFolderUnlinkedLosers: verifiedLosers.slice(0, 500),
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
        ` · özet: last-bidirectional.md`,
      type: "success",
      progress: 100,
    })
    .show();
  return summary;
}

export async function openLastBidirectionalReport(): Promise<void> {
  const dir = await resolveReportDir();
  const lastMd = PathUtils.join(dir, "last-bidirectional.md");
  const lastJson = PathUtils.join(dir, "last-bidirectional.json");
  let jsonTarget = lastJson;
  if (!(await IOUtils.exists(jsonTarget).catch(() => false))) {
    // Fallback: newest stamped report if last- write failed.
    try {
      const kids: string[] = (await IOUtils.getChildren(dir)) || [];
      const stamped = kids
        .filter((p) =>
          /disk-audit-bidirectional-.*\.json$/i.test(safeFilename(p)),
        )
        .sort();
      if (stamped.length) jsonTarget = stamped[stamped.length - 1];
    } catch {
      /* ignore */
    }
  }
  const hasJson = await IOUtils.exists(jsonTarget).catch(() => false);
  if (!hasJson) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 8000 })
      .createLine({
        text:
          "Önce «İki uçlu denetim Tara» çalıştırın" +
          ` · beklenen: ${dir}\\last-bidirectional.md`,
        type: "fail",
      })
      .show();
    return;
  }

  // Prefer human Markdown; regenerate from JSON if missing (pre-1.0.155 reports).
  let mdTarget = lastMd;
  let hasMd = await IOUtils.exists(mdTarget).catch(() => false);
  if (!hasMd) {
    const siblingMd = String(jsonTarget).replace(/\.json$/i, ".md");
    if (
      siblingMd !== jsonTarget &&
      (await IOUtils.exists(siblingMd).catch(() => false))
    ) {
      mdTarget = siblingMd;
      hasMd = true;
    }
  }
  if (!hasMd) {
    try {
      const raw = await IOUtils.readUTF8(jsonTarget);
      const payload = JSON.parse(raw);
      await writeBidirMarkdown(dir, payload, jsonTarget);
      hasMd = await IOUtils.exists(lastMd).catch(() => false);
      if (hasMd) mdTarget = lastMd;
    } catch (e) {
      ztoolkit.log("openLastBidirectionalReport md regenerate failed", e);
    }
  }

  const target = hasMd ? mdTarget : jsonTarget;
  try {
    await launchReportFile(target);
  } catch (e) {
    ztoolkit.log("openLastBidirectionalReport failed", e);
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
  ).filter(
    (r) =>
      r &&
      (r.kind === "orphan_to_missing" ||
        r.kind === "orphan_to_broken" ||
        r.kind === "broken_alt_path"),
  );
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
      // Broken: remove inaccessible PDF attachments, then link Kaynaklar file.
      if (row.kind === "orphan_to_broken" || row.kind === "broken_alt_path") {
        for (const cid of item.getAttachments?.() || []) {
          const att = await Zotero.Items.getAsync(cid);
          if (!att?.isFileAttachment?.()) continue;
          const p = await att.getFilePathAsync?.().catch(() => "");
          const exists = p ? await IOUtils.exists(p).catch(() => false) : false;
          if (!exists) {
            try {
              await Zotero.Items.trashTx(att.id);
            } catch (e) {
              ztoolkit.log("trash broken att failed", e);
            }
          }
        }
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
    // Losers were hash-verified at Tara time (filterHashVerifiedLosers).
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
