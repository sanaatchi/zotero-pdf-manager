// @ajan: claude · @etiket: katman-2, content-audit, pdf-mismatch, match-tag-clear, multi-pdf-aggregate, tag-clear-log, clear-automation-tags-menu, mismatch-tag-guard, pdf-candidate-split
/**
 * Scan already-attached PDFs against parent metadata (PDF text heuristics +
 * optional LLM). Detects wrong binds that slipped past download gates.
 *
 * Match: clear #pdf-mismatch / #pdf-review / #pdf-quarantine (same as Match
 * Attachment success). Mismatch/unverifiable: tag only. Never detach.
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { appendAuditEvent } from "./automationAudit";
import { applyPdfMismatchTags } from "./pdfAutomationTags";
import { recordPdfAutomationTagsUserClear } from "./pdfAutomationTagGuard";
import {
  clearSuccessfulMatchTags,
  type ContentValidation,
  validateAttachmentContentDetailed,
} from "./pdfSources";

declare const IOUtils: any;
declare const PathUtils: any;

export const PDF_MISMATCH_TAG = "#pdf-mismatch";
export const PDF_REVIEW_TAG = "#pdf-review";

export type ContentAuditRow = {
  itemID: number;
  attachmentID: number;
  title: string;
  verdict: ContentValidation | "no-pdf" | "error";
  action: "ok" | "tagged" | "skipped" | "error";
  note?: string;
};

export type ContentAuditSummary = {
  scanned: number;
  match: number;
  mismatch: number;
  unverifiable: number;
  skipped: number;
  noPdf: number;
  errors: number;
};

/** Pure: decide tags for one verdict (never detach). */
export function decideContentAuditAction(input: {
  verdict: ContentValidation | "no-pdf" | "error";
}): "ok" | "tag-mismatch" | "tag-review" | "skip" | "error" {
  if (input.verdict === "match") return "ok";
  if (input.verdict === "mismatch") return "tag-mismatch";
  if (input.verdict === "unverifiable") return "tag-review";
  if (input.verdict === "error") return "error";
  return "skip";
}

export function summarizeContentAudit(
  rows: ContentAuditRow[],
): ContentAuditSummary {
  const s: ContentAuditSummary = {
    scanned: rows.length,
    match: 0,
    mismatch: 0,
    unverifiable: 0,
    skipped: 0,
    noPdf: 0,
    errors: 0,
  };
  for (const r of rows) {
    if (r.verdict === "match") s.match++;
    else if (r.verdict === "mismatch") s.mismatch++;
    else if (r.verdict === "unverifiable") s.unverifiable++;
    else if (r.verdict === "no-pdf") s.noPdf++;
    else if (r.verdict === "error") s.errors++;
    else s.skipped++;
  }
  return s;
}

function itemHasAutomationTag(item: Zotero.Item, tag: string): boolean {
  if (typeof item.hasTag !== "function") return false;
  if (item.hasTag(tag)) return true;
  const alt = tag.startsWith("#") ? tag.slice(1) : `#${tag}`;
  return item.hasTag(alt);
}

async function tagItem(item: Zotero.Item, tag: string): Promise<void> {
  try {
    if (itemHasAutomationTag(item, tag)) return;
    item.addTag(tag);
    await item.saveTx();
  } catch (e) {
    ztoolkit.log("content audit tag failed", tag, e);
  }
}

function isPdfAttachment(att: Zotero.Item): boolean {
  return Boolean(
    att?.isPDFAttachment?.() ||
    String(att.attachmentContentType || "").toLowerCase() === "application/pdf",
  );
}

async function regularParentsFromSelection(
  selected: Zotero.Item[],
): Promise<Zotero.Item[]> {
  const out = new Map<number, Zotero.Item>();
  for (const source of selected) {
    if (source.isRegularItem()) {
      out.set(source.id, source);
      continue;
    }
    if (source.isAttachment() && source.parentItemID) {
      const parent = await Zotero.Items.getAsync(source.parentItemID);
      if (parent?.isRegularItem()) out.set(parent.id, parent);
    }
  }
  return [...out.values()];
}

async function listPdfAttachments(item: Zotero.Item): Promise<Zotero.Item[]> {
  const pdfs: Zotero.Item[] = [];
  for (const id of item.getAttachments()) {
    const att = await Zotero.Items.getAsync(id);
    if (!att || !att.isFileAttachment?.()) continue;
    if (!isPdfAttachment(att)) continue;
    let exists = false;
    try {
      exists = await att.fileExists();
    } catch {
      exists = false;
    }
    if (exists) pdfs.push(att);
  }
  return pdfs;
}

/**
 * Validate one parent item's PDF attachments. If any attachment matches,
 * clear mismatch tags once and do not tag siblings in the same run; otherwise
 * mismatch/unverifiable only tags. Never detaches.
 */
