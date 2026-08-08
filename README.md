<!-- @ajan: cursor · @etiket: katman-2, readme, oa-search, mir-az -->

# Zotero PDF Manager

<p>
  <img src="addon/chrome/content/icons/favicon.png" width="48" height="48" alt="Zotero PDF Manager icon">
</p>

**Zotero PDF Manager** is Katman 2 of the Kutuphane three-addon stack: it matches
PDFs to Zotero items, reconciles watched folders, downloads open-access PDFs, and
keeps attachment metadata consistent. It is **not** Zotero Attanger and **not**
LibRart Pro.

|              |                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| **addonID**  | `zotero-pdf-manager@ibrahimyildiz.art`                                                                     |
| **Version**  | see `package.json`                                                                                         |
| **Zotero**   | 7–10                                                                                                       |
| **License**  | AGPL-3.0-or-later                                                                                          |
| **Releases** | [sanaatchi/zotero-pdf-manager-releases](https://github.com/sanaatchi/zotero-pdf-manager-releases/releases) |
| **Source**   | [sanaatchi/zotero-pdf-manager](https://github.com/sanaatchi/zotero-pdf-manager)                            |

Update URL (prefs):  
`https://github.com/sanaatchi/zotero-pdf-manager-releases/releases/download/update/update.json`

## Role in the three layers

| Layer | Addon                              | Responsibility                                            |
| ----- | ---------------------------------- | --------------------------------------------------------- |
| 1     | Kutuphane Köprü + archive pipeline | OCR, künye, KP, heavy processing                          |
| **2** | **This addon**                     | PDF ↔ item match, metadata, folder reconcile, OA download |
| 3     | LibRart Pro                        | Maps, tags, citations, reading                            |

Do **not** merge the three addons. Data flows 1 → 2 → 3.

## Features

- Multi-root **folder index** (persistent, incremental) + optional linked-attachment base
- Startup / periodic / on-add **reconcile** with confidence thresholds and `#pdf-review`
- **OA download** into `{watchRoot}/downloads/` (DOI, arXiv, PMC, S2, DergiPark automatic list)
- Manual / federated sources include LibGen, PDFKitap, Dirzon, **Mir.az** (login), Zenodo, archive, OpenAIRE, CORE, Sci-Hub, YÖKTez
- **Mir.az credentials:** Preferences → PDF Manager → PDF indirici — _Mir.az e-posta / şifre_ (`pdf.mirAzEmail` / `pdf.mirAzPassword`, password field). Sent per-request to the local 8756 bridge; empty prefs fall back to server env `MIR_AZ_*`. Never logged.
- **OA Search popup** (menubar **PDF Manager → OA Search…**, also Attanger “Search all PDF sources…”): federated results table; attach to selected / new item + PDF / attach + Related Items
- **PDF content audit** (menu): detect wrong attachments via PDF text → `#pdf-mismatch`; auto-download mismatch **keeps** the PDF + tags (no auto-detach; optional manual detach after confirm)
- Orphan PDF report / optional auto-create (pref-gated, dry-run)
- Metadata check, embed, clean; filename → metadata; duplicate PDF merge
- Automation **audit log** + dry-run mode

## Install

1. Download the `.xpi` from
   [releases](https://github.com/sanaatchi/zotero-pdf-manager-releases/releases).
2. Zotero → Tools → Add-ons → gear → Install Add-on From File…
3. Set **watch roots** and OA prefs under Preferences → Zotero PDF Manager.

## Policy note (Sci-Hub / LibGen / YÖKTez)

**Automatic OA** (`AUTOMATIC_ONLINE_SOURCE_IDS`) contacts **DOI (Unpaywall)**,
**DergiPark**, and **PMC** — CAPTCHA-free first. It never calls Sci-Hub, LibGen,
proxy, YÖKTez, arXiv, S2, or ProQuest.

**Turkish journal articles:** DergiPark first; if the item has a DOI, Unpaywall
(`doi`) is also tried. LibGen/PMC/Sci-Hub stay blocked for that path.

**Manual Download / attach** may use LibGen, Sci-Hub, and YÖKTez when their prefs
are enabled. Stock `prefs.js` currently ships those adapters **enabled** and
listed in `sourceOrder` for the manual cascade — that is _not_ the automatic
path. Disable them in Preferences if you do not accept the legal/policy risk.
YÖKTez for theses is intentional on the **manual** path until an explicit auto
policy is chosen (see `CURSOR-KATMAN-2-EKSIKLER-RAPORU.md` G1).

## Build / test

```bash
npm install
npm test
npm run lint:check
npm run build
```

## Docs (in this repo)

| File                                 | Purpose                         |
| ------------------------------------ | ------------------------------- |
| `CURSOR-KATMAN-2-EKSIKLER-RAPORU.md` | Open gaps — read before editing |
| `KATMAN-2-PLAN.md`                   | Layer plan                      |
| `AUTOMATION_PLAN.md`                 | P2-1…P2-6 automation            |
| `PDFMANAGER-VENDOR.md`               | Vendor / port notes             |
| `THIRD_PARTY_NOTICES.md`             | Attribution                     |

Upstream Attanger was a historical starting point; this product identity, IDs,
and release channel are LibRArt / Kutuphane Katman 2 only.
