import type {
  RiffDBBetterAuthProfileFieldPlan,
  RiffDBBetterAuthProfileModelPlan,
  RiffDBBetterAuthProfilePlan,
} from "./profile-plan.js";

/**
 * Materializes a reviewed profile plan into RiffDB contract and query sources.
 *
 * The plan records what Better Auth resolved. This module turns that record
 * into the compiled artifacts DESIGN requires before a plan can become a
 * runtime profile: one contract, one named query per accepted call shape, and
 * one application source binding them.
 *
 * It is deliberately not a schema pusher. The output is source a human reviews
 * and compiles; the generator's contribution is that every safety property
 * RiffDB can prove is declared, and every property it cannot prove is named in
 * {@link RiffDBBetterAuthMaterialization.report} rather than silently dropped.
 */

const DEFAULT_STRING_BOUND = 2_048;
const DEFAULT_BYTES_BOUND = 8_192;
const DEFAULT_LIST_BOUND = 32;
const DEFAULT_CASCADE_MAXIMUM = 32;
/**
 * The tenant partition column.
 *
 * It is deliberately not `organization_id`: the Better Auth organization
 * plugin contributes a model named `organization`, whose synthesized key
 * column would then collide with the partition column.
 */
const PARTITION_FIELD = "tenant_id";

/** Cascade covers at most 32 relationships (SPEC DEL-004). */
const MAX_CASCADE_RELATIONSHIPS = 32;

/**
 * SPEC DEL-004 bounds the whole cascaded graph:
 * `root_count_maximum * (1 + sum(relationship maxima)) <= 256`.
 */
const MAX_CASCADE_GRAPH = 256;

/**
 * The per-relationship cascade maximum an entity with `children` can afford.
 *
 * Deleting one root must stay inside {@link MAX_CASCADE_GRAPH}, so a wide
 * aggregate lowers its per-relationship maximum rather than failing to
 * compile.
 */
function cascadeMaximumFor(children: number, bounds: ResolvedBounds): number {
  if (children === 0) return bounds.cascadeMaximum;
  return Math.max(
    1,
    Math.min(bounds.cascadeMaximum, Math.floor((MAX_CASCADE_GRAPH - 1) / children)),
  );
}

/**
 * How many roots one bulk delete may name.
 *
 * A cascading delete pays for its whole discovered graph, so an aggregate with
 * five children admits a single root per command — the same bound the
 * hand-written core contract reaches for `DeleteUser`.
 */
function deleteRootBound(children: number, bounds: ResolvedBounds): number {
  if (children === 0) return bounds.cascadeMaximum;
  const perRelationship = cascadeMaximumFor(children, bounds);
  return Math.max(1, Math.floor(MAX_CASCADE_GRAPH / (1 + children * perRelationship)));
}

export type RiffDBBetterAuthMaterializationErrorCode =
  | "unsupported_field_type"
  | "reserved_symbol_collision"
  | "cascade_bound_exceeded"
  | "invalid_materialization_option";

export class RiffDBBetterAuthMaterializationError extends Error {
  public constructor(
    public readonly code: RiffDBBetterAuthMaterializationErrorCode,
    public readonly detail: string,
  ) {
    super(`cannot materialize RiffDB Better Auth profile: ${code} (${detail})`);
    this.name = "RiffDBBetterAuthMaterializationError";
  }
}

function reject(code: RiffDBBetterAuthMaterializationErrorCode, detail: string): never {
  throw new RiffDBBetterAuthMaterializationError(code, detail);
}

export interface RiffDBBetterAuthMaterializationOptions {
  /** Compile-time maximum for every generated `string<N>` field. */
  readonly stringBound?: number;
  /** Compile-time maximum for every generated `bytes<N>` field. */
  readonly bytesBound?: number;
  /** Compile-time maximum element count for every generated `list<T,N>` field. */
  readonly listBound?: number;
  /** Per-relationship cascade maximum. */
  readonly cascadeMaximum?: number;
}

/**
 * One reference the contract could not enforce, and why.
 *
 * A generated contract declares a `reference` only for the edge that owns the
 * row's aggregate. Every other edge is emitted as an indexed key field: the
 * adapter can still query by it, but RiffDB does not prove the target exists.
 */
export interface RiffDBBetterAuthUnenforcedReference {
  readonly model: string;
  readonly field: string;
  readonly targetModel: string;
  readonly reason: "cross_aggregate_edge";
}

