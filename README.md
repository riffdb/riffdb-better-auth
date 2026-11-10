# `@riffdb/better-auth`

An external Better Auth database adapter for RiffDB.

Status: core and compiled runtime profiles are implemented for Better Auth
`~1.7.18` (`1.7.18+` in the `1.7.x` line). The default core profile, a custom-field profile, and an organization
plus 2FA profile run through Better Auth's official authentication-flow suite
against a real TLS loopback RiffDB service. The custom-field profile also runs
the official additional-fields test.

`nextCookies()` is supported with each profile. Organizations and 2FA require
an explicitly selected, deployed compiled profile. Teams and dynamic access
control remain unsupported. The organization profile also rejects user deletion;
its stored member and invitation references remain enforced.

## Architecture boundary

Better Auth-specific code lives in this repository, never in RiffDB. The
adapter dispatches only to generated named RiffDB commands and queries from a
reviewed compiled profile. It does not expose generic CRUD, accept arbitrary
transaction callbacks, perform client-side authorization filtering, or
silently fall back for unknown models, fields, joins, predicates, or plugins.

The default core runtime profile is deliberately exact:

- Better Auth `~1.7.18` (`>=1.7.18 <1.8.0`);
- the four default core models and their default field names;
- UUID identifiers for every model;
- the reviewed `nextCookies()` integration, with no storage plugins or additional fields; and
- the bundled `RiffDBBetterAuthCore` contract and `BetterAuthServer` role.

Unsupported configuration fails before any RiffDB request. A custom or plugin
profile requires its own generated contract, named operations, client facade,
and conformance tests. `materializeRiffDBBetterAuthRuntimeProfile` emits the
reviewable runtime sources and binding; RiffDB compiles and locks their client.
Adapter construction also verifies that the resolved
`better-auth` installation is in the compatible `~1.7.18` range (`1.7.18+` within `1.7.x`); package-manager overrides outside `~1.7.18` do
not bypass that runtime check. Secret-bearing Better Auth debug logging is
rejected rather than forwarded to the factory logger.

## Runtime use

```ts
import { DriverApplicationTransport } from "@riffdb/client";
import { betterAuth } from "better-auth";
import { riffdbAdapter } from "@riffdb/better-auth";

const driver = await DriverApplicationTransport.connectFromEnv();

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
deploy the core profile. Better Auth development dependencies stay exactly
pinned. Supported versions are explicit; a scheduled registry check flags new
stable releases for schema, call-shape, and conformance review.

For Next.js Server Actions, import `nextCookies` from `better-auth/next-js`
and add `nextCookies()` as the last plugin in the Better Auth configuration.
It can accompany the default core profile or the compiled profiles below.
Cookie propagation, RSC refresh suppression, and Server Action refresh behavior
are covered by integration tests using the official plugin and mocked Next.js
request helpers.

## Organization and 2FA runtime profile

Deploy `profiles/runtime/riffdb.application.json` and its exact lock before
connecting the driver. Select its binding explicitly:

```ts
import profile from "@riffdb/better-auth/profiles/organization-security";
import { organization, twoFactor } from "better-auth/plugins";

