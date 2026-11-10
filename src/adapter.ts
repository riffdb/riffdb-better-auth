import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { createRequire } from "node:module";

import {
  DriverGeneratedApplicationTransport,
  type DriverApplicationTransport,
} from "@riffdb/client";
import {
  createAdapterFactory,
  type AdapterFactory,
  type CleanedWhere,
  type CustomAdapter,
  type DBAdapter,
  type DBAdapterDebugLogOption,
  type JoinConfig,
} from "better-auth/adapters";
import type { BetterAuthOptions } from "better-auth";

import {
  RiffDBBetterAuthCoreClient,
  type ApplicationTransport,
  type FindActiveSessionsByUserIdFound,
  type FindAccountByIdFound,
  type FindAccountByProviderFound,
  type FindAccountsByUserIdFound,
  type FindSessionByIdFound,
  type FindSessionByTokenFound,
  type FindSessionsByUserIdFound,
  type FindUserByEmailFound,
  type FindUserByIdFound,
  type FindVerificationByIdFound,
  type FindVerificationByIdResult,
  type FindVerificationsByIdentifierFound,
  type TypedCommandResult,
} from "./generated/client.js";
import { isSupportedBetterAuthVersion } from "./profile.js";
import { validateRuntimeProfile, instantiateProfileClient, encodeProfileField, decodeProfileField, storageField,
  type RiffDBCompiledProfile } from "./runtime-profile.js";
import { ProfilePluginDispatcher } from "./plugin-dispatch.js";

const CORE_SCHEMA_FIELDS = {
  user: ["name", "email", "emailVerified", "image", "createdAt", "updatedAt"],
  session: [
    "expiresAt",
    "token",
    "createdAt",
    "updatedAt",
    "ipAddress",
    "userAgent",
    "userId",
  ],
  account: [
    "accountId",
    "providerId",
    "userId",
    "accessToken",
    "refreshToken",
    "idToken",
    "accessTokenExpiresAt",
    "refreshTokenExpiresAt",
    "scope",
    "password",
    "createdAt",
    "updatedAt",
  ],
  verification: ["identifier", "value", "expiresAt", "createdAt", "updatedAt"],
} as const;

type CoreModel = keyof typeof CORE_SCHEMA_FIELDS;
type RecordValue = Readonly<Record<string, unknown>>;
type Timestamp = { readonly seconds: bigint; readonly nanos: number };
type AdminUserRow = {
  readonly organization_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly image: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly revision: bigint;
};
type AdminUserWindow = {
  readonly users: ReadonlyArray<AdminUserRow>;
  readonly total: { readonly value: bigint };
};

export type RiffDBBetterAuthCallErrorCode =
  | "invalid_configuration"
  | "unsupported_model"
  | "unsupported_call_shape"
  | "unsupported_transaction_shape"
  | "result_bound_exceeded"
  | "invalid_record_shape"
  | "declared_outcome";

export class RiffDBBetterAuthCallError extends Error {
  public constructor(
    public readonly code: RiffDBBetterAuthCallErrorCode,
    public readonly operation: string,
    public readonly outcome?: string,
  ) {
    super(
      outcome === undefined
        ? `RiffDB Better Auth ${operation} failed: ${code}`
        : `RiffDB Better Auth ${operation} failed: ${code} (${outcome})`,
    );
    this.name = "RiffDBBetterAuthCallError";
  }
}

export interface RiffDBBetterAuthAdapterConfig {
  readonly driver: DriverApplicationTransport;
  readonly organizationId: string;
  readonly commandAttemptBudget?: number;
  readonly debugLogs?: DBAdapterDebugLogOption;
  readonly profile?: RiffDBCompiledProfile;
}

type CoreClient = Omit<RiffDBBetterAuthCoreClient, "causalSession" | "withReadAfterCommit"> & {
  causalSession(): CoreClient;
};

interface InternalAdapterConfig {
  readonly client: CoreClient;
  readonly organizationId: string;
  readonly debugLogs?: DBAdapterDebugLogOption;
  readonly resetModelForTesting?: (model: string) => number | Promise<number>;
  readonly profile?: RiffDBCompiledProfile;
}

function fail(
  code: RiffDBBetterAuthCallErrorCode,
  operation: string,
  outcome?: string,
): never {
  throw new RiffDBBetterAuthCallError(code, operation, outcome);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function validateConfiguration(config: InternalAdapterConfig): void {
  if (!isUuid(config.organizationId)) fail("invalid_configuration", "configuration");
  if (config.debugLogs !== undefined && config.debugLogs !== false) {
    fail("invalid_configuration", "debugLogs");
  }
}

export function assertSupportedBetterAuthInstallation(
  installedVersion = resolveInstalledBetterAuthVersion(),
): void {
  if (!isSupportedBetterAuthVersion(installedVersion)) {
    fail("invalid_configuration", "betterAuthVersion");
  }
}

function resolveInstalledBetterAuthVersion(): string {
  const require = createRequire(import.meta.url);
  let directory = dirname(require.resolve("better-auth"));
  const root = parse(directory).root;
  for (let depth = 0; depth < 8 && directory !== root; depth += 1) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as { readonly name?: unknown; readonly version?: unknown };
      if (manifest.name === "better-auth" && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    directory = dirname(directory);
  }
  fail("invalid_configuration", "betterAuthVersion");
}

function validateResolvedSchema(
  options: BetterAuthOptions,
  schema: Readonly<Record<string, { readonly modelName: string; readonly fields: Record<string, unknown> }>>,
  profile?: RiffDBCompiledProfile,
): void {
  if (options.advanced?.database?.generateId !== "uuid") {
    fail("invalid_configuration", "generateId");
  }
  if (options.databaseHooks !== undefined || options.emailAndPassword?.revokeSessionsOnPasswordReset) {
    fail("invalid_configuration", "transactionConfiguration");
  }
  if (profile !== undefined) {
    try { validateRuntimeProfile(profile, options, schema as Parameters<typeof validateRuntimeProfile>[2]); }
    catch { fail("invalid_configuration", "compiledProfile"); }
    return;
  }
  for (const plugin of options.plugins ?? []) {
    if (plugin.id !== "next-cookies" || (plugin.version !== undefined && !isSupportedBetterAuthVersion(plugin.version)) || plugin.schema !== undefined) {
      fail("invalid_configuration", "plugins");
    }
  }
  const modelNames = Object.keys(schema).sort();
  const expectedModels = Object.keys(CORE_SCHEMA_FIELDS).sort();
  if (JSON.stringify(modelNames) !== JSON.stringify(expectedModels)) {
    fail("invalid_configuration", "models");
  }
  for (const model of expectedModels as CoreModel[]) {
    const resolved = schema[model];
    if (resolved === undefined || resolved.modelName !== model) {
      fail("invalid_configuration", `${model}.modelName`);
    }
    const fields = Object.keys(resolved.fields).sort();
    const expected = [...CORE_SCHEMA_FIELDS[model]].sort();
    if (JSON.stringify(fields) !== JSON.stringify(expected)) {
      fail("invalid_configuration", `${model}.fields`);
    }
    for (const field of expected) {
      const attributes = resolved.fields[field] as { readonly fieldName?: unknown } | undefined;
      if (attributes?.fieldName !== undefined && attributes.fieldName !== field) {
        fail("invalid_configuration", `${model}.${field}.fieldName`);
      }
    }
  }
}

function asRecord(value: unknown, operation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid_record_shape", operation);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: RecordValue, field: string, operation: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) fail("invalid_record_shape", operation);
  return value;
}

function nullableString(record: RecordValue, field: string, operation: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail("invalid_record_shape", operation);
  return value;
}

function requiredBoolean(record: RecordValue, field: string, operation: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") fail("invalid_record_shape", operation);
  return value;
}

function requiredDate(record: RecordValue, field: string, operation: string): Date {
  const value = record[field];
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("invalid_record_shape", operation);
  }
  return value;
}

function nullableDate(record: RecordValue, field: string, operation: string): Date | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("invalid_record_shape", operation);
  }
  return value;
}

function toTimestamp(value: Date): Timestamp {
  const milliseconds = value.getTime();
  const seconds = Math.floor(milliseconds / 1_000);
  return {
    seconds: BigInt(seconds),
    nanos: (milliseconds - seconds * 1_000) * 1_000_000,
  };
}

function fromTimestamp(value: Timestamp): Date {
  const milliseconds = Number(value.seconds) * 1_000 + value.nanos / 1_000_000;
  if (!Number.isSafeInteger(milliseconds)) fail("invalid_record_shape", "timestamp result");
  return new Date(milliseconds);
}

function timestampOrNull(value: Date | null): Timestamp | null {
  return value === null ? null : toTimestamp(value);
}

function exactWhere(
  where: readonly CleanedWhere[] | undefined,
  fields: readonly string[],
): boolean {
  if (where === undefined || where.length !== fields.length) return false;
  const actualFields = new Set(where.map((clause) => clause.field));
  return (
    actualFields.size === fields.length &&
    fields.every((field) => actualFields.has(field)) &&
    where.every(
      (clause) =>
        clause.operator === "eq" &&
        clause.connector === "AND" &&
        clause.mode === "sensitive",
    )
  );
}

function exactWhereShape(
  where: readonly CleanedWhere[] | undefined,
  shape: readonly { readonly field: string; readonly operator: CleanedWhere["operator"] }[],
): boolean {
  if (where === undefined || where.length !== shape.length) return false;
  return (
    new Set(where.map((clause) => clause.field)).size === shape.length &&
    shape.every(({ field, operator }) =>
      where.some((clause) => clause.field === field && clause.operator === operator),
    ) &&
    where.every((clause) => clause.connector === "AND" && clause.mode === "sensitive")
  );
}

