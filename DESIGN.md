# Design boundary

## Package responsibility

`@riffdb/better-auth` owns Better Auth schema interpretation, profile
generation, adapter method mapping, and Better Auth conformance tests. RiffDB
owns database semantics, compiled operations, authorization, durability,
idempotency, and the Rust-backed TypeScript transport.

## Better Auth 1.7.18 method inventory

The adapter project must cover the current `createAdapterFactory` interface:

- `create`
- `update`
- `updateMany`
- `delete`
- `deleteMany`
- `consumeOne`
- `findOne`
- `findMany`
- `count`
- `incrementOne`

The Better Auth API presents these as generic model/where/update requests.
The RiffDB adapter must instead recognize a finite reviewed call shape and
dispatch to one generated named command or query. An unmatched combination
is an unsupported-profile error, never a dynamic RiffQL expression or generic
storage callback.

The core profile implements exact user `count` and bounded user windows for a
finite set of UUID and email predicates. Numeric offset, exact total, text
matching, independent order, and nullable order are declared in the compiled
query. The result page and total therefore share one provider epoch; the
adapter neither drains pages nor recounts client-side.

`consumeOne` maps to one atomic delete-and-return compiled command. In a
recognized Better Auth verification transaction, the adapter records a bounded
candidate and its internal revision, then commits `ConsumeVerificationSnapshot`.
The database validates that revision while deleting; a losing delete racer
returns `null`, and a changed snapshot fails explicitly. Remaining identifier-
scoped rows use the separate bounded cleanup command.

Better Auth 1.7.18 wraps password reset in a larger transaction. For the
supported existing-credential graph, `ResetCredentialPassword` consumes the
recorded verification row and revision-guards the credential password write
in one compiled command. A stale or missing account leaves the token and
password unchanged. Basic password changes use the native
`UpdateCredentialPassword` command with its current credential selector.
Additional verification rows, credential-account creation,
and session-revoking reset graphs are unsupported. Signup and OAuth creation
also remain single-command graphs; unknown callback shapes fail closed.

Mutable core records carry internal monotonically increasing revisions. The
adapter reads that compiler-owned revision, sends it to an exact update
command, and retries a bounded stale outcome. This preserves partial-update
semantics without allowing a client-side read/modify/write race to overwrite
an unrelated concurrent change. Revisions are not exposed as Better Auth
model fields.

Password-only account updates use the same revision protocol. The adapter
queries the bounded `(organization_id, user_id, provider_id)` index, submits
every observed revision to `UpdateAccountPasswords`, and retries a stale whole
command. An OAuth refresh therefore cannot restore a password from an older
account snapshot.

## Upstream patterns adopted

The adapter follows Better Auth's documented `createAdapterFactory` boundary
and lets that factory own its standard model/field mapping and value
transformations. It uses the current `@better-auth/test-utils/adapter`
conformance harness rather than reproducing the upstream tests.

Community adapters are useful compatibility references, especially the
non-relational Convex, Firestore, InstantDB, and DynamoDB implementations. The
patterns worth retaining are:

- declare storage capabilities explicitly in the adapter factory;
- keep transport/storage mechanics behind a small typed seam;
- derive and validate schema metadata before serving requests;
- exercise the adapter through Better Auth's own conformance suite; and
- treat pagination, uniqueness, and atomic consumption as database semantics,
  not incidental adapter conveniences.

RiffDB intentionally does not copy their generic CRUD dispatch, unbounded
page-draining, sequential multi-row mutation, or callback-transaction
patterns. Its seam consists of generated named operations for a compiled
profile, with explicit bounds and idempotency identity.

## Profile planning boundary

Better Auth's `createSchema` hook is exposed through a generation-only adapter.
It captures Better Auth's resolved tables after plugins, additional fields,
and storage-name overrides have been applied. The deterministic plan records
only bounded declarative metadata and never connects to RiffDB.

A plan is not a runtime database schema. Materializing it requires a reviewed
RiffDB contract, finite named queries and commands for the call shapes used by
that Better Auth configuration, generated bindings, and equivalent conformance
tests. This separation makes the profile customizable without turning schema
generation into a generic database or weakening the application-facing safety
boundary. The generation adapter rejects every runtime method.

