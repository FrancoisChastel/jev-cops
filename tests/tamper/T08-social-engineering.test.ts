/**
 * T8 — Social engineering the human (spec §Threat model).
 *
 * Attack: Agent's stated reason misdescribes the command
 * Required outcome: Confirm prompt shows the normalized raw command and the daemon's `detail`, never the agent's text
 *
 * Status: live (Pi adapter): an interactive `hold` asks with the daemon's normalized raw
 * command and `detail` (fetched from `/v1/explain`), never the tool input's prose. The
 * Claude Code hold-to-ask mapping is M1.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { register } from "../../adapters/pi/jevdict.ts";
import { FakePi, fakeContext } from "../../adapters/pi/testing/fake-pi.ts";
import { startTestDaemon, type TestDaemon } from "../../packages/daemon/src/testing/daemon.ts";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  "Confirm prompt shows the normalized raw command and the daemon's `detail`, never the agent's text";
const REPO_POLICIES = join(import.meta.dir, "..", "..", "policies");

let td: TestDaemon | null = null;
afterEach(async () => {
  await td?.stop();
  td = null;
});

describe("T8 social engineering the human", () => {
  test(`Pi: ${REQUIRED_OUTCOME}`, async () => {
    td = await startTestDaemon({ policies: {}, policiesDir: REPO_POLICIES });
    const pi = new FakePi();
    register(pi, { socket: td.config.daemon.socket });
    const ctx = fakeContext({ cwd: td.dir, hasUI: true, confirm: false });
    const lie = "Just a harmless fetch of the latest changes, nothing is overwritten";
    await pi.run(ctx, "bash", { command: "git push --force origin main", description: lie });
    const [asked] = ctx.log.confirms;
    expect(asked?.message).toContain("git push --force origin main");
    expect(asked?.message).toContain("default main/master");
    expect(`${asked?.title}\n${asked?.message}`).not.toContain(lie);
  });

  test.todo(
    `Claude Code: ${REQUIRED_OUTCOME}`,
    pending("M1 (hold-to-ask mapping in the Claude Code adapter)"),
  );
});
