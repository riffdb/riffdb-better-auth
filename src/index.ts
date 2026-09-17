export {
  BETTER_AUTH_CORE_FIELDS,
  BETTER_AUTH_CORE_MODELS,
  BETTER_AUTH_PINNED_VERSION,
  RIFFDB_BETTER_AUTH_PROFILE_SCHEMA,
  UnsupportedBetterAuthProfileError,
  defineRiffDBBetterAuthCoreProfile,
  type BetterAuthCoreModel,
  type BetterAuthModelShape,
  type RiffDBBetterAuthCoreProfile,
  type RiffDBBetterAuthCoreProfileInput,
  type RiffDBContractIdentity,
} from "./profile.js";

export {
  RIFFDB_BETTER_AUTH_PROFILE_PLAN_SCHEMA,
  RiffDBBetterAuthProfileGenerationError,
  defineRiffDBBetterAuthProfilePlan,
  renderRiffDBBetterAuthProfilePlan,
  riffdbProfileAdapter,
  type RiffDBBetterAuthProfileFieldPlan,
  type RiffDBBetterAuthProfileGenerationErrorCode,
  type RiffDBBetterAuthProfileGeneratorConfig,
  type RiffDBBetterAuthProfileModelPlan,
  type RiffDBBetterAuthProfilePlan,
} from "./profile-plan.js";

export {
  RiffDBBetterAuthCallError,
  riffdbAdapter,
  type RiffDBBetterAuthAdapterConfig,
  type RiffDBBetterAuthCallErrorCode,
} from "./adapter.js";
export {
  materializeRiffDBBetterAuthProfile,
  RiffDBBetterAuthMaterializationError,
  type RiffDBBetterAuthAggregateReport,
  type RiffDBBetterAuthGeneratedQuery,
  type RiffDBBetterAuthMaterialization,
  type RiffDBBetterAuthMaterializationErrorCode,
  type RiffDBBetterAuthMaterializationOptions,
  type RiffDBBetterAuthMaterializationReport,
  type RiffDBBetterAuthUnenforcedReference,
} from "./profile-contract.js";
