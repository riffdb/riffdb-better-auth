export const BETTER_AUTH_PINNED_VERSION = "1.6.29" as const;
export const RIFFDB_BETTER_AUTH_PROFILE_SCHEMA =
  "riffdb.better-auth-core-profile/v1" as const;

export const BETTER_AUTH_CORE_MODELS = [
  "user",
  "session",
  "account",
  "verification",
] as const;

export type BetterAuthCoreModel = (typeof BETTER_AUTH_CORE_MODELS)[number];

export const BETTER_AUTH_CORE_FIELDS = {
  user: [
    "id",
    "name",
    "email",
    "emailVerified",
    "image",
    "createdAt",
    "updatedAt",
  ],
  session: [
    "id",
    "userId",
    "token",
    "expiresAt",
    "ipAddress",
    "userAgent",
    "createdAt",
    "updatedAt",
  ],
  account: [
    "id",
    "userId",
    "accountId",
    "providerId",
    "accessToken",
    "refreshToken",
    "accessTokenExpiresAt",
    "refreshTokenExpiresAt",
    "scope",
    "idToken",
    "password",
    "createdAt",
    "updatedAt",
  ],
  verification: [
    "id",
    "identifier",
    "value",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ],
} as const satisfies Readonly<Record<BetterAuthCoreModel, readonly string[]>>;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LINEAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;

export interface BetterAuthModelShape {
  readonly name: string;
  readonly fields: readonly string[];
}

export interface RiffDBContractIdentity {
  readonly lineage: string;
  readonly version: number;
  readonly bundleHash: string;
  readonly applicationRole: string;
}

export interface RiffDBBetterAuthCoreProfileInput {
  readonly schema: typeof RIFFDB_BETTER_AUTH_PROFILE_SCHEMA;
  readonly betterAuthVersion: string;
  readonly idGeneration: "uuid" | "default" | "serial";
  readonly plugins?: readonly string[];
  readonly models: readonly BetterAuthModelShape[];
  readonly contract: RiffDBContractIdentity;
}

export interface RiffDBBetterAuthCoreProfile {
  readonly schema: typeof RIFFDB_BETTER_AUTH_PROFILE_SCHEMA;
  readonly betterAuthVersion: typeof BETTER_AUTH_PINNED_VERSION;
  readonly idGeneration: "uuid";
  readonly plugins: readonly [];
  readonly models: Readonly<
    Record<BetterAuthCoreModel, { readonly name: BetterAuthCoreModel; readonly fields: readonly string[] }>
  >;
  readonly contract: Readonly<RiffDBContractIdentity>;
}

export type UnsupportedBetterAuthProfileCode =
  | "invalid_profile_schema"
  | "unsupported_better_auth_version"
  | "unsupported_id_generation"
  | "unsupported_plugin"
  | "invalid_model_inventory"
  | "unsupported_model"
  | "unsupported_field_shape"
  | "invalid_contract_identity";

export class UnsupportedBetterAuthProfileError extends Error {
  public readonly code: UnsupportedBetterAuthProfileCode;

  public constructor(code: UnsupportedBetterAuthProfileCode) {
    super(`unsupported Better Auth profile: ${code}`);
    this.name = "UnsupportedBetterAuthProfileError";
    this.code = code;
  }
}

function reject(code: UnsupportedBetterAuthProfileCode): never {
  throw new UnsupportedBetterAuthProfileError(code);
}

function exactFields(model: BetterAuthCoreModel, fields: readonly string[]): readonly string[] {
  const expected = [...BETTER_AUTH_CORE_FIELDS[model]].sort();
  const actual = [...fields].sort();
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    reject("unsupported_field_shape");
  }
  return Object.freeze([...BETTER_AUTH_CORE_FIELDS[model]]);
}

function validateContractIdentity(
  contract: RiffDBContractIdentity,
): Readonly<RiffDBContractIdentity> {
  if (
    !LINEAGE_PATTERN.test(contract.lineage) ||
    !Number.isSafeInteger(contract.version) ||
    contract.version < 1 ||
    !HASH_PATTERN.test(contract.bundleHash) ||
    !SYMBOL_PATTERN.test(contract.applicationRole)
  ) {
    reject("invalid_contract_identity");
  }
  return Object.freeze({ ...contract });
}

/** Validates the exact compiled Better Auth core profile. */
export function defineRiffDBBetterAuthCoreProfile(
  input: RiffDBBetterAuthCoreProfileInput,
): RiffDBBetterAuthCoreProfile {
  if (input.schema !== RIFFDB_BETTER_AUTH_PROFILE_SCHEMA) {
    reject("invalid_profile_schema");
  }
  if (input.betterAuthVersion !== BETTER_AUTH_PINNED_VERSION) {
    reject("unsupported_better_auth_version");
  }
  if (input.idGeneration !== "uuid") {
    reject("unsupported_id_generation");
  }
  if ((input.plugins?.length ?? 0) !== 0) {
    reject("unsupported_plugin");
  }
  if (input.models.length !== BETTER_AUTH_CORE_MODELS.length) {
    reject("invalid_model_inventory");
  }

  const supplied = new Map<string, BetterAuthModelShape>();
  for (const model of input.models) {
    if (supplied.has(model.name)) {
      reject("invalid_model_inventory");
    }
    supplied.set(model.name, model);
  }

  const models = {} as Record<
    BetterAuthCoreModel,
    { readonly name: BetterAuthCoreModel; readonly fields: readonly string[] }
  >;
  for (const name of BETTER_AUTH_CORE_MODELS) {
    const model = supplied.get(name);
    if (model === undefined) {
      reject("unsupported_model");
    }
    models[name] = Object.freeze({ name, fields: exactFields(name, model.fields) });
  }
  if ([...supplied].some(([name]) => !BETTER_AUTH_CORE_MODELS.includes(name as BetterAuthCoreModel))) {
    reject("unsupported_model");
  }

  return Object.freeze({
    schema: RIFFDB_BETTER_AUTH_PROFILE_SCHEMA,
    betterAuthVersion: BETTER_AUTH_PINNED_VERSION,
    idGeneration: "uuid",
    plugins: Object.freeze([]) as readonly [],
    models: Object.freeze(models),
    contract: validateContractIdentity(input.contract),
  });
}
