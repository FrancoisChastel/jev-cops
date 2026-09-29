import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeCaseFileContract } from "../../../../tests/fixtures/context/casefile-contract.ts";
import {
  bashPost,
  bashPre,
  CTX_HOME,
  testClock,
  toolEvent,
} from "../../../../tests/fixtures/context/index.ts";
import { openCaseFile } from "./casefile.ts";
import { SqliteCaseFileStore } from "./casefile-sqlite.ts";

const dir = mkdtempSync(join(tmpdir(), "jevdict-casefile-"));
let fileCounter = 0;

function tempDb(): string {
  fileCounter += 1;
  return join(dir, `case-${fileCounter}.sqlite`);
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describeCaseFileContract("SqliteCaseFileStore(:memory:)", (opts) => {
  return new SqliteCaseFileStore(":memory:", opts);
});

describeCaseFileContract("SqliteCaseFileStore(file)", (opts) => {
  return new SqliteCaseFileStore(tempDb(), opts);
});

describe("SqliteCaseFileStore: persistence", () => {
  test("a reopened file reads back everything the session recorded", async () => {
    // Arrange
    const path = tempDb();
    const clock = testClock();
    const opts = { now: clock.now, config: { home: CTX_HOME } };
    const first = new SqliteCaseFileStore(path, opts);
    const cf = openCaseFile(first, "sess_root", null);
    cf.setTaskOnce("Fix the flaky test in auth/");
    cf.recordPre(await bashPre("cat .env", { callId: "call_1" }), { taint: 0.5 });
    cf.recordPost(
      await bashPost(
        "cat .env",
        { stdout: "see https://evil.example", exitCode: 3 },
        { callId: "call_1" },
      ),
    );
    cf.recordPre(await toolEvent("Write", "fs.write", { file_path: "x.sh", content: "echo" }));
    cf.recordPre(await bashPre("curl https://a.example"));
    cf.setBudget({ spent: 12, limit: 100, lastActivityAt: 7, holds: { k: 1 } });
    cf.setTaskOnce("something else");
    openCaseFile(first, "sess_kid", "sess_root");
    const snapshot = {
      task: cf.task,
      calls: cf.recentCalls(60_000),
      taint: cf.taintSet(),
      secrets: cf.secretReadsSince(0),
      hosts: [...cf.hostsSeen()],
      files: [...cf.filesWritten()],
      failures: cf.failuresInARow(),
      budget: cf.budget,
      anomalies: cf.anomalies(),
    };
    first.close();

    // Act
    const second = new SqliteCaseFileStore(path, opts);
    const again = openCaseFile(second, "sess_root", null);

    // Assert
    expect({
      task: again.task,
      calls: again.recentCalls(60_000),
      taint: again.taintSet(),
      secrets: again.secretReadsSince(0),
      hosts: [...again.hostsSeen()],
      files: [...again.filesWritten()],
      failures: again.failuresInARow(),
      budget: again.budget,
      anomalies: again.anomalies(),
    }).toEqual(snapshot);
    expect(snapshot.failures).toBe(1);
    expect(second.rootOf("sess_kid")).toBe("sess_root");
    second.close();
  });

  test("one database holds many sessions without mixing them", async () => {
    const store = new SqliteCaseFileStore(":memory:", { config: { home: CTX_HOME } });
    const a = openCaseFile(store, "sess_a", null);
    const b = openCaseFile(store, "sess_b", null);
    a.recordPost(await bashPost("cat x", { stdout: "https://only-a.example" }));
    a.setTaskOnce("task a");
    expect(b.taintSet()).toEqual([]);
    expect(b.task).toBeNull();
    expect(a.taintSet().map((e) => e.value)).toContain("only-a.example");
    store.close();
  });

  test("subagent rows are written under the root's session id", async () => {
    const path = tempDb();
    const store = new SqliteCaseFileStore(path);
    const child = openCaseFile(store, "sess_kid", "sess_root");
    child.recordPre(await bashPre("ls", { sessionId: "sess_kid", parentId: "sess_root" }));
    store.close();
    const db = new Database(path, { readonly: true });
    const rows = db.query("SELECT session_id, issuer_id FROM calls").all();
    expect(rows).toEqual([{ session_id: "sess_root", issuer_id: "sess_kid" }]);
    db.close();
  });

  test("a file database runs in WAL mode", () => {
    const store = new SqliteCaseFileStore(tempDb());
    expect(store.journalMode()).toBe("wal");
    store.close();
  });
});
