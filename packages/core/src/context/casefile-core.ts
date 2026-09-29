import type { NormalizedEvent } from "../normalizer/types.ts";
import { createBudget, type RiskBudget } from "./budget.ts";
import type { ContextConfig } from "./config.ts";
import {
  clamp01,
  contentSecretReads,
  fileWrites,
  isFailure,
  mergeFileWrite,
  newCallRecord,
  readPaths,
  resultOf,
  secretPathReads,
  taintUpdates,
} from "./record.ts";
import { findSecretPatterns } from "./secrets.ts";
import { extractTaintCandidates } from "./taint.ts";
import type {
  CallRecord,
  CaseFile,
  FileWrite,
  RecordExtra,
  SecretRead,
  TaintEntry,
} from "./types.ts";

/**
 * What a case-file backend stores for one root session. Backends only persist; every
 * rule (pairing, merging, taint inheritance) lives in {@link CaseFileEngine}.
 */
export interface CaseFileStorage {
  readTask(): string | null;
  writeTask(task: string): void;
  readCall(callId: string): CallRecord | undefined;
  /** Inserts or replaces by `callId`; a replaced call keeps its original position. */
  writeCall(call: CallRecord): void;
  /** Calls with `at >= sinceAt`, ordered by `at` then insertion. */
  readCalls(sinceAt: number): CallRecord[];
  readTaint(): TaintEntry[];
  /** Inserts or replaces by `value`. */
  writeTaint(entries: ReadonlyArray<TaintEntry>): void;
  readSecretReads(sinceAt: number): SecretRead[];
  addSecretReads(reads: ReadonlyArray<SecretRead>): void;
  readHosts(): Map<string, number>;
  /** Records hosts first seen at `at`; hosts already known keep their first time. */
  addHosts(hosts: ReadonlyArray<string>, at: number): void;
  readFiles(): Map<string, FileWrite>;
  /** Inserts or replaces by `path`. */
  writeFiles(files: ReadonlyArray<FileWrite>): void;
  readFailures(): number;
  writeFailures(count: number): void;
  readBudget(): RiskBudget | null;
  writeBudget(budget: RiskBudget): void;
  readAnomalies(): string[];
  addAnomaly(message: string): void;
}

/** Clock and config every case file of a store shares. */
export interface CaseFileOptions {
  now: () => number;
  config: ContextConfig;
}

const TASK_PREVIEW = 120;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TASK_PREVIEW ? `${flat.slice(0, TASK_PREVIEW)}…` : flat;
}

/**
 * The case-file rules on top of a {@link CaseFileStorage}: task set once (T11), pre and
 * post paired by call id (post first is accepted and logged), taint registered from
 * output with self-written-file inheritance (T10). Reads return fresh copies.
 */
export class CaseFileEngine implements CaseFile {
  readonly parentId: string | null = null;

  constructor(
    readonly sessionId: string,
    private readonly storage: CaseFileStorage,
    private readonly opts: CaseFileOptions,
  ) {}

  get task(): string | null {
    return this.storage.readTask();
  }

  get budget(): RiskBudget {
    return this.storage.readBudget() ?? createBudget(this.opts.config.budget);
  }

  now(): number {
    return this.opts.now();
  }

  setTaskOnce(task: string): void {
    const next = task.trim();
    const current = this.storage.readTask();
    if (next === "" || next === current) return;
    if (current === null) this.storage.writeTask(next);
    else this.storage.addAnomaly(`task change ignored: "${preview(next)}"`);
  }

  recordPre(n: NormalizedEvent, extra?: RecordExtra): void {
    const at = this.opts.now();
    const callId = n.event.call.id;
    const existing = this.storage.readCall(callId);
    const fresh = newCallRecord(n, at, extra?.taint ?? 0);
    if (existing === undefined) {
      this.storage.writeCall(fresh);
      this.applyPreEffects(n, at, fresh.taint);
      return;
    }
    const kind = existing.phase === "post" ? "pre after post" : "pre recorded twice";
    this.storage.addAnomaly(`${kind} for ${callId}`);
    this.storage.writeCall({ ...fresh, ...resultFields(existing), phase: existing.phase });
  }

