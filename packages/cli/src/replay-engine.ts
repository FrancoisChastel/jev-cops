import {
  type Answer,
  type CaseFile,
  type ContextConfigInput,
  createDisabledJudge,
  createMockJudge,
  createPolicyEngine,
  InMemoryCaseFileStore,
  type Judge,
  mergeConfig,
  openCaseFile,
  type PolicyConfigInput,
  type PolicyDefinition,
  type PolicyEngine,
  parseEvent,
  type RepoHints,
  resetBudget,
  resolveContextConfig,
  resolvePolicyConfig,
  type Verdict,
} from "@jevdict/core";
import { type AuditLine, type Precedent, PrecedentStore, withDerivedGit } from "@jevdict/daemon";
import { FIXTURE_WHEN_BUDGET_MS } from "@jevdict/sdk";
import {
  derivedGitOf,
  type JudgePayload,
  judgeView,
  precedentSchema,
  recordedAnswers,
} from "./audit-view.ts";

/** One re-judged event: the recorded and the new engine verdict, and honesty notes. */
export interface ReplayEvent {
  readonly eventId: string;
  readonly sessionId: string;
  readonly old: Verdict;
  readonly next: Verdict;
  readonly oldRisk: number;
  readonly newRisk: number;
  /** Why this event's replay may differ from the original for reasons other than policy. */
  readonly notes: readonly string[];
}

/** Everything a replay found. */
export interface ReplayReport {
  readonly events: readonly ReplayEvent[];
  readonly deltas: number;
  /** Lines that could not be replayed at all. */
  readonly problems: readonly string[];
}

/** Per root session: what the log lets us rebuild of its history. */
interface History {
  /** Calls judged and returned as runnable (not deny/kill) that have no post line yet. */
  readonly awaitingPost: Set<string>;
  /** Post lines whose output head existed but is not in the log (by design). */
  unloggedHeads: number;
}

