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
  test("shows through the agent socket, resets through the admin socket", async () => {
    const socket = td.config.daemon.socket;
    const adminSocket = td.config.daemon.adminSocket;
    const shown = captureIo();
    expect(await runBudgetCommand([sid, "--socket", socket], shown)).toBe(0);
    expect(shown.stdout[0]).toMatch(new RegExp(`^${sid}: spent [1-9]\\d*/100$`));
    const reset = captureIo();
    expect(await runBudgetCommand([sid, "--reset", "--admin-socket", adminSocket], reset)).toBe(0);
    expect(reset.stdout).toEqual([`${sid}: reset; now 0/100`]);
  });

  test("--reset never goes to the agent socket, which does not serve it (H1)", async () => {
    const io = captureIo();
    const agentAsAdmin = ["--reset", "--admin-socket", td.config.daemon.socket];
    expect(await runBudgetCommand([sid, ...agentAsAdmin], io)).toBe(1);
    expect(io.stderr.join("\n")).toContain("not found");
    const viaSocket = captureIo();
    const onlySocket = ["--reset", "--socket", td.config.daemon.socket];
    expect(
      await runBudgetCommand(
        [sid, ...onlySocket, "--admin-socket", `${td.dir}/none.sock`],
        viaSocket,
      ),
    ).toBe(1);
    expect(viaSocket.stderr.join("\n")).toContain(`${td.dir}/none.sock`);
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
