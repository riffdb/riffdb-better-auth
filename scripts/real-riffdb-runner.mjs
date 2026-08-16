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
  const databaseAdapter = riffdbAdapter({ driver, organizationId: ORGANIZATION_ID });
  const authOptions = {
    database: databaseAdapter,
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
  };
  const auth = betterAuth(authOptions);

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

  const directAdapter = databaseAdapter(authOptions);
  const updatedAt = new Date();
  assert.equal(
    (
      await directAdapter.update({
        model: "user",
        where: [{ field: "id", value: signup.user.id }],
        update: { name: "RiffDB Updated", updatedAt },
      })
    )?.name,
    "RiffDB Updated",
  );
  const sessions = await directAdapter.findMany({
    model: "session",
    where: [{ field: "userId", value: signup.user.id }],
  });
  assert.ok(sessions.length >= 1);
  assert.equal(
    (
      await directAdapter.update({
        model: "session",
        where: [{ field: "token", value: sessions[0].token }],
        update: { updatedAt: new Date() },
      })
    )?.id,
    sessions[0].id,
  );
  const activeSessions = await directAdapter.findMany({
    model: "session",
    where: [
      { field: "userId", value: signup.user.id },
      { field: "expiresAt", value: new Date(), operator: "gt" },
    ],
  });
  assert.ok(activeSessions.length >= 1);
  assert.equal(
    (
      await directAdapter.findMany({
        model: "session",
        where: [{ field: "token", value: [sessions[0].token], operator: "in" }],
      })
    )[0]?.id,
    sessions[0].id,
  );
  assert.equal(
    await directAdapter.deleteMany({
      model: "session",
      where: [{ field: "token", value: [sessions[0].token], operator: "in" }],
    }),
    1,
  );

  const verificationNow = new Date();
  const expiredVerificationId = crypto.randomUUID();
  const currentVerificationId = crypto.randomUUID();
  const currentVerificationIdentifier = `real-verification:${crypto.randomUUID()}`;
  await directAdapter.create({
    model: "verification",
    forceAllowId: true,
    data: {
      id: expiredVerificationId,
      identifier: `expired:${crypto.randomUUID()}`,
      value: "expired",
      expiresAt: new Date(verificationNow.getTime() - 60_000),
      createdAt: new Date(verificationNow.getTime() - 120_000),
      updatedAt: new Date(verificationNow.getTime() - 120_000),
    },
  });
  await directAdapter.create({
    model: "verification",
    forceAllowId: true,
    data: {
      id: currentVerificationId,
      identifier: currentVerificationIdentifier,
      value: "current",
      expiresAt: new Date(verificationNow.getTime() + 60_000),
      createdAt: verificationNow,
      updatedAt: verificationNow,
    },
  });
  assert.equal(
    (
      await directAdapter.update({
        model: "verification",
        where: [{ field: "identifier", value: currentVerificationIdentifier }],
        update: { value: "updated" },
      })
    )?.value,
    "updated",
  );
  assert.equal(
    await directAdapter.deleteMany({
      model: "verification",
      where: [{ field: "expiresAt", value: verificationNow, operator: "lt" }],
    }),
    1,
  );
  await directAdapter.delete({
    model: "verification",
    where: [{ field: "identifier", value: currentVerificationIdentifier }],
  });

  const oauthUserId = crypto.randomUUID();
  const oauthAccountId = crypto.randomUUID();
  const oauthExternalId = `github-${crypto.randomUUID()}`;
  const oauthNow = new Date();
  await directAdapter.transaction(async (tx) => {
    await tx.create({
      model: "user",
      forceAllowId: true,
      data: {
        id: oauthUserId,
        name: "OAuth User",
        email: `oauth-${crypto.randomUUID()}@example.test`,
        emailVerified: true,
        image: null,
        createdAt: oauthNow,
        updatedAt: oauthNow,
      },
    });
    await tx.create({
      model: "account",
      forceAllowId: true,
      data: {
        id: oauthAccountId,
        userId: oauthUserId,
        accountId: oauthExternalId,
        providerId: "github",
        accessToken: "oauth-access-token",
        createdAt: oauthNow,
        updatedAt: oauthNow,
      },
    });
  });
  assert.equal(
    (
      await directAdapter.findOne({
        model: "user",
        where: [{ field: "id", value: oauthUserId }],
      })
    )?.id,
    oauthUserId,
  );
  assert.equal(
    (
      await directAdapter.findOne({
        model: "account",
        where: [{ field: "id", value: oauthAccountId }],
      })
    )?.id,
    oauthAccountId,
  );
  assert.equal(
    (
      await directAdapter.findOne({
        model: "account",
        where: [
          { field: "accountId", value: oauthExternalId },
          { field: "providerId", value: "github" },
        ],
      })
    )?.id,
    oauthAccountId,
  );
  assert.equal(
    (
      await directAdapter.update({
        model: "account",
        where: [{ field: "id", value: oauthAccountId }],
        update: { accessToken: "oauth-access-token-2", updatedAt: new Date() },
      })
    )?.accessToken,
    "oauth-access-token-2",
  );
  await directAdapter.delete({
    model: "user",
    where: [{ field: "id", value: oauthUserId }],
  });

  assert.ok(
    (await directAdapter.deleteMany({
      model: "session",
      where: [{ field: "userId", value: signup.user.id }],
    })) >= 1,
  );
  assert.equal(
    await directAdapter.deleteMany({
      model: "account",
      where: [{ field: "userId", value: signup.user.id }],
    }),
    1,
  );
  await directAdapter.delete({
    model: "user",
    where: [{ field: "id", value: signup.user.id }],
  });
  assert.equal(
    await directAdapter.findOne({
      model: "user",
      where: [{ field: "id", value: signup.user.id }],
    }),
    null,
  );

  process.stdout.write("riffdb-better-auth-real-v1\tpassed\n");
} finally {
  await driver.shutdown();
}
