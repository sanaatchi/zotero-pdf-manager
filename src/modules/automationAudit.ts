import { config } from "../../package.json";

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
    if (!(await IOUtils.exists(path))) return [];
    const parsed = JSON.parse(await IOUtils.readUTF8(path));
    return Array.isArray(parsed) ? (parsed as AuditEvent[]) : [];
  } catch (e) {
    ztoolkit.log("Automation audit log read failed", e);
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
      await IOUtils.writeUTF8(auditPath(), JSON.stringify(trimmed));
    })
    .catch((e) => ztoolkit.log("Automation audit log write failed", e));
  return writeChain;
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

export function auditEventsToHTML(events: AuditEvent[]) {
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
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(config.addonName)} — Automation Audit</title>
<style>
:root{color-scheme:light dark}body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:20px}
h1{font-size:19px;margin:0 0 4px}.summary{color:#777;margin-bottom:14px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #8883;vertical-align:top}
th{position:sticky;top:0;background:Canvas}.badge{padding:2px 6px;border-radius:5px;background:#8882}
.success{color:#17803d}.planned{color:#2563eb}.review{color:#b06b00}.failed{color:#c0392b}
</style></head><body>
<h1>${esc(config.addonName)} — Automation Audit</h1>
<div class="summary">${events.length} recent events · newest first</div>
<table><thead><tr><th>Time</th><th>Outcome</th><th>Action</th><th>Item / file</th><th>Source</th><th>Detail</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No automation events yet.</td></tr>'}</tbody></table>
</body></html>`;
}

export async function openAutomationAuditReport() {
  const html = auditEventsToHTML(await readAuditEvents());
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
      title: "Automation Audit",
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
    new ztoolkit.ProgressWindow(config.addonName, { closeTime: 6000 })
      .createLine({ text: "Automation audit report could not be opened.", type: "fail" })
      .show();
  }
}
