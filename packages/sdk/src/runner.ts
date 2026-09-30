import {
  type Answer,
  type CaseFile,
  type ContextConfig,
  createDisabledJudge,
  createMockJudge,
  createPolicyEngine,
  type Decision,
  type Event,
  InMemoryCaseFileStore,
  type Judge,
  mergeConfig,
  openCaseFile,
  type PolicyConfig,
  type PolicyDefinition,
  type PolicyEngine,
  qualify,
  resolveContextConfig,
  resolvePolicyConfig,
  SCOPE_QUESTION,
  type Verdict,
} from "@jev-cops/core";
import {
  type FixtureCase,
  type FixtureConfig,
  type FixtureExpect,
  type FixtureFile,
  loadFixtures,
} from "./fixtures.ts";

/** Fixed start of every case's clock: the spec's example session start. */
export const FIXTURE_EPOCH = Date.parse("2026-09-29T09:12:00Z");
/** Default clock step between consecutive events of a case. */
export const DEFAULT_STEP_MS = 1_000;
/** `~`/`$HOME` for fixtures, so results never depend on the machine running them (D-003). */
export const FIXTURE_HOME = "/home/dev";
/**
 * `when` budget in fixtures. The engine's 2 ms cap is a production guard (tested in
 * core); on a cold JIT or a loaded CI box a first call can overrun it, and an overrun
 * counts as matched, which would make fixtures flaky. A case can set it back.
 */
export const FIXTURE_WHEN_BUDGET_MS = 50;

/** Options for {@link runFixtures}. */
export interface RunFixturesOptions {
  /**
   * The policy set to judge with (default: only the fixture's policy). Passing the whole
   * starter set checks that no other policy changes the fixture's outcome.
   */
  policies?: readonly PolicyDefinition[];
}

/** What the engine decided for one case. */
export interface ActualOutcome {
  verdict: Verdict;
  risk: number;
  policies: string[];
  reason: string;
}

/** One case's outcome; `diff` explains a mismatch and is absent when `ok`. */
export interface CaseResult {
  name: string;
  ok: boolean;
  expected: FixtureExpect;
  actual: ActualOutcome;
  diff?: string;
}

/** Outcome of a whole fixture file. */
export interface FixtureReport {
  passed: number;
  failed: number;
  results: CaseResult[];
}

/** Recorded answers keyed as in the judge batch: bare names belong to `policyName`. */
export function qualifyAnswers(
  policyName: string,
  answers: Readonly<Record<string, Answer>>,
): Record<string, Answer> {
  return Object.fromEntries(
    Object.entries(answers).map(([name, a]) => {
      const verbatim = name.includes("/") || name === SCOPE_QUESTION;
      return [verbatim ? name : qualify(policyName, name), a];
    }),
  );
}

function configsFor(c: FixtureCase): { context: ContextConfig; policy: PolicyConfig } {
  const overrides = (c.config ?? {}) as FixtureConfig;
  const context = resolveContextConfig({ home: FIXTURE_HOME, ...overrides.context });
  // The engine's own scope question is asked only when the case recorded an answer to
  // it; otherwise its absence would invalidate the whole batch (the mock needs them all).
  const scopeQuestion = c.answers !== undefined && Object.hasOwn(c.answers, SCOPE_QUESTION);
  const base = resolvePolicyConfig({
    when: { budgetMs: FIXTURE_WHEN_BUDGET_MS },
    ask: { scopeQuestion },
  });
  return { context, policy: mergeConfig(base, overrides.policy) };
}

function judgeFor(policyName: string, c: FixtureCase): Judge {
  if (c.answers === undefined) return createDisabledJudge();
  return createMockJudge(qualifyAnswers(policyName, c.answers as Record<string, Answer>), {
    name: "recorded",
  });
}

/** A fresh engine, clock and in-memory case-file store for one case. */
function sessionFor(policyName: string, c: FixtureCase, policies: readonly PolicyDefinition[]) {
  const { context, policy } = configsFor(c);
  let at = FIXTURE_EPOCH;
  const now = () => at;
  const store = new InMemoryCaseFileStore({ now, config: context });
  const engine = createPolicyEngine({
    policies,
    judge: judgeFor(policyName, c),
    contextConfig: context,
    policyConfig: policy,
    now,
  });
  const step = c.stepMs ?? DEFAULT_STEP_MS;
  const tick = () => {
    at += step;
  };
  const caseFile = (e: Event): CaseFile => openCaseFile(store, e.session.id, e.session.parent_id);
  return { engine, tick, caseFile, home: context.home };
}

