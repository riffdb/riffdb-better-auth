import type {
  ApplicationTransport,
  CommandRequest,
  NamedQueryRequest,
  QueryOptions,
  TypedCommandResult,
  TypedQueryResult,
} from "../../src/generated/client.js";

type Timestamp = { readonly seconds: bigint; readonly nanos: number };

interface UserRow {
  readonly organization_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly image: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly revision: bigint;
}

interface AccountRow {
  readonly organization_id: string;
  readonly id: string;
  readonly user_id: string;
  readonly account_id: string;
  readonly provider_id: string;
  readonly access_token: string | null;
  readonly refresh_token: string | null;
  readonly access_token_expires_at: Timestamp | null;
  readonly refresh_token_expires_at: Timestamp | null;
  readonly scope: string | null;
  readonly id_token: string | null;
  password: string | null;
  readonly created_at: Timestamp;
  updated_at: Timestamp;
  readonly revision: bigint;
}

interface SessionRow {
  readonly organization_id: string;
  readonly id: string;
  readonly user_id: string;
  readonly token: string;
  readonly expires_at: Timestamp;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly revision: bigint;
}

interface VerificationRow {
  readonly organization_id: string;
  readonly verification_id: string;
  readonly identifier: string;
  readonly value: string;
  readonly expires_at: Timestamp;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly revision: bigint;
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid fake command input");
  }
  return value as Record<string, unknown>;
}

function stringField(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`invalid fake string field: ${field}`);
  return value;
}

function booleanField(record: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw new Error(`invalid fake boolean field: ${field}`);
  return value;
}

function bigintField(record: Readonly<Record<string, unknown>>, field: string): bigint {
  const value = record[field];
  if (typeof value !== "bigint") throw new Error(`invalid fake bigint field: ${field}`);
  return value;
}

function optionalNumberField(
  record: Readonly<Record<string, unknown>>,
  field: string,
  fallback: number,
): number {
  const value = record[field];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid fake number field: ${field}`);
  }
  return value;
}

function optionalBigintField(
  record: Readonly<Record<string, unknown>>,
  field: string,
  fallback: bigint,
): bigint {
  const value = record[field];
  if (value === undefined) return fallback;
  if (typeof value !== "bigint") throw new Error(`invalid fake bigint field: ${field}`);
  return value;
}

function timestampField(record: Readonly<Record<string, unknown>>, field: string): Timestamp {
  const value = inputRecord(record[field]);
  if (typeof value.seconds !== "bigint" || typeof value.nanos !== "number") {
    throw new Error(`invalid fake timestamp field: ${field}`);
  }
  return { seconds: value.seconds, nanos: value.nanos };
}

function nullableStringField(
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`invalid fake nullable string field: ${field}`);
  return value;
}

function nullableTimestampField(
  record: Readonly<Record<string, unknown>>,
  field: string,
): Timestamp | null {
  return record[field] === null ? null : timestampField(record, field);
}

function stringListField(record: Readonly<Record<string, unknown>>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid fake string-list field: ${field}`);
  }
  return value as string[];
}

function compareTimestamp(left: Timestamp, right: Timestamp): number {
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
  return left.nanos - right.nanos;
}

export class FakeRiffDBApplicationTransport implements ApplicationTransport {
  private readonly users: UserRow[] = [];
  private readonly accounts: AccountRow[] = [];
  private readonly sessions: SessionRow[] = [];
  private readonly verifications: VerificationRow[] = [];
  private sequence = 0n;
  public readonly commandLog: string[] = [];

  public resetModel(model: string): number {
    const table =
      model === "user"
        ? this.users
        : model === "account"
          ? this.accounts
          : model === "session"
            ? this.sessions
            : model === "verification"
              ? this.verifications
              : undefined;
    if (table === undefined) throw new Error(`unknown fake model: ${model}`);
    const count = table.length;
    table.splice(0, table.length);
    return count;
  }