export interface RiffDBBetterAuthAggregateReport {
  readonly name: string;
  readonly root: string;
  readonly children: readonly string[];
}

export interface RiffDBBetterAuthGeneratedQuery {
  readonly name: string;
  readonly path: string;
  readonly code: string;
}

export interface RiffDBBetterAuthMaterializationReport {
  readonly aggregates: readonly RiffDBBetterAuthAggregateReport[];
  readonly unenforcedReferences: readonly RiffDBBetterAuthUnenforcedReference[];
}

export interface RiffDBBetterAuthMaterialization {
  readonly contract: string;
  readonly queries: readonly RiffDBBetterAuthGeneratedQuery[];
  readonly applicationSource: string;
  readonly report: RiffDBBetterAuthMaterializationReport;
}

/** `twoFactor` -> `two_factor`; `organizationId` -> `organization_id`. */
function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .toLowerCase();
}

/** `twoFactor` -> `TwoFactor`; `team_member` -> `TeamMember`. */
function pascal(name: string): string {
  return snake(name)
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

/**
 * The preferred synthesized primary-key column for one model, e.g. `user_id`.
 *
 * Better Auth schemas contain fields that snake-case onto this name — the
 * `account` model carries its provider's own `accountId` — so the preference
 * is resolved against the rest of the entity by {@link resolveKeyColumns}.
 */
function preferredKeyColumn(model: string): string {
  return `${snake(model)}_id`;
}

interface ResolvedBounds {
  readonly stringBound: number;
  readonly bytesBound: number;
  readonly listBound: number;
  readonly cascadeMaximum: number;
}

function resolveBounds(
  options: RiffDBBetterAuthMaterializationOptions | undefined,
): ResolvedBounds {
  const bounded = (value: number | undefined, fallback: number, maximum: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      reject("invalid_materialization_option", `${value} is out of range`);
    }
    return value;
  };
  return Object.freeze({
    stringBound: bounded(options?.stringBound, DEFAULT_STRING_BOUND, 1_048_576),
    bytesBound: bounded(options?.bytesBound, DEFAULT_BYTES_BOUND, 1_048_576),
    listBound: bounded(options?.listBound, DEFAULT_LIST_BOUND, 1_024),
    cascadeMaximum: bounded(options?.cascadeMaximum, DEFAULT_CASCADE_MAXIMUM, 256),
  });
}

/**
 * The RiffDB type for one planned field.
 *
 * A field that references another model carries that model's identifier, so it
 * is a `uuid` regardless of the JavaScript type Better Auth reports.
 */
function fieldType(field: RiffDBBetterAuthProfileFieldPlan, bounds: ResolvedBounds): string {
  const base = ((): string => {
    if (field.reference !== undefined) return "uuid";
    switch (field.type) {
      case "boolean":
        return "bool";
      case "date":
        return "timestamp";
      case "number":
        return "i64";
      case "string":
        return `string<${bounds.stringBound}>`;
      case "json":
        return `bytes<${bounds.bytesBound}>`;
      case "string[]":
        return `list<string<${bounds.stringBound}>, 0..${bounds.listBound}>`;
      case "number[]":
        return `list<i64, 0..${bounds.listBound}>`;
      default:
        return reject("unsupported_field_type", `${field.name}: ${String(field.type)}`);
    }
  })();
  return field.required ? base : `optional<${base}>`;
}

interface AggregateAssignment {
  /** Model name -> owning parent model name, for models that are children. */
  readonly parentOf: ReadonlyMap<string, string>;
  /** Aggregate root model names, in plan order. */
  readonly roots: readonly string[];
  /** Root model name -> child model names. */
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  /** Model name -> its synthesized primary-key column. */
  readonly keyColumnOf: ReadonlyMap<string, string>;
}

/**
 * Chooses a primary-key column per model that collides with nothing.
 *
 * The column must differ from the partition column, from `revision`, from
 * every stored field of its own entity, and from the parent key column its
 * children embed. Roots resolve before children so a child can see the column
 * its parent settled on.
 */
