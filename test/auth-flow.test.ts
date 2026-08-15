import { authFlowTestSuite, testAdapter } from "@better-auth/test-utils/adapter";

import { riffdbAdapterForTesting } from "../src/testing.js";
import { FakeRiffDBApplicationTransport } from "./support/fake-transport.js";

const ORGANIZATION_ID = "018f5f7e-7b0c-7d9a-8f14-77f42f53c851";
const transport = new FakeRiffDBApplicationTransport();

const { execute } = await testAdapter({
  adapter: () =>
    riffdbAdapterForTesting({
      transport,
      organizationId: ORGANIZATION_ID,
      resetModel: (model) => transport.resetModel(model),
    }),
  runMigrations() {},
  overrideBetterAuthOptions(options) {
    return {
      ...options,
      baseURL: "http://localhost:3000",
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
      disableTests: {
        "should sign up with additional fields": true,
      },
    }),
  ],
});

execute();
