import { readFileSync } from "node:fs";
import { getAuthTables } from "better-auth/db";
import { organization, twoFactor as twoFactorPlugin } from "better-auth/plugins";
import { defineRiffDBBetterAuthProfilePlan } from "./profile-plan.js";
import type { RiffDBBetterAuthProfilePlan, RiffDBBetterAuthProfileFieldPlan } from "./profile-plan.js";
import { BETTER_AUTH_CORE_FIELDS, isSupportedBetterAuthVersion } from "./profile.js";
import { storageField, type RiffDBProfileQuery } from "./runtime-profile.js";

export interface RiffDBRuntimeMaterialization {
  readonly files: Readonly<Record<string, string>>;
  readonly queries: readonly RiffDBProfileQuery[];
}

const coreModels = ["user", "account", "session", "verification"] as const;
const entityName = (name: string): string => name[0]!.toUpperCase() + name.slice(1);
const key = (model: string): string => model === "organization" ? "org_id" : `${storageField(model)}_id`;
export const profileColumn = (field: string): string => field === "organizationId" ? "org_id" : storageField(field);

function fieldType(field: RiffDBBetterAuthProfileFieldPlan): string {
  if (typeof field.type !== "string") throw new Error("runtime enum fields require a reviewed codec");
  const base = field.reference !== undefined ? "uuid" : ({ string: `string<${({ email: 320, role: 256, status: 32, name: 256, slug: 256 } as Record<string, number>)[field.name] ?? 2048}>`, boolean: "bool",
    number: "i64", date: "timestamp" } as Record<string, string>)[field.type];
  if (base === undefined) throw new Error(`runtime profile field type is not supported: ${field.type}`);
  return field.required || field.name === "failedVerificationCount" || field.name === "verified" ? base : `optional<${base}>`;
}

