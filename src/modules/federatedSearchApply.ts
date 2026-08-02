// @ajan: cursor · @etiket: katman-2, federated-search, apply
/**
 * Manual federated OA search: query all prefs-enabled download adapters,
 * show ranked report, optionally attach the top downloadable hit.
 * Does not change AUTOMATIC_ONLINE_SOURCE_IDS cascade policy.
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  enabledFederatedSourceIds,
  fetchOaPdfViaBridge,
  searchAllOaSources,
  type OaPdfHit,
} from "./oaPdfBridge";

declare const IOUtils: any;
declare const PathUtils: any;

function confirmDialog(message: string): boolean {
  return Boolean(ztoolkit.getGlobal("confirm")(message));
}

function alertDialog(message: string): void {
  ztoolkit.getGlobal("alert")(message);
}

/** Pure: first hit with a pdfUrl, preferring higher score order. */
export function pickTopDownloadableHit(hits: OaPdfHit[]): OaPdfHit | null {
  for (const hit of hits || []) {
    if (String(hit.pdfUrl || "").trim()) return hit;
  }
  return null;
}

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

export function federatedHitsToHtml(
  hits: OaPdfHit[],
  meta: { title: string; errors?: Record<string, string>; sources?: string[] },
): string {
  const rows = (hits || [])
    .map((h, i) => {
      const pdf = String(h.pdfUrl || "").trim();
      return `<tr>
  <td>${i + 1}</td>
  <td>${esc(h.score ?? "")}</td>
  <td>${esc(h.source)}</td>
  <td>${esc(h.title)}</td>
  <td class="${pdf ? "ok" : "muted"}">${pdf ? "PDF" : "—"}</td>
</tr>`;
    })
    .join("\n");
  const errLines = Object.entries(meta.errors || {})
    .map(([sid, err]) => `<li><b>${esc(sid)}</b>: ${esc(err)}</li>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"/>
<title>${esc(config.addonName)} — Federated OA</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;padding:20px;margin:0}
.ok{color:#1a7f37}.muted{color:#888}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px;border-bottom:1px solid #8883}
</style></head><body>
<h1>${esc(config.addonName)} — Tüm kaynaklarda ara</h1>
<p>${esc(meta.title)}</p>
<p class="muted">Kaynaklar: ${esc((meta.sources || []).join(", ") || "—")}</p>
${errLines ? `<ul>${errLines}</ul>` : ""}
<table><thead><tr><th>#</th><th>Skor</th><th>Kaynak</th><th>Başlık</th><th>PDF</th></tr></thead>
<tbody>${rows || "<tr><td colspan=5>(sonuç yok)</td></tr>"}</tbody></table>
</body></html>`;
}

async function openFederatedReport(html: string): Promise<void> {
  try {
    const win = Zotero.getMainWindow();
    const tmpPath = PathUtils.join(
      (Zotero as any).getTempDirectory().path,
      `zpdfmanager-federated-${Date.now()}.html`,
    );
    await IOUtils.writeUTF8(tmpPath, html);
    const uri = (Zotero as any).File.pathToFileURI(tmpPath);
    const Zotero_Tabs = (win as any).Zotero_Tabs;
    const { container } = Zotero_Tabs.add({
      type: `${config.addonRef}-federated`,
      title: "Federated OA arama",
      select: true,
      onClose: () => {},
    });
    const browser = (win.document as any).createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("flex", "1");
    browser.setAttribute("src", uri);
    container.appendChild(browser);
  } catch (e) {
    ztoolkit.log("federated report tab failed", e);
  }
}

async function attachHit(item: Zotero.Item, hit: OaPdfHit): Promise<boolean> {
  const url = String(hit.pdfUrl || "").trim();
  if (!url) return false;
  const sourceId = String(hit.source || "oa").trim() || "oa";
  const { downloadAndAttach, rethrowAttachControlFlow } =
    await import("./pdfSources");
  try {
    const bytes = await fetchOaPdfViaBridge({
      source: sourceId,
      pdfUrl: url,
      extra: {
        ...((hit.extra || {}) as Record<string, unknown>),
        landingUrl: hit.landingUrl || undefined,
        pdfUrl: url,
      },
    });
    if (!bytes) return false;
    const att = await downloadAndAttach(item, url, {
      sourceId,
      bytes,
    });
    return !!att;
  } catch (e) {
    rethrowAttachControlFlow(e);
    ztoolkit.log("federated attach failed", e);
    return false;
  }
}

export async function searchAllPdfSourcesForSelection(): Promise<void> {
  const pane = Zotero.getActiveZoteroPane?.() ?? null;
  const items =
    pane?.getSelectedItems?.()?.filter((i: Zotero.Item) => i.isRegularItem()) ??
    [];
  if (!items.length) {
    alertDialog(getString("pdf-federated-empty"));
    return;
  }

  const sources = enabledFederatedSourceIds();
  if (!sources.length) {
    alertDialog(getString("pdf-federated-no-sources"));
    return;
  }

  const popup = new ztoolkit.ProgressWindow(config.addonName, {
    closeTime: -1,
    closeOnClick: false,
  });
  popup.createLine({
    text: getString("pdf-federated-start", {
      args: { count: items.length },
    }),
    type: "default",
    progress: 0,
  });
  popup.show();

  let attached = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const title = String(item.getField("title") || `#${item.id}`);
    popup.changeLine({
      text: `[${i + 1}/${items.length}] ${title.slice(0, 60)}`,
      progress: Math.round(((i + 1) / items.length) * 100),
    });
    try {
      const body = await searchAllOaSources(item, { profile: "full" });
      const hits = Array.isArray(body.hits) ? body.hits : [];
      await openFederatedReport(
        federatedHitsToHtml(hits, {
          title,
          errors: body.errors,
          sources: body.sourcesQueried || sources,
        }),
      );
      const top = pickTopDownloadableHit(hits);
      if (!top) {
        failed++;
        continue;
      }
      const ok = confirmDialog(
        getString("pdf-federated-attach-confirm", {
          args: {
            source: top.source || "?",
            title: String(top.title || "").slice(0, 80),
          },
        }),
      );
      if (!ok) continue;
      const done = await attachHit(item, top);
      if (done) attached++;
      else failed++;
    } catch (e) {
      failed++;
      ztoolkit.log("federated search item failed", item.id, e);
    }
  }

  popup.changeLine({
    text: getString("pdf-federated-done", {
      args: { attached, failed },
    }),
    type: attached ? "success" : "fail",
    progress: 100,
  });
  popup.startCloseTimer(6000);
}
