import type { BetterAuthOptions } from "better-auth";
import {
  createAdapterFactory,
  type AdapterFactory,
  type CustomAdapter,
} from "better-auth/adapters";
import type { BetterAuthDBSchema, DBFieldAttribute, DBFieldType } from "better-auth/db";

import { BETTER_AUTH_PINNED_VERSION } from "./profile.js";

export const RIFFDB_BETTER_AUTH_PROFILE_PLAN_SCHEMA =
  "riffdb.better-auth-profile-plan/v1" as const;

const MAX_MODELS = 32;
const MAX_FIELDS_PER_MODEL = 64;
const SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const LINEAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const STORAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const SECRET_FIELD_PATTERN =
  /(?:accessToken|backupCodes|clientSecret|idToken|password|privateKey|refreshToken|secret|token|totp|value)$/iu;
const SUPPORTED_FIELD_TYPES = new Set<DBFieldType>([
  "boolean",
  "date",
  "json",
  "number",
  "number[]",
  "string",
  "string[]",
]);

export interface RiffDBBetterAuthProfileGeneratorConfig {
  readonly name: string;
  readonly contractLineage: string;
  readonly applicationRole?: string;
  readonly output?: string;
}

export interface RiffDBBetterAuthProfileFieldPlan {
  readonly name: string;
  readonly storageName: string;
  readonly type: DBFieldType;
  readonly required: boolean;
  readonly unique: boolean;
  readonly indexed: boolean;
  readonly secret: boolean;
  readonly input: boolean;
  readonly returned: boolean;
  readonly hasDefault: boolean;
  readonly hasOnUpdate: boolean;
  readonly reference?: Readonly<{ model: string; field: string; onDelete?: string }>;
}

export interface RiffDBBetterAuthProfileModelPlan {
  readonly name: string;
  readonly storageName: string;
  readonly fields: readonly RiffDBBetterAuthProfileFieldPlan[];
}

export interface RiffDBBetterAuthProfilePlan {
  readonly schema: typeof RIFFDB_BETTER_AUTH_PROFILE_PLAN_SCHEMA;
  readonly betterAuthVersion: typeof BETTER_AUTH_PINNED_VERSION;
  readonly idGeneration: "uuid";
  readonly name: string;
  readonly contract: Readonly<{ lineage: string; applicationRole: string }>;
  readonly plugins: readonly string[];
  readonly models: readonly RiffDBBetterAuthProfileModelPlan[];
  readonly bounds: Readonly<{
    maximumModels: typeof MAX_MODELS;
    maximumFieldsPerModel: typeof MAX_FIELDS_PER_MODEL;
  }>;
}

export type RiffDBBetterAuthProfileGenerationErrorCode =
  | "invalid_generator_configuration"
  | "unsupported_id_generation"
  | "profile_model_bound_exceeded"
  | "profile_field_bound_exceeded"
  | "invalid_model_name"
  | "invalid_field_name"
  | "unsupported_field_type"
  | "invalid_reference"
  | "generation_only_runtime_call";

export class RiffDBBetterAuthProfileGenerationError extends Error {
  public constructor(public readonly code: RiffDBBetterAuthProfileGenerationErrorCode) {
    super(`cannot generate RiffDB Better Auth profile: ${code}`);
    this.name = "RiffDBBetterAuthProfileGenerationError";
  }
}

function reject(code: RiffDBBetterAuthProfileGenerationErrorCode): never {
  throw new RiffDBBetterAuthProfileGenerationError(code);
}

function validateGeneratorConfig(
  config: RiffDBBetterAuthProfileGeneratorConfig,
): Readonly<{ name: string; lineage: string; applicationRole: string }> {
  const applicationRole = config.applicationRole ?? "BetterAuthServer";
  if (
    !SYMBOL_PATTERN.test(config.name) ||
    !LINEAGE_PATTERN.test(config.contractLineage) ||
    !SYMBOL_PATTERN.test(applicationRole) ||
    (config.output !== undefined &&
      (config.output.length < 1 || config.output.length > 4_096 || config.output.includes("\0")))
  ) {
    reject("invalid_generator_configuration");
  }
  return Object.freeze({
    name: config.name,
    lineage: config.contractLineage,
    applicationRole,
  });
}

function pluginIds(options: BetterAuthOptions): readonly string[] {
  const ids = (options.plugins ?? []).map((plugin) => plugin.id);
  if (ids.some((id) => !SYMBOL_PATTERN.test(id.replaceAll("-", "_")))) {
    reject("invalid_generator_configuration");
  }
  return Object.freeze([...new Set(ids)].sort());
}

