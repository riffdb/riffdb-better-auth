import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAuthTables } from "better-auth/db";
import { organization, twoFactor } from "better-auth/plugins";
import { defineRiffDBBetterAuthProfilePlan, materializeRiffDBBetterAuthRuntimeProfile } from "../dist/index.js";

for (const [directory, name, plugins] of [
  ["custom-fields", "BetterAuthCustomFields", []],
  ["runtime", "BetterAuthRuntime", [organization(), twoFactor()]],
]) {
  const options = { advanced: { database: { generateId: "uuid" } },
    user: { additionalFields: { locale: { type: "string", required: false }, dateField: { type: "date", required: false } } }, plugins };
  const plan = defineRiffDBBetterAuthProfilePlan(options, getAuthTables(options), { name, contractLineage: name });
  const result = materializeRiffDBBetterAuthRuntimeProfile(plan);
  for (const [path, source] of Object.entries(result.files)) {
    const destination = new URL(`../profiles/${directory}/${path}`, import.meta.url);
    if (process.argv[2] === "--check") assert.equal(await readFile(destination, "utf8"), source, `stale runtime profile: ${directory}/${path}`);
    else if (process.argv[2] === "--write") { await mkdir(dirname(destination.pathname), { recursive: true }); await writeFile(destination, source); }
    else throw new Error("usage: runtime-profiles.mjs --check|--write");
  }
}
