import { exactDecimal } from "@riffdb/client";
import { describe, expect, it } from "vitest";

describe("local RiffDB runtime package", () => {
  it("loads through the project-local development registry", () => {
    const value = exactDecimal("1.25", 10, 2);
    expect(value.scale).toBe(2);
    expect(value.precision).toBe(10);
  });
});