function resolveKeyColumns(
  plan: RiffDBBetterAuthProfilePlan,
  parentOf: ReadonlyMap<string, string>,
  childrenOf: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, string> {
  const modelsByName = new Map(plan.models.map((model) => [model.name, model]));
  const resolved = new Map<string, string>();

  const storedNames = (model: RiffDBBetterAuthProfileModelPlan): Set<string> => {
    const parent = parentOf.get(model.name);
    return new Set(
      model.fields
        .filter((field) => parent === undefined || field.reference?.model !== parent)
        .map((field) => snake(field.name)),
    );
  };

  const order = [
    ...plan.models.filter((model) => !parentOf.has(model.name)),
    ...plan.models.filter((model) => parentOf.has(model.name)),
  ];

  for (const model of order) {
    const taken = storedNames(model);
    taken.add(PARTITION_FIELD);
    taken.add("revision");
    const parent = parentOf.get(model.name);
    if (parent !== undefined) taken.add(resolved.get(parent)!);
    // The column also lands in every child's key, so it must clear their fields.
    for (const child of childrenOf.get(model.name) ?? []) {
      for (const name of storedNames(modelsByName.get(child)!)) taken.add(name);
    }

    const preferred = preferredKeyColumn(model.name);
    const candidate = taken.has(preferred) ? `${snake(model.name)}_row_id` : preferred;
    if (taken.has(candidate)) {
      reject("reserved_symbol_collision", `${model.name} cannot name a key column`);
    }
    resolved.set(model.name, candidate);
  }
  return resolved;
}

/**
 * Assigns every model to exactly one aggregate.
 *
 * A model with no references is a root. A model whose references include at
 * least one root becomes that root's child, choosing the first such reference
 * in sorted field order so the assignment is deterministic. Everything else is
 * its own root, because RiffDB aggregates are one level deep: a child cannot
 * itself own children.
 */
function assignAggregates(plan: RiffDBBetterAuthProfilePlan): AggregateAssignment {
  const referencesOf = new Map<string, readonly RiffDBBetterAuthProfileFieldPlan[]>();
  for (const model of plan.models) {
    referencesOf.set(
      model.name,
      model.fields.filter((field) => field.reference !== undefined),
    );
  }

  const rootEligible = new Set(
    plan.models
      .filter((model) => (referencesOf.get(model.name) ?? []).length === 0)
      .map((model) => model.name),
  );

  const parentOf = new Map<string, string>();
  for (const model of plan.models) {
    const owning = (referencesOf.get(model.name) ?? []).find((field) =>
      rootEligible.has(field.reference!.model),
    );
    if (owning !== undefined) parentOf.set(model.name, owning.reference!.model);
  }

  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(child);
    childrenOf.set(parent, bucket);
  }
  for (const bucket of childrenOf.values()) bucket.sort();

  const roots = plan.models.map((model) => model.name).filter((name) => !parentOf.has(name));
  const frozenChildren = new Map<string, readonly string[]>(
    [...childrenOf].map(([key, value]) => [key, Object.freeze(value)]),
  );

  return Object.freeze({
    parentOf,
    roots: Object.freeze(roots),
    childrenOf: frozenChildren,
    keyColumnOf: resolveKeyColumns(plan, parentOf, frozenChildren),
  });
}

/** The full key column list for one model, parent prefix included. */
function keyColumns(model: string, assignment: AggregateAssignment): readonly string[] {
  const parent = assignment.parentOf.get(model);
  return parent === undefined
    ? [PARTITION_FIELD, assignment.keyColumnOf.get(model)!]
    : [PARTITION_FIELD, assignment.keyColumnOf.get(parent)!, assignment.keyColumnOf.get(model)!];
}

/** The reference field that owns this model's aggregate, if it has one. */
function owningField(
  model: RiffDBBetterAuthProfileModelPlan,
  assignment: AggregateAssignment,
): RiffDBBetterAuthProfileFieldPlan | undefined {
  const parent = assignment.parentOf.get(model.name);
  if (parent === undefined) return undefined;
  return model.fields.find((field) => field.reference?.model === parent);
}

interface EmittedEntity {
  readonly source: string;
  readonly unenforced: readonly RiffDBBetterAuthUnenforcedReference[];
}

