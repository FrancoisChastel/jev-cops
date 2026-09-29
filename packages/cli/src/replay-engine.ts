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
import { isLatchedLine, latchedView, sessionPromptTask } from "./audit-session.ts";
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

/**
 * A call the kill latch answered. No policy ran for it, so it is replayed as `kill` and
 * kept apart from {@link ReplayEvent}s: the latch is session state, not a policy decision,
 * and is never a delta.
 */
export interface ReplayLatched {
  readonly eventId: string;
  readonly sessionId: string;
  readonly verdict: "kill";
  /** What latched the session: `kill` or `config-change`. */
  readonly cause: string;
  /** The judged call or session report that latched it. */
  readonly latchedBy: string;
  readonly notes: readonly string[];
}

/** Everything a replay found. */
export interface ReplayReport {
  readonly events: readonly ReplayEvent[];
  /** Calls answered by the kill latch, in log order. */
  readonly latched: readonly ReplayLatched[];
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
  /** The replayed verdict per event id, for the notes of calls a latch answered. */
  readonly replayed: Map<string, Verdict>;
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
  s.replayed.set(event.id, decision.verdict);
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

/**
 * A `session` line: the root's first prompt sets the case-file task (the daemon writes the
 * task on that line only, T11); a root's `end` ends its precedents as `/v1/session` does.
 * Start, later prompts, config changes, latch and unlatch change no case file: a latch is
 * carried by the judge lines it answered.
 */
function onSession(s: State, line: AuditLine): void {
  const prompt = sessionPromptTask(line);
  if (prompt !== null) {
    openCaseFile(storeOf(s), prompt.sessionId, null).setTaskOnce(prompt.task);
    return;
  }
  const rootEnd = line.payload.report === "end" && line.payload.parent_id === null;
  if (rootEnd && line.session_id !== undefined) s.precedents.expireSession(line.session_id);
}

/** A judge line the kill latch answered: `kill`, with why, never a policy verdict. */
function onLatched(s: State, line: AuditLine): ReplayLatched | string {
  const view = latchedView(line);
  if (!view.ok) return view.error;
  const l = view.payload.latched;
  const notes = [
    `session latched since ${l.event_id} (cause ${l.cause}); the latch is state, not a policy decision: replayed as kill`,
  ];
  const origin = s.replayed.get(l.event_id);
  if (l.cause === "kill" && origin !== undefined && origin !== "kill") {
    notes.push(
      `the call that latched it (${l.event_id}) now replays as ${origin}: without the latch this call would be judged by the policies`,
    );
  }
  const ids = { eventId: line.event_id ?? "?", sessionId: line.session_id ?? "?" };
  return { ...ids, verdict: "kill", cause: l.cause, latchedBy: l.event_id, notes };
}

function onBoot(s: State, line: AuditLine): void {
  const cfg = line.payload.config;
  if (line.payload.event !== "boot" || !isRecord(cfg)) return;
  s.context = isRecord(cfg.context) ? (cfg.context as ContextConfigInput) : {};
  s.policy = isRecord(cfg.policy) ? (cfg.policy as PolicyConfigInput) : {};
  if (typeof line.payload.home === "string") s.home = line.payload.home;
}

/** What the replay collects, in log order. */
interface Found {
  readonly events: ReplayEvent[];
  readonly latched: ReplayLatched[];
  readonly problems: string[];
}

/** A judge line: re-judged by the policies, or, when the latch answered it, reported apart. */
async function onJudgeLine(
  s: State,
  line: AuditLine,
  policies: readonly PolicyDefinition[],
  found: Found,
): Promise<void> {
  if (isLatchedLine(line)) {
    const r = onLatched(s, line);
    if (typeof r === "string") found.problems.push(r);
    else found.latched.push(r);
    return;
  }
  const r = await onJudge(s, line, policies);
  if (typeof r === "string") found.problems.push(r);
  else found.events.push(r);
}

async function onLine(
  s: State,
  line: AuditLine,
  policies: readonly PolicyDefinition[],
  found: Found,
): Promise<void> {
  s.at = line.at;
  if (line.kind === "boot") onBoot(s, line);
  else if (line.kind === "precedent") onPrecedent(s, line);
  else if (line.kind === "session") onSession(s, line);
  else if (line.kind === "observe") {
    const problem = await onObserve(s, line);
    if (problem !== null) found.problems.push(problem);
  } else if (line.kind === "judge") await onJudgeLine(s, line, policies, found);
}

/**
 * Re-judges every recorded pre event with `policies` (spec §Policy DSL: "runs the current
 * policy set over past sessions and prints verdict deltas"). Each session is rebuilt in a
 * fresh in-memory case file from its logged pre, post and `session` lines, in order, on
 * the logged clock (the task from the root's first prompt when the events carry none);
 * recorded judge answers are fed back through the mock judge; granted precedents, budget
 * resets and session closes and ends are replayed. Calls the kill latch answered are
 * replayed as `kill` and listed apart, never as deltas or problems. What the log cannot
 * rebuild (post output, posts never logged) is reported per event, never guessed.
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
    replayed: new Map(),
  };
  const found: Found = { events: [], latched: [], problems: [] };
  try {
    for (const line of lines) await onLine(state, line, policies, found);
  } finally {
    state.precedents.close();
  }
  const deltas = found.events.filter((e) => e.old !== e.next).length;
  return { ...found, deltas };
}
