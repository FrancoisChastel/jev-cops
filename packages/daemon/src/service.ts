import {
  type CaseFile,
  type Event,
  type Judgement,
  type PostEvent,
  type PreEvent,
  parseEvent,
} from "@jevdict/core";
import { judgePayload, observePayload } from "./audit-payload.ts";
import type { Runtime } from "./daemon.ts";
import { HOLD_TOKEN_HASH_PREFIX, type MintedHoldToken, mintHoldToken } from "./hold-tokens.ts";
import { proposeScope } from "./precedents.ts";
import { harnessVerdict } from "./verdict-map.ts";

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
 * scope and a fresh single-use token (only its hash is stored; the token expires after
 * `daemon.hold_token_ttl_ms`). Returns the token for the adapter.
 */
function recordHold(rt: Runtime, event: PreEvent, cf: CaseFile, j: Judgement): MintedHoldToken {
  const minted = mintHoldToken();
  rt.precedents.recordHold(
    {
      eventId: event.id,
      sessionId: event.session.id,
      scope: proposeScope(j.normalized, cf.task),
      policies: j.decision.policies.map(policyName),
    },
    { hash: minted.hash, expiresAt: rt.now() + rt.config.daemon.holdTokenTtlMs },
  );
  return minted;
}

/**
 * `POST /v1/judge`: validates a pre event, judges it on the session's case file, maps
 * the decision for the harness (detail stripped, D-008 headless hold → deny, observe
 * mode → allow), records a pending hold with its `hold_token` for `/v1/resolve` when the
 * harness will ask a human, and appends the `judge` audit line with the full decision
 * (and only a prefix of the token's hash) before answering.
 */
export async function handleJudge(rt: Runtime, body: unknown): Promise<Reply> {
  const parsed = parsePhase(body, "pre");
  if (!parsed.ok) return parsed.reply;
  const event: PreEvent = parsed.event;
  const cf = rt.sessions.open(event);
  const repoHints = rt.repoHints.for(event);
  const home = rt.config.daemon.home;
  const engine = rt.engine();
  const { value: judgement, answers } = await rt.recorder.run(() =>
    engine.judge(event, cf, { home, ...(repoHints === null ? {} : { repoHints }) }),
  );
  const { decision } = judgement;
  rt.degraded.update(decision.trace);
  const mode = rt.config.enforcement.mode;
  const { response, mapping } = harnessVerdict(decision, event.id, mode, event.session.mode);
  const token = response.verdict === "hold" ? recordHold(rt, event, cf, judgement) : null;
  const returned = {
    verdict: response.verdict,
    reason: response.reason,
    context_note: response.context_note,
    updated_input: response.updated_input,
    ...(token === null ? {} : { hold_token_sha256: token.hash.slice(0, HOLD_TOKEN_HASH_PREFIX) }),
  };
  const record = {
    event,
    judgement,
    answers,
    returned,
    mapping,
    enforcement: mode,
    home,
    repoHints,
  };
  rt.audit.append({
    kind: "judge",
    event_id: event.id,
    session_id: event.session.id,
    payload: judgePayload(record),
  });
  return {
    status: 200,
    body: token === null ? response : { ...response, hold_token: token.token },
  };
}

/** `POST /v1/observe`: records a post event on the case file and in the audit log; 204. */
export async function handleObserve(rt: Runtime, body: unknown): Promise<Reply> {
  const parsed = parsePhase(body, "post");
  if (!parsed.ok) return parsed.reply;
  const event: PostEvent = parsed.event;
  const cf = rt.sessions.open(event);
  await rt.engine().observe(event, cf, { home: rt.config.daemon.home });
  rt.audit.append({
    kind: "observe",
    event_id: event.id,
    session_id: event.session.id,
    payload: observePayload(event),
  });
  return { status: 204, body: null };
}
