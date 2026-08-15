import assert from "node:assert/strict";

import { DriverApplicationTransport } from "@riffdb/client";
import { betterAuth } from "better-auth";

import { riffdbAdapter } from "../dist/index.js";

const ORGANIZATION_ID = "018f5f7e-7b0c-7d9a-8f14-77f42f53c851";
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 10) {
  throw new Error(
    "usage: real-riffdb-runner SOCKET MANIFEST_HASH CATALOG_HASH DATABASE ROLE ROLE_HASH REMOTE_HASH LINEAGE VERSION BUNDLE_HASH",
  );
}
const [
  socketPath,
  applicationManifestHash,
  operationCatalogHash,
  database,
  role,
  roleDefinitionHash,
  remoteIdentityHash,
  contractLineage,
  contractVersion,
  contractBundleHash,
] = arguments_;

const driver = await DriverApplicationTransport.connect({
  socketPath,
  identity: {
    applicationManifestHash,
    operationCatalogHash,
    database,
    role,
    roleDefinitionHash,
    remoteIdentityHash,
    contractLineage,
    contractVersion: BigInt(contractVersion),
    contractBundleHash,
  },
});

try {
  let resetToken = "";
  const auth = betterAuth({
    database: riffdbAdapter({ driver, organizationId: ORGANIZATION_ID }),
    baseURL: "http://localhost:3000",
    secret: "riffdb-better-auth-development-only-secret-value",
    advanced: { database: { generateId: "uuid" } },
    emailAndPassword: {
      enabled: true,
      password: {
        hash: async (password) => password,
        verify: async ({ hash, password }) => hash === password,
      },
      async sendResetPassword({ token }) {
        resetToken = token;
      },
    },
  });

  const email = `real-${crypto.randomUUID()}@example.test`;
  const originalPassword = `${crypto.randomUUID()}-old`;
  const newPassword = `${crypto.randomUUID()}-new`;
  const signup = await auth.api.signUpEmail({
    body: { email, password: originalPassword, name: "RiffDB Loopback" },
  });
  assert.equal(signup.user.email, email);
  assert.match(signup.user.id, /^[0-9a-f-]{36}$/iu);

  const signin = await auth.api.signInEmail({
    body: { email, password: originalPassword },
  });
  assert.equal(signin.user.id, signup.user.id);

  await auth.api.requestPasswordReset({
    body: { email, redirectTo: "http://localhost:3000/reset-password" },
  });
  assert.ok(resetToken.length > 10);
  const reset = await auth.api.resetPassword({
    body: { token: resetToken, newPassword },
  });
  assert.equal(reset.status, true);

  const afterReset = await auth.api.signInEmail({
    body: { email, password: newPassword },
  });
  assert.equal(afterReset.user.id, signup.user.id);
  await assert.rejects(
    auth.api.resetPassword({
      body: { token: resetToken, newPassword: `${crypto.randomUUID()}-replay` },
    }),
  );

  process.stdout.write("riffdb-better-auth-real-v1\tpassed\n");
} finally {
  await driver.shutdown();
}
