# Design boundary

## Package responsibility

`@riffdb/better-auth` owns Better Auth schema interpretation, profile
generation, adapter method mapping, and Better Auth conformance tests. RiffDB
owns database semantics, compiled operations, authorization, durability,
idempotency, and the Rust-backed TypeScript transport.

## Better Auth 1.6.29 method inventory

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

`consumeOne` maps to one atomic delete-and-return compiled command. The same
command executes immediately when Better Auth invokes `consumeOne` inside its
verification cleanup callback, so two racers cannot both observe a token and
the loser receives `null`. Any remaining identifier-scoped verification rows
are removed afterward by the bounded compiled set command. Signup and OAuth
transactions remain single-command atomic graphs; unknown callback shapes fail
closed.

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

References:

- <https://better-auth.com/docs/guides/create-a-db-adapter>
- <https://better-auth.com/docs/adapters/community-adapters>
- <https://github.com/get-convex/better-auth>
- <https://github.com/yultyyev/better-auth-firestore>
- <https://github.com/datar-platform/better-auth-dynamodb>

## First-profile exclusions

- renamed models or fields;
- additional user/session fields;
- plugin models or plugin-added fields;
- numeric, serial, mixed, or database-generated identifiers;
- arbitrary joins, predicates, offsets beyond the compiled bound, or sort
  combinations outside the named user-window queries;
- Better Auth database hooks that imply additional database mutations; and
- secondary storage implemented by RiffDB.

## Closed RiffDB blockers

The loopback conformance run deploys the exact contract and role and connects
through `riffdb-driverd`. The initial empty `FindUserByEmail` result carries the
valid application head `0`; immutable `@riffdb/client@0.1.0-dev.16` preserves it
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

These exclusions describe the first profile, not permanent product limits.
Each addition needs an explicit bounded contract and semantic tests.

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
