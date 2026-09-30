import * as sdk from "./index.ts";

let registered = false;

/**
 * Makes `import … from "@jev-cops/sdk"` in policy files resolve to this SDK. A compiled
 * `jev-cops`/`copsd` binary loads policies from disk, where no `node_modules` or
 * tsconfig path can supply the package; this registers a Bun runtime virtual module so
 * policies get the binary's own copy (the same one the engine validates with).
 * Idempotent; call it before loading policies.
 */
export function registerSdkModule(): void {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "jev-cops-sdk",
    setup(build) {
      build.module("@jev-cops/sdk", () => ({ exports: { ...sdk }, loader: "object" }));
    },
  });
}
