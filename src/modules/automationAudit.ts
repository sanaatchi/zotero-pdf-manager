// @ajan: cursor · @etiket: katman-2, p1, p2-6, automationAudit, atomic-json
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { readJsonOrQuarantine, writeJsonAtomic } from "../utils/atomicJson";

declare const IOUtils: any;
declare const PathUtils: any;

export type AuditOutcome = "success" | "planned" | "review" | "failed" | "info";

export interface AuditEvent {
  timestamp: string;
  run: string;
  action: string;
  outcome: AuditOutcome;
  itemID?: number;
  title?: string;
  source?: string;
  path?: string;
  detail?: string;
}

export interface AuditSummary {
  total: number;
  success: number;
  planned: number;
  review: number;
  failed: number;
  info: number;
  dryRunHints: number;
}

/** Tags applied by automation — removable in Zotero to reverse a decision. */
export const REVERSIBLE_AUTOMATION_TAGS = [
  "#auto-attached",
  "#auto-oa",
  "#pdf-review",
  "#auto-created",
  "#pdf-orphan",
] as const;

const MAX_EVENTS = 2000;
let writeChain: Promise<void> = Promise.resolve();

function auditPath() {
  return PathUtils.join(
    (Zotero as any).DataDirectory.dir,
    "zpdfmanager-automation-audit.json",
  );
}

export async function readAuditEvents(): Promise<AuditEvent[]> {
  try {
    const path = auditPath();
    const parsed = await readJsonOrQuarantine(path);
    if (parsed == null) return [];
    if (Array.isArray(parsed)) return parsed as AuditEvent[];
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { data?: unknown }).data)
    ) {
      return (parsed as { data: AuditEvent[] }).data;
    }
    return [];
  } catch (e) {
    ztoolkit.log(
      "Automation audit log read failed (quarantined if corrupt)",
      e,
    );
    return [];
  }
}

export function appendAuditEvent(
  event: Omit<AuditEvent, "timestamp">,
): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      const events = await readAuditEvents();
      events.push({ timestamp: new Date().toISOString(), ...event });
      const trimmed = events.slice(-MAX_EVENTS);
      await writeJsonAtomic(auditPath(), {
        schemaVersion: 1,
        generation: Date.now(),
        savedAt: new Date().toISOString(),
        data: trimmed,
      });
    })
    .catch((e) => ztoolkit.log("Automation audit log write failed", e));
  return writeChain;
}

export async function clearAuditEvents(): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      await writeJsonAtomic(auditPath(), {
        schemaVersion: 1,
        generation: Date.now(),
        savedAt: new Date().toISOString(),
        data: [],
      });
    })
    .catch((e) => ztoolkit.log("Automation audit clear failed", e));
  return writeChain;
}

export function summarizeAuditEvents(events: AuditEvent[]): AuditSummary {
  const summary: AuditSummary = {
    total: events.length,
    success: 0,
    planned: 0,
    review: 0,
    failed: 0,
    info: 0,
    dryRunHints: 0,
  };
  for (const event of events) {
    if (event.outcome === "success") summary.success++;
    else if (event.outcome === "planned") summary.planned++;
    else if (event.outcome === "review") summary.review++;
    else if (event.outcome === "failed") summary.failed++;
    else summary.info++;
    const blob = `${event.detail || ""} ${event.outcome}`;
    if (/dry-run|planned/i.test(blob) || event.outcome === "planned") {
      summary.dryRunHints++;
    }
  }
  return summary;
}

function esc(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      })[character] as string,
  );
}

export function auditEventsToText(events: AuditEvent[]): string {
  const summary = summarizeAuditEvents(events);
  const lines = [...events].reverse().map((event) => {
    const when = new Date(event.timestamp).toLocaleString();
    const item = event.title || event.path || "—";
    return `[${event.outcome}] ${when} · ${event.action} · ${item}${
      event.detail ? `\n  ${event.detail}` : ""
    }`;
  });
  return [
    `${config.addonName} — Automation Audit`,
    `${summary.total} events · success ${summary.success} · planned ${summary.planned} · review ${summary.review} · failed ${summary.failed}`,
    `Reversible tags: ${REVERSIBLE_AUTOMATION_TAGS.join(", ")}`,
    "",
    lines.join("\n\n") || "No automation events yet.",
  ].join("\n");
}

function isDryRunPrefActive(): boolean {
  try {
    return getPref("pdf.dryRun") === true;
  } catch {
    return false;
  }
}

