import { type ContextConfig, DEFAULT_CONTEXT_CONFIG } from "../context/config.ts";
import { computeFeatures } from "../context/features.ts";
import type { RepoHints } from "../context/scope.ts";
import type { CaseFile } from "../context/types.ts";
import { withQuestionLimit, withTimeout, withValidation } from "../judge/guard.ts";
import { buildJudgeState } from "../judge/state.ts";
import type { Judge } from "../judge/types.ts";
import { normalize } from "../normalizer/normalize.ts";
import type { NormalizedEvent } from "../normalizer/types.ts";
import type { PreEvent } from "../schema/event.ts";
import { combine } from "./combine.ts";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "./config.ts";
import { buildPolicyContext } from "./context.ts";
import { createWhenTracker, evaluatePolicies, type WhenTracker } from "./evaluate.ts";
import { buildPolicyEvent } from "./event.ts";
import { floorRisk } from "./floor.ts";
import { planQuestions } from "./questions.ts";
import type {
  JudgeCallOptions,
  Judgement,
  PolicyContext,
  PolicyDefinition,
  PolicyEngine,
  PolicyEngineOptions,
  PolicyEvent,
  PrecedentLookup,
  PrecedentMatch,
} from "./types.ts";

/**
 * Key for the repeated-hold surcharge (T7): the event kind plus its sorted verbs, never
 * its arguments, so near-identical holds with different paths or hosts share one key.
 */
export function holdKey(n: NormalizedEvent): string {
  const verbs = [...new Set(n.commands.flatMap((c) => c.verbs))].sort();
  return `${n.kind}:${verbs.join(",")}`;
}

function lookupPrecedent(
  store: PrecedentLookup | undefined,
  e: PolicyEvent,
  ctx: PolicyContext,
): PrecedentMatch | null {
  try {
    return store?.lookup(e, ctx) ?? null;
  } catch {
    return null; // a broken store must never lower risk
  }
}

/** What the engine closes over; built once by {@link createPolicyEngine}. */
interface Runtime {
  policies: readonly PolicyDefinition[];
  contextConfig: ContextConfig;
  config: PolicyConfig;
  now: () => number;
  tracker: WhenTracker;
  judge: Judge;
  precedents: PrecedentLookup | undefined;
}

function hintsOf(o: JudgeCallOptions): { repoHints?: RepoHints } {
  return o.repoHints === undefined ? {} : { repoHints: o.repoHints };
}

/** normalize → features → floor → the policy views, all read-only over the case file. */
async function readEvent(rt: Runtime, event: PreEvent, cf: CaseFile, o: JudgeCallOptions) {
  const n = await normalize(event, { home: o.home });
  const features = computeFeatures(n, cf, rt.contextConfig, hintsOf(o));
  const floor = floorRisk(features.features, rt.config).risk;
  const { contextConfig, config } = rt;
  const inputs = { n, cf, features, floor, contextConfig, ...hintsOf(o), home: o.home };
  const ctx = buildPolicyContext({ ...inputs, protectedPaths: config.protectedPaths });
  return { n, features, floor, e: buildPolicyEvent(n, cf.task), ctx };
}

async function judgeEvent(
  rt: Runtime,
  event: PreEvent,
  cf: CaseFile,
  o: JudgeCallOptions,
): Promise<Judgement> {
  if (event.session.task !== undefined) cf.setTaskOnce(event.session.task);
  const { n, features, floor, e, ctx } = await readEvent(rt, event, cf, o);
  const { config } = rt;
  const matches = evaluatePolicies(rt.policies, e, ctx, {
    tracker: rt.tracker,
    sessionId: event.session.id,
    config,
  });
  const { scopeUnsure } = features;
  const plan = planQuestions({ matches, e, ctx, floor, scopeUnsure, task: cf.task, config });
  const state = buildJudgeState(n, cf, features.features, config.judge.state);
  const judged = plan.batch.length === 0 ? null : await rt.judge.ask(state, plan.batch);
  const decision = combine({
    event: e,
    ctx,
    features: features.features,
    why: features.why,
    matches,
    plan,
    judged,
    precedent: lookupPrecedent(rt.precedents, e, ctx),
    budget: cf.budget,
    holdKey: holdKey(n),
    now: rt.now(),
    config,
    budgetConfig: rt.contextConfig.budget,
  });
  cf.setBudget(decision.nextBudget);
  cf.recordPre(n, { taint: features.features.taint });
  return { decision, normalized: n, features };
}

/**
 * The policy engine: normalize → features → floor → policies' `when` → one batched judge
 * request (only in the uncertain band) → combine → charge the budget on the case file →
 * `recordPre`. It composes and never decides: every rule lives in `combine`. The given
 * judge always gets the question limit, answer validation and the timeout.
 */
export function createPolicyEngine(opts: PolicyEngineOptions): PolicyEngine {
  const config = opts.policyConfig ?? DEFAULT_POLICY_CONFIG;
  const timed = withTimeout(opts.judge, { timeoutMs: config.judge.timeoutMs });
  const rt: Runtime = {
    policies: [...opts.policies],
    contextConfig: opts.contextConfig ?? DEFAULT_CONTEXT_CONFIG,
    config,
    now: opts.now ?? Date.now,
    tracker: createWhenTracker(config.when.trackedSessions),
    judge: withQuestionLimit(withValidation(timed), config.judge.maxQuestions),
    precedents: opts.precedents,
  };
  return {
    judge: (event, cf, o) => judgeEvent(rt, event, cf, o),
    async observe(event, cf, o) {
      const n = await normalize(event, { home: o.home });
      cf.recordPost(n);
      return n;
    },
  };
}