function whereValue(where: readonly CleanedWhere[], field: string, operation: string): string {
  const value = where.find((clause) => clause.field === field)?.value;
  if (typeof value !== "string") fail("unsupported_call_shape", operation);
  return value;
}

function whereDate(where: readonly CleanedWhere[], field: string, operation: string): Date {
  const value = where.find((clause) => clause.field === field)?.value;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("unsupported_call_shape", operation);
  }
  return value;
}

function whereStringSet(
  where: readonly CleanedWhere[],
  field: string,
  operation: string,
): string[] {
  const value = where.find((clause) => clause.field === field)?.value;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("unsupported_call_shape", operation);
  }
  const values = [...new Set(value as string[])];
  if (values.length === 0 || values.length > 32) fail("result_bound_exceeded", operation);
  return values;
}

function adminUserWhere(
  where: readonly CleanedWhere[] | undefined,
  operation: string,
): Readonly<{
  operator?: "contains" | "starts_with" | "ends_with";
  needle?: string;
  userId: string | null;
}> {
  const clauses = where ?? [];
  if (clauses.length > 2) fail("unsupported_call_shape", operation);
  const id = clauses.find((clause) => clause.field === "id");
  const search = clauses.find((clause) => clause.field !== "id");
  if (
    (id !== undefined &&
      (id.operator !== "eq" || id.connector !== "AND" || id.mode !== "sensitive")) ||
    (search !== undefined &&
      (search.field !== "email" ||
        !new Set<string>(["contains", "starts_with", "ends_with"]).has(
          search.operator ?? "",
        ) ||
        search.connector !== "AND" ||
        search.mode !== "sensitive")) ||
    (id === undefined && search === undefined && clauses.length !== 0) ||
    Number(id !== undefined) + Number(search !== undefined) !== clauses.length
  ) {
    fail("unsupported_call_shape", operation);
  }
  const userId = id === undefined ? null : id.value;
  if (userId !== null && (typeof userId !== "string" || !isUuid(userId))) {
    fail("unsupported_call_shape", operation);
  }
  if (search === undefined) return Object.freeze({ userId });
  if (typeof search.value !== "string" || search.value.length === 0) {
    fail("unsupported_call_shape", operation);
  }
  return Object.freeze({
    operator: search.operator as "contains" | "starts_with" | "ends_with",
    needle: search.value,
    userId,
  });
}

function assertNoJoin(join: Readonly<Record<string, unknown>> | undefined, operation: string): void {
  if (join !== undefined && Object.keys(join).length !== 0) {
    fail("unsupported_call_shape", operation);
  }
}

function requireOutcome<T>(
  result: TypedCommandResult<T>,
  operation: string,
  expected: string,
): void {
  const outcome = (result.outcome as { readonly outcome: string }).outcome;
  if (outcome !== expected) fail("declared_outcome", operation, outcome);
}

function mapUser(row: FindUserByIdFound["user"]): Record<string, unknown> {
  return {
    id: row.user_id,
    name: row.name,
    email: row.email,
    emailVerified: row.email_verified,
    image: row.image,
    createdAt: fromTimestamp(row.created_at),
    updatedAt: fromTimestamp(row.updated_at),
  };
}

function mapSession(
  row:
    | FindSessionByTokenFound["sessions"][number]
    | FindSessionByIdFound["sessions"][number]
    | FindActiveSessionsByUserIdFound["sessions"][number]
    | FindSessionsByUserIdFound["sessions"][number],
): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    expiresAt: fromTimestamp(row.expires_at),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: fromTimestamp(row.created_at),
    updatedAt: fromTimestamp(row.updated_at),
  };
}

function mapAccount(
  row:
    | FindAccountByIdFound["accounts"][number]
    | FindAccountByProviderFound["accounts"][number]
    | FindAccountsByUserIdFound["accounts"][number],
): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    providerId: row.provider_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessTokenExpiresAt:
      row.access_token_expires_at === null ? null : fromTimestamp(row.access_token_expires_at),
    refreshTokenExpiresAt:
      row.refresh_token_expires_at === null ? null : fromTimestamp(row.refresh_token_expires_at),
    scope: row.scope,
    idToken: row.id_token,
    password: row.password,
    createdAt: fromTimestamp(row.created_at),
    updatedAt: fromTimestamp(row.updated_at),
  };
}

function mapVerification(
  row:
    | FindVerificationByIdFound["verification"]
    | FindVerificationsByIdentifierFound["verifications"][number],
): Record<string, unknown> {
  return {
    id: row.verification_id,
    identifier: row.identifier,
    value: row.value,
    expiresAt: fromTimestamp(row.expires_at),
    createdAt: fromTimestamp(row.created_at),
    updatedAt: fromTimestamp(row.updated_at),
  };
}

class CoreDispatcher {
  public readonly plugins: ProfilePluginDispatcher | undefined;
  public constructor(
    private readonly client: CoreClient,
    private readonly organizationId: string,
    private readonly resetModelForTesting?: (model: string) => number | Promise<number>,
    private readonly profile?: RiffDBCompiledProfile,
  ) { this.plugins = profile === undefined ? undefined : new ProfilePluginDispatcher(profile, client, organizationId); }

  private fields(model: CoreModel) {
    return this.profile?.plan.models.find((entry) => entry.name === model)?.fields
      .filter((field) => !(CORE_SCHEMA_FIELDS[model] as readonly string[]).includes(field.name)) ?? [];
  }

  private encodeExtra(model: CoreModel, data: RecordValue, prefix = ""): Record<string, unknown> {
    return Object.fromEntries(this.fields(model).map((field) => [prefix + storageField(field.name), encodeProfileField(field, data[field.name])]));
  }

  private decodeExtra(model: CoreModel, row: object): Record<string, unknown> {
    return Object.fromEntries(this.fields(model).map((field) => [field.name, decodeProfileField(field, (row as RecordValue)[storageField(field.name)])]));
  }

  private mapUser = (row: Parameters<typeof mapUser>[0]) => ({ ...mapUser(row), ...this.decodeExtra("user", row) });
  private mapSession = (row: Parameters<typeof mapSession>[0]) => ({ ...mapSession(row), ...this.decodeExtra("session", row) });
  private mapAccount = (row: Parameters<typeof mapAccount>[0]) => ({ ...mapAccount(row), ...this.decodeExtra("account", row) });
  private mapVerification = (row: Parameters<typeof mapVerification>[0]) => ({ ...mapVerification(row), ...this.decodeExtra("verification", row) });

  public normalizeCreate(model: string, data: Record<string, unknown>): Record<string, unknown> {
    if (!(model in CORE_SCHEMA_FIELDS)) return { ...data };
    return { ...data, ...this.decodeExtra(model as CoreModel, this.encodeExtra(model as CoreModel, data)) };
  }

  public async create(model: string, dataValue: RecordValue): Promise<Record<string, unknown>> {
    const data = asRecord(dataValue, `create ${model}`);
    if (this.plugins?.supports(model)) return this.plugins.create(model, data);
    if (model === "user") {
      const result = await this.client.createUser({
        ...this.encodeExtra("user", data),
        request_id: "",
        organization_id: this.organizationId,
        id: requiredString(data, "id", "create user"),
        name: requiredString(data, "name", "create user"),
        email: requiredString(data, "email", "create user"),
        email_verified: requiredBoolean(data, "emailVerified", "create user"),
        image: nullableString(data, "image", "create user"),
        created_at: toTimestamp(requiredDate(data, "createdAt", "create user")),
        updated_at: toTimestamp(requiredDate(data, "updatedAt", "create user")),
      });
      requireOutcome(result, "create user", "UserCreated");
      return { ...this.normalizeCreate(model, data), image: data.image ?? null };
    }
    if (model === "account") {
      const result = await this.client.createAccount({
        ...this.encodeExtra("account", data),
        request_id: "",
        organization_id: this.organizationId,
        id: requiredString(data, "id", "create account"),
        user_id: requiredString(data, "userId", "create account"),
        account_id: requiredString(data, "accountId", "create account"),
        provider_id: requiredString(data, "providerId", "create account"),
        access_token: nullableString(data, "accessToken", "create account"),
        refresh_token: nullableString(data, "refreshToken", "create account"),
        access_token_expires_at: timestampOrNull(
          nullableDate(data, "accessTokenExpiresAt", "create account"),
        ),
        refresh_token_expires_at: timestampOrNull(
          nullableDate(data, "refreshTokenExpiresAt", "create account"),
        ),
        scope: nullableString(data, "scope", "create account"),
        id_token: nullableString(data, "idToken", "create account"),
        password: nullableString(data, "password", "create account"),
        created_at: toTimestamp(requiredDate(data, "createdAt", "create account")),
        updated_at: toTimestamp(requiredDate(data, "updatedAt", "create account")),
      });
      requireOutcome(result, "create account", "AccountCreated");
      return this.normalizeCreate(model, data);
    }
    if (model === "session") {
      const token = requiredString(data, "token", "create session");
      const result = await this.client.createSession({
        ...this.encodeExtra("session", data),
        request_id: "",
        organization_id: this.organizationId,
        id: requiredString(data, "id", "create session"),
        user_id: requiredString(data, "userId", "create session"),
        token,
        expires_at: toTimestamp(requiredDate(data, "expiresAt", "create session")),
        ip_address: nullableString(data, "ipAddress", "create session"),
        user_agent: nullableString(data, "userAgent", "create session"),
        created_at: toTimestamp(requiredDate(data, "createdAt", "create session")),
        updated_at: toTimestamp(requiredDate(data, "updatedAt", "create session")),
      });
      requireOutcome(result, "create session", "SessionCreated");
      return this.normalizeCreate(model, data);
    }
    if (model === "verification") {
      const result = await this.client.createVerification({
        ...this.encodeExtra("verification", data),
        request_id: "",
        organization_id: this.organizationId,
        id: requiredString(data, "id", "create verification"),
        identifier: requiredString(data, "identifier", "create verification"),
        value: requiredString(data, "value", "create verification"),
        expires_at: toTimestamp(requiredDate(data, "expiresAt", "create verification")),
        created_at: toTimestamp(requiredDate(data, "createdAt", "create verification")),
        updated_at: toTimestamp(requiredDate(data, "updatedAt", "create verification")),
      });
      requireOutcome(result, "create verification", "VerificationCreated");
      return this.normalizeCreate(model, data);
    }
    return fail("unsupported_model", `create ${model}`);
  }