function fieldPlan(
  name: string,
  attributes: DBFieldAttribute,
  models: ReadonlySet<string>,
): RiffDBBetterAuthProfileFieldPlan {
  const storageName = attributes.fieldName ?? name;
  if (!SYMBOL_PATTERN.test(name) || !STORAGE_NAME_PATTERN.test(storageName)) {
    reject("invalid_field_name");
  }
  if (!SUPPORTED_FIELD_TYPES.has(attributes.type)) reject("unsupported_field_type");

  const reference = attributes.references;
  if (
    reference !== undefined &&
    (!models.has(reference.model) ||
      !SYMBOL_PATTERN.test(reference.model) ||
      !SYMBOL_PATTERN.test(reference.field))
  ) {
    reject("invalid_reference");
  }

  const secret = attributes.returned === false || SECRET_FIELD_PATTERN.test(name);
  return Object.freeze({
    name,
    storageName,
    type: attributes.type,
    required: attributes.required ?? false,
    unique: attributes.unique ?? false,
    indexed: attributes.index ?? false,
    secret,
    input: attributes.input !== false,
    returned: attributes.returned !== false,
    hasDefault: attributes.defaultValue !== undefined,
    hasOnUpdate: attributes.onUpdate !== undefined,
    ...(reference === undefined
      ? {}
      : {
          reference: Object.freeze({
            model: reference.model,
            field: reference.field,
            ...(reference.onDelete === undefined ? {} : { onDelete: reference.onDelete }),
          }),
        }),
  });
}

export function defineRiffDBBetterAuthProfilePlan(
  options: BetterAuthOptions,
  tables: BetterAuthDBSchema,
  config: RiffDBBetterAuthProfileGeneratorConfig,
): RiffDBBetterAuthProfilePlan {
  const checked = validateGeneratorConfig(config);
  if (options.advanced?.database?.generateId !== "uuid") {
    reject("unsupported_id_generation");
  }
  const modelEntries = Object.entries(tables).sort(([left], [right]) => left.localeCompare(right));
  if (modelEntries.length < 1 || modelEntries.length > MAX_MODELS) {
    reject("profile_model_bound_exceeded");
  }
  const modelNames = new Set(modelEntries.map(([name]) => name));

  const models = modelEntries.map(([name, table]) => {
    const storageName = table.modelName;
    if (!SYMBOL_PATTERN.test(name) || !STORAGE_NAME_PATTERN.test(storageName)) {
      reject("invalid_model_name");
    }
    const fields = Object.entries(table.fields).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    if (fields.length < 1 || fields.length > MAX_FIELDS_PER_MODEL) {
      reject("profile_field_bound_exceeded");
    }
    return Object.freeze({
      name,
      storageName,
      fields: Object.freeze(
        fields.map(([field, attributes]) => fieldPlan(field, attributes, modelNames)),
      ),
    });
  });

  return Object.freeze({
    schema: RIFFDB_BETTER_AUTH_PROFILE_PLAN_SCHEMA,
    betterAuthVersion: BETTER_AUTH_PINNED_VERSION,
    idGeneration: "uuid",
    name: checked.name,
    contract: Object.freeze({
      lineage: checked.lineage,
      applicationRole: checked.applicationRole,
    }),
    plugins: pluginIds(options),
    models: Object.freeze(models),
    bounds: Object.freeze({
      maximumModels: MAX_MODELS,
      maximumFieldsPerModel: MAX_FIELDS_PER_MODEL,
    }),
  });
}

export function renderRiffDBBetterAuthProfilePlan(plan: RiffDBBetterAuthProfilePlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function generationOnlyFailure(): never {
  throw new RiffDBBetterAuthProfileGenerationError("generation_only_runtime_call");
}

function generationOnlyAdapter(
  options: BetterAuthOptions,
  config: RiffDBBetterAuthProfileGeneratorConfig,
): CustomAdapter {
  const fail = async (): Promise<never> => generationOnlyFailure();
  return {
    create: fail,
    update: fail,
    updateMany: fail,
    findOne: fail,
    findMany: fail,
    delete: fail,
    deleteMany: fail,
    consumeOne: fail,
    incrementOne: fail,
    count: fail,
    createSchema: async ({ file, tables }) => ({
      code: renderRiffDBBetterAuthProfilePlan(
        defineRiffDBBetterAuthProfilePlan(options, tables, config),
      ),
      path: file ?? config.output ?? "riffdb/better-auth.profile.json",
      overwrite: true,
    }),
  } as CustomAdapter;
}

/**
 * Generation-only Better Auth adapter used by `better-auth generate`.
 *
 * It resolves the complete configured Better Auth schema without requiring a
 * live RiffDB driver. Runtime methods always fail; the resulting reviewed plan
 * is input to the compiled-profile materializer, never a generic CRUD schema.
 */
export function riffdbProfileAdapter(
  config: RiffDBBetterAuthProfileGeneratorConfig,
): AdapterFactory<BetterAuthOptions> {
  validateGeneratorConfig(config);
  return createAdapterFactory({
    config: {
      adapterId: "riffdb-profile-generator",
      adapterName: "RiffDB Better Auth Profile Generator",
      supportsNumericIds: false,
      supportsUUIDs: false,
      supportsJSON: true,
      supportsArrays: true,
      transaction: false,
    },
    adapter: ({ options }) => generationOnlyAdapter(options, config),
  });
}
