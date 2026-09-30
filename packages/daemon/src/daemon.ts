import {
  type ContextConfigInput,
  createPolicyEngine,
  DEFAULT_JUDGE_CONFIG,
  type Judge,
  type JudgeConfig,
  mergeConfig,
  type PolicyConfigInput,
  type PolicyEngine,
  type PolicyTrace,
  resolveContextConfig,
  resolvePolicyConfig,
} from "@jev-cops/core";
import { createJudge, type ProviderConfig } from "@jev-cops/judge";
import manifest from "../package.json" with { type: "json" };
import type { AuditLog } from "./audit.ts";
import type { AuditForwarder } from "./audit-forward/types.ts";
import { type AuditRuntime, closeAudit, openAudit } from "./audit-setup.ts";
import type { DaemonConfig } from "./config.ts";
import { ConfirmViews } from "./confirm-view.ts";
import { GitProbe } from "./git-probe.ts";
import { bunGitRunner, findGit, type GitRunner } from "./git-run.ts";
import { JudgeRecorder } from "./judge-recorder.ts";
import { KillLatch } from "./kill-latch.ts";
import { type Logger, stderrLogger } from "./log.ts";
import { PolicySet, type PolicySetOptions } from "./policies.ts";
import { PrecedentStore } from "./precedents.ts";
import { defaultJudgeInputs, type JudgeInputs, protectJudgeInputs } from "./protected-paths.ts";
import { RepoHintsCache } from "./repo-hints.ts";
import { SessionFactsStore } from "./session-facts.ts";
import { SessionStore } from "./sessions.ts";

/** Reported by `/v1/health` and the boot line: the package version. */
export const DAEMON_VERSION: string = manifest.version;
/** How often idle sessions are closed. */
export const GC_INTERVAL_MS = 10 * 60_000;

/** What tests (and embedders) may inject instead of building from config. */
export interface DaemonDeps {
  /** Replaces the provider named by `[judge] provider`. */
  judge?: Judge;
  now?: () => number;
  log?: Logger;
  /** Where provider API keys are read from (D-044). Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the hardened git runner used to derive `env.git` (tests). */
  gitRunner?: GitRunner;
  /** What the daemon protects beyond its config (config files, own binary); see {@link defaultJudgeInputs}. */
  inputs?: Partial<JudgeInputs>;
  /** The audit forwarder's reconnect backoff (tests shorten it). */
  forwardRetry?: { readonly minMs: number; readonly maxMs: number };
}

/** Per-policy `degraded` flags as last seen in a decision trace. */
export class DegradedFlags {
  private readonly flags = new Map<string, boolean>();
  update(trace: readonly PolicyTrace[]): void {
    for (const t of trace) this.flags.set(t.policy, t.degraded);
  }
  get(policyKey: string): boolean {
    return this.flags.get(policyKey) ?? false;
  }
}

/** Everything the routes share; built once by {@link createRuntime}. */
export interface Runtime {
  readonly config: DaemonConfig;
  readonly audit: AuditLog;
  /** Ships the audit log off the box (`[audit.forward]`); null when none is configured. */
  readonly forwarder: AuditForwarder | null;
  readonly sessions: SessionStore;
  /** What `/v1/session` reports taught the daemon per root session (mode, model, …). */
  readonly facts: SessionFactsStore;
  /** Sessions terminated by a `kill` or a broken hook block; cleared on the admin socket only. */
  readonly latch: KillLatch;
  readonly precedents: PrecedentStore;
  /** Confirm views of pending holds (memory only), served with the hold's token. */
  readonly confirmViews: ConfirmViews;
  readonly policies: PolicySet;
  readonly recorder: JudgeRecorder;
  readonly repoHints: RepoHintsCache;
  /** Derives `env.git` from the event's cwd when the adapter sends none (D-058). */
  readonly gitProbe: GitProbe;
  readonly degraded: DegradedFlags;
  readonly judgeName: string;
  readonly warnings: readonly string[];
  readonly log: Logger;
  readonly now: () => number;
  readonly startedAt: number;
  /** The engine for the policy set in force (rebuilt after a reload). */
  engine(): PolicyEngine;
  /**
   * Stops timers and watchers, writes the shutdown line (and its checkpoint), closes the
   * stores and the log, then lets the forwarder flush. Idempotent.
   */
  close(): Promise<void>;
}

function judgeSettings(config: DaemonConfig): JudgeConfig {
  const { timeoutMs, cacheTtlMs } = config.judge;
  return {
    ...DEFAULT_JUDGE_CONFIG,
    timeoutMs,
    cache: { ...DEFAULT_JUDGE_CONFIG.cache, ttlMs: cacheTtlMs },
  };
}

