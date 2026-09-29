import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildEvent } from "../../../../tests/fixtures/context/index.ts";
import {
  startTestDaemon,
  type TestDaemon,
  withFreshId,
} from "../../../daemon/src/testing/daemon.ts";
import { policyModule } from "../../../daemon/src/testing/policies.ts";
import { captureIo } from "../io.ts";
import { runBudgetCommand } from "./budget.ts";

let td: TestDaemon;
let sid: string;

beforeAll(async () => {
  td = await startTestDaemon({ policies: { "hold.ts": policyModule("hold", 1, "hold") } });
  const e = withFreshId(
    buildEvent({ tool: "Bash", kind: "exec", input: { command: "rm -rf /srv/x" } }),
  );
  await td.call("POST", "/v1/judge", e);
  sid = e.session.id;
});

afterAll(async () => {
  await td.stop();
});

describe("jevdict budget", () => {
  test("shows then resets a session's budget through the socket", async () => {
    const socket = td.config.daemon.socket;
    const shown = captureIo();
    expect(await runBudgetCommand([sid, "--socket", socket], shown)).toBe(0);
    expect(shown.stdout[0]).toMatch(new RegExp(`^${sid}: spent [1-9]\\d*/100$`));
    const reset = captureIo();
    expect(await runBudgetCommand([sid, "--reset", "--socket", socket], reset)).toBe(0);
    expect(reset.stdout).toEqual([`${sid}: reset; now 0/100`]);
  });

  test("unknown session or unreachable daemon exits 1; usage exits 2", async () => {
    const io = captureIo();
    expect(await runBudgetCommand(["sess_nobody", "--socket", td.config.daemon.socket], io)).toBe(
      1,
    );
    expect(io.stderr.join("\n")).toContain("unknown session");
    const down = captureIo();
    expect(await runBudgetCommand([sid, "--socket", `${td.dir}/none.sock`], down)).toBe(1);
    expect(down.stderr.join("\n")).toContain("unreachable");
    expect(await runBudgetCommand([], captureIo())).toBe(2);
  });
});