interface State {
  at: number;
  context: ContextConfigInput;
  policy: PolicyConfigInput;
  home: string;
  store: InMemoryCaseFileStore | null;
  readonly precedents: PrecedentStore;
  readonly histories: Map<string, History>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function storeOf(s: State): InMemoryCaseFileStore {
  s.store ??= new InMemoryCaseFileStore({
    now: () => s.at,
    config: mergeConfig<ContextConfigInput>(s.context, { home: s.home }),
  });
  return s.store;
}

function historyOf(s: State, sessionId: string): History {
  const root = storeOf(s).rootOf(sessionId);
  const known = s.histories.get(root);
  if (known !== undefined) return known;
  const fresh: History = { awaitingPost: new Set(), unloggedHeads: 0 };
  s.histories.set(root, fresh);
  return fresh;
}

function engineFor(s: State, policies: readonly PolicyDefinition[], judge: Judge): PolicyEngine {
  const recorded = s.policy.when?.budgetMs ?? 0;
  const when = { budgetMs: Math.max(recorded, FIXTURE_WHEN_BUDGET_MS) };
  return createPolicyEngine({
    policies,
    judge,
    contextConfig: resolveContextConfig(
      mergeConfig<ContextConfigInput>(s.context, { home: s.home }),
    ),
    policyConfig: resolvePolicyConfig(mergeConfig<PolicyConfigInput>(s.policy, { when })),
    now: () => s.at,
    precedents: s.precedents,
  });
}

/** Recorded answers → mock judge; only noul answers can be rebuilt from `jev` entries. */
function replayJudge(p: JudgePayload): { judge: Judge; note: string | null } {
  const answers = recordedAnswers(p);
  if (answers !== null)
    return { judge: createMockJudge(answers, { name: "recorded" }), note: null };
  const jev = p.decision.jev;
  if (jev.length === 0) return { judge: createDisabledJudge(), note: null };
  if (jev.some((j) => j.type !== "noul")) {
    return {
      judge: createDisabledJudge(),
      note: "judge answers not fully recorded; replayed without them",
    };
  }
  const rebuilt: Record<string, Answer> = Object.fromEntries(
    jev.map((j) => [j.question, { kind: "noul", p: j.p, confidence: j.confidence } as const]),
  );
  return { judge: createMockJudge(rebuilt, { name: "recorded" }), note: null };
}

function historyNotes(h: History, callId: string): string[] {
  const missing = [...h.awaitingPost].filter((id) => id !== callId).length;
  const notes: string[] = [];
  if (missing > 0) {
    notes.push(
      `history partial: ${missing} earlier call(s) have no post line; their results are not replayed`,
    );
  }
  if (h.unloggedHeads > 0) {
    notes.push(
      `history partial: output of ${h.unloggedHeads} earlier call(s) is not in the audit log (by design); taint and secret content from it are not replayed`,
    );
  }
  return notes;
}

async function onJudge(
  s: State,
  line: AuditLine,
  policies: readonly PolicyDefinition[],
): Promise<ReplayEvent | string> {
  const view = judgeView(line);
  if (!view.ok) return view.error;
  const p = view.payload;
  const parsed = parseEvent(p.event);
  if (!parsed.ok || parsed.value.phase !== "pre")
    return `line ${line.seq}: recorded event is not a valid pre event`;
  // The daemon judged with the env.git it derived from cwd (D-058); replay does too.
  const event = withDerivedGit(parsed.value, derivedGitOf(line.payload));
  s.home = p.home;
  const history = historyOf(s, event.session.id);
  const notes = historyNotes(history, event.call.id);
  const { judge, note } = replayJudge(p);
  const cf = openCaseFile(storeOf(s), event.session.id, event.session.parent_id);
  const hints = p.repo_hints === null ? {} : { repoHints: p.repo_hints as RepoHints };
  const { decision } = await engineFor(s, policies, judge).judge(event, cf, {
    home: s.home,
    ...hints,
  });
  if (note !== null) notes.push(note);
  if (decision.flags.judge === "invalid" && p.answers !== null) {
    notes.push("the policies now ask questions with no recorded answer; the floor stands for them");
  }
  if (p.returned.verdict !== "deny" && p.returned.verdict !== "kill")
    history.awaitingPost.add(event.call.id);
  return {
    eventId: event.id,
    sessionId: event.session.id,
    old: p.decision.verdict,
    next: decision.verdict,
    oldRisk: p.decision.risk,
    newRisk: decision.risk,
    notes,
  };
}

async function onObserve(s: State, line: AuditLine): Promise<string | null> {
  const parsed = parseEvent(line.payload.event);
  if (!parsed.ok || parsed.value.phase !== "post")
    return `line ${line.seq}: recorded event is not a valid post event`;
  const post = withDerivedGit(parsed.value, derivedGitOf(line.payload));
  const cf: CaseFile = openCaseFile(storeOf(s), post.session.id, post.session.parent_id);
  if (post.session.task !== undefined && post.session.task !== "")
    cf.setTaskOnce(post.session.task);
  await engineFor(s, [], createDisabledJudge()).observe(post, cf, { home: s.home });
  const history = historyOf(s, post.session.id);
  history.awaitingPost.delete(post.call.id);
  if (typeof line.payload.head_chars === "number" && line.payload.head_chars > 0)
    history.unloggedHeads += 1;
  return null;
}

function onPrecedent(s: State, line: AuditLine): void {
  const action = line.payload.action;
  const sid = line.session_id;
  if (action === "grant") {
    const p = precedentSchema.safeParse(line.payload.precedent);
    if (p.success) s.precedents.insert(p.data as Precedent);
  } else if (action === "budget-reset" && sid !== undefined) {
    const cf = openCaseFile(storeOf(s), sid, null);
    cf.setBudget(resetBudget(cf.budget, s.at));
  } else if (action === "session-closed" && sid !== undefined) {
    s.precedents.expireSession(sid);
  }
}

function onBoot(s: State, line: AuditLine): void {
  const cfg = line.payload.config;
  if (line.payload.event !== "boot" || !isRecord(cfg)) return;
  s.context = isRecord(cfg.context) ? (cfg.context as ContextConfigInput) : {};
  s.policy = isRecord(cfg.policy) ? (cfg.policy as PolicyConfigInput) : {};
  if (typeof line.payload.home === "string") s.home = line.payload.home;
}

/**
 * Re-judges every recorded pre event with `policies` (spec §Policy DSL: "runs the current
 * policy set over past sessions and prints verdict deltas"). Each session is rebuilt in a
 * fresh in-memory case file from its logged pre and post lines, in order, on the logged
 * clock; recorded judge answers are fed back through the mock judge; granted precedents,
 * budget resets and session closes are replayed. What the log cannot rebuild (post output,
 * posts never logged) is reported per event, never guessed.
 */
export async function replayAudit(
  lines: readonly AuditLine[],
  policies: readonly PolicyDefinition[],
): Promise<ReplayReport> {
  const state: State = {
    at: 0,
    context: {},
    policy: {},
    home: "/",
    store: null,
    precedents: new PrecedentStore(":memory:", {
      now: () => state.at,
      rootOf: (id) => storeOf(state).rootOf(id),
    }),
    histories: new Map(),
  };
  const events: ReplayEvent[] = [];
  const problems: string[] = [];
  try {
    for (const line of lines) {
      state.at = line.at;
      if (line.kind === "boot") onBoot(state, line);
      else if (line.kind === "precedent") onPrecedent(state, line);
      else if (line.kind === "observe") {
        const problem = await onObserve(state, line);
        if (problem !== null) problems.push(problem);
      } else if (line.kind === "judge") {
        const r = await onJudge(state, line, policies);
        if (typeof r === "string") problems.push(r);
        else events.push(r);
      }
    }
  } finally {
    state.precedents.close();
  }
  return { events, deltas: events.filter((e) => e.old !== e.next).length, problems };
}