function providerConfig(config: DaemonConfig): {
  provider: ProviderConfig;
  warning: string | null;
} {
  const { provider, model } = config.judge;
  switch (provider) {
    case "off":
      return { provider: { provider: "off" }, warning: null };
    case "mock":
      return {
        provider: { provider: "mock", answers: {} },
        warning: "judge = mock: every answer is invalid",
      };
    case "jev":
      return { provider: { provider: "jev", ...(model === null ? {} : { model }) }, warning: null };
    case "openrouter":
      return model === null
        ? {
            provider: { provider: "off" },
            warning: "judge = openrouter needs [judge] model; judge off",
          }
        : { provider: { provider: "openrouter", model }, warning: null };
    case "vercel-ai":
      return {
        provider: { provider: "off" },
        warning:
          "judge = vercel-ai needs a LanguageModel instance (D-043), not a TOML string; judge off",
      };
  }
}

function buildJudge(config: DaemonConfig, deps: DaemonDeps): { judge: Judge; warnings: string[] } {
  if (deps.judge !== undefined) return { judge: deps.judge, warnings: [] };
  const { provider, warning } = providerConfig(config);
  const judge = createJudge(provider, {
    judgeConfig: judgeSettings(config),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  return { judge, warnings: warning === null ? [] : [warning] };
}

/** The core configs the engine and case files run with (home from `[daemon] home`). */
export function coreConfigs(config: DaemonConfig) {
  const context = mergeConfig<ContextConfigInput>(config.context, { home: config.daemon.home });
  const judge = { timeoutMs: config.judge.timeoutMs, cache: { ttlMs: config.judge.cacheTtlMs } };
  const policy = mergeConfig<PolicyConfigInput>(config.policy, { judge });
  return {
    context,
    contextConfig: resolveContextConfig(context),
    policyConfig: resolvePolicyConfig(policy),
  };
}

function startupWarnings(config: DaemonConfig, judgeName: string): string[] {
  const out: string[] = [];
  if (config.enforcement.mode === "observe") {
    out.push(
      "enforcement = observe: every verdict is logged and returned as allow; nothing is blocked",
    );
  }
  if (judgeName === "disabled")
    out.push("judge = off: the semantic layer is disabled, the floor decides");
  return out;
}

function policyCallbacks(audit: AuditLog, log: Logger, now: () => number): PolicySetOptions {
  return {
    now,
    onReload: (s) => {
      const keys = s.policies.map((p) => `${p.name}@${p.version}`);
      const payload = { event: "policy-reload", generation: s.generation, policies: keys };
      audit.append({ kind: "boot", payload });
      log.log("info", "policies reloaded", { policies: keys });
    },
    onRejected: (problems) => {
      audit.append({ kind: "anomaly", payload: { reason: "policy reload rejected", problems } });
      log.log("warn", "policy reload rejected; keeping the previous set", { problems });
    },
  };
}

/** The `env.git` deriver: the hardened runner on the git found on PATH, or none. */
function buildGitProbe(config: DaemonConfig, deps: DaemonDeps, now: () => number, log: Logger) {
  const git = deps.gitRunner === undefined ? findGit() : null;
  const run = deps.gitRunner ?? (git === null ? null : bunGitRunner(git));
  const timeoutMs = config.daemon.gitProbeTimeoutMs;
  const warnings =
    run === null ? ["git not found on PATH: env.git is not derived from cwd (D-024 applies)"] : [];
  return { probe: new GitProbe({ run, timeoutMs, now, log }), warnings };
}

interface Closeable {
  stopGc: () => void;
  policies: PolicySet;
  audit: AuditRuntime;
  stores: ReadonlyArray<{ close(): void }>;
}

/**
 * Idempotent shutdown: timers and watchers, the shutdown line, the stores, then the log
 * and its forwarder (which flushes within its budget). A second call waits for the first.
 */
function closer(parts: Closeable): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= (async () => {
      parts.stopGc();
      parts.policies.close();
      parts.audit.audit.append({ kind: "boot", payload: { event: "shutdown" } });
      parts.audit.audit.checkpoint("shutdown");
      for (const store of parts.stores) store.close();
      await closeAudit(parts.audit);
    })();
    return closing;
  };
}

interface EngineParts {
  policies: PolicySet;
  judge: Judge;
  cores: ReturnType<typeof coreConfigs>;
  now: () => number;
  precedents: PrecedentStore;
}