function emitEntity(
  model: RiffDBBetterAuthProfileModelPlan,
  assignment: AggregateAssignment,
  bounds: ResolvedBounds,
): EmittedEntity {
  const lines: string[] = [];
  const unenforced: RiffDBBetterAuthUnenforcedReference[] = [];
  const columns = keyColumns(model.name, assignment);
  const owning = owningField(model, assignment);

  lines.push(`  entity ${pascal(model.name)} {`);
  lines.push(`    key (${columns.map((column) => `${column}: uuid`).join(", ")})`);

  // The owning reference is carried by the key, so it is never also a field.
  const stored = model.fields.filter((field) => field !== owning);
  for (const field of stored) {
    const secret = field.secret ? "secret " : "";
    lines.push(`    field ${secret}${snake(field.name)}: ${fieldType(field, bounds)}`);
  }
  lines.push("    field revision: u64");

  const tail = columns.slice(1);
  for (const field of stored) {
    if (field.unique) {
      lines.push(
        `    unique ${snake(model.name)}_${snake(field.name)} (${PARTITION_FIELD}, ${snake(field.name)})`,
      );
    }
  }
  for (const field of stored) {
    const needsIndex = field.indexed || field.unique || field.reference !== undefined;
    if (!needsIndex) continue;
    lines.push(
      `    index by_${snake(field.name)} (${PARTITION_FIELD}, ${snake(field.name)}, ${tail.join(", ")})`,
    );
  }
  // A child is discovered from its parent through this index, which is also the
  // reverse index a cascade or restrict proof names.
  if (owning !== undefined) {
    const parentModel = assignment.parentOf.get(model.name)!;
    const parentColumn = assignment.keyColumnOf.get(parentModel)!;
    lines.push(`    index by_parent (${columns.join(", ")})`);
    lines.push(
      `    reference ${snake(model.name)}_parent (${PARTITION_FIELD}, ${parentColumn})` +
        ` -> ${pascal(parentModel)}(${PARTITION_FIELD}, ${parentColumn})`,
    );
  }
  for (const field of stored) {
    if (field.reference === undefined) continue;
    unenforced.push(
      Object.freeze({
        model: model.name,
        field: field.name,
        targetModel: field.reference.model,
        reason: "cross_aggregate_edge" as const,
      }),
    );
  }

  const children = assignment.childrenOf.get(model.name) ?? [];
  if (children.length > MAX_CASCADE_RELATIONSHIPS) {
    reject("cascade_bound_exceeded", `${model.name} owns ${children.length} children`);
  }
  if (children.length === 0) {
    lines.push("    delete_policy no_inbound");
  } else {
    lines.push("    delete_policy cascade {");
    for (const child of children) {
      lines.push(
        `      relationship ${pascal(child)}.${snake(child)}_parent using ${pascal(child)}.by_parent maximum ${cascadeMaximumFor(children.length, bounds)}`,
      );
    }
    lines.push("    }");
  }
  lines.push("  }");
  return Object.freeze({ source: lines.join("\n"), unenforced: Object.freeze(unenforced) });
}

function emitAggregate(root: string, assignment: AggregateAssignment): string {
  const children = assignment.childrenOf.get(root) ?? [];
  const lines = [`  aggregate ${pascal(root)}Data {`, `    root ${pascal(root)}`];
  for (const child of children) lines.push(`    child ${pascal(child)}`);
  lines.push(`    partition_by ${PARTITION_FIELD}`);
  lines.push(`    conflict_key (${PARTITION_FIELD}, ${assignment.keyColumnOf.get(root)!})`);
  lines.push("  }");
  return lines.join("\n");
}

/** Command input declarations for every stored field of one model. */
function commandInputs(
  model: RiffDBBetterAuthProfileModelPlan,
  assignment: AggregateAssignment,
  bounds: ResolvedBounds,
): readonly string[] {
  const owning = owningField(model, assignment);
  return model.fields
    .filter((field) => field !== owning)
    .map((field) => `    input ${snake(field.name)}: ${fieldType(field, bounds)}`);
}

