import { type PolicyDefinition, type Question, validatePolicy } from "@jev-cops/core";

/**
 * Declares a policy: the module's default export (spec §Policy-as-code DSL). At the type
 * level it is the identity over {@link PolicyDefinition}, with `Q` inferred from `ask` so
 * `decide`, `reason`, `detail`, `rewrite` and `contextNote` receive answers keyed by the
 * literal question names, with literal choice options and rubric labels. At runtime it
 * runs the loader's own structural check, so a malformed policy throws at import time
 * with every problem listed, instead of being skipped by the daemon's loader later.
 * Returns the validated, frozen policy.
 */
export function definePolicy<const Q extends readonly Question[] = readonly []>(
  policy: PolicyDefinition<Q>,
): PolicyDefinition<Q> {
  const checked = validatePolicy(policy);
  if (!checked.ok) {
    const name = typeof policy?.name === "string" ? policy.name : "<unnamed>";
    throw new TypeError(`definePolicy(${JSON.stringify(name)}): ${checked.error.join("; ")}`);
  }
  return checked.value as unknown as PolicyDefinition<Q>;
}