  public async findOne(
    model: string,
    where: readonly CleanedWhere[],
    join?: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown> | null> {
    if (this.plugins?.supports(model)) return (await this.plugins.read(model, where, 1, undefined, 0, join as JoinConfig)).rows[0] ?? null;
    if (this.plugins !== undefined && join !== undefined && Object.keys(join).length > 0) {
      const value = await this.plugins.joinedCore(model, where, join as JoinConfig, false);
      if (value.outcome === "Missing") return null;
      if (model === "user" && (value.accounts as unknown[]).length > 32) fail("result_bound_exceeded", "user accounts");
      if (model === "user") return { ...this.mapUser(value.user as Parameters<typeof mapUser>[0]),
        account: (value.accounts as Parameters<typeof mapAccount>[0][]).slice(0, (join as JoinConfig).account?.limit ?? 100).map(this.mapAccount) };
      return { ...this.mapSession(value.session as Parameters<typeof mapSession>[0]),
        user: this.mapUser(value.user as Parameters<typeof mapUser>[0]) };
    }
    assertNoJoin(join, `findOne ${model}`);
    if (model === "user" && exactWhere(where, ["email"])) {
      const result = await this.client.findUserByEmail({
        organization_id: this.organizationId,
        email: whereValue(where, "email", "findOne user"),
      });
      const row = (result.value as FindUserByEmailFound).users[0];
      return row === undefined ? null : this.mapUser(row);
    }
    if (model === "user" && exactWhere(where, ["id"])) {
      const result = await this.client.findUserById({
        organization_id: this.organizationId,
        id: whereValue(where, "id", "findOne user"),
      });
      return result.value.outcome === "Missing" ? null : this.mapUser(result.value.user);
    }
    if (model === "session" && exactWhere(where, ["token"])) {
      const token = whereValue(where, "token", "findOne session");
      const result = await this.client.findSessionByToken({
        organization_id: this.organizationId,
        token,
      });
      const row = (result.value as FindSessionByTokenFound).sessions[0];
      return row === undefined ? null : this.mapSession(row);
    }
    if (model === "session" && exactWhere(where, ["id"])) {
      const result = await this.client.findSessionById({
        organization_id: this.organizationId,
        id: whereValue(where, "id", "findOne session"),
      });
      const row = (result.value as FindSessionByIdFound).sessions[0];
      return row === undefined ? null : this.mapSession(row);
    }
    if (model === "account" && exactWhere(where, ["id"])) {
      const result = await this.client.findAccountById({
        organization_id: this.organizationId,
        id: whereValue(where, "id", "findOne account"),
      });
      const row = result.value.accounts[0];
      return row === undefined ? null : this.mapAccount(row);
    }
    if (model === "account" && exactWhere(where, ["accountId", "providerId"])) {
      const result = await this.client.findAccountByProvider({
        organization_id: this.organizationId,
        account_id: whereValue(where, "accountId", "findOne account"),
        provider_id: whereValue(where, "providerId", "findOne account"),
      });
      const row = result.value.accounts[0];
      return row === undefined ? null : this.mapAccount(row);
    }
    if (model === "account" && exactWhere(where, ["userId", "accountId", "providerId"])) {
      const result = await this.client.findCredentialAccount({
        organization_id: this.organizationId,
        user_id: whereValue(where, "userId", "findCredentialAccount"),
        account_id: whereValue(where, "accountId", "findCredentialAccount"),
        provider_id: whereValue(where, "providerId", "findCredentialAccount"),
      });
      const row = result.value.accounts[0];
      return row === undefined ? null : this.mapAccount(row);
    }
    if (model === "verification" && exactWhere(where, ["id"])) {
      const result = await this.client.findVerificationById({
        organization_id: this.organizationId,
        id: whereValue(where, "id", "findOne verification"),
      });
      const value: FindVerificationByIdResult = result.value;
      return value.outcome === "Missing"
        ? null
        : this.mapVerification(value.verification);
    }
    return fail("unsupported_call_shape", `findOne ${model}`);
  }

  public async update(
    model: string,
    where: readonly CleanedWhere[],
    updateValue: RecordValue,
  ): Promise<Record<string, unknown> | null> {
    if (this.plugins?.supports(model)) return this.plugins.update(model, where, asRecord(updateValue, "update"));
    if (model === "account" && exactWhere(where, ["id"])) {
      const update = asRecord(updateValue, "update account");
      const allowed = new Set([
        ...this.fields("account").map((field) => field.name),
        "accountId",
        "providerId",
        "accessToken",
        "refreshToken",
        "accessTokenExpiresAt",
        "refreshTokenExpiresAt",
        "scope",
        "idToken",
        "password",
        "updatedAt",
      ]);
      const fields = Object.keys(update);
      if (fields.length === 0 || fields.some((field) => !allowed.has(field))) {
        fail("unsupported_call_shape", "update account");
      }
      const id = whereValue(where, "id", "update account");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const found = await this.client.findAccountById({
          organization_id: this.organizationId,
          id,
        });
        const row = found.value.accounts[0];
        if (row === undefined) return null;
        const successor = { ...mapAccount(row), ...update };
        const updated = await this.client.updateAccount({
          ...this.encodeExtra("account", successor),
          request_id: "",
          organization_id: this.organizationId,
          user_id: row.user_id,
          account_id: row.id,
          expected_revision: row.revision,
          external_account_id: requiredString(successor, "accountId", "update account"),
          provider_id: requiredString(successor, "providerId", "update account"),
          access_token: nullableString(successor, "accessToken", "update account"),
          refresh_token: nullableString(successor, "refreshToken", "update account"),
          access_token_expires_at: timestampOrNull(
            nullableDate(successor, "accessTokenExpiresAt", "update account"),
          ),
          refresh_token_expires_at: timestampOrNull(
            nullableDate(successor, "refreshTokenExpiresAt", "update account"),
          ),
          scope: nullableString(successor, "scope", "update account"),
          id_token: nullableString(successor, "idToken", "update account"),
          password: nullableString(successor, "password", "update account"),
          updated_at: toTimestamp(requiredDate(successor, "updatedAt", "update account")),
        });
        if (updated.outcome.outcome === "AccountUpdateStale") continue;
        if (updated.outcome.outcome === "AccountUpdateMissing") return null;
        requireOutcome(updated, "update account", "AccountUpdated");
        return successor;
      }
      return fail("declared_outcome", "update account", "AccountUpdateStale");
    }
    if (
      model === "session" &&
      (exactWhere(where, ["id"]) || exactWhere(where, ["token"]))
    ) {
      const update = asRecord(updateValue, "update session");
      const allowed = new Set(["expiresAt", "ipAddress", "userAgent", "updatedAt", ...this.fields("session").map((field) => field.name)]);
      const fields = Object.keys(update);
      if (fields.length === 0 || fields.some((field) => !allowed.has(field))) {
        fail("unsupported_call_shape", "update session");
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = exactWhere(where, ["id"])
          ? await this.client.findSessionById({
              organization_id: this.organizationId,
              id: whereValue(where, "id", "update session"),
            })
          : await this.client.findSessionByToken({
              organization_id: this.organizationId,
              token: whereValue(where, "token", "update session"),
            });
        const row = result.value.sessions[0];
        if (row === undefined) return null;
        const current = this.mapSession(row);
        const successor = { ...current, ...update };
        const updated = await this.client.updateSession({
          ...this.encodeExtra("session", successor),
          request_id: "",
          organization_id: this.organizationId,
          user_id: row.user_id,
          session_id: row.id,
          expected_revision: row.revision,
          expires_at: toTimestamp(requiredDate(successor, "expiresAt", "update session")),
          ip_address: nullableString(successor, "ipAddress", "update session"),
          user_agent: nullableString(successor, "userAgent", "update session"),
          updated_at: toTimestamp(requiredDate(successor, "updatedAt", "update session")),
        });
        if (updated.outcome.outcome === "SessionUpdateStale") continue;
        if (updated.outcome.outcome === "SessionUpdateMissing") return null;
        requireOutcome(updated, "update session", "SessionUpdated");
        return successor;
      }
      return fail("declared_outcome", "update session", "SessionUpdateStale");
    }
    if (
      model !== "user" ||
      (!exactWhere(where, ["id"]) && !exactWhere(where, ["email"]))
    ) {
      if (model !== "verification" || !exactWhere(where, ["identifier"])) {
        return fail("unsupported_call_shape", `update ${model}`);
      }
      const update = asRecord(updateValue, "update verification");
      const allowed = new Set(["value", "expiresAt", "updatedAt", ...this.fields("verification").map((field) => field.name)]);
      const fields = Object.keys(update);
      if (fields.length === 0 || fields.some((field) => !allowed.has(field))) {
        fail("unsupported_call_shape", "update verification");
      }
      const identifier = whereValue(where, "identifier", "update verification");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const found = await this.client.findLatestVerification({
          organization_id: this.organizationId,
          identifier,
        });
        const row = found.value.verifications[0];
        if (row === undefined) return null;
        const successor = { ...mapVerification(row), ...update };
        const result = await this.client.updateVerification({
          ...this.encodeExtra("verification", successor),
          request_id: "",
          organization_id: this.organizationId,
          verification_id: row.verification_id,
          expected_revision: row.revision,
          value: requiredString(successor, "value", "update verification"),
          expires_at: toTimestamp(
            requiredDate(successor, "expiresAt", "update verification"),
          ),
          updated_at: toTimestamp(
            requiredDate(successor, "updatedAt", "update verification"),
          ),
        });
        if (result.outcome.outcome === "VerificationUpdateStale") continue;
        if (result.outcome.outcome === "VerificationUpdateMissing") return null;
        requireOutcome(result, "update verification", "VerificationUpdated");
        return successor;
      }
      return fail("declared_outcome", "update verification", "VerificationUpdateStale");
    }
    const update = asRecord(updateValue, "update user");
    const allowed = new Set(["name", "email", "emailVerified", "image", "updatedAt", ...this.fields("user").map((field) => field.name)]);
    const fields = Object.keys(update);
    if (fields.length === 0 || fields.some((field) => !allowed.has(field))) {
      fail("unsupported_call_shape", "update user");
    }

