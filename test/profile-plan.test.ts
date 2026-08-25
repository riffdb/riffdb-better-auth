import { getAuthTables } from "better-auth/db";
import { organization, twoFactor } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import {
  RIFFDB_BETTER_AUTH_PROFILE_PLAN_SCHEMA,
  defineRiffDBBetterAuthProfilePlan,
  riffdbProfileAdapter,
} from "../src/index.js";

const generator = {
  name: "BetterAuthOrganizationSecurity",
  contractLineage: "BetterAuthOrganizationSecurity",
  applicationRole: "BetterAuthServer",
} as const;

describe("compiled profile planning", () => {
  it("captures additional fields and representative organization/security plugins", () => {
    const options = {
      advanced: { database: { generateId: "uuid" as const } },
      user: {
        additionalFields: {
          locale: { type: "string" as const, required: false },
        },
      },
      plugins: [organization({ teams: { enabled: true } }), twoFactor()],
    };
    const plan = defineRiffDBBetterAuthProfilePlan(options, getAuthTables(options), generator);

    expect(plan.schema).toBe(RIFFDB_BETTER_AUTH_PROFILE_PLAN_SCHEMA);
    expect(plan.idGeneration).toBe("uuid");
    expect(plan.plugins).toEqual(["organization", "two-factor"]);
    expect(plan.models.map((model) => model.name)).toEqual(
      expect.arrayContaining([
        "account",
        "invitation",
        "member",
        "organization",
        "session",
        "team",
        "teamMember",
        "twoFactor",
        "user",
        "verification",
      ]),
    );
    const user = plan.models.find((model) => model.name === "user");
    expect(user?.fields.find((field) => field.name === "locale")).toMatchObject({
      type: "string",
      required: false,
    });
    const twoFactorModel = plan.models.find((model) => model.name === "twoFactor");
    expect(twoFactorModel?.fields.find((field) => field.name === "secret")?.secret).toBe(true);
    expect(twoFactorModel?.fields.find((field) => field.name === "backupCodes")?.secret).toBe(
      true,
    );
  });

  it("integrates with Better Auth createSchema without a RiffDB connection", async () => {
    const options = {
      database: riffdbProfileAdapter(generator),
      advanced: { database: { generateId: "uuid" as const } },
      plugins: [twoFactor()],
    };
    const adapter = options.database(options);
    const schema = await adapter.createSchema?.(options);

    expect(schema).toMatchObject({
      path: "riffdb/better-auth.profile.json",
      overwrite: true,
    });
    expect(JSON.parse(schema?.code ?? "{}")).toMatchObject({
      schema: RIFFDB_BETTER_AUTH_PROFILE_PLAN_SCHEMA,
      idGeneration: "uuid",
      plugins: ["two-factor"],
    });
  });

  it("rejects non-UUID plans and runtime use of the generation adapter", async () => {
    const invalidOptions = { advanced: { database: { generateId: "serial" as const } } };
    expect(() =>
      defineRiffDBBetterAuthProfilePlan(
        invalidOptions,
        getAuthTables(invalidOptions),
        generator,
      ),
    ).toThrowError(expect.objectContaining({ code: "unsupported_id_generation" }));

    const options = {
      database: riffdbProfileAdapter(generator),
      advanced: { database: { generateId: "uuid" as const } },
    };
    const adapter = options.database(options);
    await expect(
      adapter.findMany({ model: "user", limit: 1 }),
    ).rejects.toMatchObject({ code: "generation_only_runtime_call" });
  });
});
