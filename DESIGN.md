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

`consumeOne` must map to one atomic compiled command. Better Auth's fallback
through a transaction callback is not supported. Likewise, any Better Auth
transaction is supported only when one generated RiffDB command represents
the entire atomic graph.

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
- arbitrary joins, offsets, predicates, or sort fields;
- Better Auth database hooks that imply additional database mutations; and
- secondary storage implemented by RiffDB.

The core profile also does not yet provide user deletion. `User` has two
independent inbound reference families (`Account` and `Session`), while the
current RiffDB delete policy can name only one reverse index that must cover
every inbound relationship. RiffDB has no compiled cascade delete. Removing
those references merely to enable deletion would weaken the profile's stored
integrity and is not an acceptable adapter-side workaround. This limitation
needs a reviewed RiffDB capability or a different compiled data model before
Better Auth account deletion can be declared supported.

## Real-service blocker

The first loopback conformance run deploys the exact contract and role and
connects through `riffdb-driverd`, then fails on the initial empty
`FindUserByEmail` result. The server returns the valid initial application head
`0`; `@riffdb/client@0.1.0-dev.3` decodes query heads with a positive-only
integer helper. This is a protocol implementation mismatch in RiffDB, not a
Better Auth call-shape failure. The adapter does not issue an unrelated warmup
write because doing so would hide the broken empty-database contract and add
an application-visible mutation.

These exclusions describe the first profile, not permanent product limits.
Each addition needs an explicit bounded contract and semantic tests.

## Secrets and authority

Session tokens, verification values, passwords, OAuth access/refresh tokens,
and ID tokens require deliberate secret classification in the generated
RiffDB contract. The Better Auth server role must receive only the operations
and field visibility required by the adapter. End-user identity and session
semantics remain Better Auth's responsibility; the adapter must not turn them
into RiffDB capability administration.