  public async executeNamedQuery<P, R>(
    request: NamedQueryRequest<P, R>,
    _options?: QueryOptions,
  ): Promise<TypedQueryResult<R>> {
    const parameters = inputRecord(request.parameters);
    const organizationId = stringField(parameters, "organization_id");
    let value: unknown;
    switch (request.queryName) {
      case "AdminUsersAllEmailAsc":
      case "AdminUsersContainsAsc":
      case "AdminUsersContainsDesc":
      case "AdminUsersStartsWithAsc":
      case "AdminUsersStartsWithDesc":
      case "AdminUsersEndsWithAsc":
      case "AdminUsersEndsWithDesc":
      case "AdminUsersEmailContainsCreatedDesc":
      case "AdminUsersEmailContainsImageAsc": {
        const needle = parameters.needle;
        const userId = parameters.user_id;
        if (needle !== undefined && typeof needle !== "string") {
          throw new Error("invalid fake admin needle");
        }
        if (userId !== undefined && userId !== null && typeof userId !== "string") {
          throw new Error("invalid fake admin user id");
        }
        let users = this.users.filter(
          (row) =>
            row.organization_id === organizationId &&
            (userId === undefined || userId === null || row.user_id === userId),
        );
        if (typeof needle === "string") {
          users = users.filter((row) => {
            if (request.queryName.includes("StartsWith")) return row.email.startsWith(needle);
            if (request.queryName.includes("EndsWith")) return row.email.endsWith(needle);
            return row.email.includes(needle);
          });
        }
        const total = BigInt(users.length);
        users.sort((left, right) => {
          if (request.queryName === "AdminUsersEmailContainsCreatedDesc") {
            const compared = compareTimestamp(right.created_at, left.created_at);
            return compared === 0 ? left.user_id.localeCompare(right.user_id) : compared;
          }
          if (request.queryName === "AdminUsersEmailContainsImageAsc") {
            if (left.image === null && right.image !== null) return 1;
            if (left.image !== null && right.image === null) return -1;
            const compared = (left.image ?? "").localeCompare(right.image ?? "");
            return compared === 0 ? left.user_id.localeCompare(right.user_id) : compared;
          }
          const compared = left.email.localeCompare(right.email);
          const ordered = request.queryName.endsWith("Desc") ? -compared : compared;
          return ordered === 0 ? left.user_id.localeCompare(right.user_id) : ordered;
        });
        const offset = Number(optionalBigintField(parameters, "offset", 0n));
        const limit = optionalNumberField(parameters, "limit", 50);
        value = { outcome: "Found", users: users.slice(offset, offset + limit), total: { value: total } };
        break;
      }
      case "FindUserByEmail": {
        const email = stringField(parameters, "email");
        value = {
          outcome: "Found",
          users: this.users.filter(
            (row) => row.organization_id === organizationId && row.email === email,
          ),
        };
        break;
      }
      case "FindUserById": {
        const id = stringField(parameters, "id");
        const user = this.users.find(
          (row) => row.organization_id === organizationId && row.user_id === id,
        );
        value = user === undefined ? { outcome: "Missing" } : { outcome: "Found", user };
        break;
      }
      case "FindSessionByToken": {
        const token = stringField(parameters, "token");
        value = {
          outcome: "Found",
          sessions: this.sessions
            .filter(
              (row) => row.organization_id === organizationId && row.token === token,
            )
            .map(({ organization_id: _organizationId, ...row }) => row),
        };
        break;
      }
      case "FindSessionById": {
        const id = stringField(parameters, "id");
        value = {
          outcome: "Found",
          sessions: this.sessions
            .filter((row) => row.organization_id === organizationId && row.id === id)
            .map(({ organization_id: _organizationId, ...row }) => row),
        };
        break;
      }
      case "FindSessionsByUserId": {
        const userId = stringField(parameters, "user_id");
        value = {
          outcome: "Found",
          sessions: this.sessions
            .filter(
              (row) => row.organization_id === organizationId && row.user_id === userId,
            )
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(({ organization_id: _organizationId, ...row }) => row),
        };
        break;
      }
      case "FindActiveSessionsByUserId": {
        const userId = stringField(parameters, "user_id");
        const expiresAfter = timestampField(parameters, "expires_after");
        value = {
          outcome: "Found",
          sessions: this.sessions
            .filter(
              (row) =>
                row.organization_id === organizationId &&
                row.user_id === userId &&
                compareTimestamp(row.expires_at, expiresAfter) > 0,
            )
            .sort((left, right) => {
              const expiry = compareTimestamp(left.expires_at, right.expires_at);
              return expiry !== 0 ? expiry : left.id.localeCompare(right.id);
            })
            .map(({ organization_id: _organizationId, ...row }) => row),
        };
        break;
      }
      case "FindAccountsByUserId": {
        const userId = stringField(parameters, "user_id");
        value = {
          outcome: "Found",
          accounts: this.accounts
            .filter(
              (row) => row.organization_id === organizationId && row.user_id === userId,
            )
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(({ organization_id: _organizationId, ...row }) => row),
        };
        break;
      }
      case "FindAccountById": {
        const id = stringField(parameters, "id");
        value = {
          outcome: "Found",
          accounts: this.accounts
            .filter((row) => row.organization_id === organizationId && row.id === id)
            .map(({ organization_id: _organizationId, ...row }) => row),
        };
        break;
      }
      case "FindAccountByProvider": {
        const accountId = stringField(parameters, "account_id");
        const providerId = stringField(parameters, "provider_id");
        value = {
          outcome: "Found",
          accounts: this.accounts
            .filter(
              (row) =>
                row.organization_id === organizationId &&
                row.account_id === accountId &&
                row.provider_id === providerId,
            )
            .map(({ organization_id: _organizationId, ...row }) => row),
        };
        break;
      }
      case "FindLatestVerification": {
        const identifier = stringField(parameters, "identifier");
        value = {
          outcome: "Found",
          verifications: this.verifications
            .filter(
              (row) =>
                row.organization_id === organizationId && row.identifier === identifier,
            )
            .sort((left, right) => {
              const seconds = Number(right.created_at.seconds - left.created_at.seconds);
              return seconds !== 0
                ? seconds
                : right.verification_id.localeCompare(left.verification_id);
            })
            .slice(0, 1)
            .map(({ organization_id: _organizationId, ...row }) => row),
        };
        break;
      }
      case "FindVerificationById": {
        const id = stringField(parameters, "id");
        const verification = this.verifications.find(
          (row) => row.organization_id === organizationId && row.verification_id === id,
        );
        value =
          verification === undefined
            ? { outcome: "Missing" }
            : {
                outcome: "Found",
                verification: (({ organization_id: _organizationId, ...row }) => row)(
                  verification,
                ),
              };
        break;
      }
      case "FindVerificationsByIdentifier": {
        const identifier = stringField(parameters, "identifier");
        value = {
          outcome: "Found",
          verifications: this.verifications
            .filter(
              (row) =>
                row.organization_id === organizationId && row.identifier === identifier,
            )
            .sort((left, right) => right.verification_id.localeCompare(left.verification_id))
            .map(({ organization_id: _organizationId, ...row }) => row),
        };
        break;
      }
      case "FindExpiredVerificationIds": {
        const expiresBefore = timestampField(parameters, "expires_before");
        value = {
          outcome: "Found",
          verifications: this.verifications
            .filter(
              (row) =>
                row.organization_id === organizationId &&
                compareTimestamp(row.expires_at, expiresBefore) < 0,
            )
            .sort((left, right) => {
              const expiry = compareTimestamp(left.expires_at, right.expires_at);
              return expiry !== 0
                ? expiry
                : left.verification_id.localeCompare(right.verification_id);
            })
            .map((row) => ({ verification_id: row.verification_id })),
        };
        break;
      }
      default:
        throw new Error(`unsupported fake query: ${request.queryName}`);
    }
    return {
      identity: {
        contractLineage: request.contractLineage,
        contractVersion: request.contractVersion,
        contractBundleHash: request.contractBundleHash,
        moduleHash: request.moduleHash,
        queryName: request.queryName,
        planHash: request.planHash,
      },
      value: value as R,
      applicationHead: this.sequence,
    };
  }

