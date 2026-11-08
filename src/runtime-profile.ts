import type { BetterAuthOptions } from "better-auth";
import type { BetterAuthDBSchema } from "better-auth/db";
import type { ApplicationTransport } from "./generated/client.js";
import { BETTER_AUTH_PINNED_VERSION, BETTER_AUTH_CORE_FIELDS } from "./profile.js";
import { defineRiffDBBetterAuthProfilePlan, type RiffDBBetterAuthProfilePlan,
  type RiffDBBetterAuthProfileFieldPlan } from "./profile-plan.js";

export interface RiffDBProfileQuery {
  readonly model: string;
  readonly method: string;
  readonly where: readonly { readonly field: string; readonly operator: string }[];
  readonly order: readonly [string, "asc" | "desc"] | null;
  readonly hydrate?: "member" | "organization";
  readonly cursor?: boolean;
}

export interface RiffDBCompiledProfileInput {
  readonly plan: RiffDBBetterAuthProfilePlan;
  readonly queries: readonly RiffDBProfileQuery[];
  /** The compiler-generated module namespace, never CRUD or transaction callbacks. */
  readonly bindings: object;
}

const boundProfile = Symbol.for("@riffdb/better-auth/compiled-profile/v1");

export interface RiffDBCompiledProfile extends RiffDBCompiledProfileInput {
  readonly schema: "riffdb.better-auth-runtime-profile/v1";
  readonly contractBundleHash: string;
  readonly Client: new (...args: never[]) => object;
}

export function instantiateProfileClient(profile: RiffDBCompiledProfile, transport: ApplicationTransport, budget: number): object {
  const Client = profile.Client as new (transport: ApplicationTransport, commandAttemptBudget: number) => object;
  return new Client(transport, budget);
}

