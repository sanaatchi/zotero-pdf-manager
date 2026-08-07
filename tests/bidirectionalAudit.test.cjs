// @ajan: cursor · @etiket: katman-2, bidirectional-audit, match-suggest, human-md-report, quarantine-only, clear-score-tighten, soft-neg, dry-run-ux, bidir-apply-report, test
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const root = process.cwd();

test("bidirectionalAudit module surface", () => {
  const src = fs.readFileSync(
    path.join(root, "src/modules/bidirectionalAudit.ts"),
    "utf8",
  );
  assert.match(src, /runBidirectionalAudit/);
  assert.match(src, /runBidirectionalAuditWithProgress/);
  assert.match(src, /runBidirectionalApplyWithProgress/);
  assert.match(src, /runBidirectionalCopiesApplyWithProgress/);
  assert.match(src, /applyBidirectionalSuggestions/);
  assert.match(src, /quarantineOnly/);
  assert.match(src, /matches:\s*false|matches\?/);
  assert.match(src, /openLastBidirectionalReport/);
  assert.match(src, /formatBidirectionalMarkdown/);
  assert.match(src, /last-bidirectional\.md/);
  assert.match(src, /özet: last-bidirectional\.md/);
  assert.match(src, /pathLooksQuarantined/);
  assert.match(src, /extractRomanVolumeToken/);
  assert.match(src, /romanVolumesConflict/);
  assert.match(src, /isClearMatchCandidate/);
  assert.match(src, /Uygulanmadı — deneme açık/);
  assert.match(src, /isUnderQuarantine/);
  assert.match(src, /softEditionMarkersConflict/);
  assert.match(src, /suggestAlternatePaths/);
  assert.match(src, /safeFilename/);
  assert.match(src, /safePathKey/);
  assert.match(src, /from ["']\.\.\/utils\/safePath["']/);
  assert.match(src, /suggestOrphanToMissingMatches/);
  assert.match(src, /basenameSoftVariants/);
  assert.match(src, /orphan_to_broken/);
  assert.match(src, /broken_alt_path/);
  assert.match(src, /filterHashVerifiedLosers/);
  assert.match(src, /siblingDownloadsRoots/);
  assert.match(src, /walkPdfEntries/);
  assert.match(src, /filenameItemTypeMismatch/);
  assert.match(src, /groupCrossFolderDuplicates/);
  assert.match(src, /typeConflict/);
  assert.match(src, /crossFolder/);
  assert.match(src, /matchSuggestions/);
  assert.match(src, /kind: \"bidirectional\"/);
  assert.match(src, /Yalnız kopyalar/);
});

test("B1 apply writes last-bidirectional-apply — does not clobber Tara last", () => {
  const src = fs.readFileSync(
    path.join(root, "src/modules/bidirectionalAudit.ts"),
    "utf8",
  );
  assert.match(src, /writeBidirApplyReport/);
  assert.match(src, /last-bidirectional-apply\.json/);
  assert.match(src, /last-bidirectional-apply\.md/);
  assert.match(src, /disk-audit-bidirectional-apply-/);
  // Apply path must call apply writer, not Tara writer.
  const applyFn = src.slice(
    src.indexOf("export async function applyBidirectionalSuggestions"),
  );
  assert.match(applyFn, /await writeBidirApplyReport\(/);
  assert.doesNotMatch(applyFn, /await writeBidirReport\(/);
  // Tara openLast still points at scan last-*.
  const openFn = src.slice(
    src.indexOf("export async function openLastBidirectionalReport"),
  );
  const openBody = openFn.slice(
    0,
    openFn.indexOf("export async function applyBidirectionalSuggestions"),
  );
  assert.match(openBody, /last-bidirectional\.md/);
  assert.match(openBody, /last-bidirectional\.json/);
  assert.doesNotMatch(openBody, /last-bidirectional-apply/);
});

test("B4 hashSkipped fail-closed — no name+size verifiedLosers restore", () => {
  const src = fs.readFileSync(
    path.join(root, "src/modules/bidirectionalAudit.ts"),
    "utf8",
  );
  assert.match(src, /refusing name\+size losers \(fail-closed\)/);
  // Old fail-open restore must be gone.
  assert.equal(
    src.includes('ztoolkit.log("bidir hash verify failed — using name+size'),
    false,
  );
  assert.equal(src.includes("keep name+size losers"), false);
  assert.equal(
    /hashSkipped = true;\r?\n\s*verifiedLosers = unlinkedLosers\.slice\(\)/.test(
      src,
    ),
    false,
  );
  assert.match(src, /hashSkipped = true;\r?\n\s*verifiedLosers = \[\];/);
});

test("B3 broken_alt_path uses isClearMatchCandidate — no forced clear:true", () => {
  const src = fs.readFileSync(
    path.join(root, "src/modules/bidirectionalAudit.ts"),
    "utf8",
  );
  const marker = 'kind: "broken_alt_path"';
  const idx = src.indexOf(marker);
  assert.ok(idx > 0);
  const altBlock = src.slice(Math.max(0, idx - 1400), idx + 500);
  assert.match(altBlock, /isClearMatchCandidate/);
  assert.match(altBlock, /titleOverlapDetail/);
  assert.doesNotMatch(altBlock, /clear:\s*true/);
});

test("B7 typeOk +0.05 ranking boost applies after clear decision", () => {
  const src = fs.readFileSync(
    path.join(root, "src/modules/bidirectionalAudit.ts"),
    "utf8",
  );
  const start = src.indexOf("export function suggestOrphanToMissingMatches");
  assert.ok(start > 0);
  const suggest = src.slice(start, start + 4500);
  const clearIdx = suggest.indexOf("isClearMatchCandidate");
  const boostIdx = suggest.indexOf("score + 0.05");
  assert.ok(clearIdx > 0, "clear decision present");
  assert.ok(boostIdx > clearIdx, "boost after clear decision");
});
test("formatBidirectionalMarkdown includes Turkish sections + quarantine warn", () => {
  // Mirror of formatBidirectionalMarkdown core (source-string contract + pure logic).
  const src = fs.readFileSync(
    path.join(root, "src/modules/bidirectionalAudit.ts"),
    "utf8",
  );
  assert.match(src, /## Özet sayılar/);
  assert.match(src, /## Hash doğrulama/);
  assert.match(src, /## Net eşleşmeler/);
  assert.match(src, /## Zayıf öneriler/);
  assert.match(src, /## Kırık \/ missing örnekleri/);
  assert.match(src, /## Ne yapmalı/);
  assert.match(src, /_pdf_quarantine/);

  function pathLooksQuarantined(p) {
    return /_pdf_quarantine/i.test(String(p || ""));
  }
  function formatBidirectionalMarkdown(payload) {
    const items = payload?.items || {};
    const pdfs = payload?.pdfs || {};
    const hash = payload?.hashVerify || {};
    const rows = Array.isArray(payload?.matchSuggestions?.rows)
      ? payload.matchSuggestions.rows
      : [];
    const clear = rows.filter((r) => r && r.clear);
    const weak = rows.filter((r) => r && !r.clear);
    const lines = [];
    lines.push("# İki uçlu PDF denetimi — özet");
    lines.push("## Özet sayılar");
    lines.push(`| Bağlı (linked) | ${items.linked || 0} |`);
    lines.push(`| Kırık (broken) | ${items.broken || 0} |`);
    lines.push(`| PDF’siz (missing) | ${items.missing || 0} |`);
    lines.push(`| PDF orphan | ${pdfs.orphan || 0} |`);
    lines.push(`| Net eşleşme (clear) | ${clear.length} |`);
    lines.push("## Hash doğrulama");
    lines.push(
      `- Aday: **${hash.candidates || 0}** · doğrulandı: **${hash.verified || 0}**`,
    );
    lines.push("## Net eşleşmeler");
    for (const r of clear) {
      const warn = pathLooksQuarantined(r.pdfPath) ? "⚠ `_pdf_quarantine`" : "";
      lines.push(
        `| \`${r.itemKey}\` | ${r.itemTitle} | ${r.pdfFile} | ${r.score} | ${warn} |`,
      );
    }
    lines.push("## Zayıf öneriler (ilk ~10)");
    for (const r of weak.slice(0, 10)) {
      lines.push(`- \`${r.itemKey}\` · ${r.itemTitle}`);
    }
    lines.push("## Kırık / missing örnekleri");
    lines.push("## Ne yapmalı");
    lines.push("- Tercihler → **İki uçlu denetim → Yalnız kopyalar**");
    return lines.join("\n");
  }

  const md = formatBidirectionalMarkdown({
    generatedAt: "2026-08-07T12:00:00Z",
    items: { linked: 10, broken: 2, missing: 3, scanned: 15 },
    pdfs: { orphan: 4, crossFolderGroups: 1, crossFolderUnlinkedLosers: 1 },
    hashVerify: { candidates: 2, verified: 1, rejected: 1, skipped: false },
    matchSuggestions: {
      clear: 1,
      weak: 1,
      rows: [
        {
          clear: true,
          itemKey: "ABCD1234",
          itemTitle: "Test Kitap",
          pdfFile: "Test.pdf",
          pdfPath: "D:/Zotero Kaynaklar/_pdf_quarantine/copies/Test.pdf",
          score: 0.9,
        },
        {
          clear: false,
          itemKey: "WEAK0001",
          itemTitle: "Zayıf",
          pdfFile: "Weak.pdf",
          pdfPath: "D:/ok/Weak.pdf",
          score: 0.55,
        },
      ],
    },
  });
  assert.match(md, /Bağlı \(linked\) \| 10/);
  assert.match(md, /Kırık \(broken\) \| 2/);
  assert.match(md, /PDF orphan \| 4/);
  assert.match(md, /ABCD1234/);
  assert.match(md, /_pdf_quarantine/);
  assert.match(md, /WEAK0001/);
  assert.match(md, /Ne yapmalı/);
  assert.match(md, /Yalnız kopyalar/);
  assert.equal(pathLooksQuarantined("D:/a/_pdf_quarantine/x.pdf"), true);
  assert.equal(pathLooksQuarantined("D:/a/ok.pdf"), false);
});

test("roman volume I vs II and quarantine never clear", () => {
  function pathLooksQuarantined(p) {
    return /_pdf_quarantine/i.test(String(p || ""));
  }
  function extractRomanVolumeToken(text) {
    const s = String(text || "")
      .replace(/\.pdf$/i, "")
      .trim();
    if (!s) return null;
    const patterns = [
      /(?:^|[\s\[(\-–—])(?:cilt|vol\.?|volume|kitap)\s*([ivxlcdm]{1,6})\s*$/i,
      /(?:^|[\s\[(\-–—])([ivxlcdm]{1,6})\s*$/i,
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (!m?.[1]) continue;
      const roman = m[1].toUpperCase();
      if (!/^[IVXLCDM]+$/.test(roman)) continue;
      if (
        !/^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(roman)
      ) {
        continue;
      }
      return roman;
    }
    return null;
  }
  function romanVolumesConflict(a, b) {
    const ra = extractRomanVolumeToken(a);
    const rb = extractRomanVolumeToken(b);
    if (!ra || !rb) return false;
    return ra !== rb;
  }
  function softEditionMarkersConflict(a, b) {
    const markers = [
      /\bsolutions?\b/i,
      /\bmanual\b/i,
      /\binstructor\b/i,
      /\bworkbook\b/i,
      /\banswer\s*keys?\b/i,
      /\bteachers?\s*editions?\b/i,
      /\bçözüm(?:ler|leri)?\b/i,
    ];
    const left = String(a || "");
    const right = String(b || "");
    for (const re of markers) {
      if (re.test(left) !== re.test(right)) return true;
    }
    return false;
  }
  function isClearMatchCandidate(opts) {
    const clearScore = opts.clearScore ?? 0.85;
    const minShared = opts.minShared ?? 3;
    if (!opts.typeOk) return false;
    if (pathLooksQuarantined(opts.pdfPath)) return false;
    if (romanVolumesConflict(opts.itemTitle, opts.pdfTitle)) return false;
    if (softEditionMarkersConflict(opts.itemTitle, opts.pdfTitle)) return false;
    const shortTitle = opts.shortSize > 0 && opts.shortSize <= 2;
    const needShared = shortTitle
      ? Math.max(minShared, opts.shortSize)
      : minShared;
    const needScore = shortTitle ? Math.max(clearScore, 0.95) : clearScore;
    return opts.shared >= needShared && opts.score >= needScore;
  }

  assert.equal(extractRomanVolumeToken("Lügatı I"), "I");
  assert.equal(extractRomanVolumeToken("Lügatı II"), "II");
  assert.equal(
    romanVolumesConflict(
      "Osmanlıca Türkçe Ansiklopedik Lügatı I",
      "Osmanlıca Türkçe Ansiklopedik Lügatı II",
    ),
    true,
  );
  assert.equal(romanVolumesConflict("Same Title I", "Same Title I"), false);
  assert.equal(
    softEditionMarkersConflict(
      "Fundamentals of Physics",
      "Solutions Manual Fundamentals of Physics",
    ),
    true,
  );
  assert.equal(
    isClearMatchCandidate({
      typeOk: true,
      score: 0.95,
      shared: 4,
      shortSize: 4,
      pdfPath: "D:/ok/Lugati II.pdf",
      itemTitle: "Osmanlıca Türkçe Ansiklopedik Lügatı I",
      pdfTitle: "Osmanlıca Türkçe Ansiklopedik Lügatı II",
    }),
    false,
  );
  assert.equal(
    isClearMatchCandidate({
      typeOk: true,
      score: 0.95,
      shared: 4,
      shortSize: 4,
      pdfPath: "D:/Zotero/_pdf_quarantine/copies/x.pdf",
      itemTitle: "Long Enough Shared Title Words Here",
      pdfTitle: "Long Enough Shared Title Words Here",
    }),
    false,
  );
  assert.equal(
    isClearMatchCandidate({
      typeOk: true,
      score: 0.95,
      shared: 4,
      shortSize: 4,
      pdfPath: "D:/ok/manual.pdf",
      itemTitle: "Fundamentals of Physics",
      pdfTitle: "Solutions Manual Fundamentals of Physics",
    }),
    false,
  );
  // Short title: need shared >= minShared (3) even when shortSize is 1.
  assert.equal(
    isClearMatchCandidate({
      typeOk: true,
      score: 1,
      shared: 1,
      shortSize: 1,
      pdfPath: "D:/ok/x.pdf",
      itemTitle: "Tarihi",
      pdfTitle: "Tarihi",
    }),
    false,
  );
  assert.equal(
    isClearMatchCandidate({
      typeOk: true,
      score: 0.95,
      shared: 3,
      shortSize: 3,
      pdfPath: "D:/ok/good.pdf",
      itemTitle: "Tiyatroda düşünsellik üzerine",
      pdfTitle: "Tiyatroda düşünsellik üzerine",
    }),
    true,
  );
});

test("safeFilename never throws on attachments: or empty", () => {
  function safeFilename(path) {
    const raw = String(path || "").trim();
    if (!raw) return "";
    const stripped = raw.replace(/^attachments:/i, "");
    const parts = stripped.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || raw;
  }
  assert.equal(safeFilename(""), "");
  assert.equal(safeFilename("attachments:foo/bar.pdf"), "bar.pdf");
  assert.equal(safeFilename("D:/a/b.pdf"), "b.pdf");
  assert.equal(
    safeFilename("attachments:Emrali (2010) x.pdf"),
    "Emrali (2010) x.pdf",
  );
});

test("basenameSoftVariants strips trailing copy numbers", () => {
  function basenameSoftVariants(name) {
    const n = String(name || "").toLowerCase();
    if (!n) return [];
    const out = [n];
    const stripped = n.replace(/ \d+(?=\.pdf$)/i, "");
    if (stripped !== n) out.push(stripped);
    return out;
  }
  assert.deepEqual(basenameSoftVariants("Book.pdf"), ["book.pdf"]);
  assert.deepEqual(basenameSoftVariants("Book 3.pdf"), [
    "book 3.pdf",
    "book.pdf",
  ]);
});

test("title overlap rejects single-token false friends", () => {
  function titleTokens(value) {
    return new Set(
      (value || "")
        .normalize("NFKD")
        .replace(/\p{Mark}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  }
  function detail(a, b) {
    const ta = titleTokens(a);
    const tb = titleTokens(b);
    if (!ta.size || !tb.size) return { score: 0, shared: 0 };
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared += 1;
    return { score: shared / Math.min(ta.size, tb.size), shared };
  }
  const bad = detail("Dünya tarihi", "Deliliğin tarihi");
  assert.equal(bad.shared, 1);
  assert.ok(bad.shared < 2);
  const good = detail("Tiyatroda düşünsellik", "Tiyatroda düşünsellik");
  assert.ok(good.shared >= 2);
  assert.equal(good.score, 1);
});

test("suggestAlternatePaths prefers exact basename", () => {
  function suggestAlternatePaths(brokenBasename, diskFiles, limit = 5) {
    const want = String(brokenBasename || "").toLowerCase();
    if (!want) return [];
    const hits = [];
    for (const f of diskFiles) {
      if (String(f.basename || "").toLowerCase() !== want) continue;
      hits.push(f.path);
      if (hits.length >= limit) break;
    }
    return hits;
  }
  const disk = [
    { path: "D:/a/foo.pdf", basename: "foo.pdf" },
    { path: "D:/b/foo.pdf", basename: "foo.pdf" },
    { path: "D:/c/bar.pdf", basename: "bar.pdf" },
  ];
  assert.deepEqual(suggestAlternatePaths("foo.pdf", disk), [
    "D:/a/foo.pdf",
    "D:/b/foo.pdf",
  ]);
  assert.deepEqual(suggestAlternatePaths("missing.pdf", disk), []);
});

test("filenameItemTypeMismatch detects [book] vs journalArticle", () => {
  const FILENAME_ITEM_TYPE_RE =
    /\[(book|journalArticle|thesis|bookSection|conferencePaper|report|document|webpage|newspaperArticle|magazineArticle|preprint|manuscript)\]/i;
  function extractFilenameItemTypeTag(filename) {
    const m = String(filename || "").match(FILENAME_ITEM_TYPE_RE);
    return m ? m[1] : null;
  }
  function filenameItemTypeMismatch(zoteroItemType, filename) {
    const tag = extractFilenameItemTypeTag(filename);
    if (!tag || !zoteroItemType) {
      return { mismatch: false, filenameType: tag };
    }
    return {
      mismatch: tag.toLowerCase() !== String(zoteroItemType).toLowerCase(),
      filenameType: tag,
    };
  }
  assert.equal(
    filenameItemTypeMismatch(
      "journalArticle",
      "Author (2020) Title [book] Pub.pdf",
    ).mismatch,
    true,
  );
  assert.equal(
    filenameItemTypeMismatch("book", "Author (2020) Title [book] Pub.pdf")
      .mismatch,
    false,
  );
  assert.equal(
    filenameItemTypeMismatch("book", "Author (2020) Title.pdf").mismatch,
    false,
  );
});

test("prefs wire bidirectional scan + open + apply + copies-only", () => {
  const script = fs.readFileSync(
    path.join(root, "src/modules/preferenceScript.ts"),
    "utf8",
  );
  assert.match(script, /runBidirectionalAuditWithProgress/);
  assert.match(script, /runBidirectionalApplyWithProgress/);
  assert.match(script, /runBidirectionalCopiesApplyWithProgress/);
  assert.match(script, /openLastBidirectionalReport/);
  assert.match(script, /syncDiskAuditApplyButtonLabels/);
  assert.match(script, /pdf-disk-audit-plan-write/);
  assert.match(script, /pdf-disk-audit-bidir/);
  assert.match(script, /pdf-disk-audit-bidir-apply/);
  assert.match(script, /pdf-disk-audit-bidir-copies-apply/);
  const xhtml = fs.readFileSync(
    path.join(root, "addon/chrome/content/preferences.xhtml"),
    "utf8",
  );
  assert.match(xhtml, /pdf-disk-audit-bidir-heading/);
  assert.match(xhtml, /pdf-disk-audit-options-heading/);
  assert.match(xhtml, /pdf-disk-audit-detail-heading/);
  assert.match(xhtml, /id="pdf-disk-audit-bidir"/);
  assert.match(xhtml, /id="pdf-disk-audit-bidir-apply"/);
  assert.match(xhtml, /id="pdf-disk-audit-bidir-copies-apply"/);
  // Compact secondary rows: no per-row help descriptions.
  assert.doesNotMatch(
    xhtml,
    /pdf-disk-audit-orphan-help[\s\S]*?pdf-disk-audit-orphan"/,
  );
  for (const loc of ["en-US", "de", "it-IT", "tr-TR"]) {
    const ftl = fs.readFileSync(
      path.join(root, "addon/locale", loc, "preferences.ftl"),
      "utf8",
    );
    assert.match(ftl, /pdf-disk-audit-bidir-heading/);
    assert.match(ftl, /pdf-disk-audit-bidir-help/);
    assert.match(ftl, /pdf-disk-audit-options-heading/);
    assert.match(ftl, /pdf-disk-audit-detail-heading/);
    assert.match(ftl, /pdf-disk-audit-detail-help/);
    assert.match(ftl, /pdf-disk-audit-bidir\s*=/);
    assert.match(ftl, /pdf-disk-audit-bidir-apply\s*=/);
    assert.match(ftl, /pdf-disk-audit-bidir-copies-apply\s*=/);
    assert.match(ftl, /pdf-disk-audit-plan-write\s*=/);
    assert.match(ftl, /pdf-disk-audit-plan-write-matches\s*=/);
    assert.match(ftl, /pdf-disk-audit-plan-write-copies\s*=/);
  }
});