function emitCommands(
  model: RiffDBBetterAuthProfileModelPlan,
  assignment: AggregateAssignment,
  bounds: ResolvedBounds,
): string {
  const entity = pascal(model.name);
  const columns = keyColumns(model.name, assignment);
  const binding = snake(model.name);
  const owning = owningField(model, assignment);
  const stored = model.fields.filter((field) => field !== owning);
  const keyInputs = columns.map((column) => `    input ${column}: uuid`);
  const lines: string[] = [];

  lines.push(`  command Create${entity} {`);
  lines.push("    input request_id: uuid");
  lines.push(...keyInputs);
  lines.push(...commandInputs(model, assignment, bounds));
  lines.push("    idempotency_key request_id");
  // A create that declares a reference must first prove the target exists,
  // reusing the same key expressions the reference was declared with.
  if (owning !== undefined) {
    const parentModel = assignment.parentOf.get(model.name)!;
    const parentColumn = assignment.keyColumnOf.get(parentModel)!;
    lines.push(
      `    read ${pascal(parentModel)}(${PARTITION_FIELD}, ${parentColumn}) as ${snake(parentModel)}` +
        ` else ${entity}ParentMissing {}`,
    );
  }
  lines.push(
    `    create ${entity}(${columns.join(", ")}) as ${binding} else ${entity}AlreadyExists {}`,
  );
  for (const field of stored) {
    lines.push(`    set ${binding}.${snake(field.name)} = ${snake(field.name)}`);
  }
  lines.push(`    set ${binding}.revision = 1`);
  lines.push(`    return ${entity}Created {}`);
  lines.push("  }");
  lines.push("");

  lines.push(`  command Update${entity} {`);
  lines.push("    input request_id: uuid");
  lines.push(...keyInputs);
  lines.push("    input expected_revision: u64");
  lines.push(...commandInputs(model, assignment, bounds));
  lines.push("    idempotency_key request_id");
  lines.push(
    `    mutate ${entity}(${columns.join(", ")}) as ${binding} else ${entity}UpdateMissing {}`,
  );
  lines.push(
    `    require current_revision: ${binding}.revision == expected_revision else ${entity}UpdateStale {}`,
  );
  for (const field of stored) {
    lines.push(`    set ${binding}.${snake(field.name)} = ${snake(field.name)}`);
  }
  lines.push(`    set ${binding}.revision = ${binding}.revision + 1`);
  lines.push(`    return ${entity}Updated {}`);
  lines.push("  }");
  lines.push("");

  const cascades = (assignment.childrenOf.get(model.name) ?? []).length > 0;
  const column = assignment.keyColumnOf.get(model.name)!;
  lines.push(`  bulk command Delete${entity} {`);
  lines.push("    input request_id: uuid");
  lines.push(...columns.slice(0, -1).map((column) => `    input ${column}: uuid`));
  lines.push(
    `    input ${column}s: list<uuid, 1..${deleteRootBound((assignment.childrenOf.get(model.name) ?? []).length, bounds)}>`,
  );
  lines.push("    idempotency_key request_id");
  lines.push(`    for ${column} in ${column}s {`);
  lines.push(
    `      delete ${entity}(${columns.join(", ")}) as ${binding} else ${entity}Missing {}`,
  );
  if (cascades) lines.push(`        cascade ${entity}CascadeLimitExceeded {}`);
  lines.push("    }");
  lines.push(`    return ${entity}Deleted {}`);
  lines.push("  }");
  return lines.join("\n");
}

/** The projection every generated read returns for one model. */
function projection(
  model: RiffDBBetterAuthProfileModelPlan,
  assignment: AggregateAssignment,
  binding: string,
): string {
  const owning = owningField(model, assignment);
  const columns = keyColumns(model.name, assignment).slice(1);
  const fields = model.fields
    .filter((field) => field !== owning)
    .map((field) =>
      field.secret
        ? `${snake(field.name)} reveals ${binding}.${snake(field.name)}`
        : snake(field.name),
    );
  return [...columns, ...fields, "revision"].join(" ");
}

function emitQueries(
  model: RiffDBBetterAuthProfileModelPlan,
  assignment: AggregateAssignment,
): readonly RiffDBBetterAuthGeneratedQuery[] {
  const entity = pascal(model.name);
  const columns = keyColumns(model.name, assignment);
  const binding = `${snake(model.name)}s`;
  const queries: RiffDBBetterAuthGeneratedQuery[] = [];

  const build = (
    name: string,
    parameters: readonly string[],
    predicate: readonly string[],
    order: string,
    take: string,
  ): RiffDBBetterAuthGeneratedQuery =>
    Object.freeze({
      name,
      path: `riffdb/queries/${snake(name)}.riffq`,
      code: [
        `query ${name}(`,
        ...parameters.map((parameter) => `    ${parameter},`),
        ") {",
        `    many ${binding} from ${entity}`,
        `        where ${predicate.join("\n          && ")}`,
        `        order by ${order}`,
        `        ${take}`,
        "",
        "    return Found {",
        `        ${binding}: ${binding} { ${projection(model, assignment, binding)} }`,
        "    }",
        "",
        "    outcomes Found",
        "}",
        "",
      ].join("\n"),
    });

  // Exact identity: every key column bound, one row.
  queries.push(
    build(
      `Find${entity}ById`,
      columns.map((column) => `$${column}: ${entity}.${column}`),
      columns.map((column) => `${column} == $${column}`),
      `${assignment.keyColumnOf.get(model.name)!} asc`,
      "take 1",
    ),
  );

  const owning = owningField(model, assignment);
  for (const field of model.fields) {
    if (field === owning) continue;
    if (!field.unique && !field.indexed && field.reference === undefined) continue;
    const column = snake(field.name);
    queries.push(
      build(
        `Find${entity}By${pascal(field.name)}`,
        [
          `$${PARTITION_FIELD}: ${entity}.${PARTITION_FIELD}`,
          `$${column}: ${entity}.${column}`,
          "$after: Cursor?",
        ],
        [`${PARTITION_FIELD} == $${PARTITION_FIELD}`, `${column} == $${column}`],
        // The serving index is (tenant, field, ...key tail), so the bounded
        // order must name that whole tail for the planner to prove it.
        columns
          .slice(1)
          .map((keyColumn) => `${keyColumn} asc`)
          .join(", "),
        field.unique ? "take 1" : "take 50 after $after",
      ),
    );
  }
  return Object.freeze(queries);
}

