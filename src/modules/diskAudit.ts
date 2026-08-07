// @ajan: cursor · @etiket: katman-2, disk-audit, orphan, name-content, multi-attach, apply, path-fold, rename-safe
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
  return DEFAULT_WATCH_ROOT || FALLBACK_KAYNAKLAR;
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
  opts?.onProgress?.({ text: "Kayıtsız PDF taranıyor…", progress: 10 });
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
    // Full list for Çöz — truncating here silently skipped orphans on apply.
    orphanFiles: filtered,
    orphanFilesTruncated: false,
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
    `Kayıtsız PDF raporu: ${filtered.length} dosya` +
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
      text: `Kimlik ${i + 1}/${orphans.length}`,
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
      withId.length,
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
      text: `Karantina ${i + 1}/${withoutId.length}`,
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
      ? `Plan: ${withId.length} kimlikli öğe, ${withoutId.length} karantina`
      : `Çözüldü: ${created} öğe oluşturuldu, ${quarantined} karantinaya, ${failed} hata`,
    8000,
  );
  return applyResult;
}

export async function runNameContentDiskAudit(opts?: {
  onProgress?: (p: DiskAuditProgress) => void;
  maxFiles?: number;
}): Promise<DiskAuditSummary> {
  const roots = normalizeDiskAuditRoots();
  const maxFiles = Math.max(
    1,
    Number(opts?.maxFiles || getPref("pdf.diskAudit.nameContentMaxFiles") || 5000),
  );
  opts?.onProgress?.({
    text: "Ad↔içerik için kayıtsız PDF toplanıyor…",
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
  const totalCandidates = targets.length;
  targets = targets.slice(0, maxFiles);
  const truncated = totalCandidates > targets.length;

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
      text: `Ad↔içerik ${i + 1}/${targets.length}`,
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
    maxFiles,
    totalCandidates,
    truncated,
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
    `Ad↔içerik: ${counts.clearMismatch} net uyumsuz / ${counts.scanned} tarandı` +
      (truncated ? ` (üst sınır ${maxFiles}; aday ${totalCandidates})` : "") +
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
        : `${rows.length} dosya önerilen adlarla yeniden adlandırılsın mı?`,
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
      text: `Yeniden adlandır ${i + 1}/${rows.length}`,
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
      // Prefer Zotero renameAttachmentFile so linked paths stay valid
      // (attachments:… / baseDir-relative). Blind attachmentPath=absolute breaks links.
      const attachment = await findAttachmentByAbsolutePath(src);
      if (attachment) {
        const ok = await renameAttachmentFileSafe(attachment, newName);
        if (!ok) {
          failed += 1;
          continue;
        }
      } else if (dest.toLowerCase() !== src.toLowerCase()) {
        await IOUtils.move(src, dest);
      }
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
      ? `Yeniden adlandırma planı: ${planned} dosya`
      : `Yeniden adlandırıldı: ${renamed}, hata: ${failed}`,
    8000,
  );
  return applyResult;
}

async function findAttachmentByAbsolutePath(
  absolutePath: string,
): Promise<Zotero.Item | null> {
  const want = PathUtils.normalize(absolutePath).normalize("NFC").toLowerCase();
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
      if (key === want) return attachment;
    }
  } catch (e) {
    ztoolkit.log("findAttachmentByAbsolutePath failed", e);
  }
  return null;
}

/** Same contract as menu.renameAttachmentFile — keeps linked paths coherent. */
async function renameAttachmentFileSafe(
  attItem: Zotero.Item,
  newName: string,
): Promise<boolean> {
  try {
    const renameAttachment = (attItem as any).renameAttachmentFile as
      | ((...args: any[]) => Promise<boolean>)
      | undefined;
    if (typeof renameAttachment !== "function") return false;
    if (renameAttachment.length <= 1) {
      return !!(await renameAttachment.call(attItem, newName, {
        overwrite: false,
        unique: true,
        updateTitle: false,
        out: {},
      }));
    }
    return !!(await renameAttachment.call(attItem, newName, false, true));
  } catch (e) {
    ztoolkit.log("renameAttachmentFileSafe failed", e);
    return false;
  }
}

