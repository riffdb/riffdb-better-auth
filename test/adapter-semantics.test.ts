import type { BetterAuthOptions } from "better-auth";
import { describe, expect, it } from "vitest";

import { RiffDBBetterAuthCallError } from "../src/index.js";
import { riffdbAdapterForTesting } from "../src/testing.js";
import { FakeRiffDBApplicationTransport } from "./support/fake-transport.js";

const ORGANIZATION_ID = "018f5f7e-7b0c-7d9a-8f14-77f42f53c851";

function options(): BetterAuthOptions {
  return {
    advanced: { database: { generateId: "uuid" } },
  };
}

function createAdapter(transport: FakeRiffDBApplicationTransport) {
  return riffdbAdapterForTesting({
    transport,
    organizationId: ORGANIZATION_ID,
    resetModel: (model) => transport.resetModel(model),
  })(options());
}

function user(id = crypto.randomUUID()) {
  const now = new Date();
  return {
    id,
    name: "Ada Lovelace",
    email: `${id}@example.test`,
    emailVerified: false,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
}

function account(userId: string, id = crypto.randomUUID()) {
  const now = new Date();
  return {
    id,
    userId,
    accountId: userId,
    providerId: "credential",
    password: "not-a-real-hash",
    createdAt: now,
    updatedAt: now,
  };
}

function session(userId: string, id = crypto.randomUUID()) {
  const now = new Date();
  return {
    id,
    userId,
    token: crypto.randomUUID(),
    expiresAt: new Date(now.getTime() + 60_000),
    ipAddress: null,
    userAgent: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("compiled transaction dispatch", () => {
  it("commits signup as exactly one generated command", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const createdUser = user();

    await adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: createdUser, forceAllowId: true });
      await tx.create({
        model: "account",
        data: account(createdUser.id),
        forceAllowId: true,
      });
      await tx.create({
        model: "session",
        data: session(createdUser.id),
        forceAllowId: true,
      });
    });

    expect(transport.commandLog).toEqual(["CreateSignupGraph"]);
    await expect(
      adapter.findOne({
        model: "user",
        where: [{ field: "email", value: createdUser.email }],
      }),
    ).resolves.toMatchObject({ id: createdUser.id });
  });

  it("commits and manages an OAuth user graph through compiled operations", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const createdUser = user();
    const createdAccount = {
      ...account(createdUser.id),
      accountId: `oauth-${crypto.randomUUID()}`,
      providerId: "github",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    };

    await adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: createdUser, forceAllowId: true });
      await tx.create({ model: "account", data: createdAccount, forceAllowId: true });
    });
    expect(transport.commandLog).toEqual(["CreateOAuthUserGraph"]);

    await expect(
      adapter.findOne({
        model: "account",
        where: [
          { field: "accountId", value: createdAccount.accountId },
          { field: "providerId", value: createdAccount.providerId },
        ],
      }),
    ).resolves.toMatchObject({ id: createdAccount.id, accessToken: "access-token" });
    const updatedAt = new Date(createdAccount.updatedAt.getTime() + 1_000);
    await expect(
      adapter.update({
        model: "account",
        where: [{ field: "id", value: createdAccount.id }],
        update: { accessToken: "new-access-token", updatedAt },
      }),
    ).resolves.toMatchObject({ accessToken: "new-access-token", updatedAt });
    await adapter.delete({
      model: "account",
      where: [{ field: "id", value: createdAccount.id }],
    });

    expect(transport.commandLog).toEqual([
      "CreateOAuthUserGraph",
      "UpdateAccount",
      "DeleteAccount",
    ]);
  });

  it("rejects an unknown transaction graph before mutation", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);

    await expect(
      adapter.transaction(async (tx) => {
        await tx.create({ model: "user", data: user(), forceAllowId: true });
      }),
    ).rejects.toMatchObject({
      code: "unsupported_transaction_shape",
    } satisfies Partial<RiffDBBetterAuthCallError>);
    expect(transport.commandLog).toEqual([]);
  });

  it("atomically consumes a complete verification set", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const now = new Date();
    const identifier = "password-reset:user@example.test";
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    for (const id of [firstId, secondId]) {
      await adapter.create({
        model: "verification",
        forceAllowId: true,
        data: {
          id,
          identifier,
          value: crypto.randomUUID(),
          expiresAt: new Date(now.getTime() + 60_000),
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    transport.commandLog.splice(0);

    await adapter.transaction(async (tx) => {
      await tx.consumeOne?.({
        model: "verification",
        where: [{ field: "id", value: firstId }],
      });
      await tx.deleteMany({
        model: "verification",
        where: [{ field: "identifier", value: identifier }],
      });
    });

    expect(transport.commandLog).toEqual(["ConsumeVerificationSet"]);
    await expect(
      adapter.findOne({
        model: "verification",
        where: [{ field: "id", value: secondId }],
      }),
    ).resolves.toBeNull();
  });

  it("updates, expires, and deletes verification rows through compiled operations", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const now = new Date();
    const identifier = `verification:${crypto.randomUUID()}`;
    const currentId = crypto.randomUUID();
    const expiredId = crypto.randomUUID();
    await adapter.create({
      model: "verification",
      forceAllowId: true,
      data: {
        id: expiredId,
        identifier: `expired:${crypto.randomUUID()}`,
        value: "expired",
        expiresAt: new Date(now.getTime() - 60_000),
        createdAt: new Date(now.getTime() - 120_000),
        updatedAt: new Date(now.getTime() - 120_000),
      },
    });
    await adapter.create({
      model: "verification",
      forceAllowId: true,
      data: {
        id: currentId,
        identifier,
        value: "original",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      },
    });
    transport.commandLog.splice(0);

    const extendedExpiry = new Date(now.getTime() + 120_000);
    await expect(
      adapter.update({
        model: "verification",
        where: [{ field: "identifier", value: identifier }],
        update: { value: "updated", expiresAt: extendedExpiry },
      }),
    ).resolves.toMatchObject({ id: currentId, value: "updated", expiresAt: extendedExpiry });
    await expect(
      adapter.deleteMany({
        model: "verification",
        where: [{ field: "expiresAt", value: now, operator: "lt" }],
      }),
    ).resolves.toBe(1);
    await adapter.delete({
      model: "verification",
      where: [{ field: "identifier", value: identifier }],
    });

    expect(transport.commandLog).toEqual([
      "UpdateVerification",
      "DeleteVerification",
      "DeleteVerification",
    ]);
    await expect(
      adapter.findOne({
        model: "verification",
        where: [{ field: "id", value: expiredId }],
      }),
    ).resolves.toBeNull();
    await expect(
      adapter.findOne({
        model: "verification",
        where: [{ field: "id", value: currentId }],
      }),
    ).resolves.toBeNull();
  });

  it("reads secret fields through named RiffQL without dispatching commands", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const createdUser = user();
    const createdAccount = account(createdUser.id);
    const createdSession = session(createdUser.id);

    await adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: createdUser, forceAllowId: true });
      await tx.create({ model: "account", data: createdAccount, forceAllowId: true });
      await tx.create({ model: "session", data: createdSession, forceAllowId: true });
    });
    transport.commandLog.splice(0);

    await expect(
      adapter.findMany({
        model: "account",
        where: [{ field: "userId", value: createdUser.id }],
      }),
    ).resolves.toMatchObject([{ password: createdAccount.password }]);
    await expect(
      adapter.findOne({
        model: "session",
        where: [{ field: "token", value: createdSession.token }],
      }),
    ).resolves.toMatchObject({ token: createdSession.token });
    expect(transport.commandLog).toEqual([]);
  });

  it("deletes a user and bounded dependent auth rows in one command", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const createdUser = user();

    await adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: createdUser, forceAllowId: true });
      await tx.create({ model: "account", data: account(createdUser.id), forceAllowId: true });
      await tx.create({ model: "session", data: session(createdUser.id), forceAllowId: true });
    });
    transport.commandLog.splice(0);

    await adapter.delete({ model: "user", where: [{ field: "id", value: createdUser.id }] });

    expect(transport.commandLog).toEqual(["DeleteUser"]);
    await expect(
      adapter.findOne({ model: "user", where: [{ field: "id", value: createdUser.id }] }),
    ).resolves.toBeNull();
    await expect(
      adapter.findMany({
        model: "account",
        where: [{ field: "userId", value: createdUser.id }],
      }),
    ).resolves.toEqual([]);
  });

  it("supports Better Auth's bounded dependent-delete sequence", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const createdUser = user();

    await adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: createdUser, forceAllowId: true });
      await tx.create({ model: "account", data: account(createdUser.id), forceAllowId: true });
      await tx.create({ model: "session", data: session(createdUser.id), forceAllowId: true });
    });
    transport.commandLog.splice(0);

    await expect(
      adapter.deleteMany({
        model: "session",
        where: [{ field: "userId", value: createdUser.id }],
      }),
    ).resolves.toBe(1);
    await expect(
      adapter.deleteMany({
        model: "account",
        where: [{ field: "userId", value: createdUser.id }],
      }),
    ).resolves.toBe(1);
    await adapter.delete({ model: "user", where: [{ field: "id", value: createdUser.id }] });

    expect(transport.commandLog).toEqual(["DeleteSession", "DeleteAccount", "DeleteUser"]);
  });

  it("updates core user fields with a revision-guarded command", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const createdUser = user();
    await adapter.create({ model: "user", data: createdUser, forceAllowId: true });
    transport.commandLog.splice(0);
    const updatedAt = new Date(createdUser.updatedAt.getTime() + 1_000);

    await expect(
      adapter.update({
        model: "user",
        where: [{ field: "email", value: createdUser.email }],
        update: { name: "Grace Hopper", image: null, updatedAt },
      }),
    ).resolves.toMatchObject({
      id: createdUser.id,
      email: createdUser.email,
      name: "Grace Hopper",
      image: null,
      updatedAt,
    });

    expect(transport.commandLog).toEqual(["UpdateUser"]);
    await expect(
      adapter.findOne({ model: "user", where: [{ field: "id", value: createdUser.id }] }),
    ).resolves.toMatchObject({ name: "Grace Hopper", updatedAt });
  });

  it("refreshes and revokes a session through compiled commands", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const createdUser = user();
    const createdSession = session(createdUser.id);
    await adapter.transaction(async (tx) => {
      await tx.create({ model: "user", data: createdUser, forceAllowId: true });
      await tx.create({ model: "account", data: account(createdUser.id), forceAllowId: true });
      await tx.create({ model: "session", data: createdSession, forceAllowId: true });
    });
    transport.commandLog.splice(0);
    const expiresAt = new Date(createdSession.expiresAt.getTime() + 60_000);
    const updatedAt = new Date(createdSession.updatedAt.getTime() + 1_000);

    await expect(
      adapter.update({
        model: "session",
        where: [{ field: "token", value: createdSession.token }],
        update: { expiresAt, updatedAt },
      }),
    ).resolves.toMatchObject({ id: createdSession.id, expiresAt, updatedAt });
    await adapter.delete({
      model: "session",
      where: [{ field: "token", value: createdSession.token }],
    });

    expect(transport.commandLog).toEqual(["UpdateSession", "DeleteSession"]);
    await expect(
      adapter.findOne({
        model: "session",
        where: [{ field: "token", value: createdSession.token }],
      }),
    ).resolves.toBeNull();
  });

  it("lists active sessions and revokes a bounded token set", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const createdUser = user();
    const now = new Date();
    const expiredSession = {
      ...session(createdUser.id),
      expiresAt: new Date(now.getTime() - 60_000),
    };
    const firstActive = {
      ...session(createdUser.id),
      expiresAt: new Date(now.getTime() + 60_000),
    };
    const secondActive = {
      ...session(createdUser.id),
      expiresAt: new Date(now.getTime() + 120_000),
    };
    await adapter.create({ model: "user", data: createdUser, forceAllowId: true });
    for (const record of [expiredSession, firstActive, secondActive]) {
      await adapter.create({ model: "session", data: record, forceAllowId: true });
    }
    transport.commandLog.splice(0);

    await expect(
      adapter.findMany({
        model: "session",
        where: [
          { field: "userId", value: createdUser.id },
          { field: "expiresAt", value: now, operator: "gt" },
        ],
      }),
    ).resolves.toMatchObject([
      { id: firstActive.id, token: firstActive.token },
      { id: secondActive.id, token: secondActive.token },
    ]);

    const tokens = [expiredSession.token, secondActive.token];
    await expect(
      adapter.findMany({
        model: "session",
        where: [{ field: "token", value: tokens, operator: "in" }],
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expiredSession.id }),
        expect.objectContaining({ id: secondActive.id }),
      ]),
    );
    await expect(
      adapter.deleteMany({
        model: "session",
        where: [{ field: "token", value: tokens, operator: "in" }],
      }),
    ).resolves.toBe(2);

    expect(transport.commandLog).toEqual(["DeleteSession"]);
    await expect(
      adapter.findMany({
        model: "session",
        where: [{ field: "userId", value: createdUser.id }],
      }),
    ).resolves.toMatchObject([{ id: firstActive.id }]);
  });

  it("uses exact compiled user windows for count, search, sort, and offset", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);
    const first = { ...user(), email: "alpha@example.test", image: null };
    const second = { ...user(), email: "beta@example.test", image: "beta.png" };
    const third = { ...user(), email: "gamma@elsewhere.test", image: "gamma.png" };
    for (const record of [first, second, third]) {
      await adapter.create({ model: "user", data: record, forceAllowId: true });
    }

    await expect(adapter.count({ model: "user" })).resolves.toBe(3);
    await expect(
      adapter.count({
        model: "user",
        where: [{ field: "email", value: "@example.test", operator: "ends_with" }],
      }),
    ).resolves.toBe(2);
    await expect(
      adapter.findMany({
        model: "user",
        where: [{ field: "email", value: "example", operator: "contains" }],
        limit: 1,
        offset: 1,
        sortBy: { field: "email", direction: "desc" },
      }),
    ).resolves.toMatchObject([{ id: first.id }]);
    await expect(
      adapter.findMany({
        model: "user",
        where: [{ field: "email", value: "@", operator: "contains" }],
        sortBy: { field: "image", direction: "asc" },
      }),
    ).resolves.toMatchObject([{ id: second.id }, { id: third.id }, { id: first.id }]);
    await expect(
      adapter.findMany({
        model: "user",
        where: [
          { field: "id", value: second.id },
          { field: "email", value: "@", operator: "contains" },
        ],
        sortBy: { field: "image", direction: "asc" },
      }),
    ).resolves.toMatchObject([{ id: second.id }]);
  });

  it("fails closed on unsupported dynamic methods without touching RiffDB", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);

    await expect(adapter.count({ model: "session" })).rejects.toMatchObject({
      code: "unsupported_call_shape",
    });
    await expect(
      adapter.incrementOne?.({
        model: "user",
        where: [{ field: "id", value: crypto.randomUUID() }],
        increment: { counter: 1 },
      }),
    ).rejects.toThrow("Field counter not found in model user");
    expect(transport.commandLog).toEqual([]);
  });
});
