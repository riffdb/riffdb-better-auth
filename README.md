# `@riffdb/better-auth`

An external Better Auth database adapter for RiffDB.

Status: pre-alpha core-profile implementation. The adapter and its complete
compiled RiffDB application are implemented, generated, and pass Better Auth's
official core authentication-flow suite. The real loopback suite also passes
against the Rust service and driver host.

## Architecture boundary

Better Auth-specific code lives in this repository, never in RiffDB. The
adapter translates a reviewed Better Auth schema into an ordinary RiffDB
contract and dispatches only to its generated named commands and queries. It
does not expose generic CRUD, accept arbitrary transaction callbacks, perform
client-side authorization filtering, or silently fall back for unknown
models, fields, plugins, joins, or predicates.

The first profile is intentionally limited to:

- Better Auth `1.6.29`;
- the four default core models and their default field names;
- UUID identifiers for every model;
- no plugins or additional fields; and
- one exact compiled RiffDB contract identity and application role.

Unsupported configuration fails before any RiffDB request. Future plugin or
schema support requires a new compiled profile version and conformance tests.

## Use

```ts
import { DriverApplicationTransport } from "@riffdb/client";
import { betterAuth } from "better-auth";
import { riffdbAdapter } from "@riffdb/better-auth";

const driver = await DriverApplicationTransport.connect({
  socketPath,
  identity,
});

export const auth = betterAuth({
  database: riffdbAdapter({
    driver,
    organizationId: "018f5f7e-7b0c-7d9a-8f14-77f42f53c851",
  }),
  advanced: { database: { generateId: "uuid" } },
  emailAndPassword: { enabled: true },
});
```

The package contains the exact application source, lock, contract bundle, and
generated artifacts needed to deploy the profile. The caller owns the RiffDB
driver connection and the application-defined organization ID. Better Auth
continues to own users, sessions, passwords, sign-in, and reset flows.

The implemented profile supports the core email/password flow, including
atomic user/account/session signup, session and account reads, single-use
verification consumption, verification-set cleanup, password update, and
read-after-commit fencing. It also supports revision-guarded user, session, and
linked-account updates; token-based session revocation; bounded session
listing (including active-only and bounded token-set reads); exact
provider-account lookup; atomic OAuth user/account creation; and
revision-guarded verification updates with bounded expiry cleanup.
User deletion is available both as one bounded cascade command and through
Better Auth's dependent-delete sequence. Unknown predicates, joins, models,
fields, plugins,
transaction graphs, counts, and increments fail closed before a dynamic query
or mutation can be sent.

Secret account credentials, session tokens, and verification values are read
by named RiffQL queries whose exact returned leaves carry compiler-checked
`reveals` declarations. The generated application role derives authority only
for those leaves. Reads never dispatch a reveal-shaped command; commands are
reserved for writes and atomic state transitions. Secret-output queries are
excluded from generated MCP tools by RiffDB.

## Local development

Start the RiffDB development registries from the RiffDB repository, using one
immutable driver publication. This project scopes only `@riffdb/*` packages to
the loopback Verdaccio endpoint in `.npmrc`; Better Auth and ordinary tooling
continue to resolve from npm.

```bash
npm install
npm run check
```

The current lock is pinned to `@riffdb/client@0.1.0-dev.6`. If the RiffDB
driver changes, publish a new immutable build number and update that exact
dependency deliberately. `npm start` is the development-only runner used by
`riffdb dev --run`; ordinary applications import the package instead.

Development build 6 has one registry packaging limitation: its x64-only
publication still leaves the unpublished ARM64 CLI package in `@riffdb/cli`'s
optional dependency metadata. `npm install` correctly selects the available
x64 package, but npm rejects a newly generated lock during `npm ci` as missing
the ARM64 entry. RiffDB's development publication must prune unavailable
platform packages (or publish the complete optional package set) before clean
external npm installs are reproducible with `npm ci`.

## Real loopback conformance

On a fresh database, the first named query correctly has application head
`0`. Immutable `@riffdb/client@0.1.0-dev.6` accepts that non-negative query
frontier without relaxing positive-only commit sequences or contract versions.
Better Auth can therefore perform its required existing-email lookup before
the first signup command without an unrelated warmup write.

Run the real loopback flow with:

```bash
riffdb dev --run
```

The included runner exercises signup, sign-in, password reset, changed-password
sign-in, single-use reset-token replay rejection, user and session updates,
active and token-set session reads, token-set revocation, verification update
and expiry cleanup, atomic OAuth user/account creation, provider-account
lookup, linked-account update, and bounded user cleanup against the real Rust
service and driver host.

See [DESIGN.md](./DESIGN.md) for the method and safety inventory.