## Planning materialization

`materializeRiffDBBetterAuthProfile` turns a reviewed plan into the first two
of those artifacts: one contract and one named query per accepted call shape,
plus the application source binding them. It emits source for review and
compilation, never a deployment, and it never connects to RiffDB.

Rows partition on `tenant_id`. The column is deliberately not `organization_id`
because the organization plugin contributes a model of that name, whose
synthesized key column would collide. Each model's key column is likewise
resolved against the rest of its entity: Better Auth's `account` carries the
provider's own `accountId`, so that entity keys on `account_row_id`.

Aggregate assignment follows the reference graph. A model with no references is
a root; a model that references a root becomes that root's child, choosing the
first such reference in sorted field order so the assignment is deterministic;
anything else is its own root, because a RiffDB aggregate is one level deep and
a child cannot own children. A child's key is prefixed by its root's key, which
is what makes the aggregate provable.

Deletion follows from that shape. A root cascades to its children, naming each
relationship and the reverse index that serves it. SPEC DEL-004 bounds the
whole discovered graph at `root_count_maximum * (1 + sum(maxima)) <= 256`, so a
wide aggregate lowers its per-relationship maximum and its bulk-delete root
count rather than failing to compile: `user` owns five children and admits one
root per command, `organization` owns two and admits three.

The generator does not pretend to enforce what RiffDB cannot prove. A cascade
may not cross an aggregate (DEL-003) and must cover every inbound relationship
exactly once (DEL-002), so a join model that reaches two roots can declare only
the edge that owns it. Every other edge becomes an indexed `uuid` field and is
listed in the materialization report as an unenforced reference. For the
representative organization and two-factor plan those are
`invitation.organizationId`, `member.userId`, and `teamMember.teamId`; the
adapter, not the contract, is responsible for their integrity. A reviewer who
needs one of them enforced changes the aggregate assignment by hand.

`profiles/organization-security/` is the materialized fixture for the
representative plan, regenerated by `npm run profiles:materialize` and verified
byte-for-byte by `npm run profiles:check`. It ships its own `riffdb.toml`, so
the claim made about it is checkable directly: `riffdb application check` in
that directory compiles the contract and all twenty queries.

References:

- <https://better-auth.com/docs/guides/create-a-db-adapter>
- <https://better-auth.com/docs/adapters/community-adapters>
- <https://github.com/get-convex/better-auth>
- <https://github.com/yultyyev/better-auth-firestore>
- <https://github.com/datar-platform/better-auth-dynamodb>

## Executable runtime profiles

`materializeRiffDBBetterAuthRuntimeProfile` extends the reviewed core sources
with a finite operation catalogue and emits `profile.ts`. After source review,
`riffdb application lock --write` generates its named client and exact immutable
identity. The adapter accepts that bound module, compares its schema plan with
the resolved Better Auth schema, and instantiates the generated client. It never
accepts a JSON schema as executable storage or a caller-supplied CRUD callback.

The runtime generator currently accepts scalar custom user fields and the
reviewed default organization and two-factor schemas. Baseline fields,
references, requiredness, and secret classification cannot be overridden.
Organization teams, dynamic access control, and mutation hooks are rejected.
Additional plugins and call shapes need a reviewed compiler implementation.
`nextCookies` is a reviewed integration plugin and adds no storage schema; its
ID is excluded from storage plans while runtime validation checks its version.

The sample applications live in `profiles/custom-fields/` and `profiles/runtime/`.
They have separate locks and generated clients. Source freshness, compilation,
package contents, and official real-service authentication conformance are
checked for all advertised profiles. The custom-field profile runs the official
additional-fields test against a contract already carrying that field.

Runtime profiles place all entities under one tenant aggregate. This intentionally
serializes same-tenant commands and lets member and invitation rows retain both
user and organization references. Compiled reads hydrate related rows through
bounded dependent batches in the same snapshot; the adapter only associates
those returned identities. It enables native joins for these profiles and
rejects unmatched joins before querying, rather than invoking factory fallback
join queries.

