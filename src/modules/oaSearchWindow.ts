// @ajan: cursor · @etiket: katman-2, oa-search, window, source-picker
/**
 * Independent OA Search popup (openDialog) — federated results + attach actions.
 * UX: per-search source picker, PDF-only filter, keyboard nav, double-click apply,
 * auto-search on open, source/error summary. Selection optional for search.
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import {
  allFederatedSourceIds,
  FEDERATED_SOURCE_LABEL,
  loadOaSearchSourceSelection,
  saveOaSearchSourceSelection,
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
  "oa-search-pdf-only": "Yalnızca PDF",
  "oa-search-sources": "Kaynaklar",
  "oa-search-sources-all": "Tümü",
  "oa-search-sources-none": "Hiçbiri",
  "oa-search-need-sources": "En az bir arama kaynağı seçin",
  "oa-search-target-none":
    "Seçim yok (arama için gerekmez). Seçiliye ekle / Related için Zotero’da kayıt seçin",
  "oa-search-ready": "Sorgu yazıp Ara’ya basın — Zotero seçimi zorunlu değil",
  "oa-search-empty": "Sonuç yok",
  "oa-search-need-query": "Başlık, DOI, ISBN veya yazar girin",
  "oa-search-hint-no-target":
    "Seçili öğe yok — Seçiliye ekle / Related için Zotero’da bir kayıt seçin",
  "oa-search-hint-no-pdf": "PDF’si olan bir sonuç satırı seçin",
  "oa-search-hint-no-hit": "Önce arama yapın, sonra bir satır seçin",
  "oa-search-attaching": "PDF indirilip ekleniyor…",
  "oa-search-attach-ok": "PDF seçili öğeye eklendi",
  "oa-search-attach-fail": "PDF eklenemedi",
  "oa-search-creating": "Öğe oluşturuluyor…",
  "oa-search-searching": "Kaynaklarda aranıyor…",
  "oa-search-results": "{count} sonuç",
  "oa-search-load-fail": "OA Arama penceresi yüklenemedi",
  "oa-search-dblclick-hint": "Çift tık: seçiliye ekle (yoksa yeni öğe)",
  "pdf-federated-no-sources": "İndirme kaynağı açık değil (tercihler)",
};

type OaSearchMeta = {
  sourcesQueried: string[];
  errors: Record<string, string>;
};

type OaSearchWindowState = {
  window?: Window;
  rawHits: OaPdfHit[];
  hits: OaPdfHit[];
  selectedIndex: number;
  targetItem: Zotero.Item | null;
  pdfOnly: boolean;
  selectedSources: string[];
  meta: OaSearchMeta;
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
  const data = addon.data as typeof addon.data & {
    oaSearch?: OaSearchWindowState;
  };
  if (!data.oaSearch) {
    data.oaSearch = {
      rawHits: [],
      hits: [],
      selectedIndex: -1,
      targetItem: null,
      pdfOnly: true,
      selectedSources: loadOaSearchSourceSelection(),
      meta: { sourcesQueried: [], errors: {} },
    };
  }
  const s = data.oaSearch;
  if (!Array.isArray(s.rawHits)) s.rawHits = [];
  if (typeof s.pdfOnly !== "boolean") s.pdfOnly = true;
  if (!Array.isArray(s.selectedSources)) {
    s.selectedSources = loadOaSearchSourceSelection();
  }
  if (!s.meta) s.meta = { sourcesQueried: [], errors: {} };
  return s;
}

function firstSelectedRegular(): Zotero.Item | null {
  const pane = Zotero.getActiveZoteroPane?.() ?? null;
  const items =
    pane?.getSelectedItems?.()?.filter((i: Zotero.Item) => i.isRegularItem()) ??
    [];
  return items[0] || null;
}

function uiString(key: string, args?: Record<string, unknown>): string {
  const fallback = LABEL_FALLBACK[key] || key;
  try {
    const s = String(
      (args ? getString(key, { args }) : getString(key)) || "",
    ).trim();
    if (!s) return fallback;
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

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const schedule =
      (typeof setTimeout === "function" ? setTimeout : null) ||
      Zotero.getMainWindow()?.setTimeout?.bind(Zotero.getMainWindow()) ||
      globalThis.setTimeout;
    schedule(resolve, ms);
  });
}

async function waitForOaDom(win: Window): Promise<Document> {
  const shellId = `${config.addonRef}-oa-shell`;
  const searchId = `${config.addonRef}-oa-search`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if (!isWindowAlive(win)) break;
      const doc = win.document;
      if (doc?.getElementById(shellId) && doc.getElementById(searchId)) {
        return doc;
      }
    } catch {
      /* ignore */
    }
    await delayMs(50);
  }
  throw new Error(uiString("oa-search-load-fail"));
}

