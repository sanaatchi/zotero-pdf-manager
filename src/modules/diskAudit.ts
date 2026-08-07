// @ajan: cursor · @etiket: katman-2, disk-audit, orphan, name-content, multi-attach, apply
/**
 * Prefs «Disk / ek denetimi» — scan (report) + apply (quarantine / rename / ID create).
 */
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { readJsonOrQuarantine, writeJsonAtomic } from "../utils/atomicJson";
import { classifyOrphanTree } from "./attachmentScanner";
import { getWatchRoots, DEFAULT_WATCH_ROOT, IndexedFile } from "./folderIndex";
import { parseFilenameMetadata, yokThesisNumber } from "./filenameMetadata";
import { validateContentViaBridge } from "./oaPdfBridge";
import {
  extractDocumentIdentifiers,
  processOrphanPDFs,
  shouldAutoCreateOrphan,
} from "./orphanProcessor";

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
  dryRun: boolean;
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
  apply?: DiskAuditApplyResult;
}

export interface DiskAuditApplyResult {
  kind: DiskAuditKind;
  dryRun: boolean;
  created?: number;
  quarantined?: number;
  renamed?: number;
  detached?: number;
  failed?: number;
  planned?: number;
  detail?: string;
}

function reportKindFile(kind: DiskAuditKind): string {
  if (kind === "nameContent") return "name-content";
  return kind;
}

export function isDiskAuditDryRun(): boolean {
  return getPref("pdf.diskAudit.dryRun") !== false;
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
  try {
    await writeJsonAtomic(PathUtils.join(dir, `last-${kind}.json`), {
      reportPath: path,
      kind,
      savedAt: new Date().toISOString(),
    });
  } catch (e) {
    ztoolkit.log("diskAudit last-pointer write failed", e);
  }
  return path;
}

export async function getLastDiskAuditReportPath(
  kind: DiskAuditKind,
): Promise<string> {
  const dir = await resolveReportDir();
  if (!dir) return "";
  const pointer = PathUtils.join(dir, `last-${reportKindFile(kind)}.json`);
  try {
    const parsed = (await readJsonOrQuarantine(pointer)) as {
      reportPath?: string;
    } | null;
    const path = String(parsed?.reportPath || "").trim();
    if (path && (await IOUtils.exists(path))) return path;
  } catch {
    /* fall through */
  }
  return "";
}

export async function openLastDiskAuditReport(
  kind: DiskAuditKind,
): Promise<boolean> {
  const path = await getLastDiskAuditReportPath(kind);
  if (!path) {
    showProgress("Henüz rapor yok — önce Tara’ya basın");
    return false;
  }
  try {
    if (typeof (Zotero.File as any)?.reveal === "function") {
      await (Zotero.File as any).reveal(path);
      return true;
    }
  } catch (e) {
    ztoolkit.log("File.reveal failed", e);
  }
  try {
    const uri =
      typeof (Zotero.File as any)?.pathToFileURI === "function"
        ? (Zotero.File as any).pathToFileURI(path)
        : `file:///${String(path).replace(/\\/g, "/")}`;
    (Zotero as any).launchURL?.(uri);
    return true;
  } catch (e) {
    ztoolkit.log("launchURL failed", e);
    showProgress(`Rapor: ${path}`);
    return false;
  }
}

export async function resolveQuarantineDir(
  sub: "orphans" | "copies",
): Promise<string> {
  const pref = String(getPref("pdf.diskAudit.quarantineDir") || "").trim();
  let base = pref;
  if (!base) {
    const roots = getWatchRoots();
    const root = (roots[0] || DEFAULT_WATCH_ROOT || "").replace(/[\\/]+$/, "");
    base = root
      ? PathUtils.join(root, "_pdf_quarantine")
      : PathUtils.join(defaultKaynaklarPath(), "..", "_pdf_quarantine");
  }
  const dir = PathUtils.join(base, sub);
  if (!(await IOUtils.exists(dir))) {
    await IOUtils.makeDirectory(dir, { createAncestors: true });
  }
  return dir;
}

