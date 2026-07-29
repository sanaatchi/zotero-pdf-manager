// @ajan: cursor · @etiket: katman-2, p1, publish, update-hash
/**
 * Publish a release to the PUBLIC dist repo so Zotero can auto-update.
 *
 * Usage:
 *   npm run gh-release
 *   node scripts/publish.mjs --notes "P1 lifecycle + OA"
 *
 * Gates: clean git tree, lint:check, test, build. Writes update.json with
 * versioned update_link + sha512 update_hash (not latest/download).
 */

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DIST_REPO = "sanaatchi/zotero-pdf-manager-releases";
const SOURCE_REPO = "sanaatchi/zotero-pdf-manager";
const UPDATE_RELEASE = "update";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const version = pkg.version;
const tag = `v${version}`;
const addonID = pkg.config.addonID;
const xpiName = "zotero-pdf-manager.xpi";
const xpiPath = join("build", xpiName);

const notesArg = process.argv.indexOf("--notes");
const notes =
  notesArg !== -1 && process.argv[notesArg + 1]
    ? process.argv[notesArg + 1]
    : `Zotero PDF Manager ${tag}`;

function run(cmd, args = []) {
  console.log(`> ${cmd} ${args.join(" ")}`.trim());
  execFileSync(cmd, args, { stdio: "inherit", shell: false });
}

function runShell(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", shell: true });
}

function assertCleanTree() {
  const out = execSync("git status --porcelain", { encoding: "utf8" });
  if (out.trim()) {
    throw new Error(
      `Working tree not clean — commit or stash before release:\n${out}`,
    );
  }
}

function sha512File(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("hex");
}

function writeUpdateFiles() {
  if (!existsSync(xpiPath)) {
    throw new Error(`Missing ${xpiPath}`);
  }
  const updateLink = `https://github.com/${DIST_REPO}/releases/download/${tag}/${xpiName}`;
  const updateHash = `sha512:${sha512File(xpiPath)}`;
  const updateJson = {
    addons: {
      [addonID]: {
        updates: [
          {
            version,
            update_link: updateLink,
            update_hash: updateHash,
            applications: {
              zotero: {
                strict_min_version: "7.0",
                strict_max_version: "10.9.9",
              },
            },
          },
        ],
      },
    },
  };
  const body = JSON.stringify(updateJson, null, 2) + "\n";
  writeFileSync("update.json", body);
  writeFileSync("update-beta.json", body);
  console.log("Wrote update.json →", updateLink);
  console.log("update_hash →", updateHash);
  return { body, updateHash, updateLink };
}

function publishUpdateJsonToBranch(body) {
  const path = "update.json";
  let sha;
  try {
    const meta = execSync(
      `gh api repos/${DIST_REPO}/contents/${path}?ref=main`,
      { encoding: "utf8", shell: true },
    );
    sha = JSON.parse(meta).sha;
  } catch {
    sha = undefined;
  }

  const payload = {
    message: `chore: sync update.json to ${tag}`,
    content: Buffer.from(body, "utf8").toString("base64"),
    branch: "main",
  };
  if (sha) payload.sha = sha;

  const tmp = join(tmpdir(), `zpdf-update-put-${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(payload));
  try {
    runShell(
      `gh api --method PUT repos/${DIST_REPO}/contents/${path} --input "${tmp}"`,
    );
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function ensureUpdateRelease(body) {
  const tmp = join(tmpdir(), `update.json`);
  writeFileSync(tmp, body);
  try {
    try {
      execSync(`gh release view ${UPDATE_RELEASE} --repo ${DIST_REPO}`, {
        stdio: "ignore",
        shell: true,
      });
      runShell(
        `gh release upload ${UPDATE_RELEASE} "${tmp}" --repo ${DIST_REPO} --clobber`,
      );
    } catch {
      runShell(
        `gh release create ${UPDATE_RELEASE} "${tmp}" --repo ${DIST_REPO} --title "update" --notes "Rolling update.json channel"`,
      );
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function verifyPublicDownload(updateHash) {
  const url = `https://github.com/${DIST_REPO}/releases/download/${tag}/${xpiName}`;
  const tmp = join(tmpdir(), `zpdf-verify-${Date.now()}.xpi`);
  try {
    runShell(
      `gh release download ${tag} --repo ${DIST_REPO} --pattern ${xpiName} --dir "${tmpdir()}" --clobber`,
    );
    // gh downloads with original name into dir
    const downloaded = join(tmpdir(), xpiName);
    const got = `sha512:${sha512File(downloaded)}`;
    if (got !== updateHash) {
      throw new Error(
        `Public XPI hash mismatch:\n  expected ${updateHash}\n  got      ${got}`,
      );
    }
    console.log("Post-download hash OK");
  } finally {
    for (const p of [tmp, join(tmpdir(), xpiName)]) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

console.log(`\n=== Gates for ${tag} (${SOURCE_REPO}) ===`);
assertCleanTree();
runShell("npm run lint:check");
runShell("npm test");

console.log(`\n=== Building ${tag} ===`);
runShell("npm run build");

const { body, updateHash, updateLink } = writeUpdateFiles();

console.log(`\n=== Publishing ${tag} to ${DIST_REPO} ===`);
try {
  execSync(`gh release view ${tag} --repo ${DIST_REPO}`, {
    stdio: "ignore",
    shell: true,
  });
  throw new Error(
    `Release ${tag} already exists on ${DIST_REPO}. Refusing to delete/recreate (immutable).`,
  );
} catch (e) {
  if (e && /already exists/.test(String(e.message))) throw e;
  // no release — ok
}

runShell(
  `gh release create ${tag} "${xpiPath}" update.json --repo ${DIST_REPO} --title "${tag}" --notes ${JSON.stringify(notes)}`,
);

ensureUpdateRelease(body);
publishUpdateJsonToBranch(body);
verifyPublicDownload(updateHash);

console.log(`\nDone. ${tag}`);
console.log(`XPI: ${updateLink}`);
console.log(
  `Update channel: https://github.com/${DIST_REPO}/releases/download/${UPDATE_RELEASE}/update.json`,
);