/** One engine per policy generation, rebuilt lazily after a reload. */
function engineFactory(parts: EngineParts): () => PolicyEngine {
  let cached: { generation: number; engine: PolicyEngine } | null = null;
  return () => {
    const snap = parts.policies.current();
    if (cached?.generation === snap.generation) return cached.engine;
    const engine = createPolicyEngine({
      policies: snap.policies,
      judge: parts.judge,
      contextConfig: parts.cores.contextConfig,
      policyConfig: parts.cores.policyConfig,
      now: parts.now,
      precedents: parts.precedents,
    });
    cached = { generation: snap.generation, engine };
    return engine;
  };
}

/** Closes idle sessions and ends their precedents every {@link GC_INTERVAL_MS}. */
function startGc(sessions: SessionStore, precedents: PrecedentStore, audit: AuditLog): () => void {
  const timer = setInterval(() => {
    for (const sid of sessions.gc()) {
      const ended = precedents.expireSession(sid);
      audit.append({
        kind: "precedent",
        session_id: sid,
        payload: { action: "session-closed", ended },
      });
    }
  }, GC_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function bootPayload(config: DaemonConfig, judgeName: string, set: PolicySet, warnings: string[]) {
  return {
    event: "boot",
    version: DAEMON_VERSION,
    enforcement: config.enforcement.mode,
    judge: judgeName,
    policies: set.current().policies.map((p) => `${p.name}@${p.version}`),
    home: config.daemon.home,
    config: { context: config.context, policy: config.policy },
    warnings,
  };
}

/** The SQLite stores, all on `[store] path`: case files, session facts, latch, precedents. */
function openStores(
  config: DaemonConfig,
  cores: ReturnType<typeof coreConfigs>,
  now: () => number,
) {
  const path = config.store.path;
  const sessions = new SessionStore(path, { now, contextConfig: cores.context });
  const rootOf = (id: string) => sessions.rootOf(id);
  return {
    sessions,
    facts: new SessionFactsStore(path, now),
    latch: new KillLatch(path, now),
    precedents: new PrecedentStore(path, { now, rootOf }),
  };
}

/**
 * Opens the stores, audit log and policy set and wires the engine from config: judge
 * from `@jev-cops/judge` (keys from env only), precedents and case files from SQLite,
 * policies hot-reloaded. The judge's own paths are appended to `[policy] protectedPaths`
 * first, so every engine built from this runtime (after any policy reload too) and the
 * boot line carry them. Throws on unreadable stores or a policy set with problems.
 */
export async function createRuntime(given: DaemonConfig, deps: DaemonDeps = {}): Promise<Runtime> {
  const config = protectJudgeInputs(given, { ...defaultJudgeInputs(), ...deps.inputs });
  const now = deps.now ?? Date.now;
  const log = deps.log ?? stderrLogger(now);
  const policies = await PolicySet.load(config.policies.dir);
  const opened = openAudit(config, {
    now,
    ...(deps.forwardRetry === undefined ? {} : { retry: deps.forwardRetry }),
  });
  const audit = opened.audit;
  policies.setCallbacks(policyCallbacks(audit, log, now));
  const cores = coreConfigs(config);
  const stores = openStores(config, cores, now);
  const { sessions, precedents } = stores;
  const recorder = new JudgeRecorder();
  const built = buildJudge(config, deps);
  const judge = recorder.wrap(built.judge);
  const git = buildGitProbe(config, deps, now, log);
  const warnings = [
    ...built.warnings,
    ...startupWarnings(config, built.judge.name),
    ...git.warnings,
    ...opened.warnings,
  ];
  const stopGc = startGc(sessions, precedents, audit);
  policies.watch();
  audit.append({
    kind: "boot",
    payload: bootPayload(config, built.judge.name, policies, warnings),
  });
  audit.checkpoint("boot");
  const lockfiles = new Set(Object.keys(cores.contextConfig.scope.registries));
  return {
    config,
    audit,
    forwarder: opened.forwarder,
    ...stores,
    confirmViews: new ConfirmViews(),
    policies,
    recorder,
    repoHints: new RepoHintsCache(lockfiles, now),
    gitProbe: git.probe,
    degraded: new DegradedFlags(),
    judgeName: built.judge.name,
    warnings,
    log,
    now,
    startedAt: now(),
    engine: engineFactory({ policies, judge, cores, now, precedents }),
    close: closer({ stopGc, policies, audit: opened, stores: Object.values(stores) }),
  };
}
