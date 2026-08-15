import { createTestSuite, testAdapter } from "@better-auth/test-utils/adapter";
import { createAdapterFactory } from "better-auth/adapters";
import { describe, expect, it } from "vitest";

describe("pinned Better Auth adapter surface", () => {
  it("provides the factory and current conformance harness", () => {
    expect(createAdapterFactory).toBeTypeOf("function");
    expect(createTestSuite).toBeTypeOf("function");
    expect(testAdapter).toBeTypeOf("function");
  });
});
