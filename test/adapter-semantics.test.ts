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

  it("fails closed on dynamic methods without touching RiffDB", async () => {
    const transport = new FakeRiffDBApplicationTransport();
    const adapter = createAdapter(transport);

    await expect(adapter.count({ model: "user" })).rejects.toMatchObject({
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