export async function listMultiAttachParents(limit = 99999): Promise<{
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
  opts?.onProgress?.({ text: "Çoklu ek taranıyor…", progress: 15 });
  const multi = await listMultiAttachParents();
  opts?.onProgress?.({ text: "Klasör kopyaları taranıyor…", progress: 55 });
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
          // Full list for Çöz — samples alone silently skipped folders >30.
          unlinkedPaths: unlinked,
        });
      }
    };
    await walk(root, 0);
  }

  const multiLoserTargets: Array<{ id: number; path: string; size: number }> =
    [];
  for (const sample of multi.samples) {
    const atts = sample.attachments || [];
    if (atts.length < 2) continue;
    const sorted = [...atts].sort((a, b) => (b.size || 0) - (a.size || 0));
    for (const loser of sorted.slice(1)) {
      multiLoserTargets.push({
        id: loser.id,
        path: loser.path,
        size: loser.size,
      });
    }
  }
  const siblingUnlinkedTargets = siblingFolders.flatMap(
    (f) => f.unlinkedPaths || f.unlinkedSamples || [],
  );

  const payload = {
    kind: "copy",
    dryRun: true as const,
    apply: false,
    generatedAt: new Date().toISOString(),
    roots,
    // Apply reads this — must be complete, not UI samples.
    applyTargets: {
      siblingUnlinked: siblingUnlinkedTargets,
      multiLosers: multiLoserTargets,
    },
    multiAttach: {
      count: multi.count,
      samples: multi.samples.slice(0, 30),
    },
    diskSibling: {
      folderCount: siblingFolders.length,
      unlinkedSum: siblingFolders.reduce((a, f) => a + f.unlinked, 0),
      samples: siblingFolders.slice(0, 30).map((f) => ({
        ...f,
        unlinkedPaths: (f.unlinkedPaths || []).slice(0, 20),
      })),
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
    `Yinelenen: ${multi.count} çoklu ek, ${siblingFolders.length} klasör kopyası` +
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
    applyTargets?: {
      siblingUnlinked?: string[];
      multiLosers?: Array<{ id: number; path: string; size: number }>;
    };
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
  if (Array.isArray(report?.applyTargets?.siblingUnlinked)) {
    for (const p of report!.applyTargets!.siblingUnlinked!) {
      if (p) siblingLosers.push(p);
    }
  } else {
    for (const folder of report?.diskSibling?.samples || []) {
      const paths = folder.unlinkedPaths?.length
        ? folder.unlinkedPaths
        : folder.unlinkedSamples || [];
      for (const p of paths) if (p) siblingLosers.push(p);
    }
  }

  type Att = { id: number; path: string; size: number };
  const multiLosers: Att[] = [];
  if (Array.isArray(report?.applyTargets?.multiLosers)) {
    for (const a of report!.applyTargets!.multiLosers!) {
      if (a && a.id) multiLosers.push(a);
    }
  } else {
    for (const sample of report?.multiAttach?.samples || []) {
      const atts = (sample.attachments || []).filter((a) => a && a.id);
      if (atts.length < 2) continue;
      const sorted = [...atts].sort((a, b) => (b.size || 0) - (a.size || 0));
      for (const loser of sorted.slice(1)) multiLosers.push(loser);
    }
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
        : `${total} fazla kopya karantina klasörüne taşınsın mı? (silinmez)`,
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
      text: `Klasör kopyası ${i + 1}/${siblingLosers.length}`,
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
      text: `Çoklu ek ${i + 1}/${multiLosers.length}`,
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
      ? `Karantina planı: ${total} işlem`
      : `Karantina: ${quarantined} taşındı, ${detached} ek kaldırıldı, ${failed} hata`,
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
      text:
        kind === "orphan"
          ? "Kayıtsız PDF taranıyor…"
          : kind === "nameContent"
            ? "Ad ↔ içerik taranıyor…"
            : "Yinelenen PDF taranıyor…",
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
      text: `Tarama başarısız: ${String((e as Error)?.message || e)}`,
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
      text:
        kind === "orphan"
          ? "Kayıtsız PDF çözülüyor…"
          : kind === "nameContent"
            ? "Yeniden adlandırma uygulanıyor…"
            : "Kopyalar karantinaya alınıyor…",
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
      text: `Çözüm başarısız: ${String((e as Error)?.message || e)}`,
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
    return `Kayıtsız: ${s.orphanCount ?? 0} — sırada: Raporu aç → Çöz`;
  if (s.kind === "nameContent") {
    const n = s.nameContent;
    return `Ad↔içerik: ${n?.clearMismatch ?? 0} net uyumsuz / ${n?.scanned ?? 0} — sırada: Çöz`;
  }
  return `Yinelenen: ${s.multiAttachParents ?? 0} çoklu ek, ${s.siblingFolders ?? 0} klasör — sırada: Çöz`;
}

function summarizeApply(r: DiskAuditApplyResult): string {
  if (r.detail === "cancelled") return "Çöz iptal edildi";
  if (r.detail === "no-report") return "Rapor yok — önce Tara";
  if (r.dryRun) {
    return `Plan kaydedildi (deneme): öğe ${r.created ?? 0}, karantina ${r.quarantined ?? 0}, ad ${r.renamed ?? 0}, plan ${r.planned ?? 0}`;
  }
  return `Bitti: öğe ${r.created ?? 0}, karantina ${r.quarantined ?? 0}, ad ${r.renamed ?? 0}, ek kaldırıldı ${r.detached ?? 0}, hata ${r.failed ?? 0}`;
}
