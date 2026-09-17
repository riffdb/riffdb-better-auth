# `@riffdb/better-auth`

An external Better Auth database adapter for RiffDB.

Status: pre-alpha, unpublished. The core runtime profile is implemented and
passes Better Auth's pinned authentication-flow suite plus a real RiffDB
loopback suite. Profile planning is implemented for custom fields and plugins,
and a reviewed plan now materializes into a RiffDB contract, named queries, and
application source that compile. Binding a materialized profile to a running
adapter instance is not implemented: the adapter still dispatches only to the
core profile's generated client.

## Architecture boundary

Better Auth-specific code lives in this repository, never in RiffDB. The
adapter dispatches only to generated named RiffDB commands and queries from a
reviewed compiled profile. It does not expose generic CRUD, accept arbitrary
transaction callbacks, perform client-side authorization filtering, or
silently fall back for unknown models, fields, joins, predicates, or plugins.

The shipped runtime profile is deliberately exact:

- Better Auth `1.6.29`;
- the four default core models and their default field names;
- UUID identifiers for every model;
- no runtime plugins or additional fields; and
- the bundled `RiffDBBetterAuthCore` contract and `BetterAuthServer` role.

Unsupported configuration fails before any RiffDB request. A custom or plugin
profile requires its own generated contract, named operations, client facade,
and conformance tests; `npm run profiles:materialize` generates the first two
from a reviewed plan. Adapter construction also verifies that the resolved
`better-auth` installation is exactly `1.6.29`; package-manager overrides do
not bypass that runtime check. Secret-bearing Better Auth debug logging is
rejected rather than forwarded to the factory logger.

## Runtime use

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

The caller owns the RiffDB driver connection and application-defined
organization ID. Better Auth continues to own users, sessions, passwords,
sign-in, OAuth, and reset flows. The package contains the exact RiffDB
application source, lock, contract bundle, and generated artifacts required to
deploy the core profile.

## Implemented core surface

The core profile supports:

- atomic email/password signup and OAuth user/account creation;
- user, account, session, and verification create/read/update/delete paths;
- revision-guarded partial updates with bounded stale retries;
- atomic delete-and-return single-use verification consumption;
- bounded dependent and cascade deletion;
- active-session, token-set, provider-account, and verification queries;
- exact user counts with an optional UUID or bounded email text predicate; and
- bounded user windows with numeric offsets and compiled email, creation-time,
  or nullable-image ordering.

User windows accept at most 100 results and an offset no greater than 4096.
Email search supports `contains`, `starts_with`, and `ends_with`; every accepted
filter/order combination maps to a distinct generated RiffQL query. Unsupported
counts, fields, filters, orderings, joins, transaction graphs, and increments
fail closed.

Token-set session reads use one bounded compiled membership query. Combining a
token set with an expiry cutoff remains unsupported until that exact compound
predicate has its own reviewed named query. Verification listing accepts its
compiled default order, plus `createdAt desc` with `limit: 1`; every other
verification sort is rejected before a RiffDB request.

Secret account credentials, session tokens, and verification values are read
by named RiffQL queries whose exact returned leaves carry compiler-checked
`reveals` declarations. The generated role receives authority only for those
leaves. These reads remain queries, while commands are reserved for writes and
atomic state transitions. Secret-output queries are excluded from generated
MCP tools by RiffDB.

## Planning a custom profile

`riffdbProfileAdapter` integrates with Better Auth's `createSchema` hook and
does not require a live database. It resolves the complete Better Auth schema,
including plugin models and additional fields, into a deterministic bounded
profile plan:

```ts
import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import { riffdbProfileAdapter } from "@riffdb/better-auth";

export const auth = betterAuth({
  database: riffdbProfileAdapter({
    name: "BetterAuthOrganizationSecurity",
    contractLineage: "BetterAuthOrganizationSecurity",
    applicationRole: "BetterAuthServer",
    output: "riffdb/better-auth.profile.json",
  }),
  advanced: { database: { generateId: "uuid" } },
  user: {
    additionalFields: {
      locale: { type: "string", required: false },
    },
  },
  plugins: [organization({ teams: { enabled: true } }), twoFactor()],
});
```

With that generation-only config, run the Better Auth CLI version matching the
pinned runtime:

```bash
npx auth@1.6.29 generate --config ./auth.profile.ts --yes
```

The output records resolved storage names, field types, required/unique/index
metadata, references, secret classification, default/update behavior, plugin
IDs, and finite profile bounds. It is an input to reviewed RiffDB profile
materialization, not a dynamically executable schema or migration. Runtime
methods on the generation-only adapter always fail.

The checked-in
[`profiles/organization-security.profile.json`](./profiles/organization-security.profile.json)
is a reproducible organization, teams, two-factor, and custom-user-field
example. Regenerate or verify it with:

```bash
npm run profiles:write
npm run profiles:check
```

## Local development

Start the four RiffDB development registries from the RiffDB repository using
one immutable driver publication. This repository's `.npmrc` scopes only
`@riffdb/*` packages to loopback Verdaccio; Better Auth and ordinary tooling
still resolve from npm.

```bash
npm install
npm run check
```

The lock is pinned to `@riffdb/client@0.1.0-dev.16` and
`@riffdb/cli@0.1.0-dev.16`. Driver changes require a new immutable local build
number and deliberate lock update. Nothing in this repository is published as
part of the current development workflow.

`npm run check` performs strict type checking, semantic and upstream tests,
profile-artifact freshness, a production build, and a package dry run.

## Real loopback conformance

Run the real service/driver flow with:

```bash
riffdb dev --run
```

The included runner exercises signup, sign-in, password reset and replay
rejection, user/session/account/verification mutation paths, atomic OAuth
creation, exact counts, bounded search/offset windows, nullable ordering,
dependent cleanup, and read-after-commit fencing against the Rust service and
driver host.

See [DESIGN.md](./DESIGN.md) for the method and safety inventory. The adapter
follows Better Auth's
[database-adapter guide](https://better-auth.com/docs/guides/create-a-db-adapter)
and uses its official pinned conformance utilities.
