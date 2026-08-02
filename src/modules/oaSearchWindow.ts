// @ajan: cursor · @etiket: katman-2, oa-search, window
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

function refreshTargetBand(doc: Document, item: Zotero.Item | null): void {
  const el = doc.getElementById(`${config.addonRef}-oa-target`);
  if (!el) return;
  if (item) {
    const title = String(item.getField("title") || `#${item.id}`);
    el.textContent = getString("oa-search-target", {
      args: { title: title.slice(0, 120) },
    });
    el.classList.add("has-item");
  } else {
    el.textContent = getString("oa-search-target-none");
    el.classList.remove("has-item");
  }
}

function updateActionButtons(doc: Document, state: OaSearchWindowState): void {
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
  if (attach) attach.disabled = !(hasPdf && hasTarget);
  if (create) create.disabled = !hasPdf;
  if (related) related.disabled = !(hasPdf && hasTarget);
}

function renderHits(doc: Document, state: OaSearchWindowState): void {
  const tbody = doc.getElementById(`${config.addonRef}-oa-tbody`);
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!state.hits.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">${esc(
      getString("oa-search-empty"),
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
  const sources = enabledFederatedSourceIds();
  if (!sources.length) {
    setStatus(doc, getString("pdf-federated-no-sources"), true);
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
    setStatus(doc, getString("oa-search-need-query"), true);
    return;
  }

  setStatus(doc, getString("oa-search-searching"));
  state.hits = [];
  state.selectedIndex = -1;
  renderHits(doc, state);

  try {
    const body = await searchAllOaSourcesByQuery(
      { text, doi, isbn, authors },
      { profile: "full", totalLimit: 25 },
    );
    state.hits = Array.isArray(body.hits) ? body.hits : [];
    state.selectedIndex = state.hits.length ? 0 : -1;
    renderHits(doc, state);
    const errBits = Object.entries(body.errors || {})
      .map(([sid, err]) => `${sid}: ${err}`)
      .join("; ");
    const base = getString("oa-search-results", {
      args: { count: state.hits.length },
    });
    setStatus(
      doc,
      errBits ? `${base} — ${errBits}` : base,
      Boolean(errBits) && !state.hits.length,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(
      doc,
      getString("oa-search-error", { args: { message: msg } }),
      true,
    );
    ztoolkit.log("OA search window failed", e);
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

function wireActions(win: Window): void {
  const doc = win.document;
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

  doc
    .getElementById(`${config.addonRef}-oa-attach`)
    ?.addEventListener("click", () => {
      void withBusy(doc, async () => {
        const hit = state.hits[state.selectedIndex];
        const item = state.targetItem;
        if (!hit || !item) return;
        setStatus(doc, getString("oa-search-attaching"));
        const ok = await attachHitToItem(item, hit);
        setStatus(
          doc,
          ok
            ? getString("oa-search-attach-ok")
            : getString("oa-search-attach-fail"),
          !ok,
        );
      });
    });

  doc
    .getElementById(`${config.addonRef}-oa-create`)
    ?.addEventListener("click", () => {
      void withBusy(doc, async () => {
        const hit = state.hits[state.selectedIndex];
        if (!hit) return;
        const libraryID =
          state.targetItem?.libraryID ?? Zotero.Libraries.userLibraryID;
        setStatus(doc, getString("oa-search-creating"));
        const item = await createItemFromHit(hit, libraryID, {
          attachPdf: true,
        });
        setStatus(
          doc,
          getString("oa-search-create-ok", {
            args: { title: String(item.getField("title") || "").slice(0, 80) },
          }),
        );
      });
    });

  doc
    .getElementById(`${config.addonRef}-oa-related`)
    ?.addEventListener("click", () => {
      void withBusy(doc, async () => {
        const hit = state.hits[state.selectedIndex];
        const item = state.targetItem;
        if (!hit || !item) return;
        setStatus(doc, getString("oa-search-attaching"));
        const { attachmentOk, relatedItem } = await attachToSelectedWithRelated(
          item,
          hit,
        );
        setStatus(
          doc,
          getString("oa-search-related-ok", {
            args: {
              attached: attachmentOk ? "yes" : "no",
              title: String(relatedItem?.getField("title") || "").slice(0, 80),
            },
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

  doc.title = getString("oa-search-title");
  const title = doc.getElementById(`${config.addonRef}-oa-title`);
  if (title) title.textContent = getString("oa-search-title");

  const labels: Array<[string, string]> = [
    [`${config.addonRef}-oa-search`, "oa-search-run"],
    [`${config.addonRef}-oa-attach`, "oa-search-attach"],
    [`${config.addonRef}-oa-create`, "oa-search-create"],
    [`${config.addonRef}-oa-related`, "oa-search-related"],
  ];
  for (const [id, key] of labels) {
    const el = doc.getElementById(id);
    if (el) el.textContent = getString(key);
  }

  refreshTargetBand(doc, state.targetItem);
  prefillFromItem(doc, state.targetItem);
  renderHits(doc, state);
  setStatus(doc, getString("oa-search-ready"));
  wireActions(win);
}

export async function openOaSearchWindow(): Promise<void> {
  const state = getState();
  if (isWindowAlive(state.window)) {
    state.targetItem = firstSelectedRegular();
    try {
      refreshTargetBand(state.window!.document, state.targetItem);
      prefillFromItem(state.window!.document, state.targetItem);
      updateActionButtons(state.window!.document, state);
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