/** Used by generated profile modules after their sources have been reviewed and locked. */
export function defineRiffDBCompiledProfile(input: RiffDBCompiledProfileInput): RiffDBCompiledProfile {
  const bindings = input.bindings as Readonly<Record<string, unknown>>;
  const contractBundleHash = bindings.CONTRACT_BUNDLE_HASH;
  const Client = bindings[`${input.plan.contract.lineage.replace(/[^a-zA-Z0-9]/gu, "")}Client`];
  if (input.plan.betterAuthVersion !== BETTER_AUTH_PINNED_VERSION ||
      typeof contractBundleHash !== "string" || !/^[a-f0-9]{64}$/u.test(contractBundleHash) ||
      bindings.CONTRACT_LINEAGE !== input.plan.contract.lineage || bindings.CONTRACT_VERSION !== 1 ||
      input.plan.models.length > 32 || input.queries.length > 128 || typeof Client !== "function") {
    throw new Error("invalid compiled Better Auth profile");
  }
  // Inspect compiler-owned request metadata locally. A freshly generated plan
  // must not bind an old client that silently omits new optional fields.
  for (const model of input.plan.models) {
    if (model.fields.length > 64) throw new Error("compiled profile field bound exceeded");
    const method = bindings[`create${model.name[0]!.toUpperCase()}${model.name.slice(1)}`];
    if (typeof method !== "function") throw new Error("missing compiled profile command");
    const request = (method as (input: object) => { contractLineage: string; contractVersion: number;
      inputSchema: { kind: string; fields: readonly { name: string; schema: { kind: string; value?: { kind: string } } }[] } })({ request_id: "" });
    if (request.contractLineage !== input.plan.contract.lineage || request.contractVersion !== 1 || request.inputSchema.kind !== "record") {
      throw new Error("compiled profile command identity mismatch");
    }
    for (const field of model.fields) {
      const name = model.name === "organization" || model.name === "member" || model.name === "invitation" || model.name === "twoFactor"
        ? field.name === "organizationId" ? "org_id" : storageField(field.name) : storageField(field.name);
      const actual = request.inputSchema.fields.find((entry) => entry.name === name)?.schema;
      const kind = field.reference !== undefined ? "uuid" : ({ string: "string", boolean: "bool", number: "i64", date: "timestamp" } as Record<string, string>)[String(field.type)];
      const optional = !field.required && !(model.name === "twoFactor" && ["verified", "failedVerificationCount"].includes(field.name));
      if (actual === undefined || kind === undefined ||
          (optional ? actual.kind !== "optional" || actual.value?.kind !== kind : actual.kind !== kind)) {
        throw new Error("compiled profile field schema mismatch");
      }
    }
    const baseFields = (BETTER_AUTH_CORE_FIELDS as Readonly<Record<string, readonly string[]>>)[model.name];
    const extra = model.fields.filter((field) => baseFields === undefined || !baseFields.includes(field.name));
    const commands = [[`update${model.name[0]!.toUpperCase()}${model.name.slice(1)}`, ""],
      ...(model.name === "user" || model.name === "account" ? [["createSignupGraph", `${model.name}_`], ["createOAuthUserGraph", `${model.name}_`]] :
        model.name === "session" ? [["createSignupGraph", "session_"]] : [])];
    for (const [name, prefix] of commands) {
      const helper = bindings[name!];
      if (typeof helper !== "function") throw new Error("missing compiled profile mutation");
      const mutation = (helper as (input: object) => typeof request)({ request_id: "" });
      for (const field of extra) {
        const column = baseFields === undefined && field.name === "organizationId" ? "org_id" : storageField(field.name);
        if (!mutation.inputSchema.fields.some((entry) => entry.name === `${prefix}${column}`)) {
          throw new Error("compiled profile mutation field missing");
        }
      }
    }
  }
  for (const name of ["consumeVerification", "consumeVerificationSnapshot", "resetCredentialPassword", "updateCredentialPassword"]) {
    if (typeof bindings[name] !== "function") throw new Error("missing compiled credential operation");
  }
  type Schema = { readonly kind: string; readonly fields?: readonly { readonly name: string; readonly schema: Schema }[]; readonly value?: Schema };
  const labels: Readonly<Record<string, string>> = { user: "user", users: "user", account: "account", accounts: "account",
    session: "session", sessions: "session", verification: "verification", verifications: "verification",
    organizations: "organization", members: "member", invitations: "invitation" };
  const reads = Object.entries(bindings).filter(([name, method]) => /^(?:find|adminUsers|profile)/u.test(name) && typeof method === "function");
  if (reads.length > 256) throw new Error("compiled profile query bound exceeded");
  for (const [name, method] of reads) {
    const request = (method as (parameters: object) => { contractBundleHash: string; resultSchemas: Readonly<Record<string, Schema>> })({});
    if (request.contractBundleHash !== contractBundleHash) throw new Error("compiled profile query identity mismatch");
    if (name === "findExpiredVerificationIds") continue; // Deliberate identity-only cleanup projection.
    for (const result of Object.values(request.resultSchemas)) for (const leaf of result.fields ?? []) {
      const modelName = labels[leaf.name] ?? (["rows", "record"].includes(leaf.name) ? input.queries.find((query) => query.method === name)?.model : undefined);
      if (modelName === undefined) continue;
      const model = input.plan.models.find((entry) => entry.name === modelName);
      const row = leaf.schema.kind === "list" ? leaf.schema.value : leaf.schema;
      if (model === undefined || row?.kind !== "record") throw new Error("compiled profile result schema mismatch");
      for (const field of model.fields) {
        const column = !["user", "session", "account", "verification"].includes(modelName) && field.name === "organizationId" ? "org_id" : storageField(field.name);
        if (!row.fields?.some((entry) => entry.name === column)) throw new Error("compiled profile result field missing");
      }
    }
  }
  const profile = Object.freeze({ [boundProfile]: true, ...input, plan: freezeCopy(input.plan),
    Client: Client as new (...args: never[]) => object, contractBundleHash,
    queries: freezeCopy(input.queries), schema: "riffdb.better-auth-runtime-profile/v1" as const });
  return profile;
}