    let userId = exactWhere(where, ["id"])
      ? whereValue(where, "id", "update user")
      : undefined;
    const initialEmail = exactWhere(where, ["email"])
      ? whereValue(where, "email", "update user")
      : undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = userId === undefined
        ? (
            await this.client.findUserByEmail({
              organization_id: this.organizationId,
              email: initialEmail!,
            })
          ).value.users[0]
        : (
            await this.client.findUserById({
              organization_id: this.organizationId,
              id: userId,
            })
          ).value;
      if (row === undefined || ("outcome" in row && row.outcome === "Missing")) return null;
      const resolved = "outcome" in row ? row.user : row;
      userId = resolved.user_id;
      const current = this.mapUser(resolved);
      const successor = { ...current, ...update };
      const result = await this.client.updateUser({
        ...this.encodeExtra("user", successor),
        request_id: "",
        organization_id: this.organizationId,
        user_id: userId,
        expected_revision: resolved.revision,
        name: requiredString(successor, "name", "update user"),
        email: requiredString(successor, "email", "update user"),
        email_verified: requiredBoolean(successor, "emailVerified", "update user"),
        image: nullableString(successor, "image", "update user"),
        updated_at: toTimestamp(requiredDate(successor, "updatedAt", "update user")),
      });
      if (result.outcome.outcome === "UserUpdateStale") continue;
      if (result.outcome.outcome === "UserUpdateMissing") return null;
      requireOutcome(result, "update user", "UserUpdated");
      return successor;
    }
    return fail("declared_outcome", "update user", "UserUpdateStale");
  }

  public async findMany(
    model: string,
    where: readonly CleanedWhere[] | undefined,
    limit: number,
    sortBy?: { readonly field: string; readonly direction: "asc" | "desc" },
    offset?: number,
    join?: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>[]> {
    if (this.plugins?.supports(model)) return (await this.plugins.read(model, where, limit, sortBy, offset, join as JoinConfig)).rows;
    if (this.plugins !== undefined && join !== undefined && Object.keys(join).length > 0) {
      if (sortBy !== undefined || (offset !== undefined && offset !== 0)) fail("unsupported_call_shape", "core join window");
      const value = await this.plugins.joinedCore(model, where ?? [], join as JoinConfig, true, limit);
      const rows = value[model === "account" ? "accounts" : "sessions"] as RecordValue[];
      const users = value.users as Parameters<typeof mapUser>[0][];
      if (rows.length > 32 || users.length > 32) fail("result_bound_exceeded", "core join");
      return rows.slice(0, limit).map((row) => ({
        ...(model === "account" ? this.mapAccount(row as Parameters<typeof mapAccount>[0]) : this.mapSession(row as Parameters<typeof mapSession>[0])),
        user: this.mapUser(users.find((user) => user.user_id === row.user_id) ?? fail("invalid_record_shape", "core join user")),
      }));
    }
    if (model === "user" && this.profile?.plan.plugins.includes("organization") && exactWhereShape(where, [{ field: "id", operator: "in" }])) {
      assertNoJoin(join, "user ID set");
      if (sortBy !== undefined || (offset !== undefined && offset !== 0)) fail("unsupported_call_shape", "user ID set");
      return this.plugins!.usersById(where!, limit);
    }
    assertNoJoin(join, `findMany ${model}`);
    if (!Number.isInteger(limit) || limit < 1) fail("unsupported_call_shape", `findMany ${model}`);
    if (model === "user") {
      const window = await this.adminUserWindow(where, limit, sortBy, offset);
      return window.users.map(this.mapUser);
    }
    if (offset !== undefined && offset !== 0) fail("unsupported_call_shape", `findMany ${model}`);
    if (model === "account" && exactWhere(where, ["userId"]) && sortBy === undefined) {
      if (limit > 100) fail("result_bound_exceeded", "findMany account");
      const result = await this.client.findAccountsByUserId({
        organization_id: this.organizationId,
        user_id: whereValue(where!, "userId", "findMany account"),
        after: null,
      });
      if (result.nextCursor !== undefined) fail("result_bound_exceeded", "findMany account");
      return result.value.accounts.slice(0, limit).map(this.mapAccount);
    }
    if (model === "account" && exactWhere(where, ["providerId", "accountId"]) && sortBy === undefined) {
      if (limit > 100) fail("result_bound_exceeded", "findMany provider account");
      const result = await this.client.findAccountByProvider({ organization_id: this.organizationId,
        account_id: whereValue(where!, "accountId", "findMany provider account"),
        provider_id: whereValue(where!, "providerId", "findMany provider account") });
      return result.value.accounts.map(this.mapAccount);
    }
    if (model === "session" && exactWhere(where, ["userId"]) && sortBy === undefined) {
      const result = await this.client.findSessionsByUserId({
        organization_id: this.organizationId,
        user_id: whereValue(where!, "userId", "findMany session"),
        after: null,
      });
      if (result.nextCursor !== undefined) fail("result_bound_exceeded", "findMany session");
      return result.value.sessions.slice(0, limit).map(this.mapSession);
    }
    if (
      model === "session" &&
      exactWhereShape(where, [
        { field: "userId", operator: "eq" },
        { field: "expiresAt", operator: "gt" },
      ]) &&
      sortBy === undefined
    ) {
      const result = await this.client.findActiveSessionsByUserId({
        organization_id: this.organizationId,
        user_id: whereValue(where!, "userId", "findMany active session"),
        expires_after: toTimestamp(
          whereDate(where!, "expiresAt", "findMany active session"),
        ),
        after: null,
      });
      if (result.nextCursor !== undefined) {
        fail("result_bound_exceeded", "findMany active session");
      }
      return result.value.sessions.slice(0, limit).map(this.mapSession);
    }
    const tokenSetShape = exactWhereShape(where, [{ field: "token", operator: "in" }]);
    const activeTokenSetShape = exactWhereShape(where, [
      { field: "token", operator: "in" },
      { field: "expiresAt", operator: "gt" },
    ]);
    if (
      model === "session" &&
      tokenSetShape &&
      sortBy === undefined
    ) {
      const tokens = whereStringSet(where!, "token", "findMany session token set");
      const result = await this.client.findSessionsByTokenSet({
        organization_id: this.organizationId,
        tokens,
      });
      return result.value.sessions.slice(0, limit).map(this.mapSession);
    }
    if (model === "session" && activeTokenSetShape) {
      return fail("unsupported_call_shape", "findMany session token set with expiry");
    }
    if (
      model === "verification" &&
      exactWhere(where, ["identifier"]) &&
      sortBy?.field === "createdAt" &&
      sortBy.direction === "desc" &&
      limit === 1
    ) {
      const result = await this.client.findLatestVerification({
        organization_id: this.organizationId,
        identifier: whereValue(where!, "identifier", "findMany verification"),
      });
      return result.value.verifications.map(this.mapVerification);
    }
    if (model === "verification" && exactWhere(where, ["identifier"]) && sortBy !== undefined) {
      return fail("unsupported_call_shape", "findMany verification sort");
    }
    if (model === "verification" && exactWhere(where, ["identifier"]) && limit <= 32) {
      const result = await this.client.findVerificationsByIdentifier({
        organization_id: this.organizationId,
        identifier: whereValue(where!, "identifier", "findMany verification"),
        after: null,
      });
      if (result.nextCursor !== undefined) fail("result_bound_exceeded", "findMany verification");
      return result.value.verifications.slice(0, limit).map(this.mapVerification);
    }
    return fail("unsupported_call_shape", `findMany ${model}`);
  }

  private async adminUserWindow(
    where: readonly CleanedWhere[] | undefined,
    limit: number,
    sortBy?: { readonly field: string; readonly direction: "asc" | "desc" },
    offset = 0,
  ): Promise<AdminUserWindow> {
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 4_096) {
      fail("result_bound_exceeded", "findMany user");
    }
    const selected = adminUserWhere(where, "findMany user");
    const parameters = {
      organization_id: this.organizationId,
      user_id: selected.userId,
      limit,
      offset: BigInt(offset),
    };
    if (selected.operator === undefined) {
      if (sortBy !== undefined && (sortBy.field !== "email" || sortBy.direction !== "asc")) {
        fail("unsupported_call_shape", "findMany user sort");
      }
      const result = await this.client.adminUsersAllEmailAsc({
        ...parameters,
        minimum_email: "",
      });
      return result.value;
    }

    const direction = sortBy?.direction ?? "asc";
    const field = sortBy?.field ?? "email";
    const searchParameters = { ...parameters, needle: selected.needle! };
    if (field === "createdAt" && direction === "desc" && selected.operator === "contains") {
      return (await this.client.adminUsersEmailContainsCreatedDesc(searchParameters)).value;
    }
    if (field === "image" && direction === "asc" && selected.operator === "contains") {
      return (await this.client.adminUsersEmailContainsImageAsc(searchParameters)).value;
    }
    if (field !== "email") fail("unsupported_call_shape", "findMany user sort");

    if (selected.operator === "contains") {
      return direction === "asc"
        ? (await this.client.adminUsersContainsAsc(searchParameters)).value
        : (await this.client.adminUsersContainsDesc(searchParameters)).value;
    }
    if (selected.operator === "starts_with") {
      return direction === "asc"
        ? (await this.client.adminUsersStartsWithAsc(searchParameters)).value
        : (await this.client.adminUsersStartsWithDesc(searchParameters)).value;
    }
    return direction === "asc"
      ? (await this.client.adminUsersEndsWithAsc(searchParameters)).value
      : (await this.client.adminUsersEndsWithDesc(searchParameters)).value;
  }

  public async count(
    model: string,
    where: readonly CleanedWhere[] | undefined,
  ): Promise<number> {
    if (this.plugins?.supports(model)) {
      if (model !== "member" || !exactWhere(where, ["organizationId"])) fail("unsupported_call_shape", "plugin count");
      return (await this.plugins.read(model, where, 1)).total;
    }
    if (model !== "user") fail("unsupported_call_shape", `count ${model}`);
    const window = await this.adminUserWindow(where, 1, undefined, 0);
    const total = window.total.value;
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail("result_bound_exceeded", "count user");
    return Number(total);
  }

  public async delete(model: string, where: readonly CleanedWhere[]): Promise<void> {
    if (this.plugins?.supports(model)) {
      if (!exactWhere(where, ["id"])) fail("unsupported_call_shape", "plugin delete");
      return this.plugins.deleteIds(model, [whereValue(where, "id", "plugin delete")]);
    }
    if (model === "user" && this.profile?.plan.plugins.includes("organization")) fail("unsupported_call_shape", "delete user in organization profile");
    if (model === "user" && exactWhere(where, ["id"])) {
      const result = await this.client.deleteUser({
        request_id: "",
        organization_id: this.organizationId,
        user_ids: [whereValue(where, "id", "delete user")],
      });
      if (result.outcome.outcome === "DeleteUserCascadeLimitExceeded") {
        fail("result_bound_exceeded", "delete user", result.outcome.outcome);
      }
      if (!new Set(["UserDeleted", "DeleteUserMissing"]).has(result.outcome.outcome)) {
        fail("declared_outcome", "delete user", result.outcome.outcome);
      }
      return;
    }
    if (model === "account" && exactWhere(where, ["id"])) {
      const account = await this.findOne(model, where);
      if (account === null) return;
      const result = await this.client.deleteAccount({
        request_id: "",
        organization_id: this.organizationId,
        user_id: requiredString(account, "userId", "delete account"),
        account_ids: [requiredString(account, "id", "delete account")],
      });
      if (!new Set(["AccountDeleted", "AccountMissing"]).has(result.outcome.outcome)) {
        fail("declared_outcome", "delete account", result.outcome.outcome);
      }
      return;
    }
    if (model === "verification" && exactWhere(where, ["id"])) {
      const result = await this.client.deleteVerification({
        request_id: "",
        organization_id: this.organizationId,
        verification_ids: [whereValue(where, "id", "delete verification")],
      });
      if (!new Set(["VerificationDeleted", "VerificationMissing"]).has(result.outcome.outcome)) {
        fail("declared_outcome", "delete verification", result.outcome.outcome);
      }
      return;
    }
    if (model === "verification" && exactWhere(where, ["identifier"])) {
      const rows = await this.findMany("verification", where, 32);
      if (rows.length === 0) return;
      const result = await this.client.deleteVerification({
        request_id: "",
        organization_id: this.organizationId,
        verification_ids: rows.map((row) =>
          requiredString(row, "id", "delete verification by identifier"),
        ),
      });
      requireOutcome(result, "delete verification by identifier", "VerificationDeleted");
      return;
    }
    if (
      model === "session" &&
      (exactWhere(where, ["id"]) || exactWhere(where, ["token"]))
    ) {
      const session = await this.findOne("session", where);
      if (session === null) return;
      const result = await this.client.deleteSession({
        request_id: "",
        organization_id: this.organizationId,
        user_id: requiredString(session, "userId", "delete session"),
        session_ids: [requiredString(session, "id", "delete session")],
      });
      if (!new Set(["SessionDeleted", "SessionMissing"]).has(result.outcome.outcome)) {
        fail("declared_outcome", "delete session", result.outcome.outcome);
      }
      return;
    }
    fail("unsupported_call_shape", `delete ${model}`);
  }

  public async deleteMany(model: string, where: readonly CleanedWhere[]): Promise<number> {
    if (this.plugins?.supports(model) && where.length > 0) {
      if (!(model === "twoFactor" && (exactWhere(where, ["userId"]) || exactWhere(where, ["id"]))) &&
          !(model === "member" && exactWhere(where, ["id"]))) fail("unsupported_call_shape", "plugin deleteMany");
      const result = await this.plugins.read(model, where, 100);
      if (result.total > 100) fail("result_bound_exceeded", "plugin deleteMany");
      await this.plugins.deleteIds(model, result.rows.map((row) => requiredString(row, "id", "plugin deleteMany")));
      return result.rows.length;
    }
    if (where.length === 0 && this.resetModelForTesting !== undefined) {
      return this.resetModelForTesting(model);
    }
    if (model === "session" && exactWhere(where, ["userId"])) {
      const rows = await this.findMany(model, where, 32);
      if (rows.length === 0) return 0;
      const result = await this.client.deleteSession({
        request_id: "",
        organization_id: this.organizationId,
        user_id: whereValue(where, "userId", "deleteMany session"),
        session_ids: rows.map((row) => requiredString(row, "id", "deleteMany session")),
      });
      requireOutcome(result, "deleteMany session", "SessionDeleted");
      return rows.length;
    }
    if (
      model === "session" &&
      exactWhereShape(where, [{ field: "token", operator: "in" }])
    ) {
      const rows = await this.findMany(model, where, 32);
      const byUser = new Map<string, string[]>();
      for (const row of rows) {
        const userId = requiredString(row, "userId", "deleteMany session token set");
        const ids = byUser.get(userId) ?? [];
        ids.push(requiredString(row, "id", "deleteMany session token set"));
        byUser.set(userId, ids);
      }
      for (const [userId, sessionIds] of byUser) {
        const result = await this.client.deleteSession({
          request_id: "",
          organization_id: this.organizationId,
          user_id: userId,
          session_ids: sessionIds,
        });
        requireOutcome(result, "deleteMany session token set", "SessionDeleted");
      }
      return rows.length;
    }
    if (model === "account" && exactWhere(where, ["userId"])) {
      const rows = await this.findMany(model, where, 100);
      if (rows.length === 0) return 0;
      if (rows.length > 32) fail("result_bound_exceeded", "deleteMany account");
      const result = await this.client.deleteAccount({
        request_id: "",
        organization_id: this.organizationId,
        user_id: whereValue(where, "userId", "deleteMany account"),
        account_ids: rows.map((row) => requiredString(row, "id", "deleteMany account")),
      });
      requireOutcome(result, "deleteMany account", "AccountDeleted");
      return rows.length;
    }
    if (
      model === "verification" &&
      exactWhereShape(where, [{ field: "expiresAt", operator: "lt" }])
    ) {
      const result = await this.client.findExpiredVerificationIds({
        organization_id: this.organizationId,
        expires_before: toTimestamp(
          whereDate(where, "expiresAt", "deleteMany expired verification"),
        ),
        after: null,
      });
      if (result.nextCursor !== undefined) {
        fail("result_bound_exceeded", "deleteMany expired verification");
      }
      const ids = result.value.verifications.map((row) => row.verification_id);
      if (ids.length === 0) return 0;
      const deleted = await this.client.deleteVerification({
        request_id: "",
        organization_id: this.organizationId,
        verification_ids: ids,
      });
      requireOutcome(deleted, "deleteMany expired verification", "VerificationDeleted");
      return ids.length;
    }
    if (model !== "verification" || !exactWhere(where, ["identifier"])) {
      return fail("unsupported_call_shape", `deleteMany ${model}`);
    }
    const rows = await this.findMany("verification", where, 32);
    if (rows.length === 0) return 0;
    const result = await this.client.consumeVerificationSet({
      request_id: "",
      organization_id: this.organizationId,
      verification_ids: rows.map((row) => requiredString(row, "id", "deleteMany verification")),
    });
    requireOutcome(result, "deleteMany verification", "VerificationSetConsumed");
    return rows.length;
  }

  public async consumeOne(
    model: string,
    where: readonly CleanedWhere[],
  ): Promise<Record<string, unknown> | null> {
    if (model !== "verification" || !exactWhere(where, ["id"])) {
      return fail("unsupported_call_shape", `consumeOne ${model}`);
    }
    const result = await this.client.consumeVerification({
      request_id: "",
      organization_id: this.organizationId,
      verification_id: whereValue(where, "id", "consumeOne verification"),
    });
    if (result.outcome.outcome === "VerificationConsumeMissing") return null;
    requireOutcome(result, "consumeOne verification", "VerificationConsumed");
    return this.mapVerification(result.outcome);
  }

  public async prepareConsume(id: string): Promise<VerificationSnapshot | null> {
    const { value } = await this.client.findVerificationById({
      organization_id: this.organizationId, id,
    });
    return value.outcome === "Missing" ? null : {
      row: this.mapVerification(value.verification), revision: value.verification.revision,
    };
  }

  public async commitConsume(snapshot: VerificationSnapshot): Promise<boolean> {
    const result = await this.client.consumeVerificationSnapshot({
      request_id: "", organization_id: this.organizationId,
      verification_id: requiredString(snapshot.row, "id", "consumeOne"),
      expected_revision: snapshot.revision,
    });
    if (result.outcome.outcome === "VerificationConsumeMissing") return false;
    requireOutcome(result, "consumeOne", "VerificationConsumed");
    return true;
  }

  public async commitPasswordReset(
    snapshot: VerificationSnapshot,
    where: readonly CleanedWhere[],
    update: RecordValue,
    cleanup: readonly RecordValue[],
  ): Promise<void> {
    const userId = whereValue(where, "userId", "resetPassword");
    if (!exactWhere(where, ["userId", "providerId", "accountId"]) ||
        whereValue(where, "providerId", "resetPassword") !== "credential" ||
        whereValue(where, "accountId", "resetPassword") !== userId ||
        snapshot.row.value !== userId || cleanup.length !== 0 ||
        Object.keys(update).some((field) => field !== "password" && field !== "updatedAt")) {
      fail("unsupported_transaction_shape", "resetPassword");
    }
    const password = requiredString(update, "password", "resetPassword");
    const updatedAt = toTimestamp(requiredDate(update, "updatedAt", "resetPassword"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { value } = await this.client.findCredentialAccount({
        organization_id: this.organizationId, user_id: userId, account_id: userId, provider_id: "credential",
      });
      const account = value.accounts[0];
      if (account === undefined) fail("unsupported_transaction_shape", "resetPassword create account");
      const result = await this.client.resetCredentialPassword({
        request_id: "", organization_id: this.organizationId,
        verification_ids: [requiredString(snapshot.row, "id", "resetPassword")],
        verification_revision: snapshot.revision,
        user_id: userId, external_account_id: userId, account_id: account.id,
        account_revision: account.revision, password, updated_at: updatedAt,
      });
      if (result.outcome.outcome === "PasswordAccountStale") continue;
      requireOutcome(result, "resetPassword", "CredentialPasswordReset");
      return;
    }
    fail("declared_outcome", "resetPassword", "PasswordAccountStale");
  }

  public async updateMany(
    model: string,
    where: readonly CleanedWhere[],
    updateValue: RecordValue,
  ): Promise<number> {
    if (model === "account" && exactWhere(where, ["userId", "providerId", "accountId"])) {
      const userId = whereValue(where, "userId", "update credential password");
      if (whereValue(where, "providerId", "update credential password") !== "credential" ||
          whereValue(where, "accountId", "update credential password") !== userId ||
          Object.keys(updateValue).some((field) => field !== "password" && field !== "updatedAt")) fail("unsupported_call_shape", "update credential password");
      const password = requiredString(updateValue, "password", "update credential password");
      const updatedAt = toTimestamp(requiredDate(updateValue, "updatedAt", "update credential password"));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { value } = await this.client.findCredentialAccount({ organization_id: this.organizationId,
          user_id: userId, account_id: userId, provider_id: "credential" });
        const account = value.accounts[0];
        if (account === undefined) return 0;
        const result = await this.client.updateCredentialPassword({ request_id: "", organization_id: this.organizationId,
          user_id: userId, account_id: account.id, external_account_id: userId, expected_revision: account.revision,
          password, updated_at: updatedAt });
        if (result.outcome.outcome === "PasswordAccountStale") continue;
        if (result.outcome.outcome === "PasswordAccountMissing") return 0;
        requireOutcome(result, "update credential password", "CredentialPasswordUpdated");
        return 1;
      }
      fail("declared_outcome", "update credential password", "PasswordAccountStale");
    }
    if (model !== "account" || !exactWhere(where, ["userId", "providerId"])) {
      return fail("unsupported_call_shape", `updateMany ${model}`);
    }
    const update = asRecord(updateValue, "updateMany account");
    const updateFields = Object.keys(update).sort();
    if (
      JSON.stringify(updateFields) !== JSON.stringify(["password", "updatedAt"])
    ) {
      fail("unsupported_call_shape", "updateMany account");
    }
    const userId = whereValue(where, "userId", "updateMany account");
    const providerId = whereValue(where, "providerId", "updateMany account");
    const updatedAt = requiredDate(update, "updatedAt", "updateMany account");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await this.client.findAccountsByUserProvider({
        organization_id: this.organizationId,
        user_id: userId,
        provider_id: providerId,
        after: null,
      });
      if (found.nextCursor !== undefined) fail("result_bound_exceeded", "updateMany account");
      const accounts = found.value.accounts;
      if (accounts.length === 0) return 0;
      const result = await this.client.updateAccountPasswords({
        request_id: "",
        organization_id: this.organizationId,
        user_id: userId,
        updates: accounts.map((account) => ({
          organization_id: this.organizationId,
          user_id: userId,
          account_id: account.id,
          provider_id: providerId,
          password: nullableString(update, "password", "updateMany account"),
          updated_at: toTimestamp(updatedAt),
          expected_revision: account.revision,
        })),
      });
      if (
        result.outcome.outcome === "PasswordAccountStale" ||
        result.outcome.outcome === "PasswordAccountMissing" ||
        result.outcome.outcome === "PasswordProviderMismatch"
      ) {
        continue;
      }
      requireOutcome(result, "updateMany account", "AccountPasswordsUpdated");
      return accounts.length;
    }
    return fail("declared_outcome", "updateMany account", "PasswordAccountStale");
  }

  public async commitSignup(records: readonly DeferredCreate[]): Promise<void> {
    if (records.length !== 3) fail("unsupported_transaction_shape", "transaction signup");
    const byModel = new Map(records.map((record) => [record.model, record.data]));
    if (byModel.size !== 3 || !["user", "account", "session"].every((name) => byModel.has(name))) {
      fail("unsupported_transaction_shape", "transaction signup");
    }
    const user = byModel.get("user")!;
    const account = byModel.get("account")!;
    const session = byModel.get("session")!;
    const userId = requiredString(user, "id", "transaction signup");
    const sessionToken = requiredString(session, "token", "transaction signup");
    if (
      requiredString(account, "userId", "transaction signup") !== userId ||
      requiredString(session, "userId", "transaction signup") !== userId
    ) {
      fail("unsupported_transaction_shape", "transaction signup");
    }
    const result = await this.client.createSignupGraph({
      ...this.encodeExtra("user", user, "user_"),
      ...this.encodeExtra("session", session, "session_"),
      ...this.encodeExtra("account", account, "account_"),
      request_id: "",
      organization_id: this.organizationId,
      user_id: userId,
      user_name: requiredString(user, "name", "transaction signup"),
      user_email: requiredString(user, "email", "transaction signup"),
      user_email_verified: requiredBoolean(user, "emailVerified", "transaction signup"),
      user_image: nullableString(user, "image", "transaction signup"),
      user_created_at: toTimestamp(requiredDate(user, "createdAt", "transaction signup")),
      user_updated_at: toTimestamp(requiredDate(user, "updatedAt", "transaction signup")),
      account_id: requiredString(account, "id", "transaction signup"),
      external_account_id: requiredString(account, "accountId", "transaction signup"),
      provider_id: requiredString(account, "providerId", "transaction signup"),
      account_password: nullableString(account, "password", "transaction signup"),
      account_created_at: toTimestamp(requiredDate(account, "createdAt", "transaction signup")),
      account_updated_at: toTimestamp(requiredDate(account, "updatedAt", "transaction signup")),
      session_id: requiredString(session, "id", "transaction signup"),
      session_token: sessionToken,
      session_expires_at: toTimestamp(requiredDate(session, "expiresAt", "transaction signup")),
      session_ip_address: nullableString(session, "ipAddress", "transaction signup"),
      session_user_agent: nullableString(session, "userAgent", "transaction signup"),
      session_created_at: toTimestamp(requiredDate(session, "createdAt", "transaction signup")),
      session_updated_at: toTimestamp(requiredDate(session, "updatedAt", "transaction signup")),
    });
    requireOutcome(result, "transaction signup", "SignupGraphCreated");
  }

  public async commitOAuthUser(records: readonly DeferredCreate[]): Promise<void> {
    if (records.length !== 2) fail("unsupported_transaction_shape", "transaction OAuth user");
    const byModel = new Map(records.map((record) => [record.model, record.data]));
    if (byModel.size !== 2 || !["user", "account"].every((name) => byModel.has(name))) {
      fail("unsupported_transaction_shape", "transaction OAuth user");
    }
    const user = byModel.get("user")!;
    const account = byModel.get("account")!;
    const userId = requiredString(user, "id", "transaction OAuth user");
    if (requiredString(account, "userId", "transaction OAuth user") !== userId) {
      fail("unsupported_transaction_shape", "transaction OAuth user");
    }
    const result = await this.client.createOAuthUserGraph({
      ...this.encodeExtra("user", user, "user_"),
      ...this.encodeExtra("account", account, "account_"),
      request_id: "",
      organization_id: this.organizationId,
      user_id: userId,
      user_name: requiredString(user, "name", "transaction OAuth user"),
      user_email: requiredString(user, "email", "transaction OAuth user"),
      user_email_verified: requiredBoolean(user, "emailVerified", "transaction OAuth user"),
      user_image: nullableString(user, "image", "transaction OAuth user"),
      user_created_at: toTimestamp(requiredDate(user, "createdAt", "transaction OAuth user")),
      user_updated_at: toTimestamp(requiredDate(user, "updatedAt", "transaction OAuth user")),
      account_id: requiredString(account, "id", "transaction OAuth user"),
      external_account_id: requiredString(account, "accountId", "transaction OAuth user"),
      provider_id: requiredString(account, "providerId", "transaction OAuth user"),
      access_token: nullableString(account, "accessToken", "transaction OAuth user"),
      refresh_token: nullableString(account, "refreshToken", "transaction OAuth user"),
      access_token_expires_at: timestampOrNull(
        nullableDate(account, "accessTokenExpiresAt", "transaction OAuth user"),
      ),
      refresh_token_expires_at: timestampOrNull(
        nullableDate(account, "refreshTokenExpiresAt", "transaction OAuth user"),
      ),
      scope: nullableString(account, "scope", "transaction OAuth user"),
      id_token: nullableString(account, "idToken", "transaction OAuth user"),
      password: nullableString(account, "password", "transaction OAuth user"),
      account_created_at: toTimestamp(
        requiredDate(account, "createdAt", "transaction OAuth user"),
      ),
      account_updated_at: toTimestamp(
        requiredDate(account, "updatedAt", "transaction OAuth user"),
      ),
    });
    requireOutcome(result, "transaction OAuth user", "OAuthUserGraphCreated");
  }

  public async commitVerificationConsume(rows: readonly RecordValue[]): Promise<void> {
    if (rows.length < 1 || rows.length > 32) {
      fail("unsupported_transaction_shape", "transaction verification consume");
    }
    const result = await this.client.consumeVerificationSet({
      request_id: "",
      organization_id: this.organizationId,
      verification_ids: rows.map((row) =>
        requiredString(row, "id", "transaction verification consume"),
      ),
    });
    requireOutcome(result, "transaction verification consume", "VerificationSetConsumed");
  }

  public async increment(model: string, where: readonly CleanedWhere[], increment: RecordValue, set?: RecordValue): Promise<Record<string, unknown> | null> {
    if (!this.plugins?.supports(model)) fail("unsupported_call_shape", `incrementOne ${model}`);
    return this.plugins.increment(model, where, { ...increment }, set === undefined ? {} : { ...set });
  }

  public async commitMemberActivation(data: Record<string, unknown>, where: CleanedWhere[], update: Record<string, unknown>): Promise<void> {
    if (this.plugins === undefined || !exactWhere(where, ["token"])) fail("unsupported_transaction_shape", "member activation");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { value } = await this.client.findSessionByToken({ organization_id: this.organizationId,
        token: whereValue(where, "token", "member activation") });
      const raw = value.sessions[0];
      if (raw === undefined) fail("declared_outcome", "member activation", "SessionMissing");
      await this.plugins.createMemberAndActivate(data, this.mapSession(raw), raw, update);
      return;
    }
  }

  public async commitPasswordChange(where: CleanedWhere[], update: Record<string, unknown>): Promise<void> {
    const account = await this.findOne("account", where);
    if (account === null || account.providerId !== "credential" || account.accountId !== account.userId) {
      fail("declared_outcome", "changePassword", "PasswordAccountMissing");
    }
    const userId = requiredString(account, "userId", "changePassword");
    const affected = await this.updateMany("account", [
      { field: "userId", value: userId, operator: "eq", connector: "AND", mode: "sensitive" },
      { field: "accountId", value: userId, operator: "eq", connector: "AND", mode: "sensitive" },
      { field: "providerId", value: "credential", operator: "eq", connector: "AND", mode: "sensitive" },
    ], update);
    if (affected !== 1) fail("declared_outcome", "changePassword", "PasswordAccountMissing");
  }
}

