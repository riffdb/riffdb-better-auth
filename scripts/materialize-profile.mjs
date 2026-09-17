import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { materializeRiffDBBetterAuthProfile } from "../dist/index.js";

/**
 * Materializes the representative profile plan into RiffDB sources.
 *
 * The plan says what Better Auth resolved; this writes the contract, named
 * queries, and application source a reviewer compiles with
 * `riffdb application check`. The committed output is a golden fixture so a
 * change in the generator shows up as a reviewable source diff.
 */

const planUrl = new URL("../profiles/organization-security.profile.json", import.meta.url);
const outputUrl = new URL("../profiles/organization-security/", import.meta.url);

const plan = JSON.parse(await readFile(planUrl, "utf8"));
const materialization = materializeRiffDBBetterAuthProfile(plan);

// The fixture ships its own project config so a reviewer can verify the claim
// the generator makes about it: `riffdb application check` in this directory.
const projectConfig = `[client]
endpoint = "http://127.0.0.1:7443"
database = "better-auth-development"

[project]
schema = "riffdb.application.json"
generators = []
`;

const files = new Map([
  ["riffdb/contract.riff", materialization.contract],
  ["riffdb.application.json", materialization.applicationSource],
  ["riffdb.toml", projectConfig],
  ["materialization.json", `${JSON.stringify(materialization.report, null, 2)}\n`],
]);
for (const query of materialization.queries) files.set(query.path, query.code);

async function written() {
  const root = fileURLToPath(outputUrl);
  const found = new Map();
  const walk = async (relative) => {
    for (const entry of await readdir(new URL(relative, outputUrl), { withFileTypes: true })) {
      const child = `${relative}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      if (entry.isDirectory()) await walk(child);
      else found.set(child, await readFile(new URL(child, outputUrl), "utf8"));
    }
  };
  await walk("");
  assert.ok(root.length > 0);
  return found;
}

switch (process.argv[2]) {
  case "--check": {
    const found = await written();
    assert.deepEqual(
      [...found.keys()].sort(),
      [...files.keys()].sort(),
      "the materialized profile file set is stale; run npm run profiles:materialize",
    );
    for (const [path, code] of files) {
      assert.equal(
        found.get(path),
        code,
        `${path} is stale; run npm run profiles:materialize`,
      );
    }
    break;
  }
  case "--write": {
    await rm(outputUrl, { recursive: true, force: true });
    await mkdir(new URL("riffdb/queries/", outputUrl), { recursive: true });
    for (const [path, code] of files) await writeFile(new URL(path, outputUrl), code, "utf8");
    break;
  }
  default:
    throw new Error("usage: node scripts/materialize-profile.mjs --check|--write");
}
