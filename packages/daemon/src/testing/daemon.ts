import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContextConfigInput,
  type Event,
  type Judge,
  mergeConfig,
  mintEventId,
  type PolicyConfigInput,
} from "@jevdict/core";
import { type AuditLine, readAudit } from "../audit.ts";
import type { DaemonConfig, EnforcementMode, HttpBind } from "../config.ts";
import { SILENT_LOGGER } from "../log.ts";
import { type RunningDaemon, startDaemon } from "../server.ts";

/** What a test daemon is built from; everything has a test-friendly default. */
export interface TestDaemonOptions {
  /** File name → module source, written into the policies directory. */
  policies: Readonly<Record<string, string>>;
  /** Load policies from this directory instead (e.g. the repo's `policies/`); `policies` is then ignored. */
  policiesDir?: string;
  judge?: Judge;
  mode?: EnforcementMode;
  deadlineMs?: number;
  judgeTimeoutMs?: number;
  holdTokenTtlMs?: number;
  http?: HttpBind | null;
  context?: ContextConfigInput;
  policy?: PolicyConfigInput;
  now?: () => number;
}

/** A daemon on a temp Unix socket plus helpers to call it and read its audit log. */
export interface TestDaemon {
  readonly daemon: RunningDaemon;
  readonly dir: string;
  readonly config: DaemonConfig;
  call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
  audit(): AuditLine[];
  writePolicy(file: string, source: string): void;
  stop(): Promise<void>;
}

/** A fresh event id, so tests never collide on `explain` or `resolve`. */
export function withFreshId<E extends Event>(e: E): E {
  return { ...e, id: mintEventId() };
}

/** The config a test daemon runs with; `when` budget relaxed so cold JIT never flakes. */
export function testConfig(dir: string, opts: TestDaemonOptions): DaemonConfig {
  return {
    daemon: {
      socket: join(dir, "d.sock"),
      http: opts.http ?? null,
      home: "/home/dev",
      judgeDeadlineMs: opts.deadlineMs ?? 12_000,
      holdTokenTtlMs: opts.holdTokenTtlMs ?? 600_000,
    },
    policies: { dir: opts.policiesDir ?? join(dir, "policies") },
    judge: {
      provider: "off",
      model: null,
      timeoutMs: opts.judgeTimeoutMs ?? 10_000,
      cacheTtlMs: 600_000,
    },
    context: opts.context ?? {},
    policy: mergeConfig<PolicyConfigInput>({ when: { budgetMs: 1_000 } }, opts.policy ?? {}),
    audit: { path: join(dir, "audit.jsonl"), forward: null },
    store: { path: join(dir, "store.sqlite") },
    enforcement: { mode: opts.mode ?? "enforce" },
  };
}

/** Starts a daemon in a new temp directory (short path: Unix sockets cap at ~104 bytes). */
export async function startTestDaemon(opts: TestDaemonOptions): Promise<TestDaemon> {
  const dir = mkdtempSync(join(tmpdir(), "jvd-"));
  mkdirSync(join(dir, "policies"));
  for (const [file, source] of Object.entries(opts.policies)) {
    writeFileSync(join(dir, "policies", file), source);
  }
  const config = testConfig(dir, opts);
  const daemon = await startDaemon(config, {
    log: SILENT_LOGGER,
    ...(opts.judge === undefined ? {} : { judge: opts.judge }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return {
    daemon,
    dir,
    config,
    async call(method, path, body) {
      const res = await fetch(`http://localhost${path}`, {
        method,
        unix: config.daemon.socket,
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        headers: { "content-type": "application/json" },
      });
      const text = await res.text();
      return { status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
    },
    audit: () => readAudit(config.audit.path).lines,
    writePolicy(file, source) {
      writeFileSync(join(dir, "policies", file), source);
    },
    async stop() {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
