import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface GeneratedOperation {
  readonly operation_name: string;
}

interface GeneratedOperations {
  readonly commands: GeneratedOperation[];
  readonly tools: GeneratedOperation[];
  readonly sdk_tools: GeneratedOperation[];
}

const operations = JSON.parse(
  readFileSync(new URL("../generated/mcp/tools.json", import.meta.url), "utf8"),
) as GeneratedOperations;

describe("generated secret-output boundary", () => {
  it("keeps secret RiffQL reads in typed SDKs and out of MCP tools", () => {
    const secretQueries = [
      "FindAccountById",
      "FindAccountByProvider",
      "FindAccountsByUserId",
      "FindAccountsByUserProvider",
      "FindActiveSessionsByUserId",
      "FindLatestVerification",
      "FindSessionById",
      "FindSessionByToken",
      "FindSessionsByTokenSet",
      "FindSessionsByUserId",
      "FindVerificationById",
      "FindVerificationsByIdentifier",
    ];

    expect(operations.sdk_tools.map((operation) => operation.operation_name).sort()).toEqual(
      secretQueries,
    );
    expect(operations.tools.map((operation) => operation.operation_name)).not.toEqual(
      expect.arrayContaining(secretQueries),
    );
    expect(operations.tools.map((operation) => operation.operation_name)).toContain(
      "FindExpiredVerificationIds",
    );
    expect(operations.commands.map((operation) => operation.operation_name)).toContain(
      "ConsumeVerification",
    );
    expect(operations.tools.map((operation) => operation.operation_name)).not.toContain(
      "ConsumeVerification",
    );
    expect(operations.commands.map((operation) => operation.operation_name)).not.toEqual(
      expect.arrayContaining([
        "RevealAccountSecrets",
        "RevealSessionToken",
        "RevealVerificationValue",
      ]),
    );
  });
});