  public async executeCommand<I, R>(
    request: CommandRequest<I, R>,
    _attemptBudget: number,
  ): Promise<TypedCommandResult<R>> {
    const input = inputRecord(request.input);
    this.commandLog.push(request.commandName);
    let outcome: Record<string, unknown>;
    switch (request.commandName) {
      case "CreateUser":
        outcome = { outcome: this.createUser(input) };
        break;
      case "CreateAccount":
        outcome = { outcome: this.createAccount(input) };
        break;
      case "CreateSession":
        outcome = { outcome: this.createSession(input) };
        break;
      case "CreateVerification":
        outcome = { outcome: this.createVerification(input) };
        break;
      case "CreateSignupGraph":
        outcome = { outcome: this.createSignupGraph(input) };
        break;
      case "CreateOAuthUserGraph":
        outcome = { outcome: this.createOAuthUserGraph(input) };
        break;
      case "UpdateUser":
        outcome = { outcome: this.updateUser(input) };
        break;
      case "UpdateSession":
        outcome = { outcome: this.updateSession(input) };
        break;
      case "UpdateAccount":
        outcome = { outcome: this.updateAccount(input) };
        break;
      case "UpdateVerification":
        outcome = { outcome: this.updateVerification(input) };
        break;
      case "DeleteSession":
        outcome = { outcome: this.deleteSessions(input) };
        break;
      case "DeleteAccount":
        outcome = { outcome: this.deleteAccounts(input) };
        break;
      case "DeleteVerification":
        outcome = {
          outcome: this.deleteVerifications(input, "VerificationDeleted", "VerificationMissing"),
        };
        break;
      case "DeleteUser":
        outcome = { outcome: this.deleteUser(input) };
        break;
      case "ConsumeVerificationSet":
        outcome = {
          outcome: this.deleteVerifications(
            input,
            "VerificationSetConsumed",
            "VerificationConsumeMissing",
          ),
        };
        break;
      case "UpdateAccountPasswords":
        outcome = { outcome: this.updateAccountPasswords(input) };
        break;
      default:
        throw new Error(`unsupported fake command: ${request.commandName}`);
    }
    this.sequence += 1n;
    return {
      outcome: outcome as R,
      commitSequence: this.sequence,
      contractVersion: request.contractVersion,
      planHash: request.planHash,
      replayed: false,
    };
  }

