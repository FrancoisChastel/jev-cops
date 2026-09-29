import type { NormalizedEvent } from "../normalizer/types.ts";
import {
  type ContextConfig,
  DEFAULT_CONTEXT_CONFIG,
  SEQUENCE_PATTERNS,
  type SequencePatternName,
} from "./config.ts";
import { secretPathReads } from "./record.ts";
import type { CaseFile } from "./types.ts";

/** One windowed sequence pattern (spec §Context model, Sequence). */
export interface SequencePattern {
  name: SequencePatternName;
  weight: number;
  windowMs: number;
}

/** A matched pattern with the call ids that make up its evidence. */
export interface SequenceMatch {
  name: SequencePatternName;
  weight: number;
  evidence: string[];
}

/** Max weight of matched patterns, the matches, and one `why` line per match. */
export interface SequenceScore {
  value: number;
  matches: SequenceMatch[];
  why: string[];
}

/** The pattern table for `cfg`: weights from config, secret-then-net on its own window. */
export function sequencePatterns(cfg: ContextConfig): SequencePattern[] {
  const { weights, windowMs, secretNetWindowMs } = cfg.sequence;
  return SEQUENCE_PATTERNS.map((name) => ({
    name,
    weight: weights[name],
    windowMs: name === "secret-read-then-net" ? secretNetWindowMs : windowMs,
  }));
}

/** The pattern table under the spec defaults. */
export const SEQUENCE_PATTERN_TABLE: ReadonlyArray<Readonly<SequencePattern>> = Object.freeze(
  sequencePatterns(DEFAULT_CONTEXT_CONFIG).map((p) => Object.freeze(p)),
);

type Detector = (n: NormalizedEvent, cf: CaseFile, since: number, cfg: ContextConfig) => string[];

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function isNet(n: NormalizedEvent): boolean {
  return n.hosts.length > 0 || n.commands.some((c) => c.kind === "net");
}

/** Secret reads in the window by other calls, plus the current call's own secret reads. */
function secretEvidence(n: NormalizedEvent, cf: CaseFile, since: number, cfg: ContextConfig) {
  const callId = n.event.call.id;
  const past = cf.secretReadsSince(since).filter((r) => r.callId !== callId);
  const own = secretPathReads(n, cf.now(), cfg).length > 0 ? [callId] : [];
  return unique([...past.map((r) => r.callId), ...own]);
}

const secretThenNet: Detector = (n, cf, since, cfg) =>
  isNet(n) ? secretEvidence(n, cf, since, cfg) : [];

const failuresThenPrivilege: Detector = (n, cf, since, cfg) => {
  if (!n.commands.some((c) => c.verbs.includes("privilege"))) return [];
  const done = cf
    .recentCalls(cf.now() - since)
    .filter((c) => c.callId !== n.event.call.id && c.ok !== undefined);
  const lastOk = done.findLastIndex((c) => c.ok === true && (c.exitCode ?? 0) === 0);
  const run = done.slice(lastOk + 1).map((c) => c.callId);
  return run.length >= cfg.sequence.failuresBeforePrivilege ? run : [];
};

function intraEventWrites(n: NormalizedEvent, path: string, before: number): boolean {
  return n.commands
    .slice(0, before)
    .some((c) => c.pathRefs.some((r) => r.access === "write" && r.path === path));
}

const writeThenExec: Detector = (n, cf, since) => {
  const callId = n.event.call.id;
  const files = cf.filesWritten();
  return unique(
    n.commands.flatMap((c, i) =>
      c.pathRefs
        .filter((r) => r.access === "exec")
        .flatMap((r) => {
          const w = files.get(r.path);
          const past = w !== undefined && w.at >= since && w.callId !== callId ? [w.callId] : [];
          return intraEventWrites(n, r.path, i) ? [...past, callId] : past;
        }),
    ),
  );
};

const newHostAfterSecret: Detector = (n, cf, since, cfg) => {
  const callId = n.event.call.id;
  const others = cf.recentCalls(Number.POSITIVE_INFINITY).filter((c) => c.callId !== callId);
  const seen = new Set(others.flatMap((c) => c.hosts));
  if (!n.hosts.some((h) => !seen.has(h))) return [];
  return secretEvidence(n, cf, since, cfg);
};

const DETECTORS: Readonly<Record<SequencePatternName, Detector>> = {
  "secret-read-then-net": secretThenNet,
  "failures-then-privilege": failuresThenPrivilege,
  "write-executable-then-exec": writeThenExec,
  "new-host-after-secret": newHostAfterSecret,
};

/**
 * Pattern matches over the case file's trailing windows for the event being judged.
 * Windows are inclusive: evidence exactly `windowMs` old counts, one ms older does not.
 * The event's own call record, if already stored, is never its own history. Pure.
 */
export function sequenceScore(
  n: NormalizedEvent,
  cf: CaseFile,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): SequenceScore {
  const now = cf.now();
  const matches = sequencePatterns(cfg).flatMap((p): SequenceMatch[] => {
    const evidence = DETECTORS[p.name](n, cf, now - p.windowMs, cfg);
    return evidence.length === 0 ? [] : [{ name: p.name, weight: p.weight, evidence }];
  });
  const value = matches.reduce((max, m) => Math.max(max, m.weight), 0);
  return { value, matches, why: matches.map((m) => `${m.name} (${m.evidence.join(", ")})`) };
}
