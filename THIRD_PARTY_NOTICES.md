<!-- @ajan: cursor · @etiket: katman-2, lisans, notices, provenance, b4-lint -->

# Third-Party Notices

Pinned SHAs and path mapping: [`PDFMANAGER-VENDOR.md`](PDFMANAGER-VENDOR.md).

## Zotero Attachment Scanner

Attachment scanning behavior in this project is adapted from
`zotero-attachment-scanner` by W. Chang:

https://github.com/SciImage/zotero-attachment-scanner  
Pinned review SHA: `bd64d535edb265a336bbdeb661fd4cd896aacf22`

MIT License

Copyright (c) 2024 W. Chang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ZotMoov / Zotero Watch Folder (behavior reference)

P2-1 linked-base merge and multi-root incremental indexing were informed by
behavior review of:

- https://github.com/wileyyugioh/zotmoov (GPL-3.0) —
  SHA `8fb20ab8baebe6976b2a281b40bc48910bc3ca62`
- https://github.com/josesiqueira/zotero-watch-folder (GPL-3.0; local mirror) —
  SHA `07068206dce23a4ad261c208734d318078108425`

No substantial source was copied into this repository for those features;
attribution lives in `src/modules/folderIndex.ts` and `PDFMANAGER-VENDOR.md`.
Full GPL texts accompany those upstream projects.

P2-5 orphan-mode handling and identifier-gated automatic item creation follow
watch-folder’s fail-closed / metadata-fallback safety posture (no blind mass
create on periodic scans). Attribution: `src/modules/orphanProcessor.ts`.

## Zotero Attanger (selective / behavior)

P2-2 match confidence thresholds and add-item settle debounce were informed by
Attanger's safe-auto vs review patterns and notifier debounce.
P2-3 add-flush drain loop, attachment→parent expansion, and trash/delete
cancellation follow Attanger's `queueAddedItems` / `flushAddedItems` behavior:

- https://github.com/MuiseDestiny/zotero-attanger (AGPL-3.0) —
  SHA `a1f98bfab1dc487ee84fdd9d2533d20596d4aea1`

Attribution: `src/modules/pdfSources.ts`, `src/modules/pdfReconciler.ts`,
`src/modules/automationAudit.ts`, `PDFMANAGER-VENDOR.md`. Combined work remains
AGPL-3.0-or-later.

## Zotero Zotadata (selective / behavior)

P2-4 OA persistence under a library downloads folder (folder as authority)
follows zotadata-style download-to-disk discipline. Sci-Hub is not part of
the automatic cascade:

- https://github.com/ydeng11/zotero-zotadata (local mirror; treat as AGPL) —
  SHA `ad1a8143ae48ea2750fa5bd647921c529a4b17a7`

Attribution: `src/modules/oaDownloadPath.ts`, `pdfDownload.ts`, `pdfSources.ts`,
`PDFMANAGER-VENDOR.md`. Treat as AGPL-compatible combined work.

## Zotero Format Metadata (selective)

Identifier / light field normalization in `metadataNormalize.ts` and
`metadataCheck.ts` adapts ideas from:

https://github.com/northword/zotero-format-metadata  
Pinned review SHA: `39db0a31f5848329d2c34ffe3470bbcabb3ffc34`

AGPL-3.0. Selective ports include DOI prefix strip, pages connector/range,
title trailing-dot, ISBN-10↔13, language/thesis/zeros helpers, creators-case,
and Extra field reorder. Journal abbreviation was **not** ported. Not the
full rule engine.

## Delete Item With Attachment (selective / behavior)

Linked-file disk unlink + attachment trash menus adapt the safety posture of:

https://github.com/redleafnew/delitemwithatt  
Pinned review SHA: `d2eaeedb40619f4d2fbe0b7b615016c01e85bdbd`

GPL-3.0. Local mirror: `referanslar/katman-2/ek-silme/delitemwithatt`.
Ported behavior only (confirm → unlink LINKED_FILE → trash attachment /
optional parent item). Language/export/collection wipe features were **not**
ported. Attribution: `src/modules/attachmentDelete.ts`,
`src/utils/attachmentDeletePlan.ts`, `PDFMANAGER-VENDOR.md`.

## Zoplicate (companion XPI — not vendored)

Item-level duplicate merge is **not** embedded. Install Zoplicate alongside
PDF Manager when master-merge UX is needed:

https://github.com/ChenglongMa/zoplicate  
Local mirror review SHA: `6e93d9fc53d14e8c971b74882d9ac55295374a37`

AGPL-3.0. PDF Manager only ships a read-only DOI/ISBN/KP candidate report
(`duplicateItemReport.ts`).
