// @ajan: cursor · @etiket: katman-2, oa-search, window, btn-labels
/**
 * Independent OA Search popup (openDialog) — federated results + attach actions.
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  enabledFederatedSourceIds,
  searchAllOaSourcesByQuery,
  type OaPdfHit,
} from "./oaPdfBridge";
import {
  attachHitToItem,
  attachToSelectedWithRelated,
  createItemFromHit,
} from "./oaSearchActions";

const WINDOW_ID = `${config.addonRef}-oa-search`;

/** Hard fallbacks — Fluent must never wipe button captions to empty. */
const LABEL_FALLBACK: Record<string, string> = {
  "oa-search-title": "OA Arama",
  "oa-search-run": "Ara",
  "oa-search-attach": "Seçiliye ekle",
  "oa-search-create": "Yeni öğe + PDF",
  "oa-search-related": "Seçiliye ekle + Related",
  "oa-search-target-none":
    "Seçili yok — yeni öğe / ilişki için Zotero’da bir kayıt seçin",
  "oa-search-ready": "Sorgu girip Ara’ya basın",
  "oa-search-empty": "Sonuç yok",
  "oa-search-need-query": "Başlık, DOI, ISBN veya yazar girin",
  "oa-search-hint-no-target": "Seçili öğe yok — Zotero’da bir kayıt seçin",
  "oa-search-hint-no-pdf": "PDF’si olan bir sonuç satırı seçin",
  "oa-search-hint-no-hit": "Önce arama yapın, sonra bir satır seçin",
  "oa-search-attaching": "PDF indirilip ekleniyor…",
  "oa-search-attach-ok": "PDF seçili öğeye eklendi",
  "oa-search-attach-fail": "PDF eklenemedi",
  "oa-search-creating": "Öğe oluşturuluyor…",
  "oa-search-searching": "Kaynaklarda aranıyor…",
  "pdf-federated-no-sources": "İndirme kaynağı açık değil (tercihler)",
};

type OaSearchWindowState = NonNullable<typeof addon.data.oaSearch> & {
  hits: OaPdfHit[];
};

function isWindowAlive(win?: Window | null): boolean {
  if (!win) return false;
  try {
    const Cu = (Components as any)?.utils;
    if (Cu?.isDeadWrapper?.(win)) return false;
    return !win.closed;
  } catch {
    return false;
  }
}

function getState(): OaSearchWindowState {
  if (!addon.data.oaSearch) {
    addon.data.oaSearch = {
      hits: [],
      selectedIndex: -1,
      targetItem: null,
    };
  }
  return addon.data.oaSearch as OaSearchWindowState;
}

function firstSelectedRegular(): Zotero.Item | null {
  const pane = Zotero.getActiveZoteroPane?.() ?? null;
  const items =
    pane?.getSelectedItems?.()?.filter((i: Zotero.Item) => i.isRegularItem()) ??
    [];
  return items[0] || null;
}

/** Locale with non-empty fallback (never blank out button labels). */
function uiString(key: string, args?: Record<string, unknown>): string {
  const fallback = LABEL_FALLBACK[key] || key;
  try {
    const s = String(
      (args ? getString(key, { args }) : getString(key)) || "",
    ).trim();
    if (!s) return fallback;
    // Missing Fluent → prefixed key echo
    if (s === `${config.addonRef}-${key}`) return fallback;
    return s;
  } catch {
    return fallback;
  }
}

function waitForWindowLoad(win: Window): Promise<void> {
  return new Promise((resolve) => {
    if (win.document.readyState === "complete") {
      resolve();
      return;
    }
    win.addEventListener("load", () => resolve(), { once: true });
  });
}

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

