// Publish a new release of Zotero PDF Manager.
//
// Builds the plugin, then creates (or overwrites) a GitHub Release on the
// PUBLIC "releases" repo, uploading the .xpi and update.json as assets.
// Zotero on every machine that has the plugin installed then auto-updates by
// polling that repo's `latest` release.
//
// Usage:
//   node scripts/publish.mjs            # release the current package.json version
//   node scripts/publish.mjs --notes "Kısa açıklama"
//
// Prerequisites (one time): `gh auth login`, and the DIST_REPO must exist.
// See scripts/publish.README.md for the one-time bootstrap.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DIST_REPO = "sanaatchi/zotero-pdf-manager-releases";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const version = pkg.version;
const xpi = "build/zotero-pdf-manager.xpi";
const tag = `v${version}`;

const notesArg = process.argv.indexOf("--notes");
const notes =
  notesArg !== -1 && process.argv[notesArg + 1]
    ? process.argv[notesArg + 1]
    : `Zotero PDF Manager ${tag}`;

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

console.log(`\n=== Building ${tag} ===`);
run("npm run build");

console.log(`\n=== Publishing ${tag} to ${DIST_REPO} ===`);
// If the tag already exists (e.g. re-running after a failed upload), delete the
// old release first so the assets are replaced cleanly.
try {
  execSync(`gh release view ${tag} --repo ${DIST_REPO}`, { stdio: "ignore" });
  console.log(`Release ${tag} already exists — deleting it to replace assets.`);
  run(`gh release delete ${tag} --repo ${DIST_REPO} --yes --cleanup-tag`);
} catch {
  // No existing release — normal path.
}

run(
  `gh release create ${tag} ${xpi} update.json ` +
    `--repo ${DIST_REPO} --title "${tag}" --notes "${notes.replace(/"/g, '\\"')}"`,
);

console.log(
  `\nDone. Zotero clients will pick up ${tag} on their next update check.`,
);
