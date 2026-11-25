// Zip dist/ into an installable .xpi (manifest.json at the archive root).
// Usage: npm run package   ->   thunderbird-spark-<version>.xpi in the project root.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
if (!existsSync(resolve(dist, "manifest.json"))) {
  console.error("dist/manifest.json missing — run `npm run build` first.");
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8"));
const out = resolve(root, `thunderbird-spark-${version}.xpi`);
rmSync(out, { force: true });
execFileSync("zip", ["-r", "-X", "-q", out, ".", "-x", "*.DS_Store", "-x", ".*"], { cwd: dist, stdio: "inherit" });
console.log(`Built ${out}`);
