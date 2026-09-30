import {
  type Answer,
  CALL_KINDS,
  type GitInfo,
  gitSchema,
  type JevQuestionType,
  verdictSchema,
} from "@jev-cops/core";
import type { AuditLine } from "@jev-cops/daemon";
import { fixtureAnswerSchema } from "@jev-cops/sdk";
import { z } from "zod";

/**
 * Typed, validated views of audit payloads for `explain` and `replay`. The log is read
 * as untrusted input: a line that does not match is reported, never trusted blindly.
 */

const traceSchema = z.looseObject({
  policy: z.string(),
  matched: z.boolean(),
  asked: z.boolean(),
  answered: z.boolean(),
  verdict: verdictSchema.nullable(),
  capped: z.boolean(),
  fallbackUsed: z.boolean(),
  waived: z.boolean(),
  degraded: z.boolean(),
  note: z.string().nullable(),
});

const jevSchema = z.looseObject({
  question: z.string(),
  type: z.enum(["noul", "choice", "score"]),
  p: z.number(),
  confidence: z.number(),
});

const decisionSchema = z.looseObject({
  verdict: verdictSchema,
  risk: z.number(),
  floor: z.number(),
  reason: z.string(),
  detail: z.string(),
  policies: z.array(z.string()),
  features: z.record(z.string(), z.number()),
  jev: z.array(jevSchema),
  budget: z.looseObject({ spent: z.number(), limit: z.number() }),
  trace: z.array(traceSchema),
  flags: z.record(z.string(), z.unknown()),
});

const repoHintsSchema = z.looseObject({
  lockfiles: z.array(z.string()),
  remoteHost: z.string().optional(),
});

/** The payload of a `judge` line as the daemon writes it (`judgePayload`). */
export const judgePayloadSchema = z.looseObject({
  event: z.unknown(),
  /** The `env.git` fields copsd derived from cwd (D-058); absent when none. */
  derived: z.looseObject({ git: gitSchema }).optional(),
  raw: z.string(),
  stateHash: z.string(),
  normalized: z.looseObject({
    kind: z.enum(CALL_KINDS),
    paths: z.array(z.string()),
    hosts: z.array(z.string()),
    opaque: z.array(z.looseObject({ reason: z.string(), span: z.string() })),
  }),
  decision: decisionSchema,
  why: z.record(z.string(), z.array(z.string())),
  answers: z.record(z.string(), fixtureAnswerSchema).nullable(),
  returned: z.looseObject({ verdict: verdictSchema, reason: z.string() }),
  mapping: z.array(z.string()),
  enforcement: z.string(),
  home: z.string(),
  repo_hints: repoHintsSchema.nullable(),
  flags: z.array(z.string()).optional(),
  prompt_like: z.array(z.string()).optional(),
});

/** A validated `judge` payload. */
export type JudgePayload = z.output<typeof judgePayloadSchema>;
/** One recorded `jev` entry. */
export interface JevEntry {
  question: string;
  type: JevQuestionType;
  p: number;
  confidence: number;
}

/** The validated payload of a `judge` line, or the reason it is not one. */
export function judgeView(
  line: AuditLine,
): { ok: true; payload: JudgePayload } | { ok: false; error: string } {
  if (line.kind !== "judge") return { ok: false, error: `line ${line.seq} is not a judge line` };
  const parsed = judgePayloadSchema.safeParse(line.payload);
  if (parsed.success) return { ok: true, payload: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `line ${line.seq}: ${issue?.path.join(".")}: ${issue?.message}` };
}

/** The `derived.git` of any audit payload, or null when absent or not a valid `env.git`. */
export function derivedGitOf(payload: Readonly<Record<string, unknown>>): GitInfo | null {
  const derived = payload.derived;
  const git = typeof derived === "object" && derived !== null ? Reflect.get(derived, "git") : null;
  const parsed = gitSchema.safeParse(git);
  return parsed.success ? parsed.data : null;
}

/** The recorded full answers, typed as core answers. */
export function recordedAnswers(p: JudgePayload): Record<string, Answer> | null {
  return p.answers === null ? null : (p.answers as Record<string, Answer>);
}

/** A `precedent` line's granted precedent, as the daemon wrote it. */
export const precedentSchema = z.looseObject({
  key: z.string(),
  sessionId: z.string(),
  scope: z.looseObject({
    kind: z.enum(CALL_KINDS),
    commandPrefix: z.string().nullable(),
    host: z.string().nullable(),
    pathPrefix: z.string().nullable(),
    taskHash: z.string(),
  }),
  riskDelta: z.number(),
  grantedAt: z.number(),
  expiresAt: z.number().nullable(),
  policies: z.array(z.string()),
  eventId: z.string(),
  by: z.string(),
});
