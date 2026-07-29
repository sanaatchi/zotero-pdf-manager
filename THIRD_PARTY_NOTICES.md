<!-- @ajan: cursor · @etiket: katman-2, lisans, notices -->

# Third-Party Notices

## Zotero Attachment Scanner

Attachment scanning behavior in this project is adapted from
`zotero-attachment-scanner` by W. Chang:

https://github.com/SciImage/zotero-attachment-scanner

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

- https://github.com/wileyyugioh/zotmoov (GPL-3.0)
- https://github.com/ArgilDD/zotero-watch-folder (GPL-3.0)

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

- https://github.com/MuiseDestiny/zotero-attanger (AGPL-3.0)

Attribution: `src/modules/pdfSources.ts`, `src/modules/pdfReconciler.ts`,
`src/modules/automationAudit.ts`, `PDFMANAGER-VENDOR.md`. Combined work remains
AGPL-3.0-or-later.

## Zotero Zotadata (selective / behavior)

P2-4 OA persistence under a library downloads folder (folder as authority)
follows zotadata-style download-to-disk discipline. Sci-Hub is not part of
the automatic cascade:

- https://github.com/PanagiotisKaraliolios/zotero-zotadata

Attribution: `src/modules/oaDownloadPath.ts`, `pdfDownload.ts`, `pdfSources.ts`,
`PDFMANAGER-VENDOR.md`. Treat as AGPL-compatible combined work.