  private createUser(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const id = stringField(input, "id");
    const email = stringField(input, "email");
    if (
      this.users.some(
        (row) =>
          row.organization_id === organizationId &&
          (row.user_id === id || row.email === email),
      )
    ) {
      return "UserAlreadyExists";
    }
    this.users.push({
      organization_id: organizationId,
      user_id: id,
      name: stringField(input, "name"),
      email,
      email_verified: booleanField(input, "email_verified"),
      image: nullableStringField(input, "image"),
      created_at: timestampField(input, "created_at"),
      updated_at: timestampField(input, "updated_at"),
      revision: 1n,
    });
    return "UserCreated";
  }

  private updateUser(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const userId = stringField(input, "user_id");
    const index = this.users.findIndex(
      (row) => row.organization_id === organizationId && row.user_id === userId,
    );
    if (index < 0) return "UserUpdateMissing";
    const current = this.users[index]!;
    if (current.revision !== bigintField(input, "expected_revision")) return "UserUpdateStale";
    this.users[index] = {
      ...current,
      name: stringField(input, "name"),
      email: stringField(input, "email"),
      email_verified: booleanField(input, "email_verified"),
      image: nullableStringField(input, "image"),
      updated_at: timestampField(input, "updated_at"),
      revision: current.revision + 1n,
    };
    return "UserUpdated";
  }

  private createAccount(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const userId = stringField(input, "user_id");
    if (
      !this.users.some(
        (row) => row.organization_id === organizationId && row.user_id === userId,
      )
    ) {
      return "AccountUserMissing";
    }
    const id = stringField(input, "id");
    const accountId = stringField(input, "account_id");
    const providerId = stringField(input, "provider_id");
    if (
      this.accounts.some(
        (row) =>
          row.organization_id === organizationId &&
          (row.id === id || (row.account_id === accountId && row.provider_id === providerId)),
      )
    ) {
      return "AccountAlreadyExists";
    }
    this.accounts.push({
      organization_id: organizationId,
      id,
      user_id: userId,
      account_id: accountId,
      provider_id: providerId,
      access_token: nullableStringField(input, "access_token"),
      refresh_token: nullableStringField(input, "refresh_token"),
      access_token_expires_at: nullableTimestampField(input, "access_token_expires_at"),
      refresh_token_expires_at: nullableTimestampField(input, "refresh_token_expires_at"),
      scope: nullableStringField(input, "scope"),
      id_token: nullableStringField(input, "id_token"),
      password: nullableStringField(input, "password"),
      created_at: timestampField(input, "created_at"),
      updated_at: timestampField(input, "updated_at"),
      revision: 1n,
    });
    return "AccountCreated";
  }