function setStatus(doc: Document, text: string, isError = false): void {
  const el = doc.getElementById(`${config.addonRef}-oa-status`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function setButtonLabel(
  el: Element | null,
  key: string,
  fallbackAttr?: string,
): void {
  if (!el) return;
  const fromAttr = fallbackAttr
    ? String(el.getAttribute(fallbackAttr) || "").trim()
    : "";
  const text = uiString(key) || fromAttr || LABEL_FALLBACK[key] || key;
  el.textContent = text;
  el.setAttribute("aria-label", text);
}

function refreshTargetBand(doc: Document, item: Zotero.Item | null): void {
  const el = doc.getElementById(`${config.addonRef}-oa-target`);
  if (!el) return;
  if (item) {
    const title = String(item.getField("title") || `#${item.id}`).slice(0, 120);
    el.textContent = uiString("oa-search-target", { title });
    if (!String(el.textContent || "").trim()) {
      el.textContent = `Seçili: ${title}`;
    }
    el.classList.add("has-item");
  } else {
    el.textContent = uiString("oa-search-target-none");
    el.classList.remove("has-item");
  }
}

/** Prefer live Zotero selection so attach enables after pane click. */
function syncTargetFromPane(
  doc: Document,
  state: OaSearchWindowState,
): Zotero.Item | null {
  const live = firstSelectedRegular();
  if (live) state.targetItem = live;
  refreshTargetBand(doc, state.targetItem);
  return state.targetItem;
}

function applyChromeLabels(doc: Document): void {
  const title = doc.getElementById(`${config.addonRef}-oa-title`);
  if (title) title.textContent = uiString("oa-search-title");
  doc.title = uiString("oa-search-title");
  setButtonLabel(
    doc.getElementById(`${config.addonRef}-oa-search`),
    "oa-search-run",
    "data-label",
  );
  setButtonLabel(
    doc.getElementById(`${config.addonRef}-oa-attach`),
    "oa-search-attach",
    "data-label",
  );
  setButtonLabel(
    doc.getElementById(`${config.addonRef}-oa-create`),
    "oa-search-create",
    "data-label",
  );
  setButtonLabel(
    doc.getElementById(`${config.addonRef}-oa-related`),
    "oa-search-related",
    "data-label",
  );
}

function updateActionButtons(doc: Document, state: OaSearchWindowState): void {
  syncTargetFromPane(doc, state);
  applyChromeLabels(doc);

  const hit = state.selectedIndex >= 0 ? state.hits[state.selectedIndex] : null;
  const hasPdf = Boolean(hit && String(hit.pdfUrl || "").trim());
  const hasTarget = Boolean(state.targetItem);
  const attach = doc.getElementById(
    `${config.addonRef}-oa-attach`,
  ) as HTMLButtonElement | null;
  const create = doc.getElementById(
    `${config.addonRef}-oa-create`,
  ) as HTMLButtonElement | null;
  const related = doc.getElementById(
    `${config.addonRef}-oa-related`,
  ) as HTMLButtonElement | null;

  if (attach) {
    attach.disabled = !(hasPdf && hasTarget);
    attach.title = !state.hits.length
      ? uiString("oa-search-hint-no-hit")
      : !hasTarget
        ? uiString("oa-search-hint-no-target")
        : !hasPdf
          ? uiString("oa-search-hint-no-pdf")
          : "";
  }
  if (create) {
    create.disabled = !hasPdf;
    create.title = !hasPdf ? uiString("oa-search-hint-no-pdf") : "";
  }
  if (related) {
    related.disabled = !(hasPdf && hasTarget);
    related.title = attach?.title || "";
  }
}

function renderHits(doc: Document, state: OaSearchWindowState): void {
  const tbody = doc.getElementById(`${config.addonRef}-oa-tbody`);
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!state.hits.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">${esc(
      uiString("oa-search-empty"),
    )}</td></tr>`;
    updateActionButtons(doc, state);
    return;
  }
  state.hits.forEach((hit, i) => {
    const tr = doc.createElement("tr");
    tr.className = "clickable" + (i === state.selectedIndex ? " selected" : "");
    const pdf = String(hit.pdfUrl || "").trim();
    tr.innerHTML = `
      <td class="num">${esc(hit.score ?? "")}</td>
      <td>${esc(hit.source)}</td>
      <td>${esc(hit.title)}</td>
      <td>${esc(hit.year || "")}</td>
      <td class="${pdf ? "ok" : "muted"}">${pdf ? "PDF" : "—"}</td>`;
    tr.addEventListener("click", () => {
      state.selectedIndex = i;
      renderHits(doc, state);
    });
    tbody.appendChild(tr);
  });
  updateActionButtons(doc, state);
}

function prefillFromItem(doc: Document, item: Zotero.Item | null): void {
  if (!item) return;
  const q = doc.getElementById(
    `${config.addonRef}-oa-q`,
  ) as HTMLInputElement | null;
  const doi = doc.getElementById(
    `${config.addonRef}-oa-doi`,
  ) as HTMLInputElement | null;
  const isbn = doc.getElementById(
    `${config.addonRef}-oa-isbn`,
  ) as HTMLInputElement | null;
  const authors = doc.getElementById(
    `${config.addonRef}-oa-authors`,
  ) as HTMLInputElement | null;
  if (q && !q.value) q.value = String(item.getField("title") || "").trim();
  if (doi && !doi.value) doi.value = String(item.getField("DOI") || "").trim();
  if (isbn && !isbn.value)
    isbn.value = String(item.getField("ISBN") || "")
      .replace(/[^0-9Xx]/g, "")
      .trim();
  if (authors && !authors.value) {
    try {
      const creators = item.getCreators?.() || [];
      authors.value = creators
        .slice(0, 4)
        .map(
          (c: any) =>
            `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.name || "",
        )
        .filter(Boolean)
        .join("; ");
    } catch {
      /* ignore */
    }
  }
}

