import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getAuthTables } from "better-auth/db";
import { organization, twoFactor } from "better-auth/plugins";

import {
  defineRiffDBBetterAuthProfilePlan,
  renderRiffDBBetterAuthProfilePlan,
} from "../dist/index.js";

const outputUrl = new URL(
  "../profiles/organization-security.profile.json",
  import.meta.url,
);
const options = {
  advanced: { database: { generateId: "uuid" } },
  user: {
    additionalFields: {
      locale: { type: "string", required: false },
    },
  },
  plugins: [organization({ teams: { enabled: true } }), twoFactor()],
};
const plan = defineRiffDBBetterAuthProfilePlan(options, getAuthTables(options), {
  name: "BetterAuthOrganizationSecurity",
  contractLineage: "BetterAuthOrganizationSecurity",
  applicationRole: "BetterAuthServer",
});
const rendered = renderRiffDBBetterAuthProfilePlan(plan);

switch (process.argv[2]) {
  case "--check":
    assert.equal(
      await readFile(outputUrl, "utf8"),
      rendered,
      "the representative Better Auth profile plan is stale; run npm run profiles:write",
    );
    break;
  case "--write":
    await mkdir(dirname(fileURLToPath(outputUrl)), { recursive: true });
    await writeFile(outputUrl, rendered, "utf8");
    break;
  default:
    throw new Error("usage: node scripts/profile-example.mjs --check|--write");
}
