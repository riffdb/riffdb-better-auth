import type { DBAdapterDebugLogOption } from "better-auth/adapters";

import { buildRiffDBBetterAuthAdapter } from "./adapter.js";
import {
  RiffDBBetterAuthCoreClient,
  type ApplicationTransport,
} from "./generated/client.js";

export interface RiffDBBetterAuthTestingAdapterConfig {
  readonly transport: ApplicationTransport;
  readonly organizationId: string;
  readonly commandAttemptBudget?: number;
  readonly debugLogs?: DBAdapterDebugLogOption;
  readonly resetModel: (model: string) => number | Promise<number>;
}

export function riffdbAdapterForTesting(config: RiffDBBetterAuthTestingAdapterConfig) {
  const commandAttemptBudget = config.commandAttemptBudget ?? 1;
  return buildRiffDBBetterAuthAdapter({
    client: new RiffDBBetterAuthCoreClient(config.transport, commandAttemptBudget),
    organizationId: config.organizationId,
    resetModelForTesting: config.resetModel,
    ...(config.debugLogs === undefined ? {} : { debugLogs: config.debugLogs }),
  });
}
