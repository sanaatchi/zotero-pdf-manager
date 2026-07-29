// @ajan: cursor · @etiket: katman-2, tests, windows
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dir = join(process.cwd(), "tests");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.cjs"))
  .map((name) => join("tests", name));

if (!files.length) {
  console.error("No tests/*.test.cjs files found");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
