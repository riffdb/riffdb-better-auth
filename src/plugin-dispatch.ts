import type { CleanedWhere, JoinConfig } from "better-auth/adapters";
import type { RiffDBBetterAuthProfileFieldPlan } from "./profile-plan.js";
import { decodeProfileField, encodeProfileField, storageField, type RiffDBCompiledProfile, type RiffDBProfileQuery } from "./runtime-profile.js";

type Row = Record<string, unknown>;
type Client = Record<string, ((input: Row) => Promise<{ value?: Row; outcome?: Row; nextCursor?: string }>) | unknown>;
const column = (field: string): string => field === "organizationId" ? "org_id" : storageField(field);
const key = (model: string): string => model === "organization" ? "org_id" : `${storageField(model)}_id`;
const name = (model: string): string => model[0]!.toUpperCase() + model.slice(1);

function refuse(operation: string): never { throw new Error(`unsupported compiled profile call: ${operation}`); }
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)) refuse("UUID");
  return value;
}
function matches(where: readonly CleanedWhere[] | undefined, expected: readonly { readonly field: string; readonly operator: string }[]): boolean {
  return where !== undefined && where.length === expected.length && new Set(where.map((clause) => clause.field)).size === where.length &&
    where.every((clause) => clause.connector === "AND" && clause.mode === "sensitive" &&
      expected.some((entry) => entry.field === clause.field && entry.operator === clause.operator));
}