async function runSearch(win: Window): Promise<void> {
  const doc = win.document;
  const state = getState();
  syncTargetFromPane(doc, state);
  const sources = enabledFederatedSourceIds();
  if (!sources.length) {
    setStatus(doc, uiString("pdf-federated-no-sources"), true);
    return;
  }
  const text = (
    doc.getElementById(`${config.addonRef}-oa-q`) as HTMLInputElement
  )?.value?.trim();
  const doi = (
    doc.getElementById(`${config.addonRef}-oa-doi`) as HTMLInputElement
  )?.value?.trim();
  const isbn = (
    doc.getElementById(`${config.addonRef}-oa-isbn`) as HTMLInputElement
  )?.value?.trim();
  const authors = (
    doc.getElementById(`${config.addonRef}-oa-authors`) as HTMLInputElement
  )?.value?.trim();
  if (!text && !doi && !isbn && !authors) {
    setStatus(doc, uiString("oa-search-need-query"), true);
    return;
  }

  setStatus(doc, uiString("oa-search-searching"));
  state.hits = [];
  state.selectedIndex = -1;
  renderHits(doc, state);

  try {
    const body = await searchAllOaSourcesByQuery(
      { text, doi, isbn, authors },
      { profile: "full", totalLimit: 25 },
    );
    state.hits = Array.isArray(body.hits) ? body.hits : [];
    // Prefer first downloadable hit so Attach enables immediately.
    let sel = state.hits.findIndex((h) => String(h.pdfUrl || "").trim());
    if (sel < 0) sel = state.hits.length ? 0 : -1;
    state.selectedIndex = sel;
    renderHits(doc, state);
    const errBits = Object.entries(body.errors || {})
      .map(([sid, err]) => `${sid}: ${err}`)
      .join("; ");
    const base = uiString("oa-search-results", { count: state.hits.length });
    let status = errBits ? `${base} — ${errBits}` : base;
    if (state.hits.length && !hasSelectedPdf(state)) {
      status = `${status} · ${uiString("oa-search-hint-no-pdf")}`;
    } else if (state.hits.length && !state.targetItem) {
      status = `${status} · ${uiString("oa-search-hint-no-target")}`;
    }
    setStatus(doc, status, Boolean(errBits) && !state.hits.length);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(doc, uiString("oa-search-error", { message: msg }), true);
    ztoolkit.log("OA search window failed", e);
  }
}

function hasSelectedPdf(state: OaSearchWindowState): boolean {
  const hit = state.selectedIndex >= 0 ? state.hits[state.selectedIndex] : null;
  return Boolean(hit && String(hit.pdfUrl || "").trim());
}

async function withBusy(doc: Document, fn: () => Promise<void>): Promise<void> {
  const buttons = [
    `${config.addonRef}-oa-attach`,
    `${config.addonRef}-oa-create`,
    `${config.addonRef}-oa-related`,
    `${config.addonRef}-oa-search`,
  ];
  for (const id of buttons) {
    const b = doc.getElementById(id) as HTMLButtonElement | null;
    if (b) b.disabled = true;
  }
  try {
    await fn();
  } finally {
    updateActionButtons(doc, getState());
    const search = doc.getElementById(
      `${config.addonRef}-oa-search`,
    ) as HTMLButtonElement | null;
    if (search) search.disabled = false;
  }
}

