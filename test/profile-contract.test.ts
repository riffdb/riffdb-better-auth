import { getAuthTables } from "better-auth/db";
import { organization, twoFactor } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import {
  RiffDBBetterAuthMaterializationError,
  defineRiffDBBetterAuthProfilePlan,
  materializeRiffDBBetterAuthProfile,
} from "../src/index.js";

const generator = {
  name: "BetterAuthOrganizationSecurity",
  contractLineage: "BetterAuthOrganizationSecurity",
  applicationRole: "BetterAuthServer",
} as const;

const options = {
  advanced: { database: { generateId: "uuid" as const } },
  user: { additionalFields: { locale: { type: "string" as const, required: false } } },
  plugins: [organization({ teams: { enabled: true } }), twoFactor()],
};

function representativePlan() {
  return defineRiffDBBetterAuthProfilePlan(options, getAuthTables(options), generator);
}

function materialize() {
  return materializeRiffDBBetterAuthProfile(representativePlan());
}

describe("profile materialization", () => {
  it("emits one contract carrying the declared lineage", () => {
    const { contract } = materialize();
    expect(contract).toContain("contract BetterAuthOrganizationSecurity version 1 {");
    expect(contract.endsWith("}\n")).toBe(true);
  });

  it("assigns every model to exactly one aggregate", () => {
    const plan = representativePlan();
    const { report } = materializeRiffDBBetterAuthProfile(plan);
    const placed = report.aggregates.flatMap((entry) => [entry.root, ...entry.children]);
    expect(placed.slice().sort()).toStrictEqual(plan.models.map((model) => model.name).sort());
  });

  it("roots the aggregates Better Auth's references imply", () => {
    const { report } = materialize();
    const byRoot = new Map(report.aggregates.map((entry) => [entry.root, entry.children]));
    expect([...byRoot.keys()].sort()).toStrictEqual(["organization", "user", "verification"]);
    expect(byRoot.get("user")).toContain("account");
    expect(byRoot.get("user")).toContain("session");
    expect(byRoot.get("organization")).toContain("team");
  });

  it("reports every reference the contract cannot enforce", () => {
    const { report, contract } = materialize();
    // A join model reaches two roots; only the owning edge becomes a
    // `reference`, so the rest must be reported rather than silently dropped.
    expect(report.unenforcedReferences).toStrictEqual([
      { model: "invitation", field: "organizationId", targetModel: "organization", reason: "cross_aggregate_edge" },
      { model: "member", field: "userId", targetModel: "user", reason: "cross_aggregate_edge" },
      { model: "teamMember", field: "teamId", targetModel: "team", reason: "cross_aggregate_edge" },
    ]);
    for (const unenforced of report.unenforcedReferences) {
      expect(contract).not.toContain(`_${unenforced.field.toLowerCase()}_reference`);
    }
  });

  it("keeps a synthesized key column clear of a schema field of the same name", () => {
    // Better Auth's `account` model carries the provider's own `accountId`.
    const { contract } = materialize();
    expect(contract).toContain("key (tenant_id: uuid, user_id: uuid, account_row_id: uuid)");
    expect(contract).toContain("field account_id: string<2048>");
  });

  it("partitions on a column no Better Auth model can collide with", () => {
    const { contract } = materialize();
    expect(contract).toContain("partition_by tenant_id");
    expect(contract).toContain("key (tenant_id: uuid, organization_id: uuid, member_id: uuid)");
  });

  it("keeps a cascading delete inside the fixed graph bound", () => {
    const { contract } = materialize();
    // user owns five children at maximum 32, so 1 * (1 + 160) <= 256 admits
    // exactly one root per command.
    expect(contract).toContain("input user_ids: list<uuid, 1..1>");
    // organization owns two, so 3 * (1 + 64) <= 256.
    expect(contract).toContain("input organization_ids: list<uuid, 1..3>");
  });

  it("proves a reference target before creating a child", () => {
    const { contract } = materialize();
    expect(contract).toContain(
      "read User(tenant_id, user_id) as user else AccountParentMissing {}",
    );
  });

  it("carries Better Auth's unreturned fields as secret", () => {
    const { contract } = materialize();
    expect(contract).toContain("field secret password: optional<string<2048>>");
    expect(contract).toContain("field secret access_token: optional<string<2048>>");
  });

  it("orders every bounded read by the tail its index proves", () => {
    const { queries } = materialize();
    const byEmail = queries.find((query) => query.name === "FindInvitationByEmail");
    expect(byEmail?.code).toContain("order by user_id asc, invitation_id asc");
  });

  it("emits an exact read per model and a bounded read per indexed field", () => {
    const { queries } = materialize();
    expect(queries.filter((query) => query.name.endsWith("ById"))).toHaveLength(10);
    expect(queries.map((query) => query.name)).toContain("FindUserByEmail");
    for (const query of queries) expect(query.path).toMatch(/^riffdb\/queries\/[a-z0-9_]+\.riffq$/u);
  });

  it("binds the queries it generated into the application source", () => {
    const { applicationSource, queries } = materialize();
    const source = JSON.parse(applicationSource);
    expect(source.schema).toBe("riffdb.application-source/v6");
    expect(source.contract.lineage).toBe("BetterAuthOrganizationSecurity");
    expect(source.query_modules[0].queries).toHaveLength(queries.length);
  });

  it("grants the generated operations to the planned application role", () => {
    const { applicationSource, queries } = materialize();
    const [role] = JSON.parse(applicationSource).roles;
    expect(role.name).toBe("BetterAuthServer");
    expect(role.queries).toStrictEqual(queries.map((query) => query.name));
    // Three commands per model, and nothing granted that was not generated.
    expect(role.commands).toHaveLength(30);
    expect(role.commands).toContain("CreateUser");
    expect(role.row_policies).toStrictEqual([]);
  });

  it("is deterministic", () => {
    expect(materialize()).toStrictEqual(materialize());
  });

  it("rejects a bound outside its permitted range", () => {
    expect(() => materializeRiffDBBetterAuthProfile(representativePlan(), { stringBound: 0 })).toThrow(
      RiffDBBetterAuthMaterializationError,
    );
  });
});