export function auditEventsToHTML(
  events: AuditEvent[],
  opts: { dryRunActive?: boolean } = {},
) {
  const summary = summarizeAuditEvents(events);
  const dryRunActive = opts.dryRunActive === true || isDryRunPrefActive();
  const rows = [...events]
    .reverse()
    .map(
      (event) => `<tr data-outcome="${esc(event.outcome)}">
<td>${esc(new Date(event.timestamp).toLocaleString())}</td>
<td><span class="badge ${esc(event.outcome)}">${esc(event.outcome)}</span></td>
<td>${esc(event.action)}</td>
<td>${esc(event.title || event.path || "—")}</td>
<td>${esc(event.source || "—")}</td>
<td>${esc(event.detail || "")}</td>
</tr>`,
    )
    .join("\n");

  const banner = dryRunActive
    ? `<div class="banner">Dry-run is ON — no attachments, tags, online fetches or orphan creates. Outcomes show as <b>planned</b>.</div>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(config.addonName)} — Automation Audit</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:14px/1.45 system-ui,"Segoe UI",sans-serif;margin:0;padding:20px}
h1{font-size:19px;margin:0 0 4px}
.summary{color:#777;margin-bottom:10px}
.summary b.ok{color:#17803d}.summary b.plan{color:#2563eb}
.summary b.rev{color:#b06b00}.summary b.bad{color:#c0392b}
.banner{background:#2563eb22;border:1px solid #2563eb66;border-radius:8px;padding:10px 12px;margin:0 0 14px}
.legend{font-size:12px;color:#666;margin:0 0 12px}
.filters{margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap}
.filters button{cursor:pointer;border:1px solid #8886;background:transparent;border-radius:6px;padding:4px 10px;font:inherit}
.filters button.active{background:#3b82f6;color:#fff;border-color:#3b82f6}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #8883;vertical-align:top}
th{position:sticky;top:0;background:Canvas}
.badge{padding:2px 6px;border-radius:5px;background:#8882;font-size:12px}
.badge.success{color:#17803d;background:#17803d22}
.badge.planned{color:#2563eb;background:#2563eb22}
.badge.review{color:#b06b00;background:#b06b0022}
.badge.failed{color:#c0392b;background:#c0392b22}
.badge.info{color:#555}
tr.hide{display:none}
code{font-size:12px}
</style></head><body>
<h1>${esc(config.addonName)} — Automation Audit</h1>
${banner}
<div class="summary">
  ${summary.total} recent events · newest first —
  <b class="ok">${summary.success} success</b>,
  <b class="plan">${summary.planned} planned</b>,
  <b class="rev">${summary.review} review</b>,
  <b class="bad">${summary.failed} failed</b>
</div>
<div class="legend">Reversible tags (remove in Zotero to undo): ${REVERSIBLE_AUTOMATION_TAGS.map(
    (tag) => `<code>${esc(tag)}</code>`,
  ).join(" · ")}</div>
<div class="filters">
  <button data-f="all" class="active">All (${summary.total})</button>
  <button data-f="success">Success (${summary.success})</button>
  <button data-f="planned">Planned (${summary.planned})</button>
  <button data-f="review">Review (${summary.review})</button>
  <button data-f="failed">Failed (${summary.failed})</button>
  <button data-f="info">Info (${summary.info})</button>
</div>
<table><thead><tr><th>Time</th><th>Outcome</th><th>Action</th><th>Item / file</th><th>Source</th><th>Detail</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No automation events yet.</td></tr>'}</tbody></table>
<script>
  const buttons = document.querySelectorAll(".filters button");
  const rows = document.querySelectorAll("tbody tr[data-outcome]");
  buttons.forEach((btn) => btn.addEventListener("click", () => {
    buttons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const f = btn.getAttribute("data-f");
    rows.forEach((row) => {
      row.classList.toggle("hide", f !== "all" && row.getAttribute("data-outcome") !== f);
    });
  }));
</script>
</body></html>`;
}

export async function openAutomationAuditReport() {
  const events = await readAuditEvents();
  const dryRunActive = isDryRunPrefActive();
  const html = auditEventsToHTML(events, { dryRunActive });
  try {
    const win = Zotero.getMainWindow();
    const path = PathUtils.join(
      (Zotero as any).getTempDirectory().path,
      `zpdfmanager-automation-audit-${Date.now()}.html`,
    );
    await IOUtils.writeUTF8(path, html);
    const uri = (Zotero as any).File.pathToFileURI(path);
    const { container } = (win as any).Zotero_Tabs.add({
      type: `${config.addonRef}-automation-audit`,
      title: dryRunActive ? "Automation Audit (dry-run)" : "Automation Audit",
      select: true,
      onClose: () => {},
    });
    const browser = (win.document as any).createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("flex", "1");
    browser.setAttribute("src", uri);
    container.appendChild(browser);
  } catch (e) {
    ztoolkit.log("Automation audit report failed", e);
    try {
      new ztoolkit.Clipboard()
        .addText(auditEventsToText(events), "text/unicode")
        .copy();
    } catch {
      /* ignore */
    }
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
      .createLine({
        text: "Automation audit could not open; copied to clipboard.",
        type: "fail",
      })
      .show();
  }
}