function wireActions(win: Window): void {
  const doc = win.document;
  if (doc.documentElement.getAttribute("data-oa-wired") === "1") {
    updateActionButtons(doc, getState());
    return;
  }
  doc.documentElement.setAttribute("data-oa-wired", "1");
  const state = getState();

  doc
    .getElementById(`${config.addonRef}-oa-search`)
    ?.addEventListener("click", () => {
      void runSearch(win);
    });

  for (const id of [
    `${config.addonRef}-oa-q`,
    `${config.addonRef}-oa-doi`,
    `${config.addonRef}-oa-isbn`,
    `${config.addonRef}-oa-authors`,
  ]) {
    doc.getElementById(id)?.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") {
        ev.preventDefault();
        void runSearch(win);
      }
    });
  }

  win.addEventListener("focus", () => {
    updateActionButtons(doc, state);
  });

  doc
    .getElementById(`${config.addonRef}-oa-attach`)
    ?.addEventListener("click", () => {
      void withBusy(doc, async () => {
        syncTargetFromPane(doc, state);
        const hit = state.hits[state.selectedIndex];
        const item = state.targetItem;
        if (!hit || !item) {
          setStatus(
            doc,
            !item
              ? uiString("oa-search-hint-no-target")
              : uiString("oa-search-hint-no-pdf"),
            true,
          );
          return;
        }
        setStatus(doc, uiString("oa-search-attaching"));
        const ok = await attachHitToItem(item, hit);
        setStatus(
          doc,
          ok
            ? uiString("oa-search-attach-ok")
            : uiString("oa-search-attach-fail"),
          !ok,
        );
      });
    });

  doc
    .getElementById(`${config.addonRef}-oa-create`)
    ?.addEventListener("click", () => {
      void withBusy(doc, async () => {
        syncTargetFromPane(doc, state);
        const hit = state.hits[state.selectedIndex];
        if (!hit || !String(hit.pdfUrl || "").trim()) {
          setStatus(doc, uiString("oa-search-hint-no-pdf"), true);
          return;
        }
        const libraryID =
          state.targetItem?.libraryID ?? Zotero.Libraries.userLibraryID;
        setStatus(doc, uiString("oa-search-creating"));
        const item = await createItemFromHit(hit, libraryID, {
          attachPdf: true,
        });
        setStatus(
          doc,
          uiString("oa-search-create-ok", {
            title: String(item.getField("title") || "").slice(0, 80),
          }),
        );
      });
    });

  doc
    .getElementById(`${config.addonRef}-oa-related`)
    ?.addEventListener("click", () => {
      void withBusy(doc, async () => {
        syncTargetFromPane(doc, state);
        const hit = state.hits[state.selectedIndex];
        const item = state.targetItem;
        if (!hit || !item) {
          setStatus(
            doc,
            !item
              ? uiString("oa-search-hint-no-target")
              : uiString("oa-search-hint-no-pdf"),
            true,
          );
          return;
        }
        setStatus(doc, uiString("oa-search-attaching"));
        const { attachmentOk, relatedItem } = await attachToSelectedWithRelated(
          item,
          hit,
        );
        setStatus(
          doc,
          uiString("oa-search-related-ok", {
            attached: attachmentOk ? "yes" : "no",
            title: String(relatedItem?.getField("title") || "").slice(0, 80),
          }),
          !attachmentOk,
        );
      });
    });
}

export async function initOaSearchWindow(win: Window): Promise<void> {
  const doc = win.document;
  const state = getState();
  state.targetItem = firstSelectedRegular();
  state.hits = [];
  state.selectedIndex = -1;

  applyChromeLabels(doc);
  refreshTargetBand(doc, state.targetItem);
  prefillFromItem(doc, state.targetItem);
  renderHits(doc, state);
  setStatus(doc, uiString("oa-search-ready"));
  wireActions(win);
  updateActionButtons(doc, state);
}

export async function openOaSearchWindow(): Promise<void> {
  const state = getState();
  if (isWindowAlive(state.window)) {
    try {
      updateActionButtons(state.window!.document, state);
      prefillFromItem(state.window!.document, state.targetItem);
    } catch {
      /* ignore */
    }
    state.window!.focus();
    return;
  }

  const mainWin = Zotero.getMainWindow();
  if (!mainWin) return;

  const url = `chrome://${config.addonRef}/content/oa-search.xhtml`;
  const features =
    "chrome,centerscreen,resizable,dialog=no,width=960,height=720";
  const win =
    (mainWin.openDialog(url, WINDOW_ID, features) as Window | null) ||
    (mainWin.open(url, WINDOW_ID, features) as Window | null);
  if (!win) return;

  state.window = win;
  win.addEventListener("unload", () => {
    if (getState().window === win) {
      getState().window = undefined;
    }
  });

  await waitForWindowLoad(win);
  await initOaSearchWindow(win);
}