  private createSession(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const userId = stringField(input, "user_id");
    if (
      !this.users.some(
        (row) => row.organization_id === organizationId && row.user_id === userId,
      )
    ) {
      return "SessionUserMissing";
    }
    const id = stringField(input, "id");
    const token = stringField(input, "token");
    if (
      this.sessions.some(
        (row) =>
          row.organization_id === organizationId && (row.id === id || row.token === token),
      )
    ) {
      return "SessionAlreadyExists";
    }
    this.sessions.push({
      organization_id: organizationId,
      id,
      user_id: userId,
      token,
      expires_at: timestampField(input, "expires_at"),
      ip_address: nullableStringField(input, "ip_address"),
      user_agent: nullableStringField(input, "user_agent"),
      created_at: timestampField(input, "created_at"),
      updated_at: timestampField(input, "updated_at"),
      revision: 1n,
    });
    return "SessionCreated";
  }

  private updateSession(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const userId = stringField(input, "user_id");
    const sessionId = stringField(input, "session_id");
    const index = this.sessions.findIndex(
      (row) =>
        row.organization_id === organizationId &&
        row.user_id === userId &&
        row.id === sessionId,
    );
    if (index < 0) return "SessionUpdateMissing";
    const current = this.sessions[index]!;
    if (current.revision !== bigintField(input, "expected_revision")) {
      return "SessionUpdateStale";
    }
    this.sessions[index] = {
      ...current,
      expires_at: timestampField(input, "expires_at"),
      ip_address: nullableStringField(input, "ip_address"),
      user_agent: nullableStringField(input, "user_agent"),
      updated_at: timestampField(input, "updated_at"),
      revision: current.revision + 1n,
    };
    return "SessionUpdated";
  }

  private createVerification(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const id = stringField(input, "id");
    if (
      this.verifications.some(
        (row) => row.organization_id === organizationId && row.verification_id === id,
      )
    ) {
      return "VerificationAlreadyExists";
    }
    this.verifications.push({
      organization_id: organizationId,
      verification_id: id,
      identifier: stringField(input, "identifier"),
      value: stringField(input, "value"),
      expires_at: timestampField(input, "expires_at"),
      created_at: timestampField(input, "created_at"),
      updated_at: timestampField(input, "updated_at"),
      revision: 1n,
    });
    return "VerificationCreated";
  }

  private updateVerification(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const verificationId = stringField(input, "verification_id");
    const index = this.verifications.findIndex(
      (row) =>
        row.organization_id === organizationId && row.verification_id === verificationId,
    );
    if (index < 0) return "VerificationUpdateMissing";
    const current = this.verifications[index]!;
    if (current.revision !== bigintField(input, "expected_revision")) {
      return "VerificationUpdateStale";
    }
    this.verifications[index] = {
      ...current,
      value: stringField(input, "value"),
      expires_at: timestampField(input, "expires_at"),
      updated_at: timestampField(input, "updated_at"),
      revision: current.revision + 1n,
    };
    return "VerificationUpdated";
  }

