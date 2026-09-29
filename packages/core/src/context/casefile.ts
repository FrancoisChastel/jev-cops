import type { NormalizedEvent } from "../normalizer/types.ts";
import type { RiskBudget } from "./budget.ts";
import { CaseFileEngine, type CaseFileOptions, type CaseFileStorage } from "./casefile-core.ts";
import { type ContextConfigInput, resolveContextConfig } from "./config.ts";
import type {
  CallRecord,
  CaseFile,
  FileWrite,
  HostSeen,
  RecordExtra,
  SecretRead,
  TaintEntry,
} from "./types.ts";

export type { CaseFileOptions, CaseFileStorage } from "./casefile-core.ts";
export { CaseFileEngine } from "./casefile-core.ts";
export type * from "./types.ts";

/**
 * Where case files live. Only root sessions own one; `link` maps a subagent session to
 * its root so every descendant shares the root's case file by reference.
 */
export interface CaseFileStore {
  /** The case file of root session `rootSessionId`, created on first use. */
  root(rootSessionId: string): CaseFile;
  /** Records `sessionId` as a child of `parentId`; returns the root it now belongs to. */
  link(sessionId: string, parentId: string): string;
  /** The root `sessionId` belongs to (itself when never linked). */
  rootOf(sessionId: string): string;
}

/**
 * A subagent's view of its root's case file (spec: "inherit their parent's case file by
 * reference"). Reads and writes go to the root; only `sessionId`/`parentId` are its own.
 */
class SubagentCaseFile implements CaseFile {
  constructor(
    private readonly shared: CaseFile,
    readonly sessionId: string,
    readonly parentId: string,
  ) {}

  get task(): string | null {
    return this.shared.task;
  }
  get budget(): RiskBudget {
    return this.shared.budget;
  }
  now(): number {
    return this.shared.now();
  }
  setTaskOnce(task: string): void {
    this.shared.setTaskOnce(task);
  }
  recordPre(n: NormalizedEvent, extra?: RecordExtra): void {
    this.shared.recordPre(n, extra);
  }
  recordPost(n: NormalizedEvent, extra?: RecordExtra): void {
    this.shared.recordPost(n, extra);
  }
  setBudget(budget: RiskBudget): void {
    this.shared.setBudget(budget);
  }
  taintSet(): ReadonlyArray<TaintEntry> {
    return this.shared.taintSet();
  }
  secretReadsSince(at: number): SecretRead[] {
    return this.shared.secretReadsSince(at);
  }
  hostsSeen(): ReadonlyMap<string, number> {
    return this.shared.hostsSeen();
  }
  hostsFirstSeen(): ReadonlyMap<string, HostSeen> {
    return this.shared.hostsFirstSeen();
  }
  filesWritten(): ReadonlyMap<string, FileWrite> {
    return this.shared.filesWritten();
  }
  failuresInARow(): number {
    return this.shared.failuresInARow();
  }
  recentCalls(windowMs: number): CallRecord[] {
    return this.shared.recentCalls(windowMs);
  }
  anomalies(): string[] {
    return this.shared.anomalies();
  }
}

/**
 * The case file for an event's session. A root session gets its own; a subagent (or a
 * session already linked as one) gets a view of its root's, so a subagent's post taints
 * the parent and the parent's taints the subagent. The task stays the root's (T11).
 */
export function openCaseFile(
  store: CaseFileStore,
  sessionId: string,
  parentId: string | null,
): CaseFile {
  const rootId = parentId === null ? store.rootOf(sessionId) : store.link(sessionId, parentId);
  const shared = store.root(rootId);
  return rootId === sessionId
    ? shared
    : new SubagentCaseFile(shared, sessionId, parentId ?? rootId);
}

/** In-memory {@link CaseFileStorage}; records are copied in and out. */
export class MemoryStorage implements CaseFileStorage {
  private task: string | null = null;
  private readonly calls = new Map<string, CallRecord>();
  private readonly taint = new Map<string, TaintEntry>();
  private readonly secrets: SecretRead[] = [];
  private readonly hosts = new Map<string, HostSeen>();
  private readonly files = new Map<string, FileWrite>();
  private failures = 0;
  private budget: RiskBudget | null = null;
  private readonly anomalies: string[] = [];

