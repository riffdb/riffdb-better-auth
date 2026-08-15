import { describe, expect, it } from "vitest";

import {
  BETTER_AUTH_CORE_FIELDS,
  BETTER_AUTH_CORE_MODELS,
  RIFFDB_BETTER_AUTH_PROFILE_SCHEMA,
  UnsupportedBetterAuthProfileError,
  defineRiffDBBetterAuthCoreProfile,
  type RiffDBBetterAuthCoreProfileInput,
} from "../src/index.js";

function coreInput(): RiffDBBetterAuthCoreProfileInput {
  return {
    schema: RIFFDB_BETTER_AUTH_PROFILE_SCHEMA,
    betterAuthVersion: "1.6.29",
    idGeneration: "uuid",
    plugins: [],
    models: BETTER_AUTH_CORE_MODELS.map((name) => ({
      name,
      fields: BETTER_AUTH_CORE_FIELDS[name],
    })),
    contract: {
      lineage: "BetterAuthCore",
      version: 1,
      bundleHash: "a".repeat(64),
      applicationRole: "BetterAuthServer",
    },
  };
}

function expectCode(run: () => unknown, code: UnsupportedBetterAuthProfileError["code"]): void {
  expect(run).toThrowError(UnsupportedBetterAuthProfileError);
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("defineRiffDBBetterAuthCoreProfile", () => {
  it("accepts and freezes the exact core-only profile", () => {
    const profile = defineRiffDBBetterAuthCoreProfile(coreInput());

    expect(profile.betterAuthVersion).toBe("1.6.29");
    expect(Object.keys(profile.models)).toEqual(BETTER_AUTH_CORE_MODELS);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.models.user.fields)).toBe(true);
    expect(Object.isFrozen(profile.contract)).toBe(true);
  });

  it("rejects plugins instead of silently creating generic tables", () => {
    expectCode(
      () => defineRiffDBBetterAuthCoreProfile({ ...coreInput(), plugins: ["two-factor"] }),
      "unsupported_plugin",
    );
  });

  it("rejects additional or missing fields", () => {
    const input = coreInput();
    const models = input.models.map((model) =>
      model.name === "user" ? { ...model, fields: [...model.fields, "role"] } : model,
    );
    expectCode(
      () => defineRiffDBBetterAuthCoreProfile({ ...input, models }),
      "unsupported_field_shape",
    );
  });

  it("rejects renamed and additional models", () => {
    const input = coreInput();
    const models = input.models.map((model) =>
      model.name === "user" ? { ...model, name: "users" } : model,
    );
    expectCode(
      () => defineRiffDBBetterAuthCoreProfile({ ...input, models }),
      "unsupported_model",
    );
  });

  it("rejects unreviewed Better Auth versions and ID strategies", () => {
    expectCode(
      () => defineRiffDBBetterAuthCoreProfile({ ...coreInput(), betterAuthVersion: "1.7.0" }),
      "unsupported_better_auth_version",
    );
    expectCode(
      () => defineRiffDBBetterAuthCoreProfile({ ...coreInput(), idGeneration: "serial" }),
      "unsupported_id_generation",
    );
  });

  it("rejects malformed RiffDB contract identities", () => {
    expectCode(
      () =>
        defineRiffDBBetterAuthCoreProfile({
          ...coreInput(),
          contract: { ...coreInput().contract, bundleHash: "not-a-hash" },
        }),
      "invalid_contract_identity",
    );
  });
});