interface DeferredCreate {
  readonly model: string;
  readonly data: Record<string, unknown>;
}

interface VerificationSnapshot {
  readonly row: Record<string, unknown>;
  readonly revision: bigint;
}

interface CustomCreateArgs {
  readonly model: string;
  readonly data: Record<string, unknown>;
  readonly select?: string[];
}

interface CustomFindOneArgs {
  readonly model: string;
  readonly where: CleanedWhere[];
  readonly select?: string[];
  readonly join?: JoinConfig;
}

interface CustomFindManyArgs {
  readonly model: string;
  readonly where?: CleanedWhere[];
  readonly limit: number;
  readonly select?: string[];
  readonly sortBy?: { readonly field: string; readonly direction: "asc" | "desc" };
  readonly offset?: number;
  readonly join?: JoinConfig;
}

interface CustomConsumeOneArgs {
  readonly model: string;
  readonly where: CleanedWhere[];
}

interface CustomUpdateArgs {
  readonly model: string;
  readonly where: CleanedWhere[];
  readonly update: Record<string, unknown>;
}

function genericCreate(
  implementation: (args: CustomCreateArgs) => Promise<Record<string, unknown>>,
): CustomAdapter["create"] {
  return implementation as CustomAdapter["create"];
}

function genericFindOne(
  implementation: (args: CustomFindOneArgs) => Promise<Record<string, unknown> | null>,
): CustomAdapter["findOne"] {
  return implementation as CustomAdapter["findOne"];
}

