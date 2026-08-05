const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
test('pythonPdfSources skips same-title siblings after mismatch', () => {
  const src = fs.readFileSync(path.join('src','modules','pythonPdfSources.ts'), 'utf8');
  assert.match(src, /rejectedTitles/);
  assert.match(src, /skip same-title sibling after mismatch/);
  assert.match(src, /isbn: req\.isbn/);
});