The current compiler refuses a command binding two entities carrying cascade
policies, even when they are read parents. Therefore the organization profile
omits user deletion and rejects `user.deleteUser.enabled`; organization deletion
cascades both memberships and invitations atomically. This is a limitation of
this layout and compiler surface, not permission to remove either reference.
The core and custom-field profiles retain their compiled user cascade.

Organization capacity is authoritative: member and invitation creation mutate
the organization's internal counters with a guard below 100, and individual
deletions release capacity atomically. The organization delete graph has at most
201 rows. Membership creation plus session activation during invitation
acceptance is another single compiled graph. Invitation status guards admit
one racer; upstream Better Auth owns its higher-level acceptance and compensation
flow around that graph.

Native 2FA commands increment failure counters, set locks under a threshold
guard, reset expired locks, and replace backup codes under an exact old-value
guard. An internal millisecond field tracks the optional lock timestamp in the
same commands, so the expiry comparison stays a native scalar predicate. Every
secret result leaf has an explicit `reveals` declaration. No counter or backup-
code path invokes Better Auth's generic mutation fallback.

Profile changes require explicit data migration review. The shared tenant
aggregate and plugin fields cannot reinterpret an installed core profile.
Internal revisions, capacity counters, required fields, reference targets, and
secret authority must be initialized and verified before adopting a new lock.
No automatic migration or mixed-profile runtime is supplied.

The broader planning materializer still supports schema exploration for teams.
Better Auth 1.7's optional unique `teamMember.membershipKey` needs an explicit
`requireUniqueValues` review: RiffDB cannot enforce a nullable unique field.
The planning fixture requires a non-null key on every row and reports that
stronger storage requirement. It cannot accept legacy null-key rows and is not
an advertised runtime profile.

## Default core profile exclusions

- renamed models or fields;
- additional user/session fields;
- plugin models or plugin-added fields;
- numeric, serial, mixed, or database-generated identifiers;
- arbitrary joins, predicates, offsets beyond the compiled bound, or sort
  combinations outside the named user-window queries;
- Better Auth database hooks that imply additional database mutations; and
- secondary storage implemented by RiffDB.

These exclusions describe the default core profile; the executable profiles
above provide reviewed extensions. Each addition needs an explicit bounded contract and semantic tests.

## Closed RiffDB blockers

The loopback conformance run deploys the exact contract and role and connects
through `riffdb-driverd`. The initial empty `FindUserByEmail` result carries the
valid application head `0`; `@riffdb/client@0.2.2` preserves it
as `0n`. The adapter does not issue an unrelated warmup write, so the first
application-visible mutation remains the compiled signup graph.

RiffDB now supports bounded cascade deletion across the `Account` and `Session`
inbound relationships, so user deletion retains stored referential integrity
and executes as one compiled command.

Named RiffQL queries now support exact compiler-declared secret output leaves.
The application role derives dedicated secret-field visibility from each
selected immutable query, which closes the former `RDB-AUTH-0214` failure
without using read-only commands or broadening the role manually.

Unary compiled deletes can now return the exact transaction-revalidated
preimage, including explicitly authorized secret leaves. Verification
consumption therefore has one durable delete/result boundary rather than a
query followed by a delete.

RiffQL now supports finite exact text predicates, numeric offsets, exact totals,
independent ordering, and explicit null placement. The generated TypeScript
client also emits only reachable compact decoders, so it compiles under strict
consumer `noUnusedLocals` settings without generated-source suppressions.


## Secrets and authority

Session tokens, verification values, passwords, OAuth access/refresh tokens,
and ID tokens require deliberate secret classification in the generated
RiffDB contract. Every named RiffQL result leaf that returns one carries an
exact `reveals` annotation. That declaration participates in immutable query
and role identity, while the generated Better Auth server role receives only
the corresponding secret-field visibility. These queries are typed SDK reads
and are omitted from MCP tool generation. End-user identity and session
semantics remain Better Auth's responsibility; the adapter must not turn them
into RiffDB capability administration.
