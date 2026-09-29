import {
  type CaseFile,
  type Event,
  type Judgement,
  type PostEvent,
  type PreEvent,
  parseEvent,
  type VerdictResponse,
} from "@jevdict/core";
import {
  judgePayload,
  latchedPayload,
  observePayload,
  type ReturnedVerdict,
} from "./audit-payload.ts";
import type { Runtime } from "./daemon.ts";
import { HOLD_TOKEN_HASH_PREFIX, type MintedHoldToken, mintHoldToken } from "./hold-tokens.ts";
import type { KillRecord } from "./kill-latch.ts";
import { proposeScope } from "./precedents.ts";
import { type NoHumanReason, noHumanOf } from "./session-facts.ts";
import { harnessVerdict, latchedVerdict } from "./verdict-map.ts";

/** A route's answer: HTTP status and JSON body (null → empty body). */
export interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** 400 with the schema error, so the adapter can log why and fail closed. */
function invalid(error: string, issues: unknown = []): Reply {
  return { status: 400, body: { error, issues } };
}

function parsePhase<P extends Event["phase"]>(
  body: unknown,
  phase: P,
): { ok: true; event: Extract<Event, { phase: P }> } | { ok: false; reply: Reply } {
  const parsed = parseEvent(body);
  if (!parsed.ok) {
    return { ok: false, reply: invalid(parsed.error.message, parsed.error.issues) };
  }
  if (parsed.value.phase !== phase) {
    const route = phase === "pre" ? "/v1/judge" : "/v1/observe";
    return { ok: false, reply: invalid(`expected a ${phase} event on ${route}`) };
  }
  return { ok: true, event: parsed.value as Extract<Event, { phase: P }> };
}

