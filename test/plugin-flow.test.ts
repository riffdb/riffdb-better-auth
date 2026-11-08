import { DriverApplicationTransport, DriverGeneratedApplicationTransport } from "@riffdb/client";
import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import profile from "../profiles/runtime/profile.js";
import { riffdbAdapter } from "../src/index.js";
import { BetterAuthRuntimeClient } from "../profiles/runtime/src/generated/client.js";

const enabled = process.env.RIFFDB_BETTER_AUTH_TEST_PROFILE === "runtime";
const TENANT = "018f5f7e-7b0c-7d9a-8f14-77f42f53c851";
function sessionHeaders(headers: Headers): Headers {
  return new Headers({ cookie: headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") });
}
function configuration(driver: DriverApplicationTransport) {
  return {
    baseURL: "http://localhost:3000", secret: "riffdb-better-auth-loopback-only-secret-value",
    database: riffdbAdapter({ driver, organizationId: TENANT, profile }),
    advanced: { database: { generateId: "uuid" as const } },
    user: { additionalFields: { locale: { type: "string" as const, required: false as const }, dateField: { type: "date" as const, required: false as const } } },
    emailAndPassword: { enabled: true, password: { hash: async (password: string) => password,
      verify: async ({ hash, password }: { hash: string; password: string }) => hash === password } },
    plugins: [organization({ async sendInvitationEmail() {} }), twoFactor({ issuer: "RiffDB" })],
    logger: { disabled: true },
  };
}

describe.skipIf(!enabled)("compiled organization and 2FA real-service flows", () => {
  let driver: DriverApplicationTransport;
  let auth: ReturnType<typeof betterAuth<ReturnType<typeof configuration>>>;
  beforeAll(async () => {
    const connection = JSON.parse(process.env.RIFFDB_BETTER_AUTH_TEST_DRIVER!);
    connection.identity.contractVersion = BigInt(connection.identity.contractVersion);
    driver = await DriverApplicationTransport.connect(connection);
    auth = betterAuth(configuration(driver));
  });
  afterAll(async () => { await driver?.shutdown(); });

  async function signup() {
    const password = crypto.randomUUID();
    const email = `${crypto.randomUUID()}@example.test`;
    const result = await auth.api.signUpEmail({ body: { email, password, name: "Profile Test", locale: "en" }, returnHeaders: true });
    const headers = sessionHeaders(result.headers);
    const adapter = configuration(driver).database(configuration(driver));
    await adapter.update({ model: "user", where: [{ field: "id", value: result.response.user.id }], update: { emailVerified: true } });
    return { id: result.response.user.id, email, password, headers, adapter };
  }
  async function boundedMap<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let offset = 0; offset < items.length; offset += 8) results.push(...await Promise.all(items.slice(offset, offset + 8).map(run)));
    return results;
  }

  it("creates organizations, accepts one invitation racer, and atomically deletes dependents", async () => {
    const owner = await signup();
    const invited = await signup();
    const org = await auth.api.createOrganization({ body: { name: "Compiled Org", slug: crypto.randomUUID() }, headers: owner.headers });
    expect(Boolean(org?.id)).toBe(true);
    const list = await auth.api.listOrganizations({ headers: owner.headers });
    expect(list.some((entry) => entry.id === org!.id)).toBe(true);
    const invitation = await auth.api.createInvitation({ body: { email: invited.email, role: "member", organizationId: org!.id }, headers: owner.headers });
    const races = await Promise.allSettled([0, 1].map(() => auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: invited.headers })));
    if (races.every((result) => result.status === "rejected")) throw (races[0] as PromiseRejectedResult).reason;
    expect(races.filter((result) => result.status === "fulfilled").length).toBe(1);
    const members = await auth.api.listMembers({ query: { organizationId: org!.id }, headers: owner.headers });
    expect(members.total).toBe(2);
    const full = await auth.api.getFullOrganization({ query: { organizationId: org!.id }, headers: owner.headers });
    expect(full?.members.length).toBe(2);
    await auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers: owner.headers });
    const left = await owner.adapter.count({ model: "member", where: [{ field: "organizationId", value: org!.id }] });
    expect(left).toBe(0);
  });

  it("enrolls TOTP, permits one backup-code racer, and rejects challenge replay", async () => {
    const user = await signup();
    const enrollment = await auth.api.enableTwoFactor({ body: { password: user.password }, headers: user.headers });
    if (enrollment.method !== "totp") throw new Error("unexpected enrollment method");
    const secret = new URL(enrollment.totpURI).searchParams.get("secret")!;
    const code = await createOTP(base32.decode(secret)).totp();
    const verified = await auth.api.verifyTOTP({ body: { code }, headers: user.headers, returnHeaders: true });
    const activeHeaders = sessionHeaders(verified.headers);
    const backupRaces = await Promise.allSettled([0, 1].map(() => auth.api.verifyBackupCode({
      body: { code: enrollment.backupCodes[0]!, disableSession: true }, headers: activeHeaders,
    })));
    expect(backupRaces.filter((result) => result.status === "fulfilled").length).toBe(1);
    const challenge = await auth.api.signInEmail({ body: { email: user.email, password: user.password }, returnHeaders: true });
    const challengeHeaders = sessionHeaders(challenge.headers);
    const completed = await auth.api.verifyBackupCode({ body: { code: enrollment.backupCodes[1]! }, headers: challengeHeaders });
    expect(Boolean(completed.token)).toBe(true);
    const replay = await Promise.allSettled([auth.api.verifyBackupCode({ body: { code: enrollment.backupCodes[2]! }, headers: challengeHeaders })]);
    expect(replay[0]?.status).toBe("rejected");
  });

  it("uses native counters and expiry guards without losing concurrent failures", async () => {
    const user = await signup();
    await auth.api.enableTwoFactor({ body: { password: user.password }, headers: user.headers });
    const row = await user.adapter.findOne<{ id: string }>({ model: "twoFactor", where: [{ field: "userId", value: user.id }] });
    expect(Boolean(row?.id)).toBe(true);
    const increments = await Promise.all(Array.from({ length: 8 }, () => user.adapter.incrementOne<{ failedVerificationCount: number }>({
      model: "twoFactor", where: [{ field: "id", value: row!.id }], increment: { failedVerificationCount: 1 },
    })));
    expect(increments.map((entry) => entry!.failedVerificationCount).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const future = new Date(Date.now() + 60_000);
    await user.adapter.incrementOne({ model: "twoFactor", where: [{ field: "id", value: row!.id },
      { field: "failedVerificationCount", operator: "gte", value: 8 }], increment: {}, set: { lockedUntil: future } });
    const early = await user.adapter.incrementOne({ model: "twoFactor", where: [{ field: "id", value: row!.id },
      { field: "lockedUntil", operator: "lte", value: new Date() }], increment: {}, set: { lockedUntil: null, failedVerificationCount: 0 } });
    expect(early === null).toBe(true);
    const expired = await user.adapter.incrementOne<{ failedVerificationCount: number }>({ model: "twoFactor", where: [{ field: "id", value: row!.id },
      { field: "lockedUntil", operator: "lte", value: new Date(future.getTime() + 1) }], increment: {}, set: { lockedUntil: null, failedVerificationCount: 0 } });
    expect(expired?.failedVerificationCount).toBe(0);
  });

  it("completes an OTP challenge once through compiled verification storage", async () => {
    const user = await signup();
    let delivered = "";
    const otpAuth = betterAuth({ ...configuration(driver), plugins: [organization(), twoFactor({
      otpOptions: { async sendOTP({ otp }) { delivered = otp; } },
    })] });
    await otpAuth.api.enableTwoFactor({ body: { password: user.password, method: "otp" }, headers: user.headers });
    const challenge = await otpAuth.api.signInEmail({ body: { email: user.email, password: user.password }, returnHeaders: true });
    const headers = sessionHeaders(challenge.headers);
    await otpAuth.api.sendTwoFactorOTP({ body: {}, headers });
    expect(delivered.length > 0).toBe(true);
    const completed = await otpAuth.api.verifyTwoFactorOTP({ body: { code: delivered }, headers });
    expect(Boolean(completed.token)).toBe(true);
    const replay = await Promise.allSettled([otpAuth.api.verifyTwoFactorOTP({ body: { code: delivered }, headers })]);
    expect(replay[0]?.status).toBe("rejected");
  });

  it("rolls back token consumption when the password snapshot is stale", async () => {
    const user = await signup();
    const client = new BetterAuthRuntimeClient(new DriverGeneratedApplicationTransport(driver));
    const account = (await client.findCredentialAccount({ organization_id: TENANT, user_id: user.id,
      account_id: user.id, provider_id: "credential" })).value.accounts[0]!;
    const id = crypto.randomUUID();
    const now = new Date();
    await user.adapter.create({ model: "verification", forceAllowId: true, data: { id,
      identifier: crypto.randomUUID(), value: user.id, expiresAt: new Date(now.getTime() + 60_000), createdAt: now, updatedAt: now } });
    const outcome = await client.resetCredentialPassword({ request_id: "", organization_id: TENANT,
      verification_ids: [id], verification_revision: 1n, user_id: user.id, external_account_id: user.id,
      account_id: account.id, account_revision: account.revision + 1n,
      password: crypto.randomUUID(), updated_at: { seconds: BigInt(Math.floor(now.getTime() / 1000)), nanos: 0 } });
    expect(outcome.outcome.outcome).toBe("PasswordAccountStale");
    const retained = await user.adapter.findOne({ model: "verification", where: [{ field: "id", value: id }] });
    expect(retained !== null).toBe(true);
    const unchanged = (await client.findCredentialAccount({ organization_id: TENANT, user_id: user.id,
      account_id: user.id, provider_id: "credential" })).value.accounts[0]!;
    expect(unchanged.password === account.password).toBe(true);
  });

  it("changes a password through Better Auth's current credential selector", async () => {
    const user = await signup();
    const successor = crypto.randomUUID();
    await auth.api.changePassword({ body: { currentPassword: user.password, newPassword: successor }, headers: user.headers });
    const signedIn = await auth.api.signInEmail({ body: { email: user.email, password: successor } });
    expect("user" in signedIn && signedIn.user.id === user.id).toBe(true);
    const old = await Promise.allSettled([auth.api.signInEmail({ body: { email: user.email, password: user.password } })]);
    expect(old[0]?.status).toBe("rejected");
  });

  it("admits one final membership seat and releases it on deletion", async () => {
    const owner = await signup();
    const orgId = crypto.randomUUID();
    await owner.adapter.create({ model: "organization", forceAllowId: true,
      data: { id: orgId, name: "Capacity", slug: crypto.randomUUID(), createdAt: new Date() } });
    const users = Array.from({ length: 101 }, () => crypto.randomUUID());
    await boundedMap(users, (id) => owner.adapter.create({ model: "user", forceAllowId: true,
      data: { id, name: "Seat", email: `${id}@example.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() } }));
    const add = (id: string) => owner.adapter.create<{ id: string }>({ model: "member", data: { organizationId: orgId,
      userId: id, role: "member", createdAt: new Date() } });
    const members = await boundedMap(users.slice(0, 99), add);
    const final = await Promise.allSettled(users.slice(99).map(add));
    expect(final.filter((entry) => entry.status === "fulfilled").length).toBe(1);
    expect(await owner.adapter.count({ model: "member", where: [{ field: "organizationId", value: orgId }] })).toBe(100);
    await owner.adapter.delete({ model: "member", where: [{ field: "id", value: members[0]!.id }] });
    const loserIndex = final.findIndex((entry) => entry.status === "rejected");
    await add(users[99 + loserIndex]!);
    expect(await owner.adapter.count({ model: "member", where: [{ field: "organizationId", value: orgId }] })).toBe(100);
    await owner.adapter.delete({ model: "organization", where: [{ field: "id", value: orgId }] });
    expect(await owner.adapter.count({ model: "member", where: [{ field: "organizationId", value: orgId }] })).toBe(0);
  }, 20_000);
});
