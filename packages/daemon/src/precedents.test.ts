import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildPolicyEvent,
  type NormalizedEvent,
  type PolicyContext,
  type PolicyEvent,
} from "@jevdict/core";
import { bashPre, CTX_SESSION } from "../../../tests/fixtures/context/index.ts";
import {
  PRECEDENT_MAX_AGE_MS,
  PrecedentStore,
  proposeScope,
  scopeKey,
  taskHash,
} from "./precedents.ts";

const TASK = "Fix the flaky test in auth/";
const NO_CTX = {} as unknown as PolicyContext;
const HOUR = 3_600_000;

let at: number;
let store: PrecedentStore;
const links = new Map<string, string>();

beforeEach(() => {
  at = 1_000_000;
  links.clear();
  store = new PrecedentStore(":memory:", {
    now: () => at,
    rootOf: (id) => links.get(id) ?? id,
  });
});

afterEach(() => store.close());

async function event(command: string, task: string | null = TASK): Promise<PolicyEvent> {
  return buildPolicyEvent(await bashPre(command), task);
}

async function hold(eventId: string, command: string, task: string | null = TASK) {
  const n: NormalizedEvent = await bashPre(command);
  store.recordHold({
    eventId,
    sessionId: CTX_SESSION,
    scope: proposeScope(n, task),
    policies: ["off-repo-write@1"],
  });
}

describe("proposeScope (the daemon proposes, never the request)", () => {
  test("kind, first two argv words, path prefix and task hash", async () => {
    const scope = proposeScope(await bashPre("rm -rf /home/dev/build"), TASK);
    expect(scope).toEqual({
      kind: "fs.delete",
      commandPrefix: "rm -rf",
      host: null,
      pathPrefix: "/home/dev/build",
      taskHash: taskHash(TASK),
    });
  });

  test("a net call is scoped by its host", async () => {
    const scope = proposeScope(await bashPre("curl -X POST https://api.example.dev/x"), TASK);
    expect(scope).toMatchObject({ kind: "net", host: "api.example.dev", pathPrefix: null });
  });

  test("several paths share their common directory", async () => {
    const scope = proposeScope(await bashPre("rm -rf /srv/a/b /srv/a/c"), TASK);
    expect(scope.pathPrefix).toBe("/srv/a");
  });

  test("the key is stable and readable", async () => {
    const scope = proposeScope(await bashPre("rm -rf /home/dev/build"), TASK);
    expect(scopeKey(scope)).toBe(scopeKey({ ...scope }));
    expect(scopeKey(scope)).toContain("fs.delete|rm -rf|/home/dev/build|");
  });
});

describe("grant and lookup", () => {
  test("grant turns a recorded hold into a precedent with the daemon's scope", async () => {
    await hold("evt_1", "rm -rf /home/dev/build");
    const p = store.grant("evt_1", "alice");
    expect(p).toMatchObject({
      sessionId: CTX_SESSION,
      riskDelta: 0.3,
      expiresAt: null,
      policies: ["off-repo-write@1"],
      by: "alice",
      scope: { commandPrefix: "rm -rf", pathPrefix: "/home/dev/build" },
    });
    expect(store.grant("evt_1", "alice")).toBeNull();
  });

  test("an event nobody held cannot be granted", () => {
    expect(store.grant("evt_unknown", "alice")).toBeNull();
  });

  test("a matching later event gets the precedent", async () => {
    await hold("evt_1", "rm -rf /home/dev/build");
    store.grant("evt_1", "alice");
    const match = store.lookup(await event("rm -rf /home/dev/build/cache"), NO_CTX);
    expect(match).toMatchObject({ riskDelta: 0.3, policies: ["off-repo-write@1"] });
  });

  test("the narrowest matching precedent wins", async () => {
    await hold("evt_1", "rm -rf /home/dev");
    await hold("evt_2", "rm -rf /home/dev/build");
    store.grant("evt_1", "alice");
    const narrow = store.grant("evt_2", "alice");
    const match = store.lookup(await event("rm -rf /home/dev/build/x"), NO_CTX);
    expect(match?.key).toBe(narrow?.key ?? "");
  });

  test("a different path, prefix, host or task does not match", async () => {
    await hold("evt_1", "rm -rf /home/dev/build");
    store.grant("evt_1", "alice");
    expect(store.lookup(await event("rm -rf /home/dev/buildx"), NO_CTX)).toBeNull();
    expect(store.lookup(await event("rm -f /home/dev/build"), NO_CTX)).toBeNull();
    expect(store.lookup(await event("rm -rf /etc"), NO_CTX)).toBeNull();
    expect(store.lookup(await event("rm -rf /home/dev/build", "another task"), NO_CTX)).toBeNull();
  });

  test("a subagent shares its root session's precedents", async () => {
    await hold("evt_1", "rm -rf /home/dev/build");
    store.grant("evt_1", "alice");
    links.set("sess_child", CTX_SESSION);
    const e = await event("rm -rf /home/dev/build");
    const child = { ...e, session: { ...e.session, id: "sess_child" } };
    expect(store.lookup(child, NO_CTX)).not.toBeNull();
    const stranger = { ...e, session: { ...e.session, id: "sess_other" } };
    expect(store.lookup(stranger, NO_CTX)).toBeNull();
  });
});

describe("TTL", () => {
  test("a precedent expires with its session", async () => {
    await hold("evt_1", "rm -rf /home/dev/build");
    store.grant("evt_1", "alice");
    expect(store.expireSession(CTX_SESSION)).toBe(1);
    expect(store.lookup(await event("rm -rf /home/dev/build"), NO_CTX)).toBeNull();
  });

  test("and after 24 hours whatever the session does", async () => {
    await hold("evt_1", "rm -rf /home/dev/build");
    store.grant("evt_1", "alice");
    at += PRECEDENT_MAX_AGE_MS - 1;
    expect(store.lookup(await event("rm -rf /home/dev/build"), NO_CTX)).not.toBeNull();
    at += 1;
    expect(store.lookup(await event("rm -rf /home/dev/build"), NO_CTX)).toBeNull();
  });

  test("pending holds are dropped after 24 hours too", async () => {
    await hold("evt_1", "rm -rf /home/dev/build");
    at += 25 * HOUR;
    expect(store.grant("evt_1", "alice")).toBeNull();
  });

  test("a store that throws is never trusted: core treats it as no precedent", () => {
    store.close();
    expect(() => store.lookup({} as PolicyEvent, NO_CTX)).toThrow();
  });
});