/** `name@version` → `name`: core waives a precedent's policies by name. */
function policyName(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Records a hold the harness will show a human, with the daemon's proposed precedent
 * scope, a fresh single-use token (only its hash is stored; the token expires after
 * `daemon.hold_token_ttl_ms`) and the confirm view the token unlocks. Returns the token
 * for the adapter.
 */
function recordHold(
  rt: Runtime,
  event: PreEvent,
  cf: CaseFile,
  j: Judgement,
  reason: string,
): MintedHoldToken {
  const minted = mintHoldToken();
  const expiresAt = rt.now() + rt.config.daemon.holdTokenTtlMs;
  rt.precedents.recordHold(
    {
      eventId: event.id,
      sessionId: event.session.id,
      scope: proposeScope(j.normalized, cf.task),
      policies: j.decision.policies.map(policyName),
    },
    { hash: minted.hash, expiresAt },
  );
  const view = { event_id: event.id, verdict: "hold", reason, raw: j.normalized.raw } as const;
  rt.confirmViews.put({ ...view, detail: j.decision.detail }, expiresAt);
  return minted;
}

/** What the audit records as returned to the harness: never the raw token, a hash prefix. */
function returnedOf(response: VerdictResponse, token: MintedHoldToken | null): ReturnedVerdict {
  return {
    verdict: response.verdict,
    reason: response.reason,
    context_note: response.context_note,
    updated_input: response.updated_input,
    risk: response.risk,
    features: response.features,
    jev: response.jev,
    ...(token === null ? {} : { hold_token_sha256: token.hash.slice(0, HOLD_TOKEN_HASH_PREFIX) }),
  };
}

/**
 * A call of a session latched killed (D-072 proposal): `kill` without running a policy
 * or touching the case file, and a `judge` line naming the latch.
 */
function judgeLatched(rt: Runtime, event: PreEvent, cf: CaseFile, latched: KillRecord): Reply {
  const { response, mapping } = latchedVerdict(event.id, cf.budget);
  const record = {
    event,
    latched,
    returned: returnedOf(response, null),
    mapping,
    enforcement: rt.config.enforcement.mode,
    home: rt.config.daemon.home,
  };
  rt.audit.append({
    kind: "judge",
    event_id: event.id,
    session_id: event.session.id,
    payload: latchedPayload(record),
  });
  return { status: 200, body: response };
}

/** A `kill` returned to the harness terminates the session: latch it and its root. */
function latchOnKill(rt: Runtime, event: PreEvent, root: string): void {
  rt.latch.latch(event.session.id, root, "kill", event.id);
  rt.audit.append({
    kind: "session",
    event_id: event.id,
    session_id: event.session.id,
    payload: { action: "latch", cause: "kill", root },
  });
}

/** Why no human can answer a hold for `event`: its own mode, else the session's facts. */
function noHumanFor(rt: Runtime, event: PreEvent, root: string): NoHumanReason | null {
  return noHumanOf(event.session.mode, null) ?? rt.facts.get(root)?.noHuman ?? null;
}

/** The engine's judgement of a live session's call, mapped, recorded and answered. */
async function judgeLive(rt: Runtime, sent: PreEvent, cf: CaseFile, root: string) {
  const probed = await rt.gitProbe.apply(sent);
  const event: PreEvent = probed.event;
  const repoHints = rt.repoHints.for(event, probed.remoteHost);
  const home = rt.config.daemon.home;
  const engine = rt.engine();
  const { value: judgement, answers } = await rt.recorder.run(() =>
    engine.judge(event, cf, { home, ...(repoHints === null ? {} : { repoHints }) }),
  );
  rt.degraded.update(judgement.decision.trace);
  const mode = rt.config.enforcement.mode;
  const noHuman = noHumanFor(rt, event, root);
  const { response, mapping } = harnessVerdict(judgement.decision, event.id, mode, noHuman);
  const token =
    response.verdict === "hold" ? recordHold(rt, event, cf, judgement, response.reason) : null;
  const returned = returnedOf(response, token);
  const record = { event: sent, derivedGit: probed.derived, judgement, answers, returned };
  rt.audit.append({
    kind: "judge",
    event_id: event.id,
    session_id: event.session.id,
    payload: judgePayload({ ...record, mapping, enforcement: mode, home, repoHints }),
  });
  if (response.verdict === "kill") latchOnKill(rt, event, root);
  const body = token === null ? response : { ...response, hold_token: token.token };
  return { status: 200, body } satisfies Reply;
}

/**
 * `POST /v1/judge`: validates a pre event. A call of a session latched killed is answered
 * `kill` (`sessionKilled`) without running a policy. Otherwise completes a missing
 * `env.git` from its cwd (D-058), judges it on the session's case file, maps the decision
 * for the harness (detail and scores stripped, hold → deny when no human can answer,
 * observe mode → allow), records a pending hold with its `hold_token` for `/v1/resolve`
 * when the harness will ask a human, appends the `judge` audit line with the adapter's
 * event as sent, what the daemon derived, and the full decision (only a prefix of the
 * token's hash), and latches the session when the harness gets `kill`.
 */
export async function handleJudge(rt: Runtime, body: unknown): Promise<Reply> {
  const parsed = parsePhase(body, "pre");
  if (!parsed.ok) return parsed.reply;
  const event = parsed.event;
  const cf = rt.sessions.open(event);
  const root = rt.sessions.rootOf(event.session.id);
  const enforcing = rt.config.enforcement.mode === "enforce";
  const latched = enforcing ? rt.latch.find(event.session.id, root) : null;
  if (latched !== null) return judgeLatched(rt, event, cf, latched);
  return judgeLive(rt, event, cf, root);
}

/**
 * `POST /v1/observe`: completes a missing `env.git` like `/v1/judge`, records the post
 * event on the case file and in the audit log (as sent, plus `derived.git`); 204.
 */
export async function handleObserve(rt: Runtime, body: unknown): Promise<Reply> {
  const parsed = parsePhase(body, "post");
  if (!parsed.ok) return parsed.reply;
  const probed = await rt.gitProbe.apply(parsed.event);
  const event: PostEvent = probed.event;
  const cf = rt.sessions.open(event);
  await rt.engine().observe(event, cf, { home: rt.config.daemon.home });
  rt.audit.append({
    kind: "observe",
    event_id: event.id,
    session_id: event.session.id,
    payload: observePayload(parsed.event, probed.derived),
  });
  return { status: 204, body: null };
}