async function uniqueDest(dir: string, filename: string): Promise<string> {
  let dest = PathUtils.join(dir, filename);
  if (!(await IOUtils.exists(dest))) return dest;
  const stem = filename.replace(/\.pdf$/i, "");
  for (let i = 1; i < 1000; i++) {
    dest = PathUtils.join(dir, `${stem} (${i}).pdf`);
    if (!(await IOUtils.exists(dest))) return dest;
  }
  return PathUtils.join(dir, `${stem}-${Date.now()}.pdf`);
}

export async function movePathToQuarantine(
  src: string,
  sub: "orphans" | "copies",
  dryRun: boolean,
): Promise<{ ok: boolean; dest?: string; planned?: boolean; error?: string }> {
  try {
    if (!(await IOUtils.exists(src))) {
      return { ok: false, error: "missing" };
    }
    const dir = await resolveQuarantineDir(sub);
    const dest = await uniqueDest(dir, PathUtils.filename(src));
    if (dryRun) return { ok: true, dest, planned: true };
    await IOUtils.move(src, dest);
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

function toIndexedFile(path: string): IndexedFile {
  const filename = PathUtils.filename(path);
  const name = filename.replace(/\.pdf$/i, "");
  const norm = name
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase();
  const alnum = norm.replace(/[^a-z0-9]/gi, "");
  return { path, mtime: 0, name, norm, alnum };
}

async function peekAnchors(path: string): Promise<{
  doi: string;
  isbn: string;
  thesisNumber: string;
}> {
  const name = PathUtils.filename(path);
  const thesisNumber = yokThesisNumber(name) || "";
  const meta = parseFilenameMetadata(name);
  let doi = String(meta.doi || "");
  let isbn = String(meta.isbn || "");
  try {
    const bytes = (await IOUtils.read(path, {
      maxBytes: 2 * 1024 * 1024,
    })) as Uint8Array;
    const text = new TextDecoder("latin1").decode(bytes);
    const ids = extractDocumentIdentifiers(text);
    if (ids.doi) doi = ids.doi;
    if (ids.isbn) isbn = ids.isbn;
  } catch {
    /* ignore */
  }
  return { doi, isbn, thesisNumber };
}

function confirmApply(message: string): boolean {
  try {
    const win = (Zotero as any).getMainWindow?.() || null;
    if (win?.confirm) return !!win.confirm(message);
  } catch {
    /* ignore */
  }
  return true;
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

export async function applyOrphanRemediation(opts?: {
  onProgress?: (p: DiskAuditProgress) => void;
  skipConfirm?: boolean;
}): Promise<DiskAuditApplyResult> {
  const dryRun = isDiskAuditDryRun();
  const reportPath = await getLastDiskAuditReportPath("orphan");
  if (!reportPath) {
    showProgress("Önce «Tara (rapor)» çalıştırın");
    return {
      kind: "orphan",
      dryRun,
      failed: 1,
      detail: "no-report",
    };
  }
  const report = (await readJsonOrQuarantine(reportPath)) as {
    orphanFiles?: string[];
  } | null;
  const orphans = Array.isArray(report?.orphanFiles)
    ? report!.orphanFiles!.filter((p) => typeof p === "string")
    : [];
  if (!orphans.length) {
    showProgress("Raporda kayıtsız PDF yok");
    return { kind: "orphan", dryRun, created: 0, quarantined: 0 };
  }
  if (
    !opts?.skipConfirm &&
    !confirmApply(
      dryRun
        ? `${orphans.length} kayıtsız PDF için PLAN yazılsın mı?\n(Deneme açık — dosya taşınmaz.)`
        : `${orphans.length} kayıtsız PDF çözülsün mü?\nDOI/ISBN/YÖK → Zotero öğesi; kalanlar karantinaya taşınır.`,
    )
  ) {
    return { kind: "orphan", dryRun, detail: "cancelled" };
  }

  const withId: IndexedFile[] = [];
  const withoutId: string[] = [];
  for (let i = 0; i < orphans.length; i++) {
    const path = orphans[i];
    opts?.onProgress?.({
      text: `Anchors ${i + 1}/${orphans.length}`,
      progress: Math.round((40 * i) / Math.max(1, orphans.length)),
    });
    const anchors = await peekAnchors(path);
    if (
      shouldAutoCreateOrphan("autoCreate", "automatic", {
        doi: anchors.doi,
        isbn: anchors.isbn,
        thesisNumber: anchors.thesisNumber || undefined,
      })
    ) {
      withId.push(toIndexedFile(path));
    } else {
      withoutId.push(path);
    }
    if (i % 10 === 0) await Zotero.Promise.delay(0);
  }

  let created = 0;
  let planned = 0;
  let failed = 0;
  if (withId.length) {
    const libraryID = Zotero.Libraries.userLibraryID;
    const stats = await processOrphanPDFs(
      withId,
      new Set(),
      libraryID,
      "autoCreate",
      Math.min(100, withId.length),
      dryRun,
      "disk-audit-orphan",
      "automatic",
    );
    created = stats.created;
    planned += stats.planned;
    failed += stats.failed;
  }

  let quarantined = 0;
  for (let i = 0; i < withoutId.length; i++) {
    const path = withoutId[i];
    opts?.onProgress?.({
      text: `Quarantine ${i + 1}/${withoutId.length}`,
      progress: Math.round(50 + (45 * i) / Math.max(1, withoutId.length)),
    });
    const moved = await movePathToQuarantine(path, "orphans", dryRun);
    if (moved.ok && moved.planned) planned += 1;
    else if (moved.ok) quarantined += 1;
    else failed += 1;
  }

  const applyResult: DiskAuditApplyResult = {
    kind: "orphan",
    dryRun,
    created,
    quarantined,
    planned,
    failed,
  };
  try {
    await writeReport("orphan-apply", {
      ...applyResult,
      generatedAt: new Date().toISOString(),
      sourceReport: reportPath,
      withId: withId.map((f) => f.path),
      withoutId,
    });
  } catch {
    /* ignore */
  }
  showProgress(
    dryRun
      ? `Orphan plan: create ${withId.length}, quarantine ${withoutId.length}`
      : `Orphan fix: created ${created}, quarantined ${quarantined}, failed ${failed}`,
    8000,
  );
  return applyResult;
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

export async function applyNameContentRenames(opts?: {
  onProgress?: (p: DiskAuditProgress) => void;
  skipConfirm?: boolean;
}): Promise<DiskAuditApplyResult> {
  const dryRun = isDiskAuditDryRun();
  const reportPath = await getLastDiskAuditReportPath("nameContent");
  if (!reportPath) {
    showProgress("Önce «Ad ↔ içerik Tara» çalıştırın");
    return { kind: "nameContent", dryRun, failed: 1, detail: "no-report" };
  }
  const report = (await readJsonOrQuarantine(reportPath)) as {
    clear_mismatch?: Array<{
      path?: string;
      proposed_rename?: string | null;
      clear_mismatch?: boolean;
    }>;
  } | null;
  const rows = (report?.clear_mismatch || []).filter(
    (r) => r?.path && r?.proposed_rename && r.clear_mismatch !== false,
  );
  if (!rows.length) {
    showProgress("Uygulanacak yeniden adlandırma yok");
    return { kind: "nameContent", dryRun, renamed: 0 };
  }
  if (
    !opts?.skipConfirm &&
    !confirmApply(
      dryRun
        ? `${rows.length} dosya için YENİDEN ADLANDIRMA PLANI yazılsın mı?`
        : `${rows.length} dosya yeniden adlandırılsın mı? (clear_mismatch)`,
    )
  ) {
    return { kind: "nameContent", dryRun, detail: "cancelled" };
  }

  let renamed = 0;
  let planned = 0;
  let failed = 0;
  const applied: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const src = String(row.path);
    const newName = String(row.proposed_rename);
    opts?.onProgress?.({
      text: `Rename ${i + 1}/${rows.length}`,
      progress: Math.round((90 * i) / Math.max(1, rows.length)),
    });
    try {
      if (!(await IOUtils.exists(src))) {
        failed += 1;
        continue;
      }
      const parent = PathUtils.parent(src);
      const dest = PathUtils.join(parent, newName);
      if (
        (await IOUtils.exists(dest)) &&
        dest.toLowerCase() !== src.toLowerCase()
      ) {
        failed += 1;
        continue;
      }
      if (dryRun) {
        planned += 1;
        applied.push({ from: src, to: dest });
        continue;
      }
      if (dest.toLowerCase() !== src.toLowerCase()) {
        await IOUtils.move(src, dest);
      }
      await relinkAttachmentPath(src, dest);
      renamed += 1;
      applied.push({ from: src, to: dest });
    } catch {
      failed += 1;
    }
    if (i % 5 === 0) await Zotero.Promise.delay(0);
  }

  const applyResult: DiskAuditApplyResult = {
    kind: "nameContent",
    dryRun,
    renamed,
    planned,
    failed,
  };
  try {
    await writeReport("name-content-apply", {
      ...applyResult,
      generatedAt: new Date().toISOString(),
      sourceReport: reportPath,
      applied,
    });
  } catch {
    /* ignore */
  }
  showProgress(
    dryRun
      ? `Rename plan: ${planned} file(s)`
      : `Renamed ${renamed}, failed ${failed}`,
    8000,
  );
  return applyResult;
}

async function relinkAttachmentPath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  const oldKey = PathUtils.normalize(oldPath).normalize("NFC").toLowerCase();
  try {
    const rows =
      (await Zotero.DB.queryAsync(
        `SELECT itemID FROM items WHERE itemTypeID=${Zotero.ItemTypes.getID("attachment")} ` +
          `AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
      )) || [];
    for (const row of rows) {
      const attachment = await Zotero.Items.getAsync(row.itemID);
      if (!attachment?.isFileAttachment?.()) continue;
      const path = await attachment.getFilePathAsync().catch(() => "");
      if (!path) continue;
      const key = PathUtils.normalize(path).normalize("NFC").toLowerCase();
      if (key !== oldKey) continue;
      try {
        if (typeof (attachment as any).attachmentPath !== "undefined") {
          // Linked attachments: set path relative to base when possible.
          (attachment as any).attachmentPath = newPath;
          await attachment.saveTx();
        }
      } catch (e) {
        ztoolkit.log("relinkAttachmentPath failed", e);
      }
    }
  } catch (e) {
    ztoolkit.log("relinkAttachmentPath scan failed", e);
  }
}

export async function listMultiAttachParents(limit = 50): Promise<{
  count: number;
  samples: Array<{
    parentKey: string;
    parentTitle: string;
    pdfCount: number;
    paths: string[];
    attachments: Array<{
      id: number;
      key: string;
      path: string;
      size: number;
    }>;
  }>;
}> {
  const samples: Array<{
    parentKey: string;
    parentTitle: string;
    pdfCount: number;
    paths: string[];
    attachments: Array<{
      id: number;
      key: string;
      path: string;
      size: number;
    }>;
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
      const attachments: Array<{
        id: number;
        key: string;
        path: string;
        size: number;
      }> = [];
      for (const cid of children) {
        const att = await Zotero.Items.getAsync(cid);
        if (!att || att.deleted) continue;
        const ct = String(att.attachmentContentType || "").toLowerCase();
        const path =
          (await att.getFilePathAsync?.().catch(() => "")) ||
          String(att.attachmentPath || "");
        if (!(ct.includes("pdf") || /\.pdf$/i.test(path))) continue;
        let size = 0;
        if (path) {
          try {
            size = Number((await IOUtils.stat(path))?.size || 0);
          } catch {
            size = 0;
          }
        }
        attachments.push({
          id: att.id,
          key: att.key,
          path: path || "",
          size,
        });
      }
      if (attachments.length >= 2) {
        count += 1;
        if (samples.length < limit) {
          samples.push({
            parentKey: parent.key,
            parentTitle:
              parent.getDisplayTitle?.() || parent.getField?.("title") || "",
            pdfCount: attachments.length,
            paths: attachments.map((a) => a.path || a.key),
            attachments,
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
    unlinkedPaths: string[];
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
          unlinkedPaths: unlinked.slice(0, 200),
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

export async function applyCopyQuarantine(opts?: {
  onProgress?: (p: DiskAuditProgress) => void;
  skipConfirm?: boolean;
}): Promise<DiskAuditApplyResult> {
  const dryRun = isDiskAuditDryRun();
  const reportPath = await getLastDiskAuditReportPath("copy");
  if (!reportPath) {
    showProgress("Önce «Yinelenen PDF Tara» çalıştırın");
    return { kind: "copy", dryRun, failed: 1, detail: "no-report" };
  }
  const report = (await readJsonOrQuarantine(reportPath)) as {
    multiAttach?: {
      samples?: Array<{
        attachments?: Array<{
          id: number;
          path: string;
          size: number;
        }>;
      }>;
    };
    diskSibling?: {
      samples?: Array<{ unlinkedPaths?: string[]; unlinkedSamples?: string[] }>;
    };
  } | null;

  const siblingLosers: string[] = [];
  for (const folder of report?.diskSibling?.samples || []) {
    const paths = folder.unlinkedPaths?.length
      ? folder.unlinkedPaths
      : folder.unlinkedSamples || [];
    for (const p of paths) if (p) siblingLosers.push(p);
  }

  type Att = { id: number; path: string; size: number };
  const multiLosers: Att[] = [];
  for (const sample of report?.multiAttach?.samples || []) {
    const atts = (sample.attachments || []).filter((a) => a && a.id);
    if (atts.length < 2) continue;
    const sorted = [...atts].sort((a, b) => (b.size || 0) - (a.size || 0));
    for (const loser of sorted.slice(1)) multiLosers.push(loser);
  }

  const total = siblingLosers.length + multiLosers.length;
  if (!total) {
    showProgress("Karantinaya alınacak kopya yok");
    return { kind: "copy", dryRun, quarantined: 0, detached: 0 };
  }
  if (
    !opts?.skipConfirm &&
    !confirmApply(
      dryRun
        ? `${total} kopya için KARANTİNA PLANI yazılsın mı?`
        : `${total} kopya _pdf_quarantine/copies altına taşınsın mı? (silinmez)`,
    )
  ) {
    return { kind: "copy", dryRun, detail: "cancelled" };
  }

  let quarantined = 0;
  let planned = 0;
  let detached = 0;
  let failed = 0;
  const detachLoser = getPref("pdf.diskAudit.copyDetachLoser") !== false;
  const moveDisk = getPref("pdf.diskAudit.copyMoveDiskLoser") !== false;

  for (let i = 0; i < siblingLosers.length; i++) {
    const path = siblingLosers[i];
    opts?.onProgress?.({
      text: `Sibling ${i + 1}/${siblingLosers.length}`,
      progress: Math.round((40 * i) / Math.max(1, siblingLosers.length)),
    });
    const moved = await movePathToQuarantine(path, "copies", dryRun);
    if (moved.ok && moved.planned) planned += 1;
    else if (moved.ok) quarantined += 1;
    else failed += 1;
  }

  for (let i = 0; i < multiLosers.length; i++) {
    const loser = multiLosers[i];
    opts?.onProgress?.({
      text: `Multi-attach ${i + 1}/${multiLosers.length}`,
      progress: Math.round(45 + (50 * i) / Math.max(1, multiLosers.length)),
    });
    try {
      if (moveDisk && loser.path) {
        const moved = await movePathToQuarantine(loser.path, "copies", dryRun);
        if (moved.ok && moved.planned) planned += 1;
        else if (moved.ok) quarantined += 1;
        else if (!moved.planned) failed += 1;
      }
      if (detachLoser && !dryRun) {
        const att = await Zotero.Items.getAsync(loser.id);
        if (att && !att.deleted) {
          await Zotero.Items.trashTx(att.id);
          detached += 1;
        }
      } else if (detachLoser && dryRun) {
        planned += 1;
      }
    } catch {
      failed += 1;
    }
  }

  const applyResult: DiskAuditApplyResult = {
    kind: "copy",
    dryRun,
    quarantined,
    detached,
    planned,
    failed,
  };
  try {
    await writeReport("copy-apply", {
      ...applyResult,
      generatedAt: new Date().toISOString(),
      sourceReport: reportPath,
      siblingLosers,
      multiLosers,
    });
  } catch {
    /* ignore */
  }
  showProgress(
    dryRun
      ? `Copy plan: ${total} action(s)`
      : `Copy fix: quarantined ${quarantined}, detached ${detached}, failed ${failed}`,
    8000,
  );
  return applyResult;
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
      text: `Disk audit (${kind})…`,
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
      dryRun: isDiskAuditDryRun(),
      roots: [],
      reportPath: "",
      error: String((e as Error)?.message || e),
    };
  }
}

export async function runDiskAuditApplyWithProgress(
  kind: DiskAuditKind,
): Promise<DiskAuditApplyResult> {
  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  });
  progress
    .createLine({
      text: `Disk fix (${kind})…`,
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
    let result: DiskAuditApplyResult;
    if (kind === "orphan")
      result = await applyOrphanRemediation({ onProgress });
    else if (kind === "nameContent")
      result = await applyNameContentRenames({ onProgress });
    else result = await applyCopyQuarantine({ onProgress });
    progress.changeLine({
      text: summarizeApply(result),
      type: result.detail === "cancelled" ? "default" : "success",
      progress: 100,
      idx: 0,
    });
    progress.startCloseTimer(7000);
    return result;
  } catch (e) {
    ztoolkit.log("diskAudit apply failed", e);
    progress.changeLine({
      text: `Disk fix failed: ${String((e as Error)?.message || e)}`,
      type: "fail",
      progress: 100,
      idx: 0,
    });
    progress.startCloseTimer(8000);
    return {
      kind,
      dryRun: isDiskAuditDryRun(),
      failed: 1,
      detail: String((e as Error)?.message || e),
    };
  }
}

function summarizeLine(s: DiskAuditSummary): string {
  if (s.kind === "orphan")
    return `Orphans: ${s.orphanCount ?? 0} — next: Open report → Fix`;
  if (s.kind === "nameContent") {
    const n = s.nameContent;
    return `Name↔content: clear_mismatch ${n?.clearMismatch ?? 0} / ${n?.scanned ?? 0} — next: Fix`;
  }
  return `Copy: multi-attach ${s.multiAttachParents ?? 0}, siblings ${s.siblingFolders ?? 0} — next: Fix`;
}

function summarizeApply(r: DiskAuditApplyResult): string {
  if (r.detail === "cancelled") return "Fix cancelled";
  if (r.detail === "no-report") return "No report — scan first";
  if (r.dryRun) {
    return `Plan recorded (dry-run): created ${r.created ?? 0}, quarantine ${r.quarantined ?? 0}, rename ${r.renamed ?? 0}, planned ${r.planned ?? 0}`;
  }
  return `Done: created ${r.created ?? 0}, quarantined ${r.quarantined ?? 0}, renamed ${r.renamed ?? 0}, detached ${r.detached ?? 0}, failed ${r.failed ?? 0}`;
}