  private createSignupGraph(input: Readonly<Record<string, unknown>>): string {
    const userInput = {
      organization_id: input.organization_id,
      id: input.user_id,
      name: input.user_name,
      email: input.user_email,
      email_verified: input.user_email_verified,
      image: input.user_image,
      created_at: input.user_created_at,
      updated_at: input.user_updated_at,
    };
    const accountInput = {
      organization_id: input.organization_id,
      user_id: input.user_id,
      id: input.account_id,
      account_id: input.external_account_id,
      provider_id: input.provider_id,
      access_token: null,
      refresh_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      scope: null,
      id_token: null,
      password: input.account_password,
      created_at: input.account_created_at,
      updated_at: input.account_updated_at,
    };
    const sessionInput = {
      organization_id: input.organization_id,
      user_id: input.user_id,
      id: input.session_id,
      token: input.session_token,
      expires_at: input.session_expires_at,
      ip_address: input.session_ip_address,
      user_agent: input.session_user_agent,
      created_at: input.session_created_at,
      updated_at: input.session_updated_at,
    };
    const organizationId = stringField(userInput, "organization_id");
    const userId = stringField(userInput, "id");
    const email = stringField(userInput, "email");
    if (
      this.users.some(
        (row) =>
          row.organization_id === organizationId &&
          (row.user_id === userId || row.email === email),
      )
    ) {
      return "SignupUserExists";
    }
    if (
      this.accounts.some(
        (row) =>
          row.organization_id === organizationId &&
          (row.id === accountInput.id ||
            (row.account_id === accountInput.account_id &&
              row.provider_id === accountInput.provider_id)),
      )
    ) {
      return "SignupAccountExists";
    }
    if (
      this.sessions.some(
        (row) =>
          row.organization_id === organizationId &&
          (row.id === sessionInput.id || row.token === sessionInput.token),
      )
    ) {
      return "SignupSessionExists";
    }
    if (this.createUser(userInput) !== "UserCreated") throw new Error("fake signup user");
    if (this.createAccount(accountInput) !== "AccountCreated") throw new Error("fake signup account");
    if (this.createSession(sessionInput) !== "SessionCreated") throw new Error("fake signup session");
    return "SignupGraphCreated";
  }

  private createOAuthUserGraph(input: Readonly<Record<string, unknown>>): string {
    const userInput = {
      organization_id: input.organization_id,
      id: input.user_id,
      name: input.user_name,
      email: input.user_email,
      email_verified: input.user_email_verified,
      image: input.user_image,
      created_at: input.user_created_at,
      updated_at: input.user_updated_at,
    };
    const accountInput = {
      organization_id: input.organization_id,
      user_id: input.user_id,
      id: input.account_id,
      account_id: input.external_account_id,
      provider_id: input.provider_id,
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      access_token_expires_at: input.access_token_expires_at,
      refresh_token_expires_at: input.refresh_token_expires_at,
      scope: input.scope,
      id_token: input.id_token,
      password: input.password,
      created_at: input.account_created_at,
      updated_at: input.account_updated_at,
    };
    const organizationId = stringField(userInput, "organization_id");
    const userId = stringField(userInput, "id");
    const email = stringField(userInput, "email");
    if (
      this.users.some(
        (row) =>
          row.organization_id === organizationId &&
          (row.user_id === userId || row.email === email),
      )
    ) {
      return "OAuthUserExists";
    }
    if (
      this.accounts.some(
        (row) =>
          row.organization_id === organizationId &&
          (row.id === accountInput.id ||
            (row.account_id === accountInput.account_id &&
              row.provider_id === accountInput.provider_id)),
      )
    ) {
      return "OAuthAccountExists";
    }
    if (this.createUser(userInput) !== "UserCreated") throw new Error("fake OAuth user");
    if (this.createAccount(accountInput) !== "AccountCreated") {
      throw new Error("fake OAuth account");
    }
    return "OAuthUserGraphCreated";
  }

  private updateAccount(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const userId = stringField(input, "user_id");
    const accountId = stringField(input, "account_id");
    const index = this.accounts.findIndex(
      (row) =>
        row.organization_id === organizationId &&
        row.user_id === userId &&
        row.id === accountId,
    );
    if (index < 0) return "AccountUpdateMissing";
    const current = this.accounts[index]!;
    if (current.revision !== bigintField(input, "expected_revision")) {
      return "AccountUpdateStale";
    }
    this.accounts[index] = {
      ...current,
      account_id: stringField(input, "external_account_id"),
      provider_id: stringField(input, "provider_id"),
      access_token: nullableStringField(input, "access_token"),
      refresh_token: nullableStringField(input, "refresh_token"),
      access_token_expires_at: nullableTimestampField(input, "access_token_expires_at"),
      refresh_token_expires_at: nullableTimestampField(input, "refresh_token_expires_at"),
      scope: nullableStringField(input, "scope"),
      id_token: nullableStringField(input, "id_token"),
      password: nullableStringField(input, "password"),
      updated_at: timestampField(input, "updated_at"),
      revision: current.revision + 1n,
    };
    return "AccountUpdated";
  }

