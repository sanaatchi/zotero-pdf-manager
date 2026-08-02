// @ajan: cursor · @etiket: katman-2, content-audit, pdf-mismatch
/**
 * Scan already-attached PDFs against parent metadata (PDF text heuristics +
 * optional LLM). Detects wrong binds that slipped past download gates.
 *
 * Default: tag + report. Optional confirm detaches mismatches (disk kept).
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { appendAuditEvent } from "./automationAudit";
import {
  cleanupRejectedAttachment,
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
  action: "ok" | "tagged" | "detached" | "skipped" | "error";
  note?: string;
  /** Kept for optional detach after report. */
  pdfText?: string;
};

export type ContentAuditSummary = {
  scanned: number;
  match: number;
  mismatch: number;
  unverifiable: number;
  skipped: number;
  noPdf: number;
  errors: number;
  detached: number;
};

/** Pure: decide tags / detach for one verdict. */
export function decideContentAuditAction(input: {
  verdict: ContentValidation | "no-pdf" | "error";
  detachMismatch: boolean;
}): "ok" | "tag-mismatch" | "detach" | "tag-review" | "skip" | "error" {
  if (input.verdict === "match") return "ok";
  if (input.verdict === "mismatch") {
    return input.detachMismatch ? "detach" : "tag-mismatch";
  }
  if (input.verdict === "unverifiable") return "tag-review";
  if (input.verdict === "error") return "error";
  return "skip";
}

export function summarizeContentAudit(rows: ContentAuditRow[]): ContentAuditSummary {
  const s: ContentAuditSummary = {
    scanned: rows.length,
    match: 0,
    mismatch: 0,
    unverifiable: 0,
    skipped: 0,
    noPdf: 0,
    errors: 0,
    detached: 0,
  };
  for (const r of rows) {
    if (r.verdict === "match") s.match++;
    else if (r.verdict === "mismatch") s.mismatch++;
    else if (r.verdict === "unverifiable") s.unverifiable++;
    else if (r.verdict === "no-pdf") s.noPdf++;
    else if (r.verdict === "error") s.errors++;
    else s.skipped++;
    if (r.action === "detached") s.detached++;
  }
  return s;
}

async function tagItem(item: Zotero.Item, tag: string): Promise<void> {
  try {
    if (item.hasTag(tag)) return;
    item.addTag(tag);
    await item.saveTx();
  } catch (e) {
    ztoolkit.log("content audit tag failed", tag, e);
  }
}

async function removeTag(item: Zotero.Item, tag: string): Promise<void> {
  try {
    if (!item.hasTag(tag)) return;
    item.removeTag(tag);
    await item.saveTx();
  } catch (e) {
    ztoolkit.log("content audit untag failed", tag, e);
  }
}

function isPdfAttachment(att: Zotero.Item): boolean {
  return Boolean(
    att?.isPDFAttachment?.() ||
      String(att.attachmentContentType || "").toLowerCase() ===
        "application/pdf",
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
 * Validate one parent item's PDF attachments. When detachMismatch is false,
 * only tags (#pdf-mismatch / #pdf-review).
 */
export async function auditItemPdfContent(
  item: Zotero.Item,
  opts: { detachMismatch?: boolean } = {},
): Promise<ContentAuditRow[]> {
  const detachMismatch = !!opts.detachMismatch;
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

  const rows: ContentAuditRow[] = [];
  for (const att of pdfs) {
    try {
      const { verdict, pdfText } = await validateAttachmentContentDetailed(
        item,
        att.id,
        { force: true },
      );
      const plan = decideContentAuditAction({ verdict, detachMismatch });
      let action: ContentAuditRow["action"] = "skipped";
      let note = `verdict=${verdict}`;

      if (plan === "ok") {
        await removeTag(item, PDF_MISMATCH_TAG);
        action = "ok";
        note = "PDF text matches metadata";
      } else if (plan === "tag-mismatch") {
        await tagItem(item, PDF_MISMATCH_TAG);
        await tagItem(item, PDF_REVIEW_TAG);
        action = "tagged";
        note = "Content mismatch — tagged #pdf-mismatch";
      } else if (plan === "detach") {
        const cleaned = await cleanupRejectedAttachment({
          attachment: att,
          pdfText,
          finalCreatedByThisRun: null,
        });
        await tagItem(item, PDF_MISMATCH_TAG);
        await tagItem(item, PDF_REVIEW_TAG);
        action = cleaned === "cleaned" ? "detached" : "error";
        note =
          cleaned === "cleaned"
            ? "Mismatch — detached (disk copy kept)"
            : "Mismatch — detach failed; tagged for review";
      } else if (plan === "tag-review") {
        await tagItem(item, PDF_REVIEW_TAG);
        action = "tagged";
        note = "Unverifiable text — tagged #pdf-review";
      }

      rows.push({
        itemID: item.id,
        attachmentID: att.id,
        title,
        verdict,
        action,
        note,
        pdfText: plan === "tag-mismatch" ? pdfText : undefined,
      });

      void appendAuditEvent({
        run: "content-audit",
        action: "pdf-content-audit",
        outcome:
          verdict === "match"
            ? "success"
            : verdict === "mismatch"
              ? "failed"
              : "review",
        itemID: item.id,
        title,
        detail: note,
      });
    } catch (e) {
      ztoolkit.log("content audit item failed", item.id, e);
      rows.push({
        itemID: item.id,
        attachmentID: att.id,
        title,
        verdict: "error",
        action: "error",
        note: String((e as Error)?.message || e),
      });
    }
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
  <b class="bad">${sum.mismatch} uyuşmazlık</b>,
  <b class="muted">${sum.unverifiable} doğrulanamaz</b>,
  ${sum.noPdf} PDF yok, ${sum.detached} ayrıldı, ${sum.errors} hata
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

function confirmDialog(message: string): boolean {
  return Boolean(ztoolkit.getGlobal("confirm")(message));
}

/**
 * Menu entry: scan selection → tag mismatches → report → optional detach.
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
    const rows = await auditItemPdfContent(item, { detachMismatch: false });
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

  if (sum.mismatch > 0) {
    const ok = confirmDialog(
      getString("pdf-content-audit-detach-confirm", {
        args: { count: sum.mismatch },
      }),
    );
    if (ok) {
      let detached = 0;
      for (const row of allRows) {
        if (row.verdict !== "mismatch" || !row.attachmentID) continue;
        const item = await Zotero.Items.getAsync(row.itemID);
        const att = await Zotero.Items.getAsync(row.attachmentID);
        if (!item || !att) continue;
        // Re-read text if we didn't keep it (shouldn't happen for mismatch).
        let pdfText = row.pdfText || "";
        if (!pdfText) {
          try {
            const again = await validateAttachmentContentDetailed(
              item,
              att.id,
              { force: true },
            );
            pdfText = again.pdfText;
          } catch {
            /* best-effort */
          }
        }
        const cleaned = await cleanupRejectedAttachment({
          attachment: att,
          pdfText,
          finalCreatedByThisRun: null,
        });
        if (cleaned === "cleaned") {
          detached++;
          row.action = "detached";
          row.note = "Mismatch — detached (disk copy kept)";
        }
        await tagItem(item, PDF_MISMATCH_TAG);
        await tagItem(item, PDF_REVIEW_TAG);
      }
      sum.detached = detached;
      new ztoolkit.ProgressWindow(config.addonName, { closeTime: 5000 })
        .createLine({
          text: getString("pdf-content-audit-detached", {
            args: { count: detached },
          }),
          type: "success",
        })
        .show();
      await openContentAuditReport(allRows);
    }
  }

  return sum;
}
