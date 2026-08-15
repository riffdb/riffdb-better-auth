# `@riffdb/better-auth`

An external Better Auth database adapter for RiffDB.

Status: pre-alpha scaffolding. The package currently validates the first
compiled profile boundary; it does not yet export a usable Better Auth adapter.

## Architecture boundary

Better Auth-specific code lives in this repository, never in RiffDB. The
adapter will translate a reviewed Better Auth schema into an ordinary RiffDB
contract and dispatch only to its generated named commands and queries. It
will not expose generic CRUD, accept arbitrary transaction callbacks, perform
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
dependency deliberately.

## Next implementation slice

1. Capture Better Auth's core adapter call-shape corpus with
   `@better-auth/test-utils`.
2. Author the complete core RiffDB contract, including all core fields and
   exact unique/reference/secret classifications.
3. Generate the TypeScript facade from the installed RiffDB CLI.
4. Implement a closed call-shape dispatcher over generated named operations.
5. Run the Better Auth adapter suite against a real loopback RiffDB service.

See [DESIGN.md](./DESIGN.md) for the method and safety inventory.
