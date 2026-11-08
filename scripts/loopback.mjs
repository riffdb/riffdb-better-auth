import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const applicationRoot = resolve(process.argv[2] ?? ".");
const root = await mkdtemp(join(tmpdir(), "riffdb-auth-"));
const cli = process.env.RIFFDB_CLI ?? resolve("node_modules/.bin/riffdb");
const lockPath = join(applicationRoot, "riffdb.application.lock.json");
const manifestPath = join(applicationRoot, "generated/riffdb.application.exact.json");
const catalogPath = join(applicationRoot, "generated/mcp/tools.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const role = lock.roles.find((entry) => entry.definition.name === "BetterAuthServer");
assert.ok(role);
const portReservation = createServer();
await new Promise((resolve) => portReservation.listen(0, "127.0.0.1", resolve));
const port = portReservation.address().port;
await new Promise((resolve) => portReservation.close(resolve));
const endpoint = `https://127.0.0.1:${port}`;
const tlsRoot = join(root, "tls");
const cliRun = (args, remote = true) => {
  const result = spawnSync(cli, [...(remote ? ["--endpoint", endpoint, "--database", "default", "--tls-trust-root", join(tlsRoot, "ca.pem")] : []), ...args],
    { cwd: applicationRoot, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `RiffDB setup command failed: ${result.stderr}`);
  return result.stdout;
};
const protectedFile = (path, value) => writeFile(path, value, { mode: 0o600 });
await mkdir(join(root, "backups"));
await mkdir(join(root, "projections"));
await protectedFile(join(root, "capability.keys"), `riffdb-capability-digest-keys-v1\n1:${randomBytes(32).toString("hex")}\n`);
await protectedFile(join(root, "idempotency.keys"), `riffdb-idempotency-digest-keys-v1\n1:${randomBytes(32).toString("hex")}\n`);
cliRun(["tls", "issue", "--out-dir", tlsRoot, "--endpoint", endpoint], false);
const quote = JSON.stringify;
await protectedFile(join(root, "server.toml"), `[server]\ndatabase = ${quote(join(root, "database.redb"))}\nenvironment = "development"\naudience = "riffdb-grpc-loopback"\ncapability_keys = ${quote(join(root, "capability.keys"))}\nidempotency_keys = ${quote(join(root, "idempotency.keys"))}\n\n[server.application_listener]\nmode = "direct_tls"\nlisten = "127.0.0.1:${port}"\npublic_endpoint = ${quote(endpoint)}\ncertificate_chain = ${quote(join(tlsRoot, "server.pem"))}\nprivate_key = ${quote(join(tlsRoot, "server.key"))}\n\n[maintenance]\nbackup_root = ${quote(join(root, "backups"))}\nprojections_root = ${quote(join(root, "projections"))}\n`);
const children = [];
const launch = (program, args) => { const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.once("error", (error) => { child.launchError = error; });
  child.stderr.on("data", () => {}); children.push(child); return child; };
try {
  const server = launch(process.env.RIFFDB_SERVER_BIN ?? "riffdbd", ["--config", join(root, "server.toml")]);
  await Promise.race([
    new Promise((resolve, reject) => {
      server.stdout.on("data", (chunk) => { if (chunk.toString().includes("riffdbd-ready-v1")) resolve(); });
      server.once("error", reject); server.once("exit", () => reject(new Error("RiffDB server exited before readiness")));
    }), setTimeout(15_000, undefined, { ref: false }).then(() => { throw new Error("RiffDB server readiness deadline exceeded"); }),
  ]);
  await protectedFile(join(root, "bootstrap-request.json"), JSON.stringify({ principal_id: "better-auth-loopback-operator", actor_kind: "human",
    requested_lifetime_seconds: 3600, audiences: ["riffdb-grpc-loopback"], grant: {
      tenant_scope: { type: "global" }, partition_scope: { type: "all" }, permissions: [
        { type: "read_contract" }, { type: "deploy_contract" }, { type: "read_health" }, { type: "administer_capabilities" }],
      field_visibility: [], max_scan_rows: 1, approval_required: [],
    } }));
  cliRun(["capability", "bootstrap", "--request", join(root, "bootstrap-request.json"), "--generate", join(root, "bootstrap.credential"), "--bearer-output", join(root, "operator.credential")]);
  cliRun(["--credential-file", join(root, "operator.credential"), "application", "deploy", "riffdb.application.json", "--lock", "riffdb.application.lock.json"]);
  cliRun(["--credential-file", join(root, "operator.credential"), "role", "bind", "generated/riffdb.application.exact.json", "--role", "BetterAuthServer", "--principal", "app:better-auth-loopback", "--actor-kind", "service", "--lifetime-seconds", "3600", "--audience", "riffdb-grpc-loopback", "--credential-output", join(root, "profile.credential")]);
  const socketPath = join(root, "driver.sock");
  await protectedFile(join(root, "driverd.toml"), `[driver]\nsocket = ${quote(socketPath)}\n\n[application]\nlock_file = ${quote(lockPath)}\nmanifest_file = ${quote(manifestPath)}\noperation_catalog_file = ${quote(catalogPath)}\ndatabase = "default"\nrole = "BetterAuthServer"\n\n[remote]\nendpoint = ${quote(endpoint)}\ntls_trust_root = ${quote(join(tlsRoot, "ca.pem"))}\ncredential_file = ${quote(join(root, "profile.credential"))}\npool_connections = 2\nstreams_per_connection = 64\n`);
  const host = launch(process.env.RIFFDB_DRIVERD ?? "riffdb-driverd", [join(root, "driverd.toml")]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (host.launchError !== undefined) throw new Error("RiffDB driver executable is unavailable");
    if (host.exitCode !== null) throw new Error("RiffDB driver exited before readiness");
    try { await access(socketPath); ready = true; break; } catch { await setTimeout(50); }
  }
  assert.ok(ready, "RiffDB driver readiness deadline exceeded");
  const identity = { applicationManifestHash: lock.exact_manifest_hash,
    operationCatalogHash: lock.artifacts.find((entry) => entry.kind === "mcp").content_hash,
    database: "default", role: "BetterAuthServer", roleDefinitionHash: role.definition_hash,
    remoteIdentityHash: createHash("sha256").update(`${endpoint}|127.0.0.1`).digest("hex"),
    contractLineage: manifest.contract.lineage, contractVersion: String(manifest.contract.version), contractBundleHash: manifest.contract.bundle_hash };
  const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "test/auth-flow.test.ts", ...(process.argv[3] === "plugins" ? ["test/plugin-flow.test.ts"] : [])], {
    stdio: "inherit", timeout: 120_000, env: { ...process.env,
      RIFFDB_BETTER_AUTH_TEST_DRIVER: JSON.stringify({ socketPath, identity }),
      RIFFDB_BETTER_AUTH_TEST_PROFILE: applicationRoot === resolve(".") ? "core" : applicationRoot.endsWith("custom-fields") ? "custom-fields" : "runtime" },
  });
  assert.equal(run.status, 0, "official Better Auth adapter loopback failed");
} finally {
  for (const child of children.reverse()) { if (child.pid === undefined) continue; child.kill("SIGTERM"); await Promise.race([new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); }), setTimeout(5000, undefined, { ref: false }).then(() => { child.kill("SIGKILL"); })]); }
  await rm(root, { recursive: true, force: true });
}