function genericFindMany(
  implementation: (args: CustomFindManyArgs) => Promise<Record<string, unknown>[]>,
): CustomAdapter["findMany"] {
  return implementation as CustomAdapter["findMany"];
}

function genericConsumeOne(
  implementation: (args: CustomConsumeOneArgs) => Promise<Record<string, unknown> | null>,
): NonNullable<CustomAdapter["consumeOne"]> {
  return implementation as NonNullable<CustomAdapter["consumeOne"]>;
}

function genericUpdate(
  implementation: (args: CustomUpdateArgs) => Promise<Record<string, unknown> | null>,
): CustomAdapter["update"] {
  return implementation as CustomAdapter["update"];
}

class TransactionRecorder {
  private readonly creates: DeferredCreate[] = [];
  private consumeAttempted = false;
  private consumedVerification: Record<string, unknown> | null | undefined;
  private verificationDeleteRows: Record<string, unknown>[] | undefined;
  private verificationDeleteIdentifier: string | undefined;
  private verificationSnapshot: VerificationSnapshot | null | undefined;
  private passwordReset: { where: CleanedWhere[]; update: RecordValue } | undefined;
  public lostConsume = false;
  private organizationDeletion: { id: string; models: string[]; deleted: boolean } | undefined;
  private memberDeletion: string | undefined;
  private sessionActivation: { where: CleanedWhere[]; update: Record<string, unknown> } | undefined;
  private passwordChange: { where: CleanedWhere[]; update: Record<string, unknown> } | undefined;