/**
 * Materializes one reviewed plan into compilable RiffDB sources.
 *
 * The returned sources are input to `riffdb application check` and human
 * review, not a deployment. Callers must read
 * {@link RiffDBBetterAuthMaterialization.report} before trusting the result:
 * it names every reference the contract does not enforce.
 */
export function materializeRiffDBBetterAuthProfile(
  plan: RiffDBBetterAuthProfilePlan,
  options?: RiffDBBetterAuthMaterializationOptions,
): RiffDBBetterAuthMaterialization {
  const bounds = resolveBounds(options);
  for (const model of plan.models) {
    if (preferredKeyColumn(model.name) === PARTITION_FIELD) {
      reject("reserved_symbol_collision", `${model.name} collides with ${PARTITION_FIELD}`);
    }
  }
  const assignment = assignAggregates(plan);

  const entities: string[] = [];
  const unenforced: RiffDBBetterAuthUnenforcedReference[] = [];
  for (const model of plan.models) {
    const emitted = emitEntity(model, assignment, bounds);
    entities.push(emitted.source);
    unenforced.push(...emitted.unenforced);
  }

  const aggregates = assignment.roots.map((root) => emitAggregate(root, assignment));
  const commands = plan.models.map((model) => emitCommands(model, assignment, bounds));
  const commandNames = plan.models.flatMap((model) => [
    `Create${pascal(model.name)}`,
    `Update${pascal(model.name)}`,
    `Delete${pascal(model.name)}`,
  ]);
  const queries = plan.models.flatMap((model) => emitQueries(model, assignment));

  const contract = [
    `contract ${plan.contract.lineage} version 1 {`,
    entities.join("\n\n"),
    "",
    aggregates.join("\n\n"),
    "",
    commands.join("\n\n"),
    "}",
    "",
  ].join("\n");

  const applicationSource = `${JSON.stringify(
    {
      schema: "riffdb.application-source/v6",
      application: snake(plan.name).replaceAll("_", "-"),
      contract: {
        source: "riffdb/contract.riff",
        lineage: plan.contract.lineage,
        version: 1,
      },
      generation: {
        go: "generated/go/client.go",
        mcp: "generated/mcp/tools.json",
        python: "generated/python/client.py",
        rust: "generated/rust/client.rs",
        typescript: "src/generated/client.ts",
      },
      migrations: [],
      query_modules: [
        {
          name: snake(plan.name),
          version: 1,
          queries: queries.map((query) => ({ name: query.name, source: query.path })),
        },
      ],
      reactive_modules: [],
      // The role grants exactly the operations this contract declares, so the
      // materialized profile is callable without widening it by hand.
      roles: [
        {
          name: plan.contract.applicationRole,
          environment: "development",
          tenant_scope: "global",
          queries: queries.map((query) => query.name),
          commands: commandNames,
          event_streams: [],
          watch_queries: [],
          agent_subscriptions: [],
          row_policies: [],
        },
      ],
      seed_inputs: [],
    },
    null,
    2,
  )}\n`;

  return Object.freeze({
    contract,
    queries,
    applicationSource,
    report: Object.freeze({
      aggregates: Object.freeze(
        assignment.roots.map((root) =>
          Object.freeze({
            name: `${pascal(root)}Data`,
            root,
            children: assignment.childrenOf.get(root) ?? Object.freeze([]),
          }),
        ),
      ),
      unenforcedReferences: Object.freeze(unenforced),
    }),
  });
}
