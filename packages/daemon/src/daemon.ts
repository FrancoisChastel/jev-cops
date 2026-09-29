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
} from "@jevdict/core";
import { createJudge, type ProviderConfig } from "@jevdict/judge";
import { AuditLog } from "./audit.ts";
import type { DaemonConfig } from "./config.ts";
import { JudgeRecorder } from "./judge-recorder.ts";
import { type Logger, stderrLogger } from "./log.ts";
import { PolicySet, type PolicySetOptions } from "./policies.ts";
import { PrecedentStore } from "./precedents.ts";
import { RepoHintsCache } from "./repo-hints.ts";
import { SessionStore } from "./sessions.ts";

/** Reported by `/v1/health` and the boot line. */
export const DAEMON_VERSION = "0.0.0";
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
  readonly sessions: SessionStore;
  readonly precedents: PrecedentStore;
  readonly policies: PolicySet;
  readonly recorder: JudgeRecorder;
  readonly repoHints: RepoHintsCache;
  readonly degraded: DegradedFlags;
  readonly judgeName: string;
  readonly warnings: readonly string[];
  readonly log: Logger;
  readonly now: () => number;
  readonly startedAt: number;
  /** The engine for the policy set in force (rebuilt after a reload). */
  engine(): PolicyEngine;
  /** Stops timers and watchers, writes the shutdown line, closes the stores. Idempotent. */
  close(): void;
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
  if (config.audit.forward?.kind === "syslog")
    out.push("audit.forward syslog is M2; not forwarding");
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

/**
 * Opens the stores, audit log and policy set and wires the engine from config: judge
 * from `@jevdict/judge` (keys from env only), precedents and case files from SQLite,
 * policies hot-reloaded. Throws on unreadable stores or a policy set with problems.
 */
export async function createRuntime(config: DaemonConfig, deps: DaemonDeps = {}): Promise<Runtime> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? stderrLogger(now);
  const policies = await PolicySet.load(config.policies.dir);
  const forward = config.audit.forward?.kind === "file" ? config.audit.forward.target : null;
  const audit = AuditLog.open(config.audit.path, { now, forward });
  policies.setCallbacks(policyCallbacks(audit, log, now));
  const cores = coreConfigs(config);
  const sessions = new SessionStore(config.store.path, { now, contextConfig: cores.context });
  const rootOf = (id: string) => sessions.rootOf(id);
  const precedents = new PrecedentStore(config.store.path, { now, rootOf });
  const recorder = new JudgeRecorder();
  const built = buildJudge(config, deps);
  const judge = recorder.wrap(built.judge);
  const warnings = [...built.warnings, ...startupWarnings(config, built.judge.name)];
  const stopGc = startGc(sessions, precedents, audit);
  policies.watch();
  audit.append({
    kind: "boot",
    payload: bootPayload(config, built.judge.name, policies, warnings),
  });
  const lockfiles = new Set(Object.keys(cores.contextConfig.scope.registries));
  let closed = false;
  return {
    config,
    audit,
    sessions,
    precedents,
    policies,
    recorder,
    repoHints: new RepoHintsCache(lockfiles, now),
    degraded: new DegradedFlags(),
    judgeName: built.judge.name,
    warnings,
    log,
    now,
    startedAt: now(),
    engine: engineFactory({ policies, judge, cores, now, precedents }),
    close() {
      if (closed) return;
      closed = true;
      stopGc();
      policies.close();
      audit.append({ kind: "boot", payload: { event: "shutdown" } });
      audit.close();
      sessions.close();
      precedents.close();
    },
  };
}