  public constructor(private readonly dispatcher: CoreDispatcher) {}

  public customAdapter(): CustomAdapter {
    return {
      create: genericCreate(async ({ model, data }) => {
        const copied = this.dispatcher.normalizeCreate(model, data);
        this.creates.push({ model, data: copied });
        return copied;
      }),
      findOne: genericFindOne(async ({ model, where, join }) =>
        this.dispatcher.findOne(model, where, join)),
      findMany: genericFindMany(async ({ model, where, limit, sortBy, offset, join }) =>
        this.dispatcher.findMany(model, where, limit, sortBy, offset, join)),
      count: async () => fail("unsupported_transaction_shape", "transaction count"),
      update: genericUpdate(async ({ model, where, update }) => {
        if (model === "account" && exactWhere(where, ["id"]) && this.passwordChange === undefined &&
            typeof update.password === "string" && Object.keys(update).every((field) => field === "password" || field === "updatedAt")) {
          requiredString(update, "password", "changePassword"); requiredDate(update, "updatedAt", "changePassword");
          const current = await this.dispatcher.findOne("account", where);
          if (current === null) fail("declared_outcome", "changePassword", "PasswordAccountMissing");
          this.passwordChange = { where, update };
          return { ...current, ...update };
        }
        if (this.dispatcher.plugins === undefined || model !== "session" || !exactWhere(where, ["token"]) ||
            this.sessionActivation !== undefined || this.creates.length !== 1 || this.creates[0]!.model !== "member" ||
            Object.keys(update).some((field) => field !== "activeOrganizationId" && field !== "updatedAt")) fail("unsupported_transaction_shape", "member activation");
        const current = await this.dispatcher.findOne("session", where);
        if (current === null) return null;
        this.sessionActivation = { where, update };
        return { ...current, ...update };
      }),
      updateMany: async ({ model, where, update }) => {
        if (model !== "account" || !exactWhere(where, ["userId", "providerId", "accountId"]) ||
            !this.consumeAttempted || this.passwordReset !== undefined ||
            Object.keys(update).some((field) => field !== "password" && field !== "updatedAt")) {
          fail("unsupported_transaction_shape", "transaction updateMany");
        }
        this.passwordReset = { where, update };
        return 1;
      },
      delete: async ({ model, where }) => {
        if (this.dispatcher.plugins === undefined || !exactWhere(where, ["id"])) fail("unsupported_transaction_shape", "transaction delete");
        const id = whereValue(where, "id", "transaction delete");
        if (model === "organization" && this.organizationDeletion?.id === id && this.organizationDeletion.models.join(",") === "member,invitation") {
          this.organizationDeletion.deleted = true; return;
        }
        if (model === "member" && this.memberDeletion === undefined && this.organizationDeletion === undefined) { this.memberDeletion = id; return; }
        fail("unsupported_transaction_shape", "transaction delete");
      },
      deleteMany: async ({ model, where }) => {
        if (this.dispatcher.plugins !== undefined && ["member", "invitation"].includes(model) && exactWhere(where, ["organizationId"])) {
          const id = whereValue(where, "organizationId", "organization delete");
          this.organizationDeletion ??= { id, models: [], deleted: false };
          if (this.organizationDeletion.id !== id || this.organizationDeletion.deleted ||
              model !== (this.organizationDeletion.models.length === 0 ? "member" : "invitation") || this.organizationDeletion.models.length >= 2) fail("unsupported_transaction_shape", "organization delete");
          this.organizationDeletion.models.push(model);
          return 0; // The upstream graph ignores these counts; one cascade commits them together.
        }
        if (
          model !== "verification" ||
          !exactWhere(where, ["identifier"]) ||
          !this.consumeAttempted ||
          this.verificationDeleteRows !== undefined
        ) {
          return fail("unsupported_transaction_shape", "transaction deleteMany");
        }
        this.verificationDeleteIdentifier = whereValue(
          where,
          "identifier",
          "transaction deleteMany verification",
        );
        this.verificationDeleteRows = (await this.dispatcher.findMany("verification", where, 32))
          .filter((row) => row.id !== this.consumedVerification?.id);
        return this.verificationDeleteRows.length;
      },
      consumeOne: genericConsumeOne(async ({ model, where }) => {
        if (
          model !== "verification" ||
          !exactWhere(where, ["id"]) ||
          this.consumeAttempted
        ) {
          return fail("unsupported_transaction_shape", "transaction consumeOne");
        }
        this.consumeAttempted = true;
        this.verificationSnapshot = await this.dispatcher.prepareConsume(whereValue(where, "id", "consumeOne"));
        this.consumedVerification = this.verificationSnapshot?.row ?? null;
        return this.consumedVerification;
      }),
      incrementOne: async () => fail("unsupported_transaction_shape", "transaction incrementOne"),
    };
  }

