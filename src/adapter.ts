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
}

interface InternalAdapterConfig {
  readonly client: RiffDBBetterAuthCoreClient;
  readonly organizationId: string;
  readonly debugLogs?: DBAdapterDebugLogOption;
  readonly resetModelForTesting?: (model: string) => number | Promise<number>;
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
}

function validateResolvedSchema(
  options: BetterAuthOptions,
  schema: Readonly<Record<string, { readonly modelName: string; readonly fields: Record<string, unknown> }>>,
): void {
  if (options.advanced?.database?.generateId !== "uuid") {
    fail("invalid_configuration", "generateId");
  }
  if ((options.plugins?.length ?? 0) !== 0) fail("invalid_configuration", "plugins");
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

function nextRequestId(): string {
  return crypto.randomUUID();
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
  private readAfterCommit: bigint | undefined;

  public constructor(
    private readonly client: RiffDBBetterAuthCoreClient,
    private readonly organizationId: string,
    private readonly resetModelForTesting?: (model: string) => number | Promise<number>,
  ) {}

  private observeCommit(result: { readonly commitSequence?: bigint }): void {
    if (
      result.commitSequence !== undefined &&
      (this.readAfterCommit === undefined || result.commitSequence > this.readAfterCommit)
    ) {
      this.readAfterCommit = result.commitSequence;
    }
  }

  private queryOptions(): { readonly readAfterCommit?: bigint } {
    return this.readAfterCommit === undefined ? {} : { readAfterCommit: this.readAfterCommit };
  }

  public async create(model: string, dataValue: RecordValue): Promise<Record<string, unknown>> {
    const data = asRecord(dataValue, `create ${model}`);
    if (model === "user") {
      const result = await this.client.createUser({
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        id: requiredString(data, "id", "create user"),
        name: requiredString(data, "name", "create user"),
        email: requiredString(data, "email", "create user"),
        email_verified: requiredBoolean(data, "emailVerified", "create user"),
        image: nullableString(data, "image", "create user"),
        created_at: toTimestamp(requiredDate(data, "createdAt", "create user")),
        updated_at: toTimestamp(requiredDate(data, "updatedAt", "create user")),
      });
      this.observeCommit(result);
      requireOutcome(result, "create user", "UserCreated");
      return { ...data, image: data.image ?? null };
    }
    if (model === "account") {
      const result = await this.client.createAccount({
        request_id: nextRequestId(),
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
      this.observeCommit(result);
      requireOutcome(result, "create account", "AccountCreated");
      return { ...data };
    }
    if (model === "session") {
      const token = requiredString(data, "token", "create session");
      const result = await this.client.createSession({
        request_id: nextRequestId(),
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
      this.observeCommit(result);
      requireOutcome(result, "create session", "SessionCreated");
      return { ...data };
    }
    if (model === "verification") {
      const result = await this.client.createVerification({
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        id: requiredString(data, "id", "create verification"),
        identifier: requiredString(data, "identifier", "create verification"),
        value: requiredString(data, "value", "create verification"),
        expires_at: toTimestamp(requiredDate(data, "expiresAt", "create verification")),
        created_at: toTimestamp(requiredDate(data, "createdAt", "create verification")),
        updated_at: toTimestamp(requiredDate(data, "updatedAt", "create verification")),
      });
      this.observeCommit(result);
      requireOutcome(result, "create verification", "VerificationCreated");
      return { ...data };
    }
    return fail("unsupported_model", `create ${model}`);
  }

  public async findOne(
    model: string,
    where: readonly CleanedWhere[],
    join?: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown> | null> {
    assertNoJoin(join, `findOne ${model}`);
    if (model === "user" && exactWhere(where, ["email"])) {
      const result = await this.client.findUserByEmail(
        {
          organization_id: this.organizationId,
          email: whereValue(where, "email", "findOne user"),
        },
        this.queryOptions(),
      );
      const row = (result.value as FindUserByEmailFound).users[0];
      return row === undefined ? null : mapUser(row);
    }
    if (model === "user" && exactWhere(where, ["id"])) {
      const result = await this.client.findUserById(
        {
          organization_id: this.organizationId,
          id: whereValue(where, "id", "findOne user"),
        },
        this.queryOptions(),
      );
      return result.value.outcome === "Missing" ? null : mapUser(result.value.user);
    }
    if (model === "session" && exactWhere(where, ["token"])) {
      const token = whereValue(where, "token", "findOne session");
      const result = await this.client.findSessionByToken(
        { organization_id: this.organizationId, token },
        this.queryOptions(),
      );
      const row = (result.value as FindSessionByTokenFound).sessions[0];
      return row === undefined ? null : mapSession(row);
    }
    if (model === "session" && exactWhere(where, ["id"])) {
      const result = await this.client.findSessionById(
        {
          organization_id: this.organizationId,
          id: whereValue(where, "id", "findOne session"),
        },
        this.queryOptions(),
      );
      const row = (result.value as FindSessionByIdFound).sessions[0];
      return row === undefined ? null : mapSession(row);
    }
    if (model === "account" && exactWhere(where, ["id"])) {
      const result = await this.client.findAccountById(
        {
          organization_id: this.organizationId,
          id: whereValue(where, "id", "findOne account"),
        },
        this.queryOptions(),
      );
      const row = result.value.accounts[0];
      return row === undefined ? null : mapAccount(row);
    }
    if (model === "account" && exactWhere(where, ["accountId", "providerId"])) {
      const result = await this.client.findAccountByProvider(
        {
          organization_id: this.organizationId,
          account_id: whereValue(where, "accountId", "findOne account"),
          provider_id: whereValue(where, "providerId", "findOne account"),
        },
        this.queryOptions(),
      );
      const row = result.value.accounts[0];
      return row === undefined ? null : mapAccount(row);
    }
    if (model === "verification" && exactWhere(where, ["id"])) {
      const result = await this.client.findVerificationById(
        {
          organization_id: this.organizationId,
          id: whereValue(where, "id", "findOne verification"),
        },
        this.queryOptions(),
      );
      const value: FindVerificationByIdResult = result.value;
      return value.outcome === "Missing"
        ? null
        : mapVerification(value.verification);
    }
    return fail("unsupported_call_shape", `findOne ${model}`);
  }

  public async update(
    model: string,
    where: readonly CleanedWhere[],
    updateValue: RecordValue,
  ): Promise<Record<string, unknown> | null> {
    if (model === "account" && exactWhere(where, ["id"])) {
      const update = asRecord(updateValue, "update account");
      const allowed = new Set([
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
        const found = await this.client.findAccountById(
          { organization_id: this.organizationId, id },
          this.queryOptions(),
        );
        const row = found.value.accounts[0];
        if (row === undefined) return null;
        const successor = { ...mapAccount(row), ...update };
        const updated = await this.client.updateAccount({
          request_id: nextRequestId(),
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
        this.observeCommit(updated);
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
      const allowed = new Set(["expiresAt", "ipAddress", "userAgent", "updatedAt"]);
      const fields = Object.keys(update);
      if (fields.length === 0 || fields.some((field) => !allowed.has(field))) {
        fail("unsupported_call_shape", "update session");
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = exactWhere(where, ["id"])
          ? await this.client.findSessionById(
              {
                organization_id: this.organizationId,
                id: whereValue(where, "id", "update session"),
              },
              this.queryOptions(),
            )
          : await this.client.findSessionByToken(
              {
                organization_id: this.organizationId,
                token: whereValue(where, "token", "update session"),
              },
              this.queryOptions(),
            );
        const row = result.value.sessions[0];
        if (row === undefined) return null;
        const current = mapSession(row);
        const successor = { ...current, ...update };
        const updated = await this.client.updateSession({
          request_id: nextRequestId(),
          organization_id: this.organizationId,
          user_id: row.user_id,
          session_id: row.id,
          expected_revision: row.revision,
          expires_at: toTimestamp(requiredDate(successor, "expiresAt", "update session")),
          ip_address: nullableString(successor, "ipAddress", "update session"),
          user_agent: nullableString(successor, "userAgent", "update session"),
          updated_at: toTimestamp(requiredDate(successor, "updatedAt", "update session")),
        });
        this.observeCommit(updated);
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
      const allowed = new Set(["value", "expiresAt", "updatedAt"]);
      const fields = Object.keys(update);
      if (fields.length === 0 || fields.some((field) => !allowed.has(field))) {
        fail("unsupported_call_shape", "update verification");
      }
      const identifier = whereValue(where, "identifier", "update verification");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const found = await this.client.findLatestVerification(
          { organization_id: this.organizationId, identifier },
          this.queryOptions(),
        );
        const row = found.value.verifications[0];
        if (row === undefined) return null;
        const successor = { ...mapVerification(row), ...update };
        const result = await this.client.updateVerification({
          request_id: nextRequestId(),
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
        this.observeCommit(result);
        if (result.outcome.outcome === "VerificationUpdateStale") continue;
        if (result.outcome.outcome === "VerificationUpdateMissing") return null;
        requireOutcome(result, "update verification", "VerificationUpdated");
        return successor;
      }
      return fail("declared_outcome", "update verification", "VerificationUpdateStale");
    }
    const update = asRecord(updateValue, "update user");
    const allowed = new Set(["name", "email", "emailVerified", "image", "updatedAt"]);
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
            await this.client.findUserByEmail(
              { organization_id: this.organizationId, email: initialEmail! },
              this.queryOptions(),
            )
          ).value.users[0]
        : (
            await this.client.findUserById(
              { organization_id: this.organizationId, id: userId },
              this.queryOptions(),
            )
          ).value;
      if (row === undefined || ("outcome" in row && row.outcome === "Missing")) return null;
      const resolved = "outcome" in row ? row.user : row;
      userId = resolved.user_id;
      const current = mapUser(resolved);
      const successor = { ...current, ...update };
      const result = await this.client.updateUser({
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        user_id: userId,
        expected_revision: resolved.revision,
        name: requiredString(successor, "name", "update user"),
        email: requiredString(successor, "email", "update user"),
        email_verified: requiredBoolean(successor, "emailVerified", "update user"),
        image: nullableString(successor, "image", "update user"),
        updated_at: toTimestamp(requiredDate(successor, "updatedAt", "update user")),
      });
      this.observeCommit(result);
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
    assertNoJoin(join, `findMany ${model}`);
    if (offset !== undefined && offset !== 0) fail("unsupported_call_shape", `findMany ${model}`);
    if (!Number.isInteger(limit) || limit < 1) fail("unsupported_call_shape", `findMany ${model}`);
    if (model === "account" && exactWhere(where, ["userId"]) && sortBy === undefined) {
      if (limit > 100) fail("result_bound_exceeded", "findMany account");
      const result = await this.client.findAccountsByUserId(
        {
          organization_id: this.organizationId,
          user_id: whereValue(where!, "userId", "findMany account"),
          after: null,
        },
        this.queryOptions(),
      );
      if (result.nextCursor !== undefined) fail("result_bound_exceeded", "findMany account");
      return result.value.accounts.slice(0, limit).map(mapAccount);
    }
    if (model === "session" && exactWhere(where, ["userId"]) && sortBy === undefined) {
      const result = await this.client.findSessionsByUserId(
        {
          organization_id: this.organizationId,
          user_id: whereValue(where!, "userId", "findMany session"),
          after: null,
        },
        this.queryOptions(),
      );
      if (result.nextCursor !== undefined) fail("result_bound_exceeded", "findMany session");
      return result.value.sessions.slice(0, limit).map(mapSession);
    }
    if (
      model === "session" &&
      exactWhereShape(where, [
        { field: "userId", operator: "eq" },
        { field: "expiresAt", operator: "gt" },
      ]) &&
      sortBy === undefined
    ) {
      const result = await this.client.findActiveSessionsByUserId(
        {
          organization_id: this.organizationId,
          user_id: whereValue(where!, "userId", "findMany active session"),
          expires_after: toTimestamp(
            whereDate(where!, "expiresAt", "findMany active session"),
          ),
          after: null,
        },
        this.queryOptions(),
      );
      if (result.nextCursor !== undefined) {
        fail("result_bound_exceeded", "findMany active session");
      }
      return result.value.sessions.slice(0, limit).map(mapSession);
    }
    const tokenSetShape = exactWhereShape(where, [{ field: "token", operator: "in" }]);
    const activeTokenSetShape = exactWhereShape(where, [
      { field: "token", operator: "in" },
      { field: "expiresAt", operator: "gt" },
    ]);
    if (
      model === "session" &&
      (tokenSetShape || activeTokenSetShape) &&
      sortBy === undefined
    ) {
      const tokens = whereStringSet(where!, "token", "findMany session token set");
      const cutoff = activeTokenSetShape
        ? whereDate(where!, "expiresAt", "findMany session token set")
        : undefined;
      const rows = await Promise.all(
        tokens.map(async (token) => {
          const result = await this.client.findSessionByToken(
            { organization_id: this.organizationId, token },
            this.queryOptions(),
          );
          return result.value.sessions[0];
        }),
      );
      return rows
        .filter((row) => row !== undefined)
        .filter((row) => cutoff === undefined || fromTimestamp(row.expires_at) > cutoff)
        .slice(0, limit)
        .map(mapSession);
    }
    if (
      model === "verification" &&
      exactWhere(where, ["identifier"]) &&
      sortBy?.field === "createdAt" &&
      sortBy.direction === "desc" &&
      limit === 1
    ) {
      const result = await this.client.findLatestVerification(
        {
          organization_id: this.organizationId,
          identifier: whereValue(where!, "identifier", "findMany verification"),
        },
        this.queryOptions(),
      );
      return result.value.verifications.map(mapVerification);
    }
    if (model === "verification" && exactWhere(where, ["identifier"]) && limit <= 32) {
      const result = await this.client.findVerificationsByIdentifier(
        {
          organization_id: this.organizationId,
          identifier: whereValue(where!, "identifier", "findMany verification"),
          after: null,
        },
        this.queryOptions(),
      );
      if (result.nextCursor !== undefined) fail("result_bound_exceeded", "findMany verification");
      return result.value.verifications.slice(0, limit).map(mapVerification);
    }
    return fail("unsupported_call_shape", `findMany ${model}`);
  }

  public async delete(model: string, where: readonly CleanedWhere[]): Promise<void> {
    if (model === "user" && exactWhere(where, ["id"])) {
      const result = await this.client.deleteUser({
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        user_ids: [whereValue(where, "id", "delete user")],
      });
      this.observeCommit(result);
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
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        user_id: requiredString(account, "userId", "delete account"),
        account_ids: [requiredString(account, "id", "delete account")],
      });
      this.observeCommit(result);
      if (!new Set(["AccountDeleted", "AccountMissing"]).has(result.outcome.outcome)) {
        fail("declared_outcome", "delete account", result.outcome.outcome);
      }
      return;
    }
    if (model === "verification" && exactWhere(where, ["id"])) {
      const result = await this.client.deleteVerification({
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        verification_ids: [whereValue(where, "id", "delete verification")],
      });
      this.observeCommit(result);
      if (!new Set(["VerificationDeleted", "VerificationMissing"]).has(result.outcome.outcome)) {
        fail("declared_outcome", "delete verification", result.outcome.outcome);
      }
      return;
    }
    if (model === "verification" && exactWhere(where, ["identifier"])) {
      const rows = await this.findMany("verification", where, 32);
      if (rows.length === 0) return;
      const result = await this.client.deleteVerification({
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        verification_ids: rows.map((row) =>
          requiredString(row, "id", "delete verification by identifier"),
        ),
      });
      this.observeCommit(result);
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
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        user_id: requiredString(session, "userId", "delete session"),
        session_ids: [requiredString(session, "id", "delete session")],
      });
      this.observeCommit(result);
      if (!new Set(["SessionDeleted", "SessionMissing"]).has(result.outcome.outcome)) {
        fail("declared_outcome", "delete session", result.outcome.outcome);
      }
      return;
    }
    fail("unsupported_call_shape", `delete ${model}`);
  }

  public async deleteMany(model: string, where: readonly CleanedWhere[]): Promise<number> {
    if (where.length === 0 && this.resetModelForTesting !== undefined) {
      return this.resetModelForTesting(model);
    }
    if (model === "session" && exactWhere(where, ["userId"])) {
      const rows = await this.findMany(model, where, 32);
      if (rows.length === 0) return 0;
      const result = await this.client.deleteSession({
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        user_id: whereValue(where, "userId", "deleteMany session"),
        session_ids: rows.map((row) => requiredString(row, "id", "deleteMany session")),
      });
      this.observeCommit(result);
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
          request_id: nextRequestId(),
          organization_id: this.organizationId,
          user_id: userId,
          session_ids: sessionIds,
        });
        this.observeCommit(result);
        requireOutcome(result, "deleteMany session token set", "SessionDeleted");
      }
      return rows.length;
    }
    if (model === "account" && exactWhere(where, ["userId"])) {
      const rows = await this.findMany(model, where, 100);
      if (rows.length === 0) return 0;
      if (rows.length > 32) fail("result_bound_exceeded", "deleteMany account");
      const result = await this.client.deleteAccount({
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        user_id: whereValue(where, "userId", "deleteMany account"),
        account_ids: rows.map((row) => requiredString(row, "id", "deleteMany account")),
      });
      this.observeCommit(result);
      requireOutcome(result, "deleteMany account", "AccountDeleted");
      return rows.length;
    }
    if (
      model === "verification" &&
      exactWhereShape(where, [{ field: "expiresAt", operator: "lt" }])
    ) {
      const result = await this.client.findExpiredVerificationIds(
        {
          organization_id: this.organizationId,
          expires_before: toTimestamp(
            whereDate(where, "expiresAt", "deleteMany expired verification"),
          ),
          after: null,
        },
        this.queryOptions(),
      );
      if (result.nextCursor !== undefined) {
        fail("result_bound_exceeded", "deleteMany expired verification");
      }
      const ids = result.value.verifications.map((row) => row.verification_id);
      if (ids.length === 0) return 0;
      const deleted = await this.client.deleteVerification({
        request_id: nextRequestId(),
        organization_id: this.organizationId,
        verification_ids: ids,
      });
      this.observeCommit(deleted);
      requireOutcome(deleted, "deleteMany expired verification", "VerificationDeleted");
      return ids.length;
    }
    if (model !== "verification" || !exactWhere(where, ["identifier"])) {
      return fail("unsupported_call_shape", `deleteMany ${model}`);
    }
    const rows = await this.findMany("verification", where, 32);
    if (rows.length === 0) return 0;
    const result = await this.client.consumeVerificationSet({
      request_id: nextRequestId(),
      organization_id: this.organizationId,
      verification_ids: rows.map((row) => requiredString(row, "id", "deleteMany verification")),
    });
    this.observeCommit(result);
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
    const row = await this.findOne(model, where);
    if (row === null) return null;
    const result = await this.client.consumeVerificationSet({
      request_id: nextRequestId(),
      organization_id: this.organizationId,
      verification_ids: [requiredString(row, "id", "consumeOne verification")],
    });
    this.observeCommit(result);
    if (result.outcome.outcome === "VerificationConsumeMissing") return null;
    requireOutcome(result, "consumeOne verification", "VerificationSetConsumed");
    return row;
  }

  public async updateMany(
    model: string,
    where: readonly CleanedWhere[],
    updateValue: RecordValue,
  ): Promise<number> {
    if (model !== "account" || !exactWhere(where, ["userId", "providerId"])) {
      return fail("unsupported_call_shape", `updateMany ${model}`);
    }
    const update = asRecord(updateValue, "updateMany account");
    const updateFields = Object.keys(update).sort();
    if (
      JSON.stringify(updateFields) !== JSON.stringify(["password", "updatedAt"]) &&
      JSON.stringify(updateFields) !== JSON.stringify(["password"])
    ) {
      fail("unsupported_call_shape", "updateMany account");
    }
    const userId = whereValue(where, "userId", "updateMany account");
    const providerId = whereValue(where, "providerId", "updateMany account");
    const userClause = where.find((clause) => clause.field === "userId");
    if (userClause === undefined) fail("unsupported_call_shape", "updateMany account");
    const accounts = (await this.findMany("account", [userClause], 100)).filter(
      (account) => account.providerId === providerId,
    );
    if (accounts.length === 0) return 0;
    if (accounts.length > 8) fail("result_bound_exceeded", "updateMany account");
    const updatedAt = requiredDate(update, "updatedAt", "updateMany account");
    const result = await this.client.updateAccountPasswords({
      request_id: nextRequestId(),
      organization_id: this.organizationId,
      user_id: userId,
      updates: accounts.map((account) => ({
        organization_id: this.organizationId,
        user_id: userId,
        account_id: requiredString(account, "id", "updateMany account"),
        provider_id: providerId,
        password: nullableString(update, "password", "updateMany account"),
        updated_at: toTimestamp(updatedAt),
      })),
    });
    this.observeCommit(result);
    requireOutcome(result, "updateMany account", "AccountPasswordsUpdated");
    return accounts.length;
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
      request_id: nextRequestId(),
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
    this.observeCommit(result);
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
      request_id: nextRequestId(),
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
    this.observeCommit(result);
    requireOutcome(result, "transaction OAuth user", "OAuthUserGraphCreated");
  }

  public async commitVerificationConsume(rows: readonly RecordValue[]): Promise<void> {
    if (rows.length < 1 || rows.length > 32) {
      fail("unsupported_transaction_shape", "transaction verification consume");
    }
    const result = await this.client.consumeVerificationSet({
      request_id: nextRequestId(),
      organization_id: this.organizationId,
      verification_ids: rows.map((row) =>
        requiredString(row, "id", "transaction verification consume"),
      ),
    });
    this.observeCommit(result);
    requireOutcome(result, "transaction verification consume", "VerificationSetConsumed");
  }
}

interface DeferredCreate {
  readonly model: string;
  readonly data: Record<string, unknown>;
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
  private consumedVerificationId: string | undefined;
  private verificationDeleteRows: Record<string, unknown>[] | undefined;

  public constructor(private readonly dispatcher: CoreDispatcher) {}

  public customAdapter(): CustomAdapter {
    return {
      create: genericCreate(async ({ model, data }) => {
        const copied = { ...data };
        this.creates.push({ model, data: copied });
        return copied;
      }),
      findOne: genericFindOne(async ({ model, where, join }) =>
        this.dispatcher.findOne(model, where, join)),
      findMany: genericFindMany(async ({ model, where, limit, sortBy, offset, join }) =>
        this.dispatcher.findMany(model, where, limit, sortBy, offset, join)),
      count: async () => fail("unsupported_transaction_shape", "transaction count"),
      update: async () => fail("unsupported_transaction_shape", "transaction update"),
      updateMany: async () => fail("unsupported_transaction_shape", "transaction updateMany"),
      delete: async () => fail("unsupported_transaction_shape", "transaction delete"),
      deleteMany: async ({ model, where }) => {
        if (model !== "verification" || !exactWhere(where, ["identifier"])) {
          return fail("unsupported_transaction_shape", "transaction deleteMany");
        }
        this.verificationDeleteRows = await this.dispatcher.findMany("verification", where, 32);
        return this.verificationDeleteRows.length;
      },
      consumeOne: genericConsumeOne(async ({ model, where }) => {
        if (model !== "verification" || !exactWhere(where, ["id"])) {
          return fail("unsupported_transaction_shape", "transaction consumeOne");
        }
        const row = await this.dispatcher.findOne(model, where);
        if (row === null) return null;
        this.consumedVerificationId = requiredString(
          row,
          "id",
          "transaction consumeOne verification",
        );
        return row;
      }),
      incrementOne: async () => fail("unsupported_transaction_shape", "transaction incrementOne"),
    };
  }

  public async commit(): Promise<void> {
    const hasVerificationMutation =
      this.consumedVerificationId !== undefined || this.verificationDeleteRows !== undefined;
    if (this.creates.length > 0 && hasVerificationMutation) {
      fail("unsupported_transaction_shape", "mixed transaction");
    }
    if (this.creates.length > 0) {
      if (this.creates.length === 2) {
        await this.dispatcher.commitOAuthUser(this.creates);
      } else {
        await this.dispatcher.commitSignup(this.creates);
      }
      return;
    }
    if (hasVerificationMutation) {
      if (this.consumedVerificationId === undefined || this.verificationDeleteRows === undefined) {
        fail("unsupported_transaction_shape", "transaction verification consume");
      }
      if (
        !this.verificationDeleteRows.some(
          (row) => row.id === this.consumedVerificationId,
        )
      ) {
        fail("unsupported_transaction_shape", "transaction verification consume");
      }
      await this.dispatcher.commitVerificationConsume(this.verificationDeleteRows);
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
    count: async ({ model }) => fail("unsupported_call_shape", `count ${model}`),
    update: genericUpdate(async ({ model, where, update }) =>
      dispatcher.update(model, where, update)),
    updateMany: async ({ model, where, update }) => dispatcher.updateMany(model, where, update),
    delete: async ({ model, where }) => dispatcher.delete(model, where),
    deleteMany: async ({ model, where }) => dispatcher.deleteMany(model, where),
    consumeOne: genericConsumeOne(async ({ model, where }) =>
      dispatcher.consumeOne(model, where)),
    incrementOne: async ({ model }) => fail("unsupported_call_shape", `incrementOne ${model}`),
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
  validateConfiguration(config);
  return (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> => {
    const dispatcher = new CoreDispatcher(
      config.client,
      config.organizationId,
      config.resetModelForTesting,
    );
    const factory = createAdapterFactory({
      config: {
        ...BASE_FACTORY_CONFIG,
        debugLogs: config.debugLogs ?? false,
        transaction: async (callback) => {
          const recorder = new TransactionRecorder(dispatcher);
          const transactionFactory = createAdapterFactory({
            config: {
              ...BASE_FACTORY_CONFIG,
              debugLogs: false,
              transaction: false,
            },
            adapter: ({ options: transactionOptions, schema }) => {
              validateResolvedSchema(transactionOptions, schema);
              return recorder.customAdapter();
            },
          });
          const transactionAdapter = transactionFactory(options);
          const result = await callback(transactionAdapter);
          await recorder.commit();
          return result;
        },
      },
      adapter: ({ options: resolvedOptions, schema }) => {
        validateResolvedSchema(resolvedOptions, schema);
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
    client: new RiffDBBetterAuthCoreClient(transport, commandAttemptBudget),
    organizationId: config.organizationId,
    ...(config.debugLogs === undefined ? {} : { debugLogs: config.debugLogs }),
  });
}
