# AGENTS.md — RiffDB Better Auth adapter

## Mission

Build `@riffdb/better-auth` as an external Better Auth database adapter backed
by the published `@riffdb/client` package. Better Auth-specific behavior stays
in this repository and must never be added to the RiffDB repository.

## Boundaries

1. Use Better Auth's `createAdapterFactory` public surface and its official
   adapter conformance harness.
2. Map every supported adapter call shape to a generated, named RiffDB command
   or query from a reviewed compiled profile.
3. Never expose generic CRUD, arbitrary RiffQL, public transaction callbacks,
   client-side authorization filtering, or silent fallbacks.
4. Implement `consumeOne` as one atomic compiled RiffDB command. Do not rely on
   Better Auth's transaction fallback.
5. Reject unsupported models, fields, plugins, predicates, sorts, joins, ID
   strategies, or Better Auth versions before making a RiffDB request.
6. Keep all inputs, result sizes, scans, pagination, retries, and diagnostics
   bounded. Never log tokens, passwords, verification values, or OAuth secrets.
7. Pin development dependencies and immutable RiffDB driver builds exactly.

## Before merging

- Run `npm run check`.
- Run the official Better Auth adapter suite against a real loopback RiffDB
  service for any adapter behavior change.
- Verify `npm pack --dry-run` includes only intended public artifacts.
- Document supported Better Auth versions and profile limitations.