  private deleteUser(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const ids = stringListField(input, "user_ids");
    const userId = ids[0]!;
    const userIndex = this.users.findIndex(
      (row) => row.organization_id === organizationId && row.user_id === userId,
    );
    if (userIndex < 0) return "DeleteUserMissing";
    const accountCount = this.accounts.filter(
      (row) => row.organization_id === organizationId && row.user_id === userId,
    ).length;
    const sessionCount = this.sessions.filter(
      (row) => row.organization_id === organizationId && row.user_id === userId,
    ).length;
    if (accountCount > 32 || sessionCount > 32) return "DeleteUserCascadeLimitExceeded";
    for (let index = this.accounts.length - 1; index >= 0; index -= 1) {
      const row = this.accounts[index]!;
      if (row.organization_id === organizationId && row.user_id === userId) {
        this.accounts.splice(index, 1);
      }
    }
    for (let index = this.sessions.length - 1; index >= 0; index -= 1) {
      const row = this.sessions[index]!;
      if (row.organization_id === organizationId && row.user_id === userId) {
        this.sessions.splice(index, 1);
      }
    }
    this.users.splice(userIndex, 1);
    return "UserDeleted";
  }

  private deleteSessions(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const userId = stringField(input, "user_id");
    const ids = stringListField(input, "session_ids");
    if (
      ids.some(
        (id) =>
          !this.sessions.some(
            (row) =>
              row.organization_id === organizationId && row.user_id === userId && row.id === id,
          ),
      )
    ) {
      return "SessionMissing";
    }
    for (const id of ids) {
      const index = this.sessions.findIndex(
        (row) =>
          row.organization_id === organizationId && row.user_id === userId && row.id === id,
      );
      this.sessions.splice(index, 1);
    }
    return "SessionDeleted";
  }

  private deleteAccounts(input: Readonly<Record<string, unknown>>): string {
    const organizationId = stringField(input, "organization_id");
    const userId = stringField(input, "user_id");
    const ids = stringListField(input, "account_ids");
    if (
      ids.some(
        (id) =>
          !this.accounts.some(
            (row) =>
              row.organization_id === organizationId && row.user_id === userId && row.id === id,
          ),
      )
    ) {
      return "AccountMissing";
    }
    for (const id of ids) {
      const index = this.accounts.findIndex(
        (row) =>
          row.organization_id === organizationId && row.user_id === userId && row.id === id,
      );
      this.accounts.splice(index, 1);
    }
    return "AccountDeleted";
  }

  private deleteVerifications(
    input: Readonly<Record<string, unknown>>,
    success: string,
    missing: string,
  ): string {
    const organizationId = stringField(input, "organization_id");
    const ids = stringListField(input, "verification_ids");
    if (
      ids.some(
        (id) =>
          !this.verifications.some(
            (row) => row.organization_id === organizationId && row.verification_id === id,
          ),
      )
    ) {
      return missing;
    }
    for (const id of ids) {
      const index = this.verifications.findIndex(
        (row) => row.organization_id === organizationId && row.verification_id === id,
      );
      this.verifications.splice(index, 1);
    }
    return success;
  }

  private updateAccountPasswords(input: Readonly<Record<string, unknown>>): string {
    const updates = input.updates;
    if (!Array.isArray(updates)) throw new Error("invalid fake account updates");
    const resolved = updates.map(inputRecord);
    for (const update of resolved) {
      const account = this.accounts.find(
        (row) =>
          row.organization_id === stringField(update, "organization_id") &&
          row.user_id === stringField(update, "user_id") &&
          row.id === stringField(update, "account_id"),
      );
      if (account === undefined) return "PasswordAccountMissing";
      if (account.provider_id !== stringField(update, "provider_id")) {
        return "PasswordProviderMismatch";
      }
    }
    for (const update of resolved) {
      const account = this.accounts.find(
        (row) => row.id === stringField(update, "account_id"),
      )!;
      account.password = nullableStringField(update, "password");
      account.updated_at = timestampField(update, "updated_at");
    }
    return "AccountPasswordsUpdated";
  }
}
