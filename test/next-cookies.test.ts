import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { riffdbAdapterForTesting } from "../src/testing.js";
import { FakeRiffDBApplicationTransport } from "./support/fake-transport.js";

const request = vi.hoisted(() => ({ headers: new Headers(), set: vi.fn() }));
vi.mock("next/headers.js", () => ({ headers: async () => request.headers, cookies: async () => ({ set: request.set }) }));

describe("reviewed nextCookies integration", () => {
  beforeEach(() => { request.headers = new Headers(); request.set.mockClear(); });
  function setup() {
    const transport = new FakeRiffDBApplicationTransport();
    const database = riffdbAdapterForTesting({ transport, organizationId: "018f5f7e-7b0c-7d9a-8f14-77f42f53c851", resetModel: (model) => transport.resetModel(model) });
    const options = {
      baseURL: "http://localhost:3000", secret: "riffdb-better-auth-next-cookie-test-secret",
      database, advanced: { database: { generateId: "uuid" as const } },
      emailAndPassword: { enabled: true, password: { hash: async (password: string) => password,
        verify: async ({ hash, password }: { hash: string; password: string }) => hash === password } },
      plugins: [nextCookies()],
    };
    return { auth: betterAuth(options), adapter: database(options), transport };
  }

  it("sets the Next.js request cookies after a server API signup", async () => {
    const { auth } = setup();
    await auth.api.signUpEmail({ body: { email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID(), name: "Next Cookie" } });
    expect(request.set.mock.calls.some(([name]) => name === "better-auth.session_token")).toBe(true);
  });

  it("suppresses RSC refresh and refreshes the session in a Server Action", async () => {
    const { auth, adapter, transport } = setup();
    const signedUp = await auth.api.signUpEmail({ body: { email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID(), name: "Next Session" }, returnHeaders: true });
    const cookie = signedUp.headers.getSetCookie().map((header) => header.split(";")[0]).join("; ");
    await adapter.update({ model: "session", where: [{ field: "token", value: signedUp.response.token }],
      update: { expiresAt: new Date(Date.now() + 3_600_000) } });
    request.set.mockClear(); transport.commandLog.splice(0);
    request.headers = new Headers({ RSC: "1" });
    await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(transport.commandLog.includes("UpdateSession")).toBe(false);
    expect(request.set.mock.calls.length).toBe(0);
    request.headers.set("next-action", "test-action");
    await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(transport.commandLog.includes("UpdateSession")).toBe(true);
    expect(request.set.mock.calls.some(([name]) => name === "better-auth.session_token")).toBe(true);
  });
});