const auth = betterAuth({
  database: riffdbAdapter({ driver, organizationId: tenantId, profile }),
  advanced: { database: { generateId: "uuid" } },
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      locale: { type: "string", required: false },
      dateField: { type: "date", required: false },
    },
  },
  plugins: [
    organization({ membershipLimit: 100, invitationLimit: 100 }),
    twoFactor(),
  ],
});
```

These are example profile fields; `dateField` also serves the upstream
conformance test. Generate a separate reviewed profile to use a different field
inventory. The standalone custom-field example is available at
`@riffdb/better-auth/profiles/custom-fields` and deploys from
`profiles/custom-fields/` without storage plugins.

The adapter's `organizationId` is the application's RiffDB tenant partition.
The organization plugin's `organizationId` identifies an auth organization
inside that partition. They are separate identifiers.

The organization profile supports organization creation/update/listing, active
organization sessions, membership listing/counts/roles/removal, invitations and
guarded status transitions, and atomic organization/dependent deletion.
Membership creation and session activation during invitation acceptance share
one compiled command. Native capacity guards admit at most 100 live memberships
and 100 retained invitations per organization; deleting an individual record
releases its capacity. Lists are bounded at 100, membership offsets at 4096,
and user hydration sets at 32. Member pages support the compiled default role
order, role ascending/descending, and creation-time ascending/descending.
Other member filters and sorts are rejected.

2FA supports TOTP enrollment/verification, OTP challenges, backup codes,
challenge consumption, and account lockout. Failure increments, expired-lock
reset, backup-code replacement, and invitation status transitions use native
compiled commands. Tests cover TOTP enrollment, backup-code and invitation
races, challenge replay, lockout counters, capacity contention, and reset rollback.

Teams, dynamic access control, organization mutation hooks, renamed storage,
plugin-model custom fields, user deletion in organization profiles, and
`revokeSessionsOnPasswordReset` are rejected. Password changes that request
`revokeOtherSessions` also require a separately compiled transaction graph.
Organization limits must be integers from 1 through 100. Custom runtime fields
currently support scalar strings, booleans, safe integers, and dates on `user`;
custom indexes, uniqueness,
and references require a separately implemented profile. Credential password
reset supports an existing credential account and one verification row per
identifier. Additional transaction graphs fail closed.

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
npx auth@1.7.18 generate --config ./auth.profile.ts --yes
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

## Materializing an executable profile

Pass the reviewed plan to `materializeRiffDBBetterAuthRuntimeProfile(plan)`.
Write the returned `files` under a new application directory, review the
contract, queries, and `profile.ts`, then run `riffdb application lock --write`
in that directory. Compile `profile.ts` and the generated TypeScript client
with your application and pass its default export as `riffdbAdapter({ profile,
driver, organizationId })`. A JSON plan alone cannot be passed to the adapter.
Runtime construction compares the resolved schema and reviewed plugins with
the bound plan before requests. Binding also checks compiler-owned command and
result schemas, so a stale client cannot silently omit a new optional field.
The generated client and driver enforce the exact compiled application and
operation identities.

The planning fixture also reports its explicit non-null requirement for the
optional unique team membership key; it cannot accept legacy null-key rows.

The executable generator accepts the core schema plus the reviewed organization
and 2FA schemas. The broader `materializeRiffDBBetterAuthProfile` remains a
planning tool: its teams example reports unenforced references and is not an
executable runtime profile.

Regenerate the executable examples with `npm run profiles:runtime`, review
the source diff, and write each application's lock explicitly. `npm run
profiles:check` verifies source freshness, compiler locks, and generated clients.

A different profile is a different compiled application identity. There is no
automatic switch or reinterpretation of existing core data. For existing
installations, plan and review an explicit data migration, including identifier
mapping, required/default fields, references, secrets, and capacity counts.
Deploy the matching contract, operations, role, and client together. Never point
a new binding at an old lock. Runtime profile examples are intended for fresh
installations until an application-specific migration has been reviewed.

## Local development

```bash
npm ci --ignore-scripts
npm run check
```

The lock is pinned to `@riffdb/client@0.2.2` and `@riffdb/cli@0.2.2`.

`npm run check` performs strict type checking, semantic and upstream tests,
profile-artifact freshness, a production build, and a package dry run.

## Real loopback conformance

Run the official suite against isolated TLS services and Rust driver hosts:

```bash
npm run test:loopback
```

This runs the core, custom-field, and organization/2FA profiles. It requires
`riffdbd` and `riffdb-driverd` from the RiffDB `0.2.2` release bundle (or a
checkout at the full revision recorded in `.github/riffdb-revision`) on `PATH`.
`RIFFDB_CLI`, `RIFFDB_SERVER_BIN`, and `RIFFDB_DRIVERD` can also select exact
local binary paths.

Release CI verifies the bundle checksum and revision before running the
loopback suite. Certificates, capabilities, sockets, and databases
are disposable and removed at the end. The official
harness's cleanup hook is scoped to that disposable service; it is never a
public delete-all operation.

The original `scripts/real-riffdb-runner.mjs` also remains available to an
external harness supplying its ten exact driver-identity arguments.

See [DESIGN.md](./DESIGN.md) for the method and safety inventory. The adapter
follows Better Auth's
[database-adapter guide](https://better-auth.com/docs/guides/create-a-db-adapter)
and uses its official pinned conformance utilities.


## RiffDB compatibility CI

This adapter owns its RiffDB compatibility checks. Pull requests compile the
application sources and verify existing locks and generated artifacts against
the full commit in `.github/riffdb-revision`. Scheduled checks use RiffDB
`main`; manual dispatch accepts a full commit or `main`. Failures are reported
here and do not block RiffDB itself. The job also runs `npm run check` and
`npm run test:loopback`, including the official Better Auth suite for every
advertised runtime profile.

To upgrade, update the pin, migrate sources as needed, review the result of
`riffdb application lock --write`, and verify with `riffdb application check`.
Commit the pin and migration together in this repository.