  readTask(): string | null {
    return this.task;
  }
  writeTask(task: string): void {
    this.task = task;
  }
  readCall(callId: string): CallRecord | undefined {
    const call = this.calls.get(callId);
    return call === undefined ? undefined : structuredClone(call);
  }
  writeCall(call: CallRecord): void {
    this.calls.set(call.callId, structuredClone(call));
  }
  readCalls(sinceAt: number): CallRecord[] {
    const calls = [...this.calls.values()].filter((c) => c.at >= sinceAt);
    return structuredClone(calls.sort((a, b) => a.at - b.at));
  }
  readTaint(): TaintEntry[] {
    return [...this.taint.values()].map((e) => ({ ...e }));
  }
  writeTaint(entries: ReadonlyArray<TaintEntry>): void {
    for (const e of entries) this.taint.set(e.value, { ...e });
  }
  readSecretReads(sinceAt: number): SecretRead[] {
    return this.secrets.filter((r) => r.at >= sinceAt).map((r) => ({ ...r }));
  }
  addSecretReads(reads: ReadonlyArray<SecretRead>): void {
    this.secrets.push(...reads.map((r) => ({ ...r })));
  }
  readHosts(): Map<string, HostSeen> {
    return new Map([...this.hosts].map(([h, seen]) => [h, { ...seen }]));
  }
  addHosts(hosts: ReadonlyArray<string>, at: number, callId: string): void {
    for (const h of hosts) if (!this.hosts.has(h)) this.hosts.set(h, { at, callId });
  }
  readFiles(): Map<string, FileWrite> {
    return new Map([...this.files].map(([k, v]) => [k, { ...v }]));
  }
  writeFiles(files: ReadonlyArray<FileWrite>): void {
    for (const f of files) this.files.set(f.path, { ...f });
  }
  readFailures(): number {
    return this.failures;
  }
  writeFailures(count: number): void {
    this.failures = count;
  }
  readBudget(): RiskBudget | null {
    return this.budget === null ? null : structuredClone(this.budget);
  }
  writeBudget(budget: RiskBudget): void {
    this.budget = structuredClone(budget);
  }
  readAnomalies(): string[] {
    return [...this.anomalies];
  }
  addAnomaly(message: string): void {
    this.anomalies.push(message);
  }
}

/** Clock and config for a store; both default (`Date.now`, spec defaults). */
export interface StoreOptions {
  now?: () => number;
  config?: ContextConfigInput;
}

/** Resolves {@link StoreOptions} into the options every case file of a store shares. */
export function caseFileOptions(opts: StoreOptions = {}): CaseFileOptions {
  return { now: opts.now ?? Date.now, config: resolveContextConfig(opts.config) };
}

/** The root of `sessionId`: links always point straight at a root, so one lookup suffices. */
export function resolveRoot(links: ReadonlyMap<string, string>, sessionId: string): string {
  return links.get(sessionId) ?? sessionId;
}

/** Case files held in memory, for tests and short-lived tools. */
export class InMemoryCaseFileStore implements CaseFileStore {
  private readonly files = new Map<string, CaseFileEngine>();
  private readonly links = new Map<string, string>();
  private readonly options: CaseFileOptions;

  constructor(opts: StoreOptions = {}) {
    this.options = caseFileOptions(opts);
  }

  root(rootSessionId: string): CaseFile {
    const existing = this.files.get(rootSessionId);
    if (existing !== undefined) return existing;
    const created = new CaseFileEngine(rootSessionId, new MemoryStorage(), this.options);
    this.files.set(rootSessionId, created);
    return created;
  }

  link(sessionId: string, parentId: string): string {
    const known = this.links.get(sessionId);
    if (known !== undefined) return known;
    const root = resolveRoot(this.links, parentId);
    if (root !== sessionId) this.links.set(sessionId, root);
    return root;
  }

  rootOf(sessionId: string): string {
    return resolveRoot(this.links, sessionId);
  }
}

/** A single root case file in memory: the common case in tests. */
export function createCaseFile(sessionId: string, opts: StoreOptions = {}): CaseFile {
  return new InMemoryCaseFileStore(opts).root(sessionId);
}