function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry !== null && typeof entry === "object") {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
  };
  freeze(copy);
  return copy;
}

export function validateRuntimeProfile(
  profile: RiffDBCompiledProfile, options: BetterAuthOptions, tables: BetterAuthDBSchema,
): void {
  if ((profile as unknown as Record<symbol, unknown>)[boundProfile] !== true) throw new Error("unbound compiled Better Auth profile");
  const plan = defineRiffDBBetterAuthProfilePlan({ ...options,
    plugins: options.plugins?.filter((plugin) => plugin.id !== "next-cookies") ?? [],
  }, tables, { name: profile.plan.name, contractLineage: profile.plan.contract.lineage,
    applicationRole: profile.plan.contract.applicationRole });
  if (JSON.stringify(plan) !== JSON.stringify(profile.plan)) throw new Error("compiled Better Auth schema mismatch");
  if (new Set((options.plugins ?? []).map((plugin) => plugin.id)).size !== (options.plugins ?? []).length) {
    throw new Error("duplicate Better Auth plugins");
  }
  for (const plugin of options.plugins ?? []) {
    if (plugin.version !== BETTER_AUTH_PINNED_VERSION ||
        ![...profile.plan.plugins, "next-cookies"].includes(plugin.id)) {
      throw new Error("unsupported Better Auth plugin");
    }
    if (plugin.id === "organization") {
      const settings = (plugin as { options?: Record<string, unknown> }).options ?? {};
      if ((settings.teams as { enabled?: boolean } | undefined)?.enabled ||
          (settings.dynamicAccessControl as { enabled?: boolean } | undefined)?.enabled ||
          settings.organizationHooks !== undefined || settings.organizationCreation !== undefined) {
        throw new Error("unsupported organization plugin options");
      }
      for (const limit of ["membershipLimit", "invitationLimit", "organizationLimit"]) {
        const value = settings[limit];
        if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100)) {
          throw new Error("unsupported organization profile limit");
        }
      }
    }
  }
  if (profile.plan.plugins.includes("organization") && options.user?.deleteUser?.enabled) {
    throw new Error("user deletion is unavailable in the organization profile");
  }
  if (options.databaseHooks !== undefined || options.emailAndPassword?.revokeSessionsOnPasswordReset) {
    throw new Error("unsupported compiled Better Auth transaction configuration");
  }
}

export function storageField(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

export function encodeProfileField(field: RiffDBBetterAuthProfileFieldPlan, value: unknown): unknown {
  if (value === undefined || value === null) {
    if (field.required) throw new Error(`missing compiled profile field: ${field.name}`);
    return null;
  }
  if (field.reference !== undefined && (typeof value !== "string" || !/^[a-f0-9-]{36}$/iu.test(value))) {
    throw new Error(`invalid compiled profile reference: ${field.name}`);
  }
  switch (field.type) {
    case "string":
      if (typeof value !== "string" || Buffer.byteLength(value) >
          (({ email: 320, role: 256, status: 32, name: 256, slug: 256 } as Record<string, number>)[field.name] ?? 2048)) break;
      return value;
    case "boolean": if (typeof value === "boolean") return value; break;
    case "number":
      if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
      break;
    case "date":
      if (value instanceof Date && Number.isFinite(value.getTime())) {
        const seconds = Math.floor(value.getTime() / 1000);
        return { seconds: BigInt(seconds), nanos: (value.getTime() - seconds * 1000) * 1_000_000 };
      }
      break;
    default: break;
  }
  throw new Error(`invalid compiled profile field: ${field.name}`);
}

export function decodeProfileField(field: RiffDBBetterAuthProfileFieldPlan, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (field.type === "date") {
    const stamp = value as { seconds: bigint; nanos: number };
    const milliseconds = Number(stamp.seconds) * 1000 + stamp.nanos / 1_000_000;
    if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) {
      throw new Error("invalid compiled profile timestamp");
    }
    return new Date(milliseconds);
  }
  if (field.type === "number") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("invalid compiled profile integer");
    return number;
  }
  return value;
}
