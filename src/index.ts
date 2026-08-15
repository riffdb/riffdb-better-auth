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
  RiffDBBetterAuthCallError,
  riffdbAdapter,
  type RiffDBBetterAuthAdapterConfig,
  type RiffDBBetterAuthCallErrorCode,
} from "./adapter.js";
