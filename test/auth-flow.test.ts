import { authFlowTestSuite, testAdapter } from "@better-auth/test-utils/adapter";
import { DriverApplicationTransport, DriverGeneratedApplicationTransport } from "@riffdb/client";
import { afterAll } from "vitest";
import { organization, twoFactor } from "better-auth/plugins";
import customFieldsProfile from "../profiles/custom-fields/profile.js";
import runtimeProfile from "../profiles/runtime/profile.js";

import { buildRiffDBBetterAuthAdapter } from "../src/adapter.js";
import { RiffDBBetterAuthCoreClient } from "../src/generated/client.js";
import { instantiateProfileClient } from "../src/runtime-profile.js";
import { riffdbAdapterForTesting } from "../src/testing.js";
import { FakeRiffDBApplicationTransport } from "./support/fake-transport.js";

const ORGANIZATION_ID = "018f5f7e-7b0c-7d9a-8f14-77f42f53c851";
const transport = new FakeRiffDBApplicationTransport();
const driverConfig = process.env.RIFFDB_BETTER_AUTH_TEST_DRIVER;
const connection = driverConfig === undefined ? undefined : JSON.parse(driverConfig);
if (connection !== undefined) connection.identity.contractVersion = BigInt(connection.identity.contractVersion);
const driver = connection === undefined ? undefined : await DriverApplicationTransport.connect(connection);
const profileName = process.env.RIFFDB_BETTER_AUTH_TEST_PROFILE ?? "core";
const profile = profileName === "core" ? undefined : profileName === "custom-fields" ? customFieldsProfile : runtimeProfile;
afterAll(async () => { await driver?.shutdown(); });

const { execute } = await testAdapter({
  adapter: () =>
    driver === undefined ? riffdbAdapterForTesting({
      transport,
      organizationId: ORGANIZATION_ID,
      resetModel: (model) => transport.resetModel(model),
    }) : buildRiffDBBetterAuthAdapter({
      client: profile === undefined ? new RiffDBBetterAuthCoreClient(new DriverGeneratedApplicationTransport(driver)) :
        instantiateProfileClient(profile, new DriverGeneratedApplicationTransport(driver), 3) as unknown as Parameters<typeof buildRiffDBBetterAuthAdapter>[0]["client"],
      organizationId: ORGANIZATION_ID,
      ...(profile === undefined ? {} : { profile }),
      // The official harness cleans up only at suite end. The surrounding
      // `riffdb dev` process owns and destroys this isolated database.
      resetModelForTesting: () => 0,
    }),
  runMigrations() {},
  overrideBetterAuthOptions(options) {
    return {
      ...options,
      baseURL: "http://localhost:3000",
      ...(profile === undefined ? {} : {
        user: { ...options.user, additionalFields: { ...options.user?.additionalFields,
          locale: { type: "string", required: false }, dateField: { type: "date", required: false } } },
        plugins: profileName === "runtime" ? [organization(), twoFactor()] : [],
      }),
      advanced: {
        ...options.advanced,
        database: {
          ...options.advanced?.database,
          generateId: "uuid",
        },
      },
    };
  },
  tests: [
    authFlowTestSuite({
      disableTests: profile === undefined ? {
        // This test adds a `dateField` to the user model through
        // `modifyBetterAuthOptions` and rebuilds the adapter in place. The
        // harness re-invokes the adapter factory without re-running
        // migrations, so there is no point at which a contract carrying that
        // field could be compiled. Passing it would require storing unplanned
        // fields dynamically, which is the generic-CRUD escape hatch this
        // adapter exists to refuse. Additional fields are supported through a
        // materialized profile instead; see DESIGN.md "Executable runtime profiles".
        "should sign up with additional fields": true,
      } : {},
    }),
  ],
});

execute();
