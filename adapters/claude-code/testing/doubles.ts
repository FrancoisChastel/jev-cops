/**
 * In-process test doubles for the hook runtime: a scripted daemon client and a
 * {@link HookDeps} whose log lines are recorded. Not part of the hook binary.
 */
import type { PostEvent, PreEvent, SessionEvent } from "@jev-cops/core";
import type { DaemonClient, Reply } from "../src/client.ts";
import type { HookDeps } from "../src/deps.ts";
import type { HookLogLine } from "../src/log.ts";

/** What the fake client answers per route; a function may throw or never resolve. */
export interface Script {
  judge?: (e: PreEvent) => Reply | Promise<Reply>;
  observe?: (e: PostEvent) => Reply | Promise<Reply>;
  session?: (r: SessionEvent) => Reply | Promise<Reply>;
  confirmView?: (id: string, token: string) => Reply | Promise<Reply>;
}

/** Every request the fake client received, in order. */
export interface Calls {
  judge: PreEvent[];
  observe: PostEvent[];
  session: SessionEvent[];
  confirmView: { id: string; token: string }[];
}

/** A reply with `status` and `body` and no view token. */
export function reply(body: unknown, status = 200, viewToken: string | null = null): Reply {
  return { status, body, viewToken };
}

const refused = (): Promise<Reply> => Promise.reject(new Error("ConnectionRefused: no daemon"));

/** A daemon client that answers from `script` (unscripted routes refuse the connection). */
export function scriptedClient(script: Script): { client: DaemonClient; calls: Calls } {
  const calls: Calls = { judge: [], observe: [], session: [], confirmView: [] };
  const client: DaemonClient = {
    judge: async (e) => {
      calls.judge.push(e);
      return script.judge ? script.judge(e) : refused();
    },
    observe: async (e) => {
      calls.observe.push(e);
      return script.observe ? script.observe(e) : refused();
    },
    session: async (r) => {
      calls.session.push(r);
      return script.session ? script.session(r) : refused();
    },
    confirmView: async (id, token) => {
      calls.confirmView.push({ id, token });
      return script.confirmView ? script.confirmView(id, token) : refused();
    },
  };
  return { client, calls };
}

/** Deps for {@link runHook} over a scripted client; `log` lines are collected. */
export function testDeps(script: Script, overrides: Partial<HookDeps> = {}) {
  const { client, calls } = scriptedClient(script);
  const logged: HookLogLine[] = [];
  const deps: HookDeps = {
    client,
    deadlines: { judgeMs: 2_000, eventMs: 2_000, requestMs: 1_000 },
    mode: () => "interactive",
    harnessVersion: () => "2.1.285",
    log: (line) => {
      logged.push(line);
    },
    configCheck: () => ({ intact: true, why: "test: intact" }),
    ...overrides,
  };
  return { deps, calls, logged };
}
