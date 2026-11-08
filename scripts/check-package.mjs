import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--cache", "./node_modules/.cache/npm"],
  { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(result.status, 0, "npm pack --dry-run failed");
const [pack] = JSON.parse(result.stdout);
const paths = new Set(pack.files.map((file) => file.path));
for (const directory of ["", "profiles/custom-fields/", "profiles/runtime/"]) {
  const lock = JSON.parse(await readFile(`${directory}riffdb.application.lock.json`, "utf8"));
  for (const artifact of lock.artifacts) assert.ok(paths.has(`${directory}${artifact.path}`), `missing public compiler artifact: ${directory}${artifact.path}`);
  assert.ok(paths.has(`${directory}riffdb/contract.riff`));
  assert.ok(paths.has(`${directory}riffdb.application.json`));
  assert.ok(paths.has(`${directory}riffdb.application.lock.json`));
}
for (const path of ["dist/index.js", "dist/index.d.ts", "dist/profiles/custom-fields/profile.js",
  "dist/profiles/runtime/profile.js", "profiles/runtime/profile.ts", "README.md", "DESIGN.md"]) {
  assert.ok(paths.has(path), `missing public entry point: ${path}`);
}
for (const path of paths) {
  assert.ok(!/(?:^|\/)(?:\.riffdb|projections|test|node_modules)\//u.test(path), `private artifact in package: ${path}`);
  assert.ok(!/\.(?:credential|redb|pem|key|keys|log)$/u.test(path), `local state in package: ${path}`);
}
console.log(`npm pack --dry-run verified ${paths.size} public files (${pack.unpackedSize} unpacked bytes)`);