/** Complete runtime sources for reviewed core extensions, organization (without teams), and 2FA. */
export function materializeRiffDBBetterAuthRuntimeProfile(plan: RiffDBBetterAuthProfilePlan): RiffDBRuntimeMaterialization {
  if (!isSupportedBetterAuthVersion(plan.betterAuthVersion) || plan.plugins.some((id) => !["organization", "two-factor"].includes(id)) ||
      plan.models.some((model) => ![...coreModels, "organization", "member", "invitation", "twoFactor"].includes(model.name))) {
    throw new Error("unsupported runtime profile");
  }
  const org = plan.plugins.includes("organization");
  const twoFactor = plan.plugins.includes("two-factor");
  const baselineOptions = { advanced: { database: { generateId: "uuid" as const } },
    plugins: [...(org ? [organization()] : []), ...(twoFactor ? [twoFactorPlugin()] : [])] };
  const baseline = defineRiffDBBetterAuthProfilePlan(baselineOptions, getAuthTables(baselineOptions), {
    name: plan.name, contractLineage: plan.contract.lineage, applicationRole: plan.contract.applicationRole,
  });
  if (JSON.stringify(plan.models.map((model) => model.name)) !== JSON.stringify(baseline.models.map((model) => model.name))) {
    throw new Error("unsupported runtime model inventory");
  }
  for (const model of plan.models) {
    const expected = baseline.models.find((entry) => entry.name === model.name)!;
    for (const field of expected.fields) if (JSON.stringify(model.fields.find((entry) => entry.name === field.name)) !== JSON.stringify(field)) {
      throw new Error("unsupported runtime schema override");
    }
    for (const field of model.fields.filter((field) => !expected.fields.some((entry) => entry.name === field.name))) {
      if (model.name !== "user" || field.indexed || field.unique || field.reference !== undefined) {
        throw new Error("unsupported runtime field extension");
      }
    }
  }
  for (const model of plan.models) {
    if (model.storageName !== model.name || model.fields.some((field) => field.storageName !== field.name)) {
      throw new Error("runtime profiles require default storage names");
    }
    for (const field of model.fields) fieldType(field);
  }
  const files: Record<string, string> = {};
  const base = new URL("../", import.meta.url);
  const application = JSON.parse(readFileSync(new URL("riffdb.application.json", base), "utf8"));
  let contract = readFileSync(new URL("riffdb/contract.riff", base), "utf8")
    .replace("contract RiffDBBetterAuthCore version 1", `contract ${plan.contract.lineage} version 1`);
  const extra = new Map<string, readonly RiffDBBetterAuthProfileFieldPlan[]>();
  for (const model of coreModels) {
    const fields = plan.models.find((entry) => entry.name === model)?.fields;
    if (fields === undefined) throw new Error(`missing runtime profile model: ${model}`);
    const known = BETTER_AUTH_CORE_FIELDS[model] as readonly string[];
    extra.set(model, fields.filter((field) => !known.includes(field.name)));
  }
  const declarations = new Map<string, string>();
  const pattern = /^  (?:(?:bulk )?command|entity|aggregate) (\w+) \{/gmu;
  const starts = [...contract.matchAll(pattern)];
  for (let i = 0; i < starts.length; i += 1) {
    declarations.set(starts[i]![1]!, contract.slice(starts[i]!.index, starts[i + 1]?.index ?? contract.lastIndexOf("}")) .trimEnd());
  }
  for (const model of coreModels) {
    const entity = entityName(model);
    const fields = extra.get(model)!;
    let source = declarations.get(entity)!;
    const inserted = fields.map((field) => `    field ${field.secret ? "secret " : ""}${storageField(field.name)}: ${fieldType(field)}`).join("\n");
    source = source.replace(/    (unique|index|delete_policy)/u, `${inserted}${inserted ? "\n" : ""}    $1`);
    if (model === "user" && fields.length > 0) source = source.replace(/cover\(([^)]+)\)/gu,
      (_match, cover: string) => `cover(${cover}, ${fields.map((field) => storageField(field.name)).join(", ")})`);
    if (model === "user") source = source.replace("    unique user_email", "    index by_id (organization_id, user_id)\n    unique user_email");
    declarations.set(entity, source);
    for (const command of [`Create${entity}`, `Update${entity}`,
      ...(model === "user" || model === "account" ? ["CreateSignupGraph", "CreateOAuthUserGraph"] : model === "session" ? ["CreateSignupGraph"] : [])]) {
      let body = declarations.get(command)!;
      const graph = command.endsWith("Graph");
      const binding = model;
      const inputs = fields.map((field) => `    input ${graph ? `${model}_` : ""}${storageField(field.name)}: ${fieldType(field)}`).join("\n");
      body = body.replace("    idempotency_key", `${inputs}${inputs ? "\n" : ""}    idempotency_key`);
      const assignments = fields.map((field) => `    set ${binding}.${storageField(field.name)} = ${graph ? `${model}_` : ""}${storageField(field.name)}${command.startsWith("Update") && model !== "user" && model !== "verification" ? " checked_by current_revision" : ""}`).join("\n");
      body = body.replace(`    set ${binding}.revision =`, `${assignments}${assignments ? "\n" : ""}    set ${binding}.revision =`);
      if (command.startsWith("Update") && (model === "user" || model === "verification")) body = body.replace(new RegExp(`(    set ${model}\\.(?!revision)[^\\n]+)`, "gu"), "$1 checked_by current_revision");
      declarations.set(command, body);
    }
  }
  for (const query of application.query_modules[0].queries) {
    let source = readFileSync(new URL(query.source, base), "utf8");
    for (const model of coreModels) {
      source = source.replace(new RegExp(`\\b(${model}s?): (${model}s?) \\{([^{}]*)\\}`, "gu"), (_match, label: string, alias: string, projection: string) => {
        const fields = extra.get(model)!;
        const leaves = fields.map((field) => `${storageField(field.name)}${field.secret ? ` reveals ${alias}.${storageField(field.name)}` : ""}`).join(" ");
        return `${label}: ${alias} {${projection} ${leaves} }`;
      });
    }
    files[query.source] = source;
  }
  // Shared tenant ownership lets organization relationships retain both
  // foreign-key proofs. Organization profiles omit user deletion: the current
  // compiler cannot admit commands binding two cascade-policy entities.
  declarations.delete("UserAuthData");
  declarations.delete("VerificationData");
  if (org) {
    declarations.set("User", declarations.get("User")!.replace(/    delete_policy cascade \{[^}]*\}/u, ""));
    declarations.delete("DeleteUser");
  } else if (twoFactor) {
    declarations.set("User", declarations.get("User")!.replace("    delete_policy cascade {",
      "    delete_policy cascade {\n      relationship TwoFactor.two_factor_user using TwoFactor.by_user_id maximum 1"));
  }
  declarations.set("Tenant", "  entity Tenant {\n    key (organization_id: uuid)\n    delete_policy no_inbound\n  }");
  const plugins = plan.models.filter((model) => !coreModels.includes(model.name as typeof coreModels[number]));
  const projection = (model: string, alias: string): string => {
    const fields = plan.models.find((entry) => entry.name === model)!.fields;
    return [key(model), ...fields.map((field) => `${profileColumn(field.name)}${field.secret && field.reference === undefined ? ` reveals ${alias}.${profileColumn(field.name)}` : ""}`), "revision"].join(" ");
  };
  for (const model of plugins) {
    const entity = entityName(model.name);
    const columns = model.fields.map((field) => `    field ${field.secret && field.reference === undefined ? "secret " : ""}${profileColumn(field.name)}: ${fieldType(field)}`);
    if (model.name === "organization") columns.push("    field member_count: i64", "    field invitation_count: i64");
    if (model.name === "twoFactor") columns.push("    field locked_until_millis: i64");
    const indexes = model.fields.filter((field) => field.reference !== undefined || (!field.secret && (field.indexed || field.unique)))
      .map((field) => `    index by_${profileColumn(field.name)} (organization_id, ${profileColumn(field.name)}, ${key(model.name)})${field.type === "string" && field.reference === undefined ? ` text_key(${profileColumn(field.name)}, binary_utf8_v1)` : ""}`);
    const references = model.fields.filter((field) => field.reference !== undefined).map((field) =>
      `    reference ${storageField(model.name)}_${field.name === "userId" ? "user" : storageField(field.name)} (organization_id, ${profileColumn(field.name)}) -> ${entityName(field.reference!.model)}(organization_id, ${field.reference!.model === "user" ? "user_id" : key(field.reference!.model)})`);
    const unique = model.fields.filter((field) => field.unique).map((field) => `    unique unique_${profileColumn(field.name)} (organization_id, ${profileColumn(field.name)})`);
    if (model.name === "member") {
      indexes.push("    index by_role (organization_id, role, member_id) text_key(role, binary_utf8_v1)", "    index by_created_at (organization_id, created_at, member_id)");
      unique.push("    unique membership (organization_id, org_id, user_id)");
      indexes.push("    index by_org_user (organization_id, org_id, user_id, member_id)");
      for (const name of ["role", "created_at"]) indexes.push(`    index by_org_${name} (organization_id, org_id, ${name}, member_id)${name === "role" ? " text_key(role, binary_utf8_v1)" : ""}`);
    }
    if (model.name === "invitation") {
      indexes.push("    index by_org_status (organization_id, org_id, status, invitation_id)",
        "    index by_org_email_status (organization_id, org_id, email, status, invitation_id)");
    }
    if (model.name === "twoFactor") unique.push("    unique two_factor_user (organization_id, user_id)");
    const policy = model.name === "organization" ? `    delete_policy cascade {\n      relationship Member.member_organization_id using Member.by_org_id maximum 100\n      relationship Invitation.invitation_organization_id using Invitation.by_org_id maximum 100\n    }` : "    delete_policy no_inbound";
    declarations.set(entity, [`  entity ${entity} {`, `    key (organization_id: uuid, ${key(model.name)}: uuid)`, ...columns,
      "    field revision: u64", ...unique, ...indexes, ...references, policy, "  }"].join("\n"));
    const inputs = model.fields.map((field) => `    input ${profileColumn(field.name)}: ${fieldType(field)}`);
    if (model.name === "twoFactor") inputs.push("    input locked_until_millis: i64");
    const parentReads = model.fields.filter((field) => field.reference !== undefined).map((field) =>
      `    read ${entityName(field.reference!.model)}(organization_id, ${profileColumn(field.name)}) as parent_${profileColumn(field.name)} else ${entity}ParentMissing {}`);
    const setters = model.fields.map((field) => `    set record.${profileColumn(field.name)} = ${profileColumn(field.name)}`);
    if (model.name === "twoFactor") setters.push("    set record.locked_until_millis = locked_until_millis");
    const initialCounters = model.name === "organization" ? ["    set record.member_count = 0", "    set record.invitation_count = 0"] : [];
    declarations.set(`Create${entity}`, [`  command Create${entity} {`, "    input request_id: uuid", "    input organization_id: uuid",
      `    input ${key(model.name)}: uuid`, ...inputs, "    idempotency_key request_id", ...parentReads,
      `    create ${entity}(organization_id, ${key(model.name)}) as record else ${entity}AlreadyExists {}`,
      ...setters, ...initialCounters, "    set record.revision = 1", `    return ${entity}Created {}`, "  }"].join("\n"));
    declarations.set(`Update${entity}`, [`  command Update${entity} {`, "    input request_id: uuid", "    input organization_id: uuid",
      `    input ${key(model.name)}: uuid`, "    input expected_revision: u64", ...inputs, "    idempotency_key request_id", ...parentReads,
      `    mutate ${entity}(organization_id, ${key(model.name)}) as record else ${entity}Missing {}`,
      "    require current_revision: record.revision == expected_revision else Stale {}",
      ...setters.map((line) => `${line} checked_by current_revision`), "    set record.revision = record.revision + 1",
      `    return ${entity}Updated {}`, "  }"].join("\n"));
    declarations.set(`Delete${entity}`, [`  bulk command Delete${entity} {`, "    input request_id: uuid", "    input organization_id: uuid",
      `    input ids: list<uuid, 1..${model.name === "organization" ? 1 : 100}>`, "    idempotency_key request_id", "    for id in ids {",
      `      delete ${entity}(organization_id, id) as record else ${entity}Missing {}`,
      ...(model.name === "organization" ? ["        cascade CascadeLimitExceeded {}"] : []), "    }", `    return ${entity}Deleted {}`, "  }"].join("\n"));
  }
  if (org) {
    for (const [model, counter] of [["Member", "member_count"], ["Invitation", "invitation_count"]]) {
      let create = declarations.get(`Create${model}`)!;
      create = create.replace("    read Organization(organization_id, org_id) as parent_org_id", "    mutate Organization(organization_id, org_id) as parent_org_id");
      create = create.replace("    set record.", `    require capacity: parent_org_id.${counter} < 100 else CapacityExceeded {}\n    set record.`);
      create = create.replace(`    return ${model}Created {}`, `    set parent_org_id.${counter} = parent_org_id.${counter} + 1\n    set parent_org_id.revision = parent_org_id.revision + 1\n    return ${model}Created {}`);
      declarations.set(`Create${model}`, create);
      const deletion = [
        `  bulk command Delete${model} {`, "    input request_id: uuid", "    input organization_id: uuid",
        "    input org_id: uuid", "    input ids: list<uuid, 1..1>", "    idempotency_key request_id",
        "    mutate Organization(organization_id, org_id) as parent else OrganizationMissing {}",
        "    for id in ids {", `      delete ${model}(organization_id, id) as record else ${model}Missing {}`,
        "      require same_organization: record.org_id == org_id else OrganizationMismatch {}", "    }",
        `    require counted: parent.${counter} > 0 else CounterInconsistent {}`,
        `    set parent.${counter} = parent.${counter} - 1 checked_by counted`, "    set parent.revision = parent.revision + 1",
        `    return ${model}Deleted {}`, "  }",
      ].join("\n");
      declarations.set(`Delete${model}`, deletion);
    }
  }
  const entities = [...declarations.values()].filter((source) => source.startsWith("  entity"));
  declarations.set("TenantData", ["  aggregate TenantData {", "    root Tenant",
    ...entities.filter((source) => !source.startsWith("  entity Tenant ")).map((source) => `    child ${/^  entity (\w+)/u.exec(source)![1]}`),
    "    partition_by organization_id", "    conflict_key (organization_id)", "  }"].join("\n"));

  const queries: RiffDBProfileQuery[] = [];
  const addQuery = (model: string, suffix: string, where: readonly { field: string; operator: string }[], order: readonly [string, "asc" | "desc"] | null = null): void => {
    const entity = entityName(model);
    const name = `Profile${entity}${suffix}`;
    const conditions = where.map((clause) => `${clause.field === "id" ? key(model) : profileColumn(clause.field)} ${clause.operator === "in" ? "in" : "=="} $${profileColumn(clause.field)}`);
    const params = where.map((clause) => `$${profileColumn(clause.field)}: ${clause.operator === "in" ? "Set<" : ""}${entity}.${clause.field === "id" ? key(model) : profileColumn(clause.field)}${clause.operator === "in" ? ">" : ""}`);
    const ordered = order === null ? `${key(model)} asc` : `${profileColumn(order[0])} ${order[1]}, ${key(model)} asc`;
    const counted = model === "member" && where.length === 1 && where[0]?.field === "organizationId";
    if (counted) { conditions.push("role >= $minimum_role"); params.push("$minimum_role: Member.role = \"\""); }
    const effectiveOrder = counted && order === null ? "role asc, member_id asc" : ordered;
    const hydrate = model === "member" && !counted ? "member" : model === "organization" && where[0]?.operator !== "in" ? "organization" : undefined;
    let body: string;
    if (hydrate === "organization") {
      body = `    one record from Organization\n        where organization_id == $organization_id && ${conditions.join(" && ")}\n        else Missing\n\n` +
        ["member", "invitation"].map((child) => `    many ${child}s from ${entityName(child)}\n        where organization_id == $organization_id && org_id == record.org_id\n        order by ${key(child)} asc\n        take 100\n`).join("\n") +
        `\n    return Found {\n        record: record { ${projection(model, "record")} }\n        members: members { ${projection("member", "members")} }\n        invitations: invitations { ${projection("invitation", "invitations")} }\n    }\n    outcomes Found | Missing`;
    } else {
      body = `    many rows from ${entity}\n        where organization_id == $organization_id && ${conditions.join(" && ")}\n        order by ${where[0]?.operator === "in" ? `${key(model)} asc` : effectiveOrder}\n        take $limit${counted ? " offset $offset" : " after $after"}\n`;
      if (hydrate === "member") {
        body += `\n    many organizations from Organization\n        where organization_id == $organization_id && org_id in distinct(rows.org_id)\n        take 100\n\n    many users from User\n        where organization_id == $organization_id && user_id in distinct(rows.user_id)\n        take 100\n`;
      }
      if (counted) body += "\n    aggregate total from rows { exact_count() as value }\n";
      body += `\n    return Found {\n        rows: rows { ${projection(model, "rows")} }\n${counted ? "        total: total { value }\n" : ""}`;
      if (hydrate === "member") {
        const userFields = ["user_id", "name", "email", "email_verified", "image", "created_at", "updated_at", "revision", ...extra.get("user")!.map((field) => `${storageField(field.name)}${field.secret ? ` reveals users.${storageField(field.name)}` : ""}`)];
        body += `        organizations: organizations { ${projection("organization", "organizations")} }\n        users: users { ${userFields.join(" ")} }\n`;
      }
      body += "    }\n    outcomes Found";
    }
    const cursor = hydrate !== "organization" && !counted;
    if (cursor) params.push("$after: Cursor?");
    const path = `riffdb/queries/${storageField(name)}.riffq`;
    files[path] = `query ${name}(\n    $organization_id: ${entity}.organization_id,\n    ${params.join(",\n    ")},\n    $limit: Limit<100> = 100,\n    $offset: u64 = 0\n) {\n${body}\n}\n`;
    application.query_modules[0].queries.push({ name, source: path });
    application.roles[0].queries.push(name);
    queries.push({ model, ...(cursor ? { cursor: true } : {}), method: name[0]!.toLowerCase() + name.slice(1), where, order, ...(hydrate === undefined ? {} : { hydrate }) });
  };
  for (const model of plugins) {
    addQuery(model.name, "ById", [{ field: "id", operator: "eq" }]);
    if (model.name === "organization") addQuery(model.name, "BySlug", [{ field: "slug", operator: "eq" }]);
    if (model.name === "twoFactor") addQuery(model.name, "ByUser", [{ field: "userId", operator: "eq" }]);
    if (model.name === "member") {
      addQuery("member", "ByUser", [{ field: "userId", operator: "eq" }]);
      addQuery("member", "ByOrganization", [{ field: "organizationId", operator: "eq" }]);
      addQuery("member", "ByOrganizationUser", [{ field: "organizationId", operator: "eq" }, { field: "userId", operator: "eq" }]);
      for (const field of ["role", "createdAt"]) for (const direction of ["asc", "desc"] as const) {
        addQuery("member", `ByOrganization${entityName(field)}${entityName(direction)}`, [{ field: "organizationId", operator: "eq" }], [field, direction]);
      }
    }
    if (model.name === "invitation") {
      for (const field of ["organizationId", "email"]) addQuery("invitation", `By${entityName(field)}`, [{ field, operator: "eq" }]);
      addQuery("invitation", "ByOrganizationStatus", [{ field: "organizationId", operator: "eq" }, { field: "status", operator: "eq" }]);
      addQuery("invitation", "ByOrganizationEmailStatus", [{ field: "organizationId", operator: "eq" }, { field: "email", operator: "eq" }, { field: "status", operator: "eq" }]);
    }
  }
  // Exact point-batch hydration used by the organization plugin's user lists.
  if (org) {
    const user = files["riffdb/queries/find_user_by_id.riffq"]!;
    const leaves = /user: user \{([^}]+)\}/u.exec(user)![1]!;
    const path = "riffdb/queries/profile_users_by_id_set.riffq";
    files[path] = `query ProfileUsersByIdSet($organization_id: User.organization_id, $ids: Set<User.user_id>) {\n    many users from User\n        where organization_id == $organization_id && user_id in $ids\n        order by user_id asc\n        take 100\n    return Found { users: users { ${leaves.replaceAll("user.", "users.")} } }\n    outcomes Found\n}\n`;
    application.query_modules[0].queries.push({ name: "ProfileUsersByIdSet", source: path });
    application.roles[0].queries.push("ProfileUsersByIdSet");
  }
  const leaves = (path: string, label: string): string => new RegExp(`${label}: ${label} \\{([^}]+)\\}`, "u").exec(files[path]!)![1]!;
  const userLeaves = leaves("riffdb/queries/find_user_by_id.riffq", "user");
  const accountLeaves = leaves("riffdb/queries/find_accounts_by_user_id.riffq", "accounts");
  const sessionLeaves = leaves("riffdb/queries/find_session_by_token.riffq", "sessions");
  const addCoreQuery = (queryName: string, source: string): void => {
    const path = `riffdb/queries/${storageField(queryName)}.riffq`;
    files[path] = source;
    application.query_modules[0].queries.push({ name: queryName, source: path });
    application.roles[0].queries.push(queryName);
  };
  for (const field of ["id", "email"]) {
    const queryName = `ProfileUserWithAccountsBy${entityName(field)}`;
    addCoreQuery(queryName, `query ${queryName}($organization_id: User.organization_id, $value: User.${field === "id" ? "user_id" : "email"}) {\n    one user from User\n        where organization_id == $organization_id && ${field === "id" ? "user_id" : "email"} == $value\n        else Missing\n    many accounts from Account\n        where organization_id == $organization_id && user_id == user.user_id\n        order by id asc\n        take 33\n    return Found { user: user { ${userLeaves} } accounts: accounts { ${accountLeaves} } }\n    outcomes Found | Missing\n}\n`);
  }
  for (const field of ["id", "token"]) {
    const queryName = `ProfileSessionWithUserBy${entityName(field)}`;
    addCoreQuery(queryName, `query ${queryName}($organization_id: Session.organization_id, $value: Session.${field}) {\n    one session from Session\n        where organization_id == $organization_id && ${field} == $value\n        else Missing\n    one user from User\n        where organization_id == $organization_id && user_id == session.user_id\n        else IntegrityFailure\n    return Found { session: session { ${sessionLeaves.replaceAll("sessions.", "session.")} } user: user { ${userLeaves} } }\n    outcomes Found | Missing | IntegrityFailure\n}\n`);
  }
  for (const [basePath, originalName, queryName, label, bound] of [
    ["riffdb/queries/find_account_by_provider.riffq", "FindAccountByProvider", "ProfileAccountWithUserByProvider", "accounts", 1],
    ["riffdb/queries/find_sessions_by_token_set.riffq", "FindSessionsByTokenSet", "ProfileSessionsWithUsersByTokenSet", "sessions", 32],
  ] as const) {
    const source = files[basePath]!.replace(originalName, queryName).replace("    return Found {",
      `    many users from User\n        where organization_id == $organization_id && user_id in distinct(${label}.user_id)\n        take ${bound}\n\n    return Found {\n        users: users { ${userLeaves.replaceAll("user.", "users.")} }`);
    addCoreQuery(queryName, source);
  }
  const atomic = (name: string, model: string, inputs: string[], guards: string[], sets: string[]): void => {
    const entity = entityName(model);
    declarations.set(name, [`  command ${name} {`, "    input request_id: uuid", "    input organization_id: uuid",
      `    input ${key(model)}: uuid`, ...inputs.map((input) => `    input ${input}`), "    idempotency_key request_id",
      `    mutate ${entity}(organization_id, ${key(model)}) as record else Missing {}`,
      ...guards.map((guard, i) => `    require guard_${i}: ${guard} else GuardFailed {}`),
      ...sets.map((set) => `    set record.${set} checked_by guard_0`), "    set record.revision = record.revision + 1",
      "    return Changed { }",
      "  }"].join("\n"));
    // Outcomes project exact leaves, including compiler-declared secret output.
    const fields = plan.models.find((entry) => entry.name === model)!.fields;
    const leaves = [`${key(model)}: record.${key(model)}`, ...fields.map((field) => `${profileColumn(field.name)}: record.${profileColumn(field.name)}${field.secret && field.reference === undefined ? ` reveals record.${profileColumn(field.name)}` : ""}`), "revision: record.revision"];
    declarations.set(name, declarations.get(name)!.replace("    return Changed { }", `    return Changed {\n      ${leaves.join(",\n      ")}\n    }`));
  };
  if (twoFactor) {
    atomic("IncrementTwoFactorFailure", "twoFactor", [], ["record.failed_verification_count < 1000000"], ["failed_verification_count = record.failed_verification_count + 1"]);
    atomic("LockTwoFactor", "twoFactor", ["minimum_failures: i64", "locked_until: optional<timestamp>", "locked_until_millis: i64"], ["record.failed_verification_count >= minimum_failures"], ["locked_until = locked_until", "locked_until_millis = locked_until_millis"]);
    atomic("ResetExpiredTwoFactor", "twoFactor", ["before_millis: i64"], ["record.locked_until_millis > 0 && record.locked_until_millis <= before_millis"], ["failed_verification_count = 0", "locked_until = null", "locked_until_millis = 0"]);
    atomic("ReplaceTwoFactorBackupCodes", "twoFactor", ["expected: string<2048>", "replacement: string<2048>"], ["record.backup_codes == expected"], ["backup_codes = replacement"]);
  }
  if (org) {
    atomic("TransitionInvitation", "invitation", ["expected: string<32>", "replacement: string<32>"], ["record.status == expected"], ["status = replacement"]);
    let body = declarations.get("CreateMember")!.replace("command CreateMember", "command CreateMemberAndActivateOrganization")
      .replace("    idempotency_key", "    input session_user_id: uuid\n    input session_id: uuid\n    input session_revision: u64\n    input session_updated_at: timestamp\n    input session_active_organization_id: optional<string<2048>>\n    idempotency_key")
      .replace("as record else MemberAlreadyExists {}", "as record else MemberAlreadyExists {}\n    mutate Session(organization_id, session_user_id, session_id) as session else SessionMissing {}")
      .replace("    require capacity:", "    require session_snapshot: session.revision == session_revision else Stale {}\n    require session_owner: session.user_id == user_id else SessionOwnerMismatch {}\n    require capacity:");
    body = body.replace("    return MemberCreated {}", "    set session.active_organization_id = session_active_organization_id checked_by session_snapshot\n    set session.updated_at = session_updated_at checked_by session_snapshot\n    set session.revision = session.revision + 1\n    return MemberCreated {}");
    declarations.set("CreateMemberAndActivateOrganization", body);
  }
  contract = [`contract ${plan.contract.lineage} version 1 {`, ...[...declarations.values()].filter((source) => source.startsWith("  entity")),
    declarations.get("TenantData"), ...[...declarations.values()].filter((source) => /^  (?:bulk )?command/u.test(source)), "}", ""].join("\n\n");
  files["riffdb/contract.riff"] = contract;
  application.application = storageField(plan.name).replaceAll("_", "-");
  application.contract.lineage = plan.contract.lineage;
  application.roles[0].name = plan.contract.applicationRole;
  application.roles[0].commands = [...declarations.keys()].filter((name) => /^  (?:bulk )?command/u.test(declarations.get(name)!));
  application.roles = [application.roles[0]];
  files["riffdb.application.json"] = `${JSON.stringify(application, null, 2)}\n`;
  files["riffdb.toml"] = '[project]\nschema = "riffdb.application.json"\ngenerators = ["typescript"]\n';
  files["profile.ts"] = `// Generated profile binding. Review sources, then run riffdb application lock --write.\nimport { defineRiffDBCompiledProfile } from "@riffdb/better-auth";\nimport * as bindings from "./src/generated/client.js";\nexport default defineRiffDBCompiledProfile({\n  plan: ${JSON.stringify(plan, null, 2)},\n  queries: ${JSON.stringify(queries, null, 2)},\n  bindings,\n});\n`;
  for (const path of Object.keys(files)) {
    files[path] = `${files[path]!.split("\n").map((line) => line.trimEnd()).join("\n").trimEnd()}\n`;
  }
  return Object.freeze({ files: Object.freeze(files), queries: Object.freeze(queries) });
}