async function feed(engine: PolicyEngine, e: Event, cf: CaseFile, home: string): Promise<void> {
  if (e.phase === "pre") await engine.judge(e, cf, { home });
  else await engine.observe(e, cf, { home });
}

/** Feeds a case's task and history, then judges its event; one fresh session per case. */
async function decide(
  policyName: string,
  c: FixtureCase,
  policies: readonly PolicyDefinition[],
): Promise<Decision> {
  const s = sessionFor(policyName, c, policies);
  if (c.task !== undefined) s.caseFile(c.event).setTaskOnce(c.task);
  for (const e of c.history ?? []) {
    s.tick();
    await feed(s.engine, e, s.caseFile(e), s.home);
  }
  s.tick();
  const { decision } = await s.engine.judge(c.event, s.caseFile(c.event), { home: s.home });
  return decision;
}

function policyMatched(expected: string, matched: readonly string[]): boolean {
  return matched.some((m) => m === expected || m.slice(0, m.lastIndexOf("@")) === expected);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

/** One line per unmet expectation; empty when the decision meets them all. */
export function mismatches(expected: FixtureExpect, d: Decision): string[] {
  const lines: string[] = [];
  if (d.verdict !== expected.verdict) {
    lines.push(`verdict: expected ${expected.verdict}, got ${d.verdict}`);
  }
  for (const p of expected.policies ?? []) {
    if (!policyMatched(p, d.policies)) {
      lines.push(`policies: missing ${p} (matched: ${d.policies.join(", ") || "none"})`);
    }
  }
  if (expected.riskMin !== undefined && d.risk < expected.riskMin) {
    lines.push(`risk: ${d.risk.toFixed(3)} below riskMin ${expected.riskMin}`);
  }
  if (expected.riskMax !== undefined && d.risk > expected.riskMax) {
    lines.push(`risk: ${d.risk.toFixed(3)} above riskMax ${expected.riskMax}`);
  }
  const want = expected.updatedInput;
  if (want !== undefined && stable(want) !== stable(d.updated_input)) {
    lines.push(`updatedInput: expected ${stable(want)}, got ${stable(d.updated_input)}`);
  }
  return lines;
}

/** Runs one case and compares; the diff carries the engine's human detail for debugging. */
export async function runFixtureCase(
  policyName: string,
  c: FixtureCase,
  policies: readonly PolicyDefinition[],
): Promise<CaseResult> {
  const d = await decide(policyName, c, policies);
  const actual = { verdict: d.verdict, risk: d.risk, policies: [...d.policies], reason: d.reason };
  const lines = mismatches(c.expect, d);
  const base = { name: c.name, ok: lines.length === 0, expected: c.expect, actual };
  return lines.length === 0 ? base : { ...base, diff: [...lines, "detail:", d.detail].join("\n") };
}

async function resolveFile(fixtures: string | URL | FixtureFile): Promise<FixtureFile> {
  if (typeof fixtures !== "string" && !(fixtures instanceof URL)) return fixtures;
  const path = fixtures instanceof URL ? Bun.fileURLToPath(fixtures) : fixtures;
  const loaded = await loadFixtures(path);
  if (!loaded.ok) throw new Error(`invalid fixtures: ${loaded.error.join("\n")}`);
  return loaded.value;
}

/**
 * Runs a policy's fixtures through the real policy engine, offline and deterministic:
 * a fresh in-memory case file per case, a fixed clock advancing `stepMs` per event,
 * recorded answers through the mock judge (or a disabled judge when a case has none),
 * `home` pinned to {@link FIXTURE_HOME}. Judges with `opts.policies` (default: only
 * `policy`). Throws when the file is unreadable, invalid, or for another policy.
 */
export async function runFixtures(
  policy: PolicyDefinition,
  fixtures: string | URL | FixtureFile,
  opts: RunFixturesOptions = {},
): Promise<FixtureReport> {
  const file = await resolveFile(fixtures);
  if (file.policy !== policy.name) {
    throw new Error(`fixtures are for policy "${file.policy}", not "${policy.name}"`);
  }
  const policies = opts.policies ?? [policy];
  const results: CaseResult[] = [];
  for (const c of file.cases) results.push(await runFixtureCase(policy.name, c, policies));
  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed, results };
}