  public async commit(): Promise<void> {
    const hasVerificationMutation =
      this.consumeAttempted || this.verificationDeleteRows !== undefined;
    const hasOrganizationMutation = this.organizationDeletion !== undefined || this.memberDeletion !== undefined;
    if (this.passwordChange !== undefined) {
      if (hasVerificationMutation || hasOrganizationMutation || this.creates.length > 0 || this.sessionActivation !== undefined) fail("unsupported_transaction_shape", "mixed password change");
      await this.dispatcher.commitPasswordChange(this.passwordChange.where, this.passwordChange.update);
      return;
    }
    if (hasOrganizationMutation) {
      if (this.creates.length > 0 || hasVerificationMutation || this.sessionActivation !== undefined ||
          (this.organizationDeletion !== undefined && this.memberDeletion !== undefined)) fail("unsupported_transaction_shape", "mixed organization transaction");
      if (this.organizationDeletion !== undefined) {
        if (!this.organizationDeletion.deleted) fail("unsupported_transaction_shape", "incomplete organization deletion");
        await this.dispatcher.plugins!.deleteIds("organization", [this.organizationDeletion.id]);
      } else await this.dispatcher.plugins!.deleteIds("member", [this.memberDeletion!]);
      return;
    }
    if (this.creates.length > 0 && hasVerificationMutation) {
      fail("unsupported_transaction_shape", "mixed transaction");
    }
    if (this.creates.length > 0) {
      if (this.creates.length === 1 && this.creates[0]!.model === "member" && this.sessionActivation !== undefined) {
        await this.dispatcher.commitMemberActivation(this.creates[0]!.data, this.sessionActivation.where, this.sessionActivation.update);
        return;
      }
      if (this.creates.length === 2) {
        await this.dispatcher.commitOAuthUser(this.creates);
      } else {
        await this.dispatcher.commitSignup(this.creates);
      }
      return;
    }
    if (hasVerificationMutation) {
      if (!this.consumeAttempted || this.consumedVerification === undefined) {
        fail("unsupported_transaction_shape", "transaction verification consume");
      }
      if (this.verificationSnapshot == null) return;
      if (
        this.verificationDeleteRows !== undefined && this.consumedVerification !== null &&
        this.consumedVerification.identifier !== this.verificationDeleteIdentifier
      ) {
        fail("unsupported_transaction_shape", "transaction verification consume");
      }
      if (this.passwordReset !== undefined) {
        await this.dispatcher.commitPasswordReset(this.verificationSnapshot,
          this.passwordReset.where, this.passwordReset.update, this.verificationDeleteRows ?? []);
        return;
      }
      if (!await this.dispatcher.commitConsume(this.verificationSnapshot)) {
        this.lostConsume = true;
        return;
      }
      if (this.verificationDeleteRows !== undefined && this.verificationDeleteRows.length > 0) {
        await this.dispatcher.commitVerificationConsume(this.verificationDeleteRows);
      }
    }
  }
}

function customAdapter(dispatcher: CoreDispatcher): CustomAdapter {
  return {
    create: genericCreate(async ({ model, data }) => dispatcher.create(model, data)),
    findOne: genericFindOne(async ({ model, where, join }) =>
      dispatcher.findOne(model, where, join)),
    findMany: genericFindMany(async ({ model, where, limit, sortBy, offset, join }) =>
      dispatcher.findMany(model, where, limit, sortBy, offset, join)),
    count: async ({ model, where }) => dispatcher.count(model, where),
    update: genericUpdate(async ({ model, where, update }) =>
      dispatcher.update(model, where, update)),
    updateMany: async ({ model, where, update }) => dispatcher.updateMany(model, where, update),
    delete: async ({ model, where }) => dispatcher.delete(model, where),
    deleteMany: async ({ model, where }) => dispatcher.deleteMany(model, where),
    consumeOne: genericConsumeOne(async ({ model, where }) =>
      dispatcher.consumeOne(model, where)),
    incrementOne: (async ({ model, where, increment, set }) => dispatcher.increment(model, where, increment, set)) as NonNullable<CustomAdapter["incrementOne"]>,
  };
}

const BASE_FACTORY_CONFIG = {
  adapterId: "riffdb",
  adapterName: "RiffDB Better Auth Core",
  usePlural: false,
  supportsNumericIds: false,
  supportsUUIDs: false,
  supportsJSON: false,
  supportsDates: true,
  supportsBooleans: true,
  supportsArrays: false,
} as const;

export function buildRiffDBBetterAuthAdapter(
  config: InternalAdapterConfig,
): AdapterFactory<BetterAuthOptions> {
  assertSupportedBetterAuthInstallation();
  validateConfiguration(config);
  return (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> => {
    if (config.profile !== undefined) options = { ...options, advanced: { ...options.advanced,
      database: { ...options.advanced?.database, joins: true } } };
    const dispatcher = new CoreDispatcher(
      config.client.causalSession(),
      config.organizationId,
      config.resetModelForTesting,
      config.profile,
    );
    const factory = createAdapterFactory({
      config: {
        ...BASE_FACTORY_CONFIG,
        adapterName: config.profile?.plan.name ?? BASE_FACTORY_CONFIG.adapterName,
        debugLogs: false,
        transaction: async (callback) => {
          const recorder = new TransactionRecorder(dispatcher);
          const transactionFactory = createAdapterFactory({
            config: {
              ...BASE_FACTORY_CONFIG,
              debugLogs: false,
              transaction: false,
            },
            adapter: ({ options: transactionOptions, schema }) => {
              validateResolvedSchema(transactionOptions, schema, config.profile);
              return recorder.customAdapter();
            },
          });
          const transactionAdapter = transactionFactory(options);
          const result = await callback(transactionAdapter);
          await recorder.commit();
          return recorder.lostConsume ? null as typeof result : result;
        },
      },
      adapter: ({ options: resolvedOptions, schema }) => {
        validateResolvedSchema(resolvedOptions, schema, config.profile);
        return customAdapter(dispatcher);
      },
    });
    return factory(options);
  };
}

export function riffdbAdapter(
  config: RiffDBBetterAuthAdapterConfig,
): AdapterFactory<BetterAuthOptions> {
  const commandAttemptBudget = config.commandAttemptBudget ?? 3;
  if (!Number.isInteger(commandAttemptBudget) || commandAttemptBudget < 1 || commandAttemptBudget > 10) {
    fail("invalid_configuration", "commandAttemptBudget");
  }
  const transport: ApplicationTransport = new DriverGeneratedApplicationTransport(config.driver);
  return buildRiffDBBetterAuthAdapter({
    client: config.profile === undefined ? new RiffDBBetterAuthCoreClient(transport, commandAttemptBudget) :
      instantiateProfileClient(config.profile, transport, commandAttemptBudget) as CoreClient,
    organizationId: config.organizationId,
    ...(config.debugLogs === undefined ? {} : { debugLogs: config.debugLogs }),
    ...(config.profile === undefined ? {} : { profile: config.profile }),
  });
}
