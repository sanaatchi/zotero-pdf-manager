import { config } from "../../package.json";
import { getPref } from "../utils/prefs";

declare const IOUtils: any;
declare const PathUtils: any;

export type AttemptOutcome =
  | "attached"
  | "no-match"
  | "rejected"
  | "error"
  | "unsupported";

export interface SourceAttempt {
  source: string;
  outcome: AttemptOutcome;
  reason?: string;
}

export interface ItemReport {
  itemID: number;
  title: string;
  result: "added" | "skipped" | "failed";
  attachedSource?: string;
  note?: string;
  attempts: SourceAttempt[];
}

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

const OUTCOME_LABEL: Record<AttemptOutcome, string> = {
  attached: "eklendi",
  "no-match": "bulunamadı",
  rejected: "reddedildi (içerik uyuşmadı)",
  error: "hata",
  unsupported: "tür desteklenmiyor",
};

const RESULT_LABEL = {
  added: "Eklendi",
  skipped: "Atlandı",
  failed: "Başarısız",
};

export function reportToText(reports: ItemReport[]): string {
  const lines = reports.map((r) => {
    const attempts = r.attempts
      .map(
        (a) =>
          `${a.source}: ${OUTCOME_LABEL[a.outcome]}${a.reason ? ` (${a.reason})` : ""}`,
      )
      .join(" · ");
    const head = `[${RESULT_LABEL[r.result]}] ${r.title}`;
    return r.note
      ? `${head}\n  ${r.note}`
      : `${head}\n  ${attempts || "—"}`;
  });
  return `${config.addonName} — İndirme raporu\n\n${lines.join("\n\n")}`;
}

export function generateHtml(reports: ItemReport[]): string {
  const added = reports.filter((r) => r.result === "added").length;
  const failed = reports.filter((r) => r.result === "failed").length;
  const skipped = reports.filter((r) => r.result === "skipped").length;

  const rows = reports
    .map((r) => {
      const badge =
        r.result === "added" ? "✓" : r.result === "failed" ? "✗" : "–";
      const attempts = r.attempts
        .map((a) => {
          const cls =
            a.outcome === "attached"
              ? "ok"
              : a.outcome === "error" || a.outcome === "rejected"
                ? "bad"
                : "muted";
          return `<span class="chip ${cls}">${esc(a.source)}: ${esc(
            OUTCOME_LABEL[a.outcome],
          )}${a.reason ? ` — ${esc(a.reason)}` : ""}</span>`;
        })
        .join(" ");
      return `<tr data-status="${r.result}">
        <td class="status ${r.result}">${badge}</td>
        <td class="title">${esc(r.title)}${
          r.attachedSource
            ? ` <span class="src">← ${esc(r.attachedSource)}</span>`
            : ""
        }</td>
        <td class="attempts">${r.note ? esc(r.note) : attempts || "—"}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(config.addonName)} — İndirme Raporu</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; margin: 0; padding: 20px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .summary { color: #666; margin-bottom: 16px; }
  .summary b.ok { color: #1a7f37; } .summary b.bad { color: #c0392b; } .summary b.muted { color: #888; }
  .filters { margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .filters button { cursor: pointer; border: 1px solid #ccc; background: transparent; border-radius: 6px; padding: 4px 10px; font: inherit; }
  .filters button.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #8883; vertical-align: top; }
  th { position: sticky; top: 0; background: Canvas; }
  td.status { font-size: 16px; width: 28px; text-align: center; }
  td.status.added { color: #1a7f37; } td.status.failed { color: #c0392b; } td.status.skipped { color: #999; }
  td.title { font-weight: 600; max-width: 420px; }
  .src { font-weight: 400; color: #1a7f37; font-size: 12px; }
  .chip { display: inline-block; border-radius: 5px; padding: 1px 6px; margin: 1px 2px; font-size: 12px; background: #8882; }
  .chip.ok { background: #1a7f3733; color: #1a7f37; }
  .chip.bad { background: #c0392b22; color: #c0392b; }
  .chip.muted { color: #777; }
  tr.hide { display: none; }
</style>
</head>
<body>
  <h1>${esc(config.addonName)} — İndirme Raporu</h1>
  <div class="summary">
    Toplam ${reports.length} öğe —
    <b class="ok">${added} eklendi</b>,
    <b class="muted">${skipped} atlandı</b>,
    <b class="bad">${failed} başarısız</b>
  </div>
  <div class="filters">
    <button data-f="all" class="active">Tümü (${reports.length})</button>
    <button data-f="failed">Başarısız (${failed})</button>
    <button data-f="added">Eklendi (${added})</button>
    <button data-f="skipped">Atlandı (${skipped})</button>
  </div>
  <table>
    <thead><tr><th></th><th>Öğe</th><th>Denemeler / Neden</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
<script>
  const buttons = document.querySelectorAll(".filters button");
  const rows = document.querySelectorAll("tbody tr");
  buttons.forEach((btn) => btn.addEventListener("click", () => {
    buttons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const f = btn.getAttribute("data-f");
    rows.forEach((row) => {
      row.classList.toggle("hide", f !== "all" && row.getAttribute("data-status") !== f);
    });
  }));
</script>
</body>
</html>`;
}

/**
 * Open the download report as an HTML page in a Zotero tab. Falls back to
 * copying a plain-text report to the clipboard if the tab cannot be created.
 */
export async function openDownloadReport(reports: ItemReport[]) {
  if (!reports.length || getPref("pdf.showReport") === false) return;
  const html = generateHtml(reports);
  try {
    const win = Zotero.getMainWindow();
    const tmpPath = PathUtils.join(
      (Zotero as any).getTempDirectory().path,
      `zpdfmanager-report-${Date.now()}.html`,
    );
    await IOUtils.writeUTF8(tmpPath, html);
    const uri = (Zotero as any).File.pathToFileURI(tmpPath);

    const Zotero_Tabs = (win as any).Zotero_Tabs;
    const { container } = Zotero_Tabs.add({
      type: `${config.addonRef}-report`,
      title: "İndirme Raporu",
      select: true,
      onClose: () => {},
    });
    const browser = (win.document as any).createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("flex", "1");
    browser.setAttribute("src", uri);
    container.appendChild(browser);
  } catch (e) {
    ztoolkit.log("Report tab failed; copying to clipboard instead", e);
    try {
      new ztoolkit.Clipboard()
        .addText(reportToText(reports), "text/unicode")
        .copy();
    } catch {
      /* ignore clipboard failure */
    }
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
      .createLine({
        text: "Rapor sekmesi açılamadı; rapor panoya kopyalandı.",
        type: "default",
      })
      .show();
  }
}