export async function auditItemPdfContent(
  item: Zotero.Item,
): Promise<ContentAuditRow[]> {
  const title = String(item.getField("title") || `#${item.id}`);
  const pdfs = await listPdfAttachments(item);
  if (!pdfs.length) {
    return [
      {
        itemID: item.id,
        attachmentID: 0,
        title,
        verdict: "no-pdf",
        action: "skipped",
        note: "No accessible PDF attachment",
      },
    ];
  }

  type PendingRow = {
    attachmentID: number;
    verdict: ContentValidation | "error";
    plan: ReturnType<typeof decideContentAuditAction>;
    note: string;
  };

  const pending: PendingRow[] = [];
  const errors: ContentAuditRow[] = [];

  for (const att of pdfs) {
    try {
      const { verdict } = await validateAttachmentContentDetailed(
        item,
        att.id,
        { force: true },
      );
      pending.push({
        attachmentID: att.id,
        verdict,
        plan: decideContentAuditAction({ verdict }),
        note: `verdict=${verdict}`,
      });
    } catch (e) {
      ztoolkit.log("content audit item failed", item.id, e);
      errors.push({
        itemID: item.id,
        attachmentID: att.id,
        title,
        verdict: "error",
        action: "error",
        note: String((e as Error)?.message || e),
      });
    }
  }

  const anyMatch = pending.some((p) => p.verdict === "match");
  const rows: ContentAuditRow[] = [...errors];

  if (anyMatch) {
    // One good PDF is enough — clear automation tags once; do not re-tag siblings.
    await clearSuccessfulMatchTags(item);
    if (itemHasAutomationTag(item, PDF_MISMATCH_TAG)) {
      void appendAuditEvent({
        run: "content-audit",
        action: "pdf-content-audit-tag-clear-failed",
        outcome: "failed",
        itemID: item.id,
        title,
        detail:
          "verdict match on attachment but #pdf-mismatch still on item after clearSuccessfulMatchTags",
      });
      ztoolkit.log(
        "content audit: tag clear failed after match",
        item.id,
        title,
      );
    }
  }

  for (const p of pending) {
    let action: ContentAuditRow["action"] = "skipped";
    let note = p.note;

    if (anyMatch) {
      if (p.plan === "ok") {
        action = "ok";
        note = "PDF text matches metadata — cleared mismatch tags";
      } else {
        action = "skipped";
        note =
          p.verdict === "mismatch"
            ? "Sibling PDF matched metadata — #pdf-mismatch not applied"
            : p.verdict === "unverifiable"
              ? "Sibling PDF matched metadata — #pdf-review not applied"
              : note;
      }
    } else if (p.plan === "tag-mismatch") {
      await applyPdfMismatchTags(
        item,
        { source: "content-audit", run: "content-audit" },
        tagItem,
      );
      action = "tagged";
      note = "Content mismatch — tagged #pdf-mismatch (attachment kept)";
    } else if (p.plan === "tag-review") {
      await tagItem(item, PDF_REVIEW_TAG);
      action = "tagged";
      note = "Unverifiable text — tagged #pdf-review";
    }

    rows.push({
      itemID: item.id,
      attachmentID: p.attachmentID,
      title,
      verdict: p.verdict,
      action,
      note,
    });

    void appendAuditEvent({
      run: "content-audit",
      action: "pdf-content-audit",
      outcome:
        p.verdict === "match"
          ? "success"
          : p.verdict === "mismatch"
            ? "failed"
            : "review",
      itemID: item.id,
      title,
      detail: note,
    });
  }

  return rows;
}

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