function bindSearchTrigger(win: Window, el: Element | null): void {
  if (!el) return;
  const run = (ev?: Event) => {
    try {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
    } catch {
      /* ignore */
    }
    void runSearch(win);
  };
  el.addEventListener("click", run);
  el.addEventListener("command", run);
  (el as any).onclick = run;
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

function hitHasPdf(hit: OaPdfHit | null | undefined): boolean {
  return Boolean(hit && String(hit.pdfUrl || "").trim());
}

/** PDF-first, then score descending. */
export function rankOaHits(hits: OaPdfHit[]): OaPdfHit[] {
  return [...(hits || [])].sort((a, b) => {
    const pa = hitHasPdf(a) ? 1 : 0;
    const pb = hitHasPdf(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return Number(b.score || 0) - Number(a.score || 0);
  });
}

export function filterOaHits(hits: OaPdfHit[], pdfOnly: boolean): OaPdfHit[] {
  const ranked = rankOaHits(hits);
  if (!pdfOnly) return ranked;
  return ranked.filter((h) => hitHasPdf(h));
}

function applyHitFilter(state: OaSearchWindowState): void {
  const prev =
    state.selectedIndex >= 0 ? state.hits[state.selectedIndex] : null;
  state.hits = filterOaHits(state.rawHits, state.pdfOnly);
  if (!state.hits.length) {
    state.selectedIndex = -1;
    return;
  }
  if (prev) {
    const idx = state.hits.findIndex(
      (h) =>
        h === prev ||
        (h.source === prev.source &&
          h.title === prev.title &&
          (h.pdfUrl || "") === (prev.pdfUrl || "")),
    );
    state.selectedIndex = idx >= 0 ? idx : 0;
  } else {
    state.selectedIndex = 0;
  }
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
  const pdfOnlyLabel = doc.getElementById(
    `${config.addonRef}-oa-pdf-only-label`,
  );
  if (pdfOnlyLabel) pdfOnlyLabel.textContent = uiString("oa-search-pdf-only");
  const sourcesLabel = doc.getElementById(
    `${config.addonRef}-oa-sources-label`,
  );
  if (sourcesLabel) sourcesLabel.textContent = uiString("oa-search-sources");
  setButtonLabel(
    doc.getElementById(`${config.addonRef}-oa-sources-all`),
    "oa-search-sources-all",
    "data-label",
  );
  setButtonLabel(
    doc.getElementById(`${config.addonRef}-oa-sources-none`),
    "oa-search-sources-none",
    "data-label",
  );
}

function sourceLabel(id: string): string {
  return FEDERATED_SOURCE_LABEL[id] || id;
}

function readSelectedSources(doc: Document): string[] {
  const known = allFederatedSourceIds();
  const out: string[] = [];
  for (const id of known) {
    const el = doc.getElementById(
      `${config.addonRef}-oa-src-${id}`,
    ) as HTMLInputElement | null;
    if (el?.checked) out.push(id);
  }
  return out;
}

function persistSelectedSources(
  doc: Document,
  state: OaSearchWindowState,
): string[] {
  const selected = readSelectedSources(doc);
  state.selectedSources = selected;
  saveOaSearchSourceSelection(selected);
  return selected;
}

function renderSourcePicker(doc: Document, state: OaSearchWindowState): void {
  const host = doc.getElementById(`${config.addonRef}-oa-sources`);
  if (!host) return;
  const selected = new Set(
    state.selectedSources.length
      ? state.selectedSources
      : loadOaSearchSourceSelection(),
  );
  host.innerHTML = "";
  for (const id of allFederatedSourceIds()) {
    const label = doc.createElement("label");
    const input = doc.createElement("input");
    input.type = "checkbox";
    input.id = `${config.addonRef}-oa-src-${id}`;
    input.value = id;
    input.checked = selected.has(id);
    input.addEventListener("change", () => {
      persistSelectedSources(doc, state);
    });
    const span = doc.createElement("span");
    span.textContent = sourceLabel(id);
    label.appendChild(input);
    label.appendChild(span);
    host.appendChild(label);
  }
  state.selectedSources = [...selected].filter((id) =>
    allFederatedSourceIds().includes(id),
  );
}

function setAllSources(
  doc: Document,
  state: OaSearchWindowState,
  on: boolean,
): void {
  for (const id of allFederatedSourceIds()) {
    const el = doc.getElementById(
      `${config.addonRef}-oa-src-${id}`,
    ) as HTMLInputElement | null;
    if (el) el.checked = on;
  }
  persistSelectedSources(doc, state);
}

function updateActionButtons(doc: Document, state: OaSearchWindowState): void {
  syncTargetFromPane(doc, state);
  applyChromeLabels(doc);

  const hit = state.selectedIndex >= 0 ? state.hits[state.selectedIndex] : null;
  const hasPdf = hitHasPdf(hit);
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
          : uiString("oa-search-dblclick-hint");
  }
  if (create) {
    create.disabled = !hasPdf;
    create.title = !hasPdf
      ? uiString("oa-search-hint-no-pdf")
      : uiString("oa-search-dblclick-hint");
  }
  if (related) {
    related.disabled = !(hasPdf && hasTarget);
    related.title = attach?.title || "";
  }

  const pdfOnly = doc.getElementById(
    `${config.addonRef}-oa-pdf-only`,
  ) as HTMLInputElement | null;
  if (pdfOnly) pdfOnly.checked = state.pdfOnly;
}

function shortErr(msg: string): string {
  return String(msg || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function formatResultStatus(state: OaSearchWindowState): string {
  const n = state.hits.length;
  const raw = state.rawHits.length;
  const base =
    state.pdfOnly && raw !== n
      ? `${uiString("oa-search-results", { count: n })} (${raw} toplam)`
      : uiString("oa-search-results", { count: n });
  const src = (state.meta.sourcesQueried || []).join(", ");
  const errEntries = Object.entries(state.meta.errors || {});
  const errBits = errEntries
    .slice(0, 4)
    .map(([sid, err]) => `${sid}: ${shortErr(err)}`)
    .join(" · ");
  let status = src ? `${base} · ${src}` : base;
  if (errBits) status = `${status} · ⚠ ${errBits}`;
  if (n && !hitHasPdf(state.hits[state.selectedIndex])) {
    status = `${status} · ${uiString("oa-search-hint-no-pdf")}`;
  } else if (n && !state.targetItem) {
    status = `${status} · ${uiString("oa-search-hint-no-target")}`;
  }
  return status;
}

function renderHits(doc: Document, state: OaSearchWindowState): void {
  const tbody = doc.getElementById(`${config.addonRef}-oa-tbody`);
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!state.hits.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">${esc(
      uiString("oa-search-empty"),
    )}</td></tr>`;
    updateActionButtons(doc, state);
    return;
  }
  state.hits.forEach((hit, i) => {
    const tr = doc.createElement("tr");
    tr.className = "clickable" + (i === state.selectedIndex ? " selected" : "");
    tr.setAttribute("tabindex", "0");
    const pdf = String(hit.pdfUrl || "").trim();
    const doi = String(hit.doi || "").trim();
    const landing = String(hit.landingUrl || "").trim();
    tr.innerHTML = `
      <td class="num">${esc(hit.score ?? "")}</td>
      <td>${esc(hit.source)}</td>
      <td>
        <div class="hit-title">${esc(hit.title)}</div>
        ${
          doi
            ? `<div class="hit-meta muted">DOI ${esc(doi)}</div>`
            : landing
              ? `<div class="hit-meta muted">${esc(landing.slice(0, 60))}</div>`
              : ""
        }
      </td>
      <td>${esc(hit.year || "")}</td>
      <td class="${pdf ? "ok" : "muted"}">${pdf ? "PDF" : "—"}</td>
      <td class="muted">${esc((hit.authors || "").toString().slice(0, 40))}</td>`;
    tr.addEventListener("click", () => {
      state.selectedIndex = i;
      renderHits(doc, state);
    });
    tr.addEventListener("dblclick", () => {
      state.selectedIndex = i;
      void applyPrimaryAction(doc, state);
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

function readQuery(doc: Document): {
  text: string;
  doi: string;
  isbn: string;
  authors: string;
} {
  return {
    text: (
      doc.getElementById(`${config.addonRef}-oa-q`) as HTMLInputElement
    )?.value?.trim(),
    doi: (
      doc.getElementById(`${config.addonRef}-oa-doi`) as HTMLInputElement
    )?.value?.trim(),
    isbn: (
      doc.getElementById(`${config.addonRef}-oa-isbn`) as HTMLInputElement
    )?.value?.trim(),
    authors: (
      doc.getElementById(`${config.addonRef}-oa-authors`) as HTMLInputElement
    )?.value?.trim(),
  };
}

async function applyPrimaryAction(
  doc: Document,
  state: OaSearchWindowState,
): Promise<void> {
  syncTargetFromPane(doc, state);
  const hit = state.hits[state.selectedIndex];
  if (!hitHasPdf(hit)) {
    setStatus(doc, uiString("oa-search-hint-no-pdf"), true);
    return;
  }
  await withBusy(doc, async () => {
    if (state.targetItem) {
      setStatus(doc, uiString("oa-search-attaching"));
      const ok = await attachHitToItem(state.targetItem, hit);
      setStatus(
        doc,
        ok
          ? uiString("oa-search-attach-ok")
          : uiString("oa-search-attach-fail"),
        !ok,
      );
      return;
    }
    const libraryID = Zotero.Libraries.userLibraryID;
    setStatus(doc, uiString("oa-search-creating"));
    const item = await createItemFromHit(hit, libraryID, { attachPdf: true });
    setStatus(
      doc,
      uiString("oa-search-create-ok", {
        title: String(item.getField("title") || "").slice(0, 80),
      }),
    );
  });
}

async function runSearch(win: Window): Promise<void> {
  const doc = win.document;
  const state = getState();
  syncTargetFromPane(doc, state);

  const searchBtn = doc.getElementById(
    `${config.addonRef}-oa-search`,
  ) as HTMLButtonElement | null;
  if (searchBtn) searchBtn.disabled = true;

  try {
    const sources = persistSelectedSources(doc, state);
    if (!sources.length) {
      setStatus(doc, uiString("oa-search-need-sources"), true);
      return;
    }

    const { text, doi, isbn, authors } = readQuery(doc);
    if (!text && !doi && !isbn && !authors) {
      setStatus(doc, uiString("oa-search-need-query"), true);
      return;
    }

    setStatus(
      doc,
      `${uiString("oa-search-searching")} (${sources.join(", ")})`,
    );
    state.rawHits = [];
    state.hits = [];
    state.selectedIndex = -1;
    state.meta = { sourcesQueried: sources.slice(), errors: {} };
    renderHits(doc, state);

    try {
      const body = await searchAllOaSourcesByQuery(
        { text, doi, isbn, authors },
        {
          profile: "full",
          totalLimit: 40,
          sources,
        },
      );
      state.rawHits = Array.isArray(body.hits) ? body.hits : [];
      state.meta = {
        sourcesQueried: body.sourcesQueried || sources,
        errors: body.errors || {},
      };
      applyHitFilter(state);
      renderHits(doc, state);
      setStatus(
        doc,
        formatResultStatus(state),
        Boolean(Object.keys(state.meta.errors).length) && !state.hits.length,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(doc, uiString("oa-search-error", { message: msg }), true);
      ztoolkit.log("OA search window failed", e);
    }
  } finally {
    if (searchBtn) searchBtn.disabled = false;
    updateActionButtons(doc, state);
  }
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

function moveSelection(
  doc: Document,
  state: OaSearchWindowState,
  delta: number,
): void {
  if (!state.hits.length) return;
  const next = Math.max(
    0,
    Math.min(
      state.hits.length - 1,
      (state.selectedIndex < 0 ? 0 : state.selectedIndex) + delta,
    ),
  );
  state.selectedIndex = next;
  renderHits(doc, state);
  const rows = doc.querySelectorAll(
    `#${config.addonRef}-oa-tbody tr.clickable`,
  );
  const row = rows[next] as HTMLElement | undefined;
  row?.scrollIntoView?.({ block: "nearest" });
}