/** Dispatches only the finite catalogue emitted with a locked profile. */
export class ProfilePluginDispatcher {
  private readonly client: Client;
  public constructor(private readonly profile: RiffDBCompiledProfile, client: object, private readonly tenant: string) {
    this.client = client as Client;
  }
  public supports(model: string): boolean {
    return ["organization", "member", "invitation", "twoFactor"].includes(model) &&
      this.profile.plan.models.some((entry) => entry.name === model);
  }
  public async joinedCore(model: string, where: readonly CleanedWhere[], join: JoinConfig, many: boolean, limit = 1): Promise<Row> {
    const targets = Object.keys(join);
    if (targets.length !== 1 || targets[0] !== (model === "user" ? "account" : "user") || limit < 1 || limit > 100 ||
        (join[targets[0]!]!.limit ?? 100) > 100) refuse(`core join ${model}`);
    const shape = (fields: readonly { field: string; operator: string }[]) => matches(where, fields);
    let method: string;
    let input: Row;
    if (!many && model === "user" && (shape([{ field: "id", operator: "eq" }]) || shape([{ field: "email", operator: "eq" }]))) {
      const field = where[0]!.field;
      method = `profileUserWithAccountsBy${name(field)}`;
      input = { value: field === "id" ? uuid(where[0]!.value) : encodeProfileField(this.fields("user").find((entry) => entry.name === field)!, where[0]!.value) };
    } else if (!many && model === "session" && (shape([{ field: "id", operator: "eq" }]) || shape([{ field: "token", operator: "eq" }]))) {
      const field = where[0]!.field;
      method = `profileSessionWithUserBy${name(field)}`;
      input = { value: field === "id" ? uuid(where[0]!.value) : encodeProfileField(this.fields("session").find((entry) => entry.name === field)!, where[0]!.value) };
    } else if (many && model === "account" && shape([{ field: "accountId", operator: "eq" }, { field: "providerId", operator: "eq" }])) {
      method = "profileAccountWithUserByProvider";
      input = this.params(model, where);
    } else if (many && model === "session" && shape([{ field: "token", operator: "in" }])) {
      const tokens = where[0]!.value;
      if (!Array.isArray(tokens) || tokens.length > 32) refuse("session token set");
      method = "profileSessionsWithUsersByTokenSet";
      input = { tokens: tokens.map((token) => encodeProfileField(this.fields("session").find((entry) => entry.name === "token")!, token)) };
    } else return refuse(`core join ${model}`);
    const { value } = await this.invoke(method, { organization_id: this.tenant, ...input });
    if (value === undefined || value.outcome === "IntegrityFailure") refuse("core join integrity");
    return value;
  }
  private fields(model: string): readonly RiffDBBetterAuthProfileFieldPlan[] {
    return this.profile.plan.models.find((entry) => entry.name === model)?.fields ?? refuse(model);
  }
  private encode(model: string, row: Row): Row {
    const fields = this.fields(model);
    if (Object.keys(row).some((field) => field !== "id" && !fields.some((entry) => entry.name === field))) refuse(`create ${model} fields`);
    const result = Object.fromEntries(fields.map((field) => [column(field.name), encodeProfileField(field,
      row[field.name] ?? (field.name === "failedVerificationCount" ? 0 : field.name === "verified" ? true : undefined))]));
    if (model === "twoFactor") result.locked_until_millis = BigInt(row.lockedUntil instanceof Date ? row.lockedUntil.getTime() : 0);
    return result;
  }
  private decode(model: string, row: Row): Row {
    return { id: uuid(row[key(model)]), ...Object.fromEntries(this.fields(model)
      .map((field) => [field.name, decodeProfileField(field, row[column(field.name)])])) };
  }
  private async invoke(method: string, input: Row): Promise<{ value?: Row; outcome?: Row; nextCursor?: string }> {
    const operation = this.client[method];
    if (typeof operation !== "function") refuse(method);
    return await (operation as (input: Row) => Promise<{ value?: Row; outcome?: Row; nextCursor?: string }>).call(this.client, input);
  }
  private async command(method: string, input: Row, expected: string): Promise<Row> {
    const result = await this.invoke(method, { request_id: "", organization_id: this.tenant, ...input });
    const outcome = result.outcome ?? refuse(method);
    if (outcome.outcome !== expected) throw new Error(`compiled profile command outcome: ${method}/${String(outcome.outcome)}`);
    return outcome;
  }
  public async create(model: string, data: Row): Promise<Row> {
    const input = this.encode(model, data);
    await this.command(`create${name(model)}`, { ...input, [key(model)]: uuid(data.id) }, `${name(model)}Created`);
    return { ...data };
  }
  public async createMemberAndActivate(data: Row, session: Row, raw: Row, update: Row): Promise<void> {
    if (data.organizationId !== update.activeOrganizationId || data.userId !== session.userId ||
        Object.keys(update).some((field) => field !== "activeOrganizationId" && field !== "updatedAt")) refuse("member activation graph");
    await this.command("createMemberAndActivateOrganization", { ...this.encode("member", data), member_id: uuid(data.id),
      session_active_organization_id: update.activeOrganizationId,
      session_id: uuid(session.id), session_user_id: uuid(session.userId), session_revision: raw.revision,
      session_updated_at: encodeProfileField(this.fields("session").find((field) => field.name === "updatedAt")!, update.updatedAt ?? session.updatedAt),
    }, "MemberCreated");
  }
  private validateJoin(model: string, join: JoinConfig | undefined): void {
    if (join === undefined || Object.keys(join).length === 0) return;
    const allowed = model === "member" ? ["organization", "user"] : model === "organization" ? ["member", "invitation"] : [];
    for (const [target, config] of Object.entries(join)) {
      if (!allowed.includes(target) || (config.limit ?? 100) < 1 || (config.limit ?? 100) > 100 ||
          config.on.to !== (model === "organization" ? "organizationId" : "id") ||
          config.on.from !== (model === "organization" ? "id" : target === "user" ? "userId" : "organizationId")) refuse(`join ${model}`);
    }
  }
  private select(model: string, where: readonly CleanedWhere[] | undefined, order?: { field: string; direction: "asc" | "desc" }): RiffDBProfileQuery {
    return this.profile.queries.find((query) => query.model === model && matches(where, query.where) &&
      (order === undefined ? query.order === null : query.order?.[0] === order.field && query.order[1] === order.direction)) ?? refuse(`query ${model}`);
  }
  private params(model: string, where: readonly CleanedWhere[]): Row {
    return Object.fromEntries(where.map((clause) => {
      const field = this.fields(model).find((entry) => entry.name === clause.field);
      const value = clause.field === "id" ? uuid(clause.value) : field === undefined ? refuse("predicate field") : encodeProfileField(field, clause.value);
      return [column(clause.field), value];
    }));
  }
  public async read(
    model: string, where: readonly CleanedWhere[] | undefined, limit: number,
    order?: { field: string; direction: "asc" | "desc" }, offset = 0, join?: JoinConfig,
  ): Promise<{ rows: Row[]; total: number; raw: Row[] }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 4096) refuse(`bounds ${model}`);
    if (model !== "member" && offset !== 0) refuse(`offset ${model}`);
    this.validateJoin(model, join);
    const query = this.select(model, where, order);
    if (join !== undefined && Object.keys(join).length > 0 && query.hydrate === undefined) refuse(`join ${model} shape`);
    if (query.cursor && offset !== 0) refuse(`offset ${model} shape`);
    const result = await this.invoke(query.method, { organization_id: this.tenant, ...this.params(model, where!), limit, offset: BigInt(offset), ...(query.cursor ? { after: null } : {}), ...(model === "member" && query.hydrate === undefined ? { minimum_role: "" } : {}) });
    if (result.nextCursor !== undefined && query.cursor) refuse("result bound exceeded");
    const value = result.value ?? refuse("query result");
    if (value.outcome === "Missing") return { rows: [], total: 0, raw: [] };
    const raw = (value.rows ?? (value.record === undefined ? refuse("query result shape") : [value.record])) as Row[];
    if (!Array.isArray(raw) || raw.length > 100) refuse("result bound");
    const rows = raw.map((row) => this.decode(model, row));
    if (model === "member" && query.hydrate === undefined && value.total === undefined) refuse("missing exact count");
    const total = value.total === undefined ? rows.length : Number((value.total as { value: bigint }).value);
    if (!Number.isSafeInteger(total) || total < 0) refuse("count bound");
    if (query.hydrate === "member" && join !== undefined) {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        if (join.organization !== undefined) row.organization = this.decode("organization", (value.organizations as Row[])
          .find((entry) => entry.org_id === row.organizationId) ?? refuse("organization integrity"));
        if (join.user !== undefined) row.user = this.decodeUser((value.users as Row[])
          .find((entry) => entry.user_id === row.userId) ?? refuse("user integrity"));
      }
    }
    if (query.hydrate === "organization" && rows[0] !== undefined && join !== undefined) {
      for (const target of ["member", "invitation"]) if (join[target] !== undefined) {
        const records = value[`${target}s`] as Row[];
        if (!Array.isArray(records) || records.length > 100) refuse("joined result bound");
        rows[0][target] = records.slice(0, join[target]!.limit ?? 100).map((row) => this.decode(target, row));
      }
    }
    return { rows, total, raw };
  }
  private decodeUser(row: Row): Row {
    return { id: row.user_id, ...Object.fromEntries(this.fields("user").map((field) =>
      [field.name, decodeProfileField(field, row[storageField(field.name)])])) };
  }
  public async usersById(where: readonly CleanedWhere[], limit: number): Promise<Row[]> {
    if (!matches(where, [{ field: "id", operator: "in" }]) || !Array.isArray(where[0]!.value) ||
        where[0]!.value.length > 32 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) refuse("user ID set");
    const ids = [...new Set(where[0]!.value.map(uuid))];
    if (ids.length === 0) return [];
    const result = await this.invoke("profileUsersByIdSet", { organization_id: this.tenant, ids });
    const users = result.value?.users as Row[];
    if (!Array.isArray(users) || users.length > 32) refuse("user set result");
    return users.slice(0, limit).map((row) => this.decodeUser(row));
  }
  public async update(model: string, where: readonly CleanedWhere[], update: Row): Promise<Row | null> {
    if (Object.keys(update).length === 0 || Object.keys(update).some((field) => !this.fields(model).some((entry) => entry.name === field && entry.reference === undefined))) refuse(`update ${model}`);
    // Validate every input before the first snapshot read.
    for (const [field, value] of Object.entries(update)) encodeProfileField(this.fields(model).find((entry) => entry.name === field)!, value);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.read(model, where, 1);
      if (current.rows[0] === undefined) return null;
      const successor = { ...current.rows[0], ...update };
      const input = this.encode(model, successor);
      const result = await this.invoke(`update${name(model)}`, { ...input, request_id: "", organization_id: this.tenant,
        [key(model)]: uuid(successor.id), expected_revision: current.raw[0]!.revision });
      if (result.outcome?.outcome === "Stale") continue;
      if (result.outcome?.outcome === `${name(model)}Missing`) return null;
      if (result.outcome?.outcome !== `${name(model)}Updated`) refuse(`update outcome ${model}`);
      return successor;
    }
    throw new Error("compiled profile revision retry budget exhausted");
  }
  public async deleteIds(model: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    if (ids.length > (model === "organization" ? 1 : 100)) refuse("delete bound");
    let parent: Row = {};
    if (model === "member" || model === "invitation") {
      if (ids.length !== 1) refuse("relationship delete bound");
      const current = await this.read(model, [{ field: "id", operator: "eq", connector: "AND", mode: "sensitive", value: uuid(ids[0]) }], 1);
      if (current.rows[0] === undefined) return;
      parent = { org_id: uuid(current.rows[0].organizationId) };
    }
    await this.command(`delete${name(model)}`, { ...parent, ids: ids.map(uuid) }, `${name(model)}Deleted`);
  }
  public async increment(model: string, where: readonly CleanedWhere[], increment: Row, set: Row = {}): Promise<Row | null> {
    const id = where.find((clause) => clause.field === "id")?.value;
    const input: Row = { request_id: "", organization_id: this.tenant, [key(model)]: uuid(id) };
    const shape = (fields: readonly { field: string; operator: string }[]) => matches(where, fields);
    let method: string;
    const value = (field: string) => where.find((clause) => clause.field === field)?.value;
    if (model === "twoFactor" && shape([{ field: "id", operator: "eq" }]) &&
        Object.keys(increment).length === 1 && increment.failedVerificationCount === 1 && Object.keys(set).length === 0) {
      method = "incrementTwoFactorFailure";
    } else if (model === "twoFactor" && shape([{ field: "id", operator: "eq" }, { field: "failedVerificationCount", operator: "gte" }]) &&
        Object.keys(increment).length === 0 && Object.keys(set).length === 1 && set.lockedUntil instanceof Date) {
      method = "lockTwoFactor";
      if (!Number.isSafeInteger(value("failedVerificationCount")) || Number(value("failedVerificationCount")) < 1 || Number(value("failedVerificationCount")) > 1_000_000) refuse("lock threshold");
      input.minimum_failures = BigInt(value("failedVerificationCount") as number);
      input.locked_until = encodeProfileField(this.fields(model).find((field) => field.name === "lockedUntil")!, set.lockedUntil);
      input.locked_until_millis = BigInt(set.lockedUntil.getTime());
    } else if (model === "twoFactor" && shape([{ field: "id", operator: "eq" }, { field: "lockedUntil", operator: "lte" }]) &&
        Object.keys(increment).length === 0 && Object.keys(set).length === 2 && set.failedVerificationCount === 0 && set.lockedUntil === null) {
      method = "resetExpiredTwoFactor";
      const before = value("lockedUntil");
      if (!(before instanceof Date) || !Number.isFinite(before.getTime())) refuse("lock expiry");
      input.before_millis = BigInt(before.getTime());
    } else if (model === "twoFactor" && shape([{ field: "id", operator: "eq" }, { field: "backupCodes", operator: "eq" }]) &&
        Object.keys(increment).length === 0 && Object.keys(set).length === 1 && typeof set.backupCodes === "string") {
      method = "replaceTwoFactorBackupCodes";
      const field = this.fields(model).find((entry) => entry.name === "backupCodes")!;
      input.expected = encodeProfileField(field, value("backupCodes"));
      input.replacement = encodeProfileField(field, set.backupCodes);
    } else if (model === "invitation" && shape([{ field: "id", operator: "eq" }, { field: "status", operator: "eq" }]) &&
        Object.keys(increment).length === 0 && Object.keys(set).length === 1 && typeof set.status === "string") {
      method = "transitionInvitation";
      const states = ["pending", "accepted", "rejected", "canceled"];
      if (!states.includes(String(value("status"))) || !states.includes(set.status)) refuse("invitation status");
      input.expected = value("status"); input.replacement = set.status;
    } else if (model === "invitation" && shape([{ field: "id", operator: "eq" }]) && Object.keys(increment).length === 0 &&
        Object.keys(set).length === 1 && typeof set.status === "string") {
      return await this.update(model, where, set);
    } else return refuse(`increment ${model}`);
    const { outcome } = await this.invoke(method, input);
    if (outcome?.outcome === "Missing" || outcome?.outcome === "GuardFailed") return null;
    if (outcome?.outcome !== "Changed") refuse(`increment outcome ${model}`);
    return this.decode(model, outcome);
  }
}