export function contentAuditToHtml(rows: ContentAuditRow[]): string {
  const sum = summarizeContentAudit(rows);
  const body = rows
    .map((r) => {
      const cls =
        r.verdict === "match"
          ? "ok"
          : r.verdict === "mismatch" || r.verdict === "error"
            ? "bad"
            : "muted";
      return `<tr data-status="${esc(r.verdict)}">
  <td class="${cls}">${esc(r.verdict)}</td>
  <td>${esc(r.title)}</td>
  <td>${esc(r.action)}</td>
  <td>${esc(r.note || "")}</td>
</tr>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"/>
<title>${esc(config.addonName)} — PDF içerik denetimi</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;padding:20px;margin:0}
.summary{color:#666;margin-bottom:12px}
.ok{color:#1a7f37}.bad{color:#c0392b}.muted{color:#888}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px;border-bottom:1px solid #8883}
</style></head><body>
<h1>${esc(config.addonName)} — PDF içerik denetimi</h1>
<div class="summary">
  ${sum.scanned} tarandı —
  <b class="ok">${sum.match} uyumlu</b>,
  <b class="bad">${sum.mismatch} uyuşmazlık</b> (ekler kalır + #pdf-mismatch),
  <b class="muted">${sum.unverifiable} doğrulanamaz</b>,
  ${sum.noPdf} PDF yok, ${sum.errors} hata
</div>
<table><thead><tr><th>Sonuç</th><th>Öğe</th><th>İşlem</th><th>Not</th></tr></thead>
<tbody>${body}</tbody></table>
</body></html>`;
}

async function openContentAuditReport(rows: ContentAuditRow[]): Promise<void> {
  if (!rows.length || getPref("pdf.showReport") === false) return;
  const html = contentAuditToHtml(rows);
  try {
    const win = Zotero.getMainWindow();
    const tmpPath = PathUtils.join(
      (Zotero as any).getTempDirectory().path,
      `zpdfmanager-content-audit-${Date.now()}.html`,
    );
    await IOUtils.writeUTF8(tmpPath, html);
    const uri = (Zotero as any).File.pathToFileURI(tmpPath);
    const Zotero_Tabs = (win as any).Zotero_Tabs;
    const { container } = Zotero_Tabs.add({
      type: `${config.addonRef}-content-audit`,
      title: "PDF içerik denetimi",
      select: true,
      onClose: () => {},
    });
    const browser = (win.document as any).createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("flex", "1");
    browser.setAttribute("src", uri);
    container.appendChild(browser);
  } catch (e) {
    ztoolkit.log("content audit report tab failed", e);
  }
}

/**
 * Menu entry: scan selection → tag mismatches → report.
 * Never detaches or erases attachments.
 */
export async function auditSelectedPdfContent(): Promise<ContentAuditSummary> {
  const pane = Zotero.getActiveZoteroPane?.() ?? null;
  const selected = pane?.getSelectedItems?.() ?? [];
  const items = await regularParentsFromSelection(selected);
  if (!items.length) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 4000 })
      .createLine({
        text: getString("pdf-content-audit-empty"),
        type: "default",
      })
      .show();
    return summarizeContentAudit([]);
  }

  const popup = new ztoolkit.ProgressWindow(config.addonName, {
    closeTime: -1,
    closeOnClick: false,
  });
  popup.createLine({
    text: getString("pdf-content-audit-start", {
      args: { count: items.length },
    }),
    type: "default",
    progress: 0,
  });
  popup.show();

  const allRows: ContentAuditRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    popup.changeLine({
      text: `[${i + 1}/${items.length}] ${String(item.getField("title") || item.id).slice(0, 60)}`,
      progress: Math.round(((i + 1) / items.length) * 100),
    });
    const rows = await auditItemPdfContent(item);
    allRows.push(...rows);
  }

  const sum = summarizeContentAudit(allRows);
  popup.changeLine({
    text: getString("pdf-content-audit-done", {
      args: {
        match: sum.match,
        mismatch: sum.mismatch,
        review: sum.unverifiable,
      },
    }),
    type: sum.mismatch ? "fail" : "success",
    progress: 100,
  });
  popup.startCloseTimer(6000);

  await openContentAuditReport(allRows);

  return sum;
}

/** True when parent carries any PDF automation tag cleared on successful match. */
export function itemHasClearablePdfAutomationTag(item: Zotero.Item): boolean {
  return (
    itemHasAutomationTag(item, PDF_MISMATCH_TAG) ||
    itemHasAutomationTag(item, PDF_REVIEW_TAG) ||
    itemHasAutomationTag(item, "#pdf-quarantine") ||
    itemHasAutomationTag(item, "#pdf-candidate")
  );
}

/**
 * Manual recovery: remove #pdf-mismatch / #pdf-review / #pdf-quarantine /
 * #pdf-candidate only.
 * Confirm dialog; does not run content validation or change attachments.
 */
export async function clearPdfAutomationTagsOnSelected(): Promise<{
  cleared: number;
  skipped: number;
}> {
  const pane = Zotero.getActiveZoteroPane?.() ?? null;
  const selected = pane?.getSelectedItems?.() ?? [];
  const items = await regularParentsFromSelection(selected);
  if (!items.length) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 4000 })
      .createLine({
        text: getString("pdf-clear-automation-tags-empty"),
        type: "default",
      })
      .show();
    return { cleared: 0, skipped: 0 };
  }

  const targets = items.filter((item) =>
    itemHasClearablePdfAutomationTag(item),
  );
  if (!targets.length) {
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 4000 })
      .createLine({
        text: getString("pdf-clear-automation-tags-none"),
        type: "default",
      })
      .show();
    return { cleared: 0, skipped: items.length };
  }

  const confirmed = window.confirm(
    getString("pdf-clear-automation-tags-confirm", {
      args: { count: targets.length },
    }),
  );
  if (!confirmed) return { cleared: 0, skipped: items.length };

  let cleared = 0;
  for (const item of targets) {
    await clearSuccessfulMatchTags(item);
    recordPdfAutomationTagsUserClear(item.id);
    void appendAuditEvent({
      run: "manual-clear",
      action: "pdf-automation-tags-user-clear",
      outcome: "success",
      itemID: item.id,
      title: String(item.getField("title") || `#${item.id}`),
      source: "clear-automation-tags-menu",
      detail:
        "User cleared #pdf-mismatch / #pdf-review / #pdf-quarantine; passive re-tag suppressed",
    });
    if (!itemHasClearablePdfAutomationTag(item)) cleared++;
  }

  new ztoolkit.ProgressWindow(config.addonName, { closeTime: 5000 })
    .createLine({
      text: getString("pdf-clear-automation-tags-done", {
        args: { cleared, total: targets.length },
      }),
      type: cleared === targets.length ? "success" : "default",
    })
    .show();

  return { cleared, skipped: items.length - cleared };
}