  recordPost(n: NormalizedEvent, extra?: RecordExtra): void {
    const result = resultOf(n);
    const callId = n.event.call.id;
    if (result === null) {
      this.storage.addAnomaly(`recordPost given a pre event for ${callId}`);
      return;
    }
    const at = this.opts.now();
    const existing = this.storage.readCall(callId);
    if (existing === undefined) {
      this.storage.addAnomaly(`post before pre for ${callId}`);
      this.applyPreEffects(n, at, 0);
    }
    const base = existing ?? newCallRecord(n, at, 0);
    this.storage.writeCall({ ...base, ...result, phase: "post" });
    this.storage.writeFailures(isFailure(result) ? this.storage.readFailures() + 1 : 0);
    this.registerOutput(n, at, extra);
  }

  setBudget(budget: RiskBudget): void {
    this.storage.writeBudget(budget);
  }

  taintSet(): ReadonlyArray<TaintEntry> {
    return this.storage.readTaint().map((e) => ({ ...e }));
  }

  secretReadsSince(at: number): SecretRead[] {
    return this.storage.readSecretReads(at).map((r) => ({ ...r }));
  }

  hostsSeen(): ReadonlyMap<string, number> {
    return new Map(this.storage.readHosts());
  }

  filesWritten(): ReadonlyMap<string, FileWrite> {
    return new Map([...this.storage.readFiles()].map(([k, v]) => [k, { ...v }]));
  }

  failuresInARow(): number {
    return this.storage.readFailures();
  }

  recentCalls(windowMs: number): CallRecord[] {
    return this.storage.readCalls(this.opts.now() - windowMs).map(copyCall);
  }

  anomalies(): string[] {
    return [...this.storage.readAnomalies()];
  }

  private applyPreEffects(n: NormalizedEvent, at: number, taint: number): void {
    const files = this.storage.readFiles();
    const writes = fileWrites(n, at, taint, this.storage.readTaint(), files);
    this.storage.writeFiles(writes.map((w) => mergeFileWrite(files.get(w.path), w)));
    this.storage.addHosts(n.hosts, at);
    this.storage.addSecretReads(secretPathReads(n, at, this.opts.config));
  }

  private registerOutput(n: NormalizedEvent, at: number, extra: RecordExtra | undefined): void {
    const files = this.storage.readFiles();
    const inherited = readPaths(n).reduce((m, p) => Math.max(m, files.get(p)?.taint ?? 0), 0);
    const own = extra?.taint ?? this.opts.config.taint.outputTaint;
    const taint = clamp01(Math.max(own, inherited));
    const sourceCallId = n.event.call.id;
    const candidates = extractTaintCandidates(n, this.opts.config.taint);
    if (taint > 0 && candidates.length > 0) {
      const existing = new Map(this.storage.readTaint().map((e) => [e.value, e]));
      const incoming = candidates.map((value) => ({ value, sourceCallId, at, taint }));
      this.storage.writeTaint(taintUpdates(existing, incoming));
    }
    const head = n.event.phase === "post" ? (n.event.result.stdout_head ?? "") : "";
    if (findSecretPatterns(head).length > 0) {
      this.storage.addSecretReads(contentSecretReads(n, at));
    }
  }
}

function resultFields(call: CallRecord): Partial<CallRecord> {
  return {
    ...(call.ok === undefined ? {} : { ok: call.ok }),
    ...(call.exitCode === undefined ? {} : { exitCode: call.exitCode }),
  };
}

/** A deep copy of a call record, so callers can never reach stored arrays. */
export function copyCall(call: CallRecord): CallRecord {
  return {
    ...call,
    verbs: [...call.verbs],
    paths: [...call.paths],
    hosts: [...call.hosts],
    argv: [...call.argv],
  };
}
