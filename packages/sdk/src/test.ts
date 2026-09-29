import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type PolicyDefinition, validatePolicy } from "@jevdict/core";
import { type FixtureFile, parseFixtures } from "./fixtures.ts";
import { runFixtureCase } from "./runner.ts";

/**
 * `bun:test` adapter for policy fixtures: `bun test policies/` is the M0 gate until
 * `jevdict test` exists. Kept out of the SDK's main entry so loading a policy never
 * imports the test runner.
 */

/** `x.ts` → `x.fixtures.json`, next to the policy module. */
export function fixturePathFor(policyModulePath: string): string {
  return `${policyModulePath.replace(/\.(?:ts|js|mjs)$/, "")}.fixtures.json`;
}

function readFixturesSync(path: string): FixtureFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(
      `cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = parseFixtures(raw);
  if (!parsed.ok) throw new Error(`invalid fixtures ${path}:\n${parsed.error.join("\n")}`);
  return parsed.value;
}

async function importPolicy(path: string, expectedName: string): Promise<PolicyDefinition> {
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const checked = validatePolicy(mod.default);
  if (!checked.ok) throw new Error(`${path}: ${checked.error.join("; ")}`);
  if (checked.value.name !== expectedName) {
    throw new Error(`fixtures are for policy "${expectedName}", not "${checked.value.name}"`);
  }
  return checked.value;
}

/** Options for {@link describeFixtures}. */
export interface DescribeFixturesOptions {
  /** Judge with this policy set instead of the module's policy alone. */
  policies?: readonly PolicyDefinition[];
  /** Suffix for the describe block, e.g. `"with the starter set"`. */
  label?: string;
}

/**
 * Registers one `test()` per case of the policy's `*.fixtures.json`, inside a `describe`
 * named after the policy file. The fixture file is read synchronously so every case is
 * registered up front; an unreadable or invalid file throws here, failing the test file
 * loudly instead of registering nothing. A failing case throws its diff. Returns the
 * registered case names.
 */
export function describeFixtures(
  policyModulePath: string | URL,
  opts: DescribeFixturesOptions = {},
): string[] {
  const modulePath =
    policyModulePath instanceof URL
      ? Bun.fileURLToPath(policyModulePath)
      : resolve(policyModulePath);
  const file = readFixturesSync(fixturePathFor(modulePath));
  const label = opts.label === undefined ? file.policy : `${file.policy} (${opts.label})`;
  let policy: Promise<PolicyDefinition> | undefined;
  describe(label, () => {
    for (const c of file.cases) {
      test(c.name, async () => {
        policy ??= importPolicy(modulePath, file.policy);
        const p = await policy;
        const result = await runFixtureCase(p.name, c, opts.policies ?? [p]);
        if (!result.ok) throw new Error(`${c.name}\n${result.diff ?? ""}`);
      });
    }
  });
  return file.cases.map((c) => c.name);
}