function wireActions(win: Window): void {
  const doc = win.document;
  if (doc.documentElement.getAttribute("data-oa-wired") === "1") {
    updateActionButtons(doc, getState());
    return;
  }
  doc.documentElement.setAttribute("data-oa-wired", "1");
  const state = getState();

  bindSearchTrigger(win, doc.getElementById(`${config.addonRef}-oa-search`));

  doc
    .getElementById(`${config.addonRef}-oa-sources-all`)
    ?.addEventListener("click", () => {
      setAllSources(doc, state, true);
    });
  doc
    .getElementById(`${config.addonRef}-oa-sources-none`)
    ?.addEventListener("click", () => {
      setAllSources(doc, state, false);
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

  const pdfOnly = doc.getElementById(
    `${config.addonRef}-oa-pdf-only`,
  ) as HTMLInputElement | null;
  pdfOnly?.addEventListener("change", () => {
    state.pdfOnly = Boolean(pdfOnly.checked);
    applyHitFilter(state);
    renderHits(doc, state);
    setStatus(doc, formatResultStatus(state));
  });

  win.addEventListener("focus", () => {
    updateActionButtons(doc, state);
  });

  doc.addEventListener("keydown", (ev) => {
    const ke = ev as KeyboardEvent;
    const tag = ((ev.target as HTMLElement)?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (ke.key === "ArrowDown") {
      ke.preventDefault();
      moveSelection(doc, state, 1);
    } else if (ke.key === "ArrowUp") {
      ke.preventDefault();
      moveSelection(doc, state, -1);
    } else if (ke.key === "Enter") {
      ke.preventDefault();
      void applyPrimaryAction(doc, state);
    }
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
        if (!hitHasPdf(hit)) {
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
  await waitForOaDom(win);
  const doc = win.document;
  const state = getState();
  state.targetItem = firstSelectedRegular();
  state.rawHits = [];
  state.hits = [];
  state.selectedIndex = -1;
  state.pdfOnly = true;
  state.selectedSources = loadOaSearchSourceSelection();
  state.meta = { sourcesQueried: [], errors: {} };

  applyChromeLabels(doc);
  refreshTargetBand(doc, state.targetItem);
  prefillFromItem(doc, state.targetItem);
  renderSourcePicker(doc, state);
  renderHits(doc, state);
  setStatus(doc, uiString("oa-search-ready"));
  wireActions(win);
  updateActionButtons(doc, state);

  // Auto-search when fields already have a query (e.g. from selected item).
  const q = readQuery(doc);
  if (q.text || q.doi || q.isbn || q.authors) {
    void runSearch(win);
  }
}

export async function openOaSearchWindow(): Promise<void> {
  const state = getState();
  if (isWindowAlive(state.window)) {
    try {
      await waitForOaDom(state.window!);
      state.targetItem = firstSelectedRegular();
      updateActionButtons(state.window!.document, state);
      prefillFromItem(state.window!.document, state.targetItem);
      setStatus(state.window!.document, uiString("oa-search-ready"));
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
    "chrome,centerscreen,resizable,dialog=no,width=1020,height=740";
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
