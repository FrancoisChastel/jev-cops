/**
 * Golden scenarios (PLAN-M2 §9 "compiler fixtures"): each compiles to `<name>.yaml` (unless
 * refused) and `<name>.report.txt` next to this file. Regenerate with
 * `JEV_COPS_UPDATE_GOLDENS=1 bun test packages/openshell` and review the diff.
 */
import type { CompileInput } from "../src/compile.ts";
import { STARTER_POLICY_REFS } from "../src/findings.ts";
import { defaultLayout } from "../src/layout.ts";

const JUDGE = { port: 17_681 };
const GITHUB_HTTPS = { host: "github.com", transport: "https", port: 443 } as const;
const GITHUB_SSH = { host: "github.com", transport: "ssh", port: 22 } as const;

/** One golden: a name and the compiler input. */
export interface Scenario {
  readonly name: string;
  readonly input: CompileInput;
}

const claude = { harness: "claude-code", layout: defaultLayout("claude-code") } as const;
const pi = { harness: "pi", layout: defaultLayout("pi") } as const;

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "claude-code-npm-github",
    input: {
      ...claude,
      policies: STARTER_POLICY_REFS,
      task: "Fix the flaky test in src/cart.test.ts",
      repo: { lockfiles: ["package-lock.json"], remote: GITHUB_HTTPS },
      judge: JUDGE,
    },
  },
  {
    name: "claude-code-baseline",
    input: { ...claude, policies: STARTER_POLICY_REFS, task: null, repo: null, judge: JUDGE },
  },
  {
    name: "claude-code-task-hosts",
    input: {
      ...claude,
      policies: STARTER_POLICY_REFS,
      task: "Update the client to https://docs.stripe.com/api/v2 and test against api.stripe.com",
      repo: { lockfiles: ["bun.lock", "uv.lock"], remote: GITHUB_SSH },
      judge: JUDGE,
    },
  },
  {
    name: "pi-pypi-ssh",
    input: {
      ...pi,
      policies: STARTER_POLICY_REFS,
      task: "Add retries to the uploader",
      repo: { lockfiles: ["poetry.lock"], remote: GITHUB_SSH },
      judge: JUDGE,
    },
  },
  {
    name: "t13-judge-hosts",
    input: {
      ...claude,
      policies: STARTER_POLICY_REFS,
      task: "Find out why openrouter.ai rejects our key; compare https://api.typesafe.ai/v1 with docs.example.com",
      repo: null,
      judge: JUDGE,
      judgeHosts: ["llm.corp.example"],
    },
  },
  {
    name: "refused-home-in-workspace",
    input: {
      ...claude,
      layout: { ...claude.layout, home: "/sandbox/home" },
      policies: STARTER_POLICY_REFS,
      task: null,
      repo: null,
      judge: JUDGE,
    },
  },
];
