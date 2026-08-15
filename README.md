# `@riffdb/better-auth`

An external Better Auth database adapter for RiffDB.

Status: pre-alpha core-profile implementation. The adapter and its complete
compiled RiffDB application are implemented, generated, and pass Better Auth's
official core authentication-flow suite. A real loopback run currently stops
on the RiffDB TypeScript driver's empty-database frontier bug described below.

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
read-after-commit fencing. Unknown predicates, joins, models, fields, plugins,
transaction graphs, counts, and increments fail closed before a dynamic query
or mutation can be sent.

## Local development

Start the RiffDB development registries from the RiffDB repository, using one
immutable driver publication. This project scopes only `@riffdb/*` packages to
the loopback Verdaccio endpoint in `.npmrc`; Better Auth and ordinary tooling
continue to resolve from npm.

```bash
npm ci
npm run check
```

The current lock is pinned to `@riffdb/client@0.1.0-dev.3`. If the RiffDB
driver changes, publish a new immutable build number and update that exact
dependency deliberately. `npm start` is the development-only runner used by
`riffdb dev --run`; ordinary applications import the package instead.

## Current RiffDB blocker

On a fresh database, the first named query correctly has application head
`0`. The published `@riffdb/client@0.1.0-dev.3` decoder accepts only positive
`application_head` values and throws `invalid RiffDB driver message` before
returning the empty result. Better Auth must query for an existing email before
the first signup command, so the adapter cannot legitimately warm the database
with a write to avoid this condition. The RiffDB driver must accept a
non-negative query frontier (including zero), followed by a new immutable
local-registry build of the CLI and client packages.

After that driver fix, rerun:

```bash
riffdb dev --run
```

The included runner exercises signup, sign-in, password reset, changed-password
sign-in, and single-use reset-token replay against the real Rust service and
driver host.

See [DESIGN.md](./DESIGN.md) for the method and safety inventory.
