/**
 * @jev-cops/core — canonical event schema, bash normalizer, context engine,
 * policy engine and verdict ladder. Adapters and the daemon build on this;
 * nothing here knows about any harness.
 */
export const CORE_VERSION = "0.0.0";

export * from "./context/index.ts";
export * from "./judge/index.ts";
export * from "./normalizer/index.ts";
export * from "./policy/index.ts";
export * from "./result.ts";
export * from "./schema/index.ts";
