// @ajan: cursor · @etiket: katman-2, p1, publish, update-hash, provenance
/**
 * Publish a release to the PUBLIC dist repo so Zotero can auto-update.
 *
 * All subprocesses use arg-array execFileSync (no shell). Notes are a single
 * argv value. Provenance JSON links source commit ↔ XPI sha512.
 *
 * Usage:
 *   npm run gh-release
 *   node scripts/publish.mjs --notes "safe notes"
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DIST_REPO = "sanaatchi/zotero-pdf-manager-releases";
const SOURCE_REPO = "sanaatchi/zotero-pdf-manager";
const UPDATE_RELEASE = "update";
const isWin = process.platform === "win32";
const npmBin = isWin ? "npm.cmd" : "npm";
const ghBin = "gh";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const version = pkg.version;
const tag = `v${version}`;
const addonID = pkg.config.addonID;
const xpiName = "zotero-pdf-manager.xpi";
const xpiPath = join("build", xpiName);
const provenancePath = join("build", "provenance.json");

const notesArg = process.argv.indexOf("--notes");
const notes =
  notesArg !== -1 && process.argv[notesArg + 1]
    ? process.argv[notesArg + 1]
    : `Zotero PDF Manager ${tag}`;

export function buildGhReleaseCreateArgs({
  tag: t,
  xpi,
  updateJson,
  repo,
  title,
  releaseNotes,
}) {
  return [
    "release",
    "create",
    t,
    xpi,
    updateJson,
    "--repo",
    repo,
    "--title",
    title,
    "--notes",
    releaseNotes,
  ];
}

function run(bin, args) {
  console.log(`> ${bin} ${args.join(" ")}`);
  // .cmd/.bat on Windows require a shell to spawn; git/gh stay shell-free.
  const needsCmdShell = isWin && /\.(cmd|bat)$/i.test(bin);
  execFileSync(bin, args, { stdio: "inherit", shell: needsCmdShell });
}

function capture(bin, args) {
  const needsCmdShell = isWin && /\.(cmd|bat)$/i.test(bin);
  return execFileSync(bin, args, {
    encoding: "utf8",
    shell: needsCmdShell,
  }).trim();
}

function assertCleanTree() {
  const out = capture("git", ["status", "--porcelain"]);
  if (out) {
    throw new Error(
      `Working tree not clean — commit or stash before release:\n${out}`,
    );
  }
}

function sha512File(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("hex");
}

function writeUpdateAndProvenance(sourceCommit) {
  if (!existsSync(xpiPath)) throw new Error(`Missing ${xpiPath}`);
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

  const provenance = {
    addonID,
    version,
    tag,
    sourceRepo: SOURCE_REPO,
    sourceCommit,
    distRepo: DIST_REPO,
    xpi: xpiName,
    update_hash: updateHash,
    update_link: updateLink,
    builtAt: new Date().toISOString(),
  };
  // Optional: GH_CI_RUN_ID / GH_CI_RUN_URL from caller or Actions env.
  const ciRunId = process.env.GH_CI_RUN_ID || process.env.GITHUB_RUN_ID;
  const ciRunUrl =
    process.env.GH_CI_RUN_URL ||
    (ciRunId
      ? `https://github.com/${SOURCE_REPO}/actions/runs/${ciRunId}`
      : undefined);
  if (ciRunId) provenance.ciRunId = String(ciRunId);
  if (ciRunUrl) provenance.ciRunUrl = ciRunUrl;
  provenance.sourceVisibility = process.env.GH_SOURCE_VISIBILITY || "public";
  writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + "\n");
  console.log("Wrote update.json →", updateLink);
  console.log("update_hash →", updateHash);
  console.log("sourceCommit →", sourceCommit);
  if (ciRunUrl) console.log("ciRunUrl →", ciRunUrl);
  return { body, updateHash, updateLink, provenance };
}

function publishUpdateJsonToBranch(body) {
  const path = "update.json";
  let sha;
  try {
    const meta = capture("gh", [
      "api",
      `repos/${DIST_REPO}/contents/${path}?ref=main`,
    ]);
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
    run("gh", [
      "api",
      "--method",
      "PUT",
      `repos/${DIST_REPO}/contents/${path}`,
      "--input",
      tmp,
    ]);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function ensureUpdateRelease(body) {
  const tmp = join(tmpdir(), "update.json");
  writeFileSync(tmp, body);
  try {
    try {
      capture("gh", ["release", "view", UPDATE_RELEASE, "--repo", DIST_REPO]);
      run("gh", [
        "release",
        "upload",
        UPDATE_RELEASE,
        tmp,
        "--repo",
        DIST_REPO,
        "--clobber",
      ]);
    } catch {
      run("gh", [
        "release",
        "create",
        UPDATE_RELEASE,
        tmp,
        "--repo",
        DIST_REPO,
        "--title",
        "update",
        "--notes",
        "Rolling update.json channel",
      ]);
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
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    DIST_REPO,
    "--pattern",
    xpiName,
    "--dir",
    tmpdir(),
    "--clobber",
  ]);
  const downloaded = join(tmpdir(), xpiName);
  const got = `sha512:${sha512File(downloaded)}`;
  try {
    if (got !== updateHash) {
      throw new Error(
        `Public XPI hash mismatch:\n  expected ${updateHash}\n  got      ${got}`,
      );
    }
    console.log("Post-download hash OK");
  } finally {
    try {
      unlinkSync(downloaded);
    } catch {
      /* ignore */
    }
  }
}

function main() {
  console.log(`\n=== Gates for ${tag} (${SOURCE_REPO}) ===`);
  assertCleanTree();
  const sourceCommit = capture("git", ["rev-parse", "HEAD"]);
  run(npmBin, ["run", "lint:check"]);
  run(npmBin, ["test"]);

  console.log(`\n=== Building ${tag} ===`);
  run(npmBin, ["run", "build"]);

  const { body, updateHash, updateLink, provenance } =
    writeUpdateAndProvenance(sourceCommit);

  console.log(`\n=== Publishing ${tag} to ${DIST_REPO} ===`);
  try {
    capture("gh", ["release", "view", tag, "--repo", DIST_REPO]);
    throw new Error(
      `Release ${tag} already exists on ${DIST_REPO}. Refusing to delete/recreate (immutable).`,
    );
  } catch (e) {
    if (e && /already exists/.test(String(e.message))) throw e;
  }

  const createArgs = buildGhReleaseCreateArgs({
    tag,
    xpi: xpiPath,
    updateJson: "update.json",
    repo: DIST_REPO,
    title: tag,
    releaseNotes: `${notes}\n\nsource: ${SOURCE_REPO}@${sourceCommit}\nhash: ${updateHash}`,
  });
  // Append provenance asset
  createArgs.splice(5, 0, provenancePath);
  run(ghBin, createArgs);

  ensureUpdateRelease(body);
  publishUpdateJsonToBranch(body);
  verifyPublicDownload(updateHash);

  console.log(`\nDone. ${tag}`);
  console.log(`XPI: ${updateLink}`);
  console.log(`Provenance: ${JSON.stringify(provenance)}`);
  console.log(
    `Update channel: https://github.com/${DIST_REPO}/releases/download/${UPDATE_RELEASE}/update.json`,
  );
}

const isDirectRun =
  process.argv[1] && /publish\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (isDirectRun) {
  main();
}
