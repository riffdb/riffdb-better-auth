import type { DriverApplicationTransport } from "@riffdb/client";
import { getAuthTables } from "better-auth/db";
import { organization, twoFactor } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";
import custom from "../profiles/custom-fields/profile.js";
import runtime from "../profiles/runtime/profile.js";
import { defineRiffDBCompiledProfile, defineRiffDBBetterAuthProfilePlan, materializeRiffDBBetterAuthRuntimeProfile, riffdbAdapter } from "../src/index.js";

const tenant = "018f5f7e-7b0c-7d9a-8f14-77f42f53c851";
const fields = { locale: { type: "string" as const, required: false }, dateField: { type: "date" as const, required: false } };
function setup(profile = runtime) {
  const invoke = vi.fn();
  const factory = riffdbAdapter({ driver: { invoke } as unknown as DriverApplicationTransport, organizationId: tenant, profile });
  const options = { advanced: { database: { generateId: "uuid" as const } }, user: { additionalFields: fields },
    plugins: profile === runtime ? [organization(), twoFactor()] : [] };
  return { factory, options, invoke };
}

describe("compiled runtime profile boundary", () => {
  it("rejects schema drift and unsupported plugin options before driver calls", () => {
    const { factory, options, invoke } = setup();
    expect(() => factory({ ...options, user: { additionalFields: { locale: { type: "number" } } } })).toThrow();
    expect(() => factory({ ...options, plugins: [organization({ teams: { enabled: true } }), twoFactor()] })).toThrow();
    expect(() => factory({ ...options, user: { ...options.user, deleteUser: { enabled: true } } })).toThrow();
    expect(() => factory({ ...options, emailAndPassword: { enabled: true, revokeSessionsOnPasswordReset: true } })).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects uncompiled predicates, order, joins, and increments before driver calls", async () => {
    const { factory, options, invoke } = setup();
    const adapter = factory(options);
    const id = crypto.randomUUID();
    await expect(adapter.findMany({ model: "member", where: [{ field: "organizationId", value: id }], sortBy: { field: "userId", direction: "desc" } })).rejects.toThrow();
    await expect(adapter.findOne({ model: "member", where: [{ field: "id", value: id }], join: { invitation: true } })).rejects.toThrow();
    await expect(adapter.incrementOne({ model: "twoFactor", where: [{ field: "id", value: id }], increment: { failedVerificationCount: 2 } })).rejects.toThrow();
    await expect(adapter.deleteMany({ model: "invitation", where: [{ field: "email", value: "unused@example.test" }] })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("binds custom fields and rejects missing fields before any request", () => {
    const { factory, options, invoke } = setup(custom);
    expect(factory(options).id).toBe("riffdb");
    expect(() => factory({ ...options, user: {} })).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a stale generated client that would omit a newly planned optional field", () => {
    const user = custom.plan.models.find((model) => model.name === "user")!;
    const field = { ...user.fields.find((field) => field.name === "locale")!, name: "timezone", storageName: "timezone" };
    const plan = { ...custom.plan, models: custom.plan.models.map((model) => model === user ? { ...model, fields: [...model.fields, field] } : model) };
    expect(() => defineRiffDBCompiledProfile({ plan, queries: custom.queries, bindings: custom.bindings })).toThrow("compiled profile field schema mismatch");
    expect(() => defineRiffDBCompiledProfile({ plan: custom.plan, queries: custom.queries, bindings: runtime.bindings })).toThrow("invalid compiled Better Auth profile");
  });

  it("refuses to materialize teams as an executable runtime profile", () => {
    const options = { advanced: { database: { generateId: "uuid" as const } }, plugins: [organization({ teams: { enabled: true } })] };
    const plan = defineRiffDBBetterAuthProfilePlan(options, getAuthTables(options), { name: "UnsupportedTeams", contractLineage: "UnsupportedTeams" });
    expect(() => materializeRiffDBBetterAuthRuntimeProfile(plan)).toThrow("unsupported runtime profile");
  });
});
