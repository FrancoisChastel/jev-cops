import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookCommand } from "../../../../adapters/claude-code/testing/setup.ts";
import {
  type DoctorFixture,
  doctorEnv,
  doctorFixture,
  executable,
  installHook,
  userSettingsPath,
  writeJson,
} from "../testing/doctor.ts";
import { CLI_VERSION } from "../version.ts";
import {
  binaryChecks,
  duplicatesCheck,
  execFormCheck,
  foreignHooksCheck,
  hookFacts,
  hookVersionChecks,
  registrationCheck,
  socketChecks,
} from "./doctor-hook-checks.ts";
import { readClaudeSettings } from "./doctor-settings.ts";

let f: DoctorFixture;
let socket = "";

beforeEach(() => {
  f = doctorFixture();
  socket = join(f.root, "copsd.sock");
});
afterEach(() => f.dispose());

const facts = () => {
  const e = doctorEnv(f);
  return { e, f: hookFacts(readClaudeSettings(e), e) };
};

/** The settings of an install whose PreToolUse entry runs `command` with the jev-cops flags. */
function withPreToolUse(command: string, args?: string[]): void {
  const settings = installHook(f, socket) as { hooks: Record<string, unknown[]> };
  const handler = {
    type: "command",
    command,
    args: args ?? ["--harness", "claude-code", "--socket", socket],
  };
  writeJson(userSettingsPath(f), {
    ...settings,
    hooks: { ...settings.hooks, PreToolUse: [{ hooks: [handler] }] },
  });
}

describe("doctor: the jev-cops hook as registered", () => {
  test("an intact user install: registered, exec form, binary, socket, no duplicates, no foreign hook", () => {
    installHook(f, socket);
    const { e, f: x } = facts();
    expect(registrationCheck(x, e)).toMatchObject({ status: "ok", group: "claude-code hook" });
    expect(execFormCheck(x).status).toBe("ok");
    expect(binaryChecks(x).map((c) => c.status)).toEqual(["ok"]);
    expect(socketChecks(x, socket).map((c) => c.status)).toEqual(["ok"]);
    expect(duplicatesCheck(x).status).toBe("ok");
    expect(foreignHooksCheck(x)).toMatchObject({ status: "ok", detail: "none" });
  });

  test("no settings at all: fail, with the install hint", () => {
    const { e, f: x } = facts();
    const c = registrationCheck(x, e);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("every tool runs unjudged");
    expect(c.detail).toContain("cops install claude-code");
  });

  test("the PreToolUse entry removed: fail naming the event", () => {
    const settings = installHook(f, socket) as { hooks: Record<string, unknown> };
    const { PreToolUse: _gone, ...rest } = settings.hooks;
    writeJson(userSettingsPath(f), { hooks: rest });
    const { e, f: x } = facts();
    const c = registrationCheck(x, e);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("PreToolUse");
  });

  test("disableAllHooks makes the install not intact", () => {
    installHook(f, socket, { disableAllHooks: true });
    const { e, f: x } = facts();
    expect(registrationCheck(x, e)).toMatchObject({ status: "fail" });
    expect(registrationCheck(x, e).detail).toContain("disableAllHooks");
  });

  test("a shell-form entry fails the exec-form check", () => {
    writeJson(userSettingsPath(f), {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: `cops-hook --harness claude-code --socket ${socket}` },
            ],
          },
        ],
      },
    });
    const { e, f: x } = facts();
    expect(execFormCheck(x).status).toBe("fail");
    expect(registrationCheck(x, e).status).toBe("fail");
  });

  test("binary missing, not executable, or not on PATH: gate silently disabled", () => {
    withPreToolUse(join(f.root, "gone", "cops-hook"));
    const missing = binaryChecks(facts().f).find((c) => c.detail.includes("does not exist"));
    expect(missing?.status).toBe("fail");
    expect(missing?.detail).toContain("gate silently disabled");

    const plain = join(f.bin, "cops-hook");
    writeFileSync(plain, "#!/bin/sh\nexit 0\n");
    chmodSync(plain, 0o644);
    withPreToolUse(plain);
    expect(
      binaryChecks(facts().f).some(
        (c) => c.status === "fail" && c.detail.includes("is not executable"),
      ),
    ).toBe(true);

    withPreToolUse("cops-hook-nowhere");
    expect(
      binaryChecks(facts().f).some(
        (c) => c.status === "fail" && c.detail.includes("is not on PATH"),
      ),
    ).toBe(true);
  });

  test("a hook whose socket is not copsd's fails; unparsable flags fail", () => {
    installHook(f, join(f.root, "other.sock"));
    expect(socketChecks(facts().f, socket)[0]?.status).toBe("fail");
    withPreToolUse(process.execPath, ["x.ts", "--harness", "claude-code", "--bogus"]);
    const bad = socketChecks(facts().f, socket).find((c) => c.detail.includes("do not parse"));
    expect(bad?.status).toBe("fail");
  });

  test("mismatched duplicates across files warn", () => {
    installHook(f, socket);
    const other = hookCommand(join(f.root, "second.sock"));
    writeJson(join(f.project, ".claude", "settings.json"), {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: other.command, args: other.args }] }],
      },
    });
    const c = duplicatesCheck(facts().f);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("second.sock");
  });

  test("another PreToolUse hook that could rewrite the input warns", () => {
    const settings = installHook(f, socket) as { hooks: Record<string, unknown[]> };
    const foreign = { hooks: [{ type: "command", command: "/opt/rewriter", args: [] }] };
    const http = { hooks: [{ type: "http", url: "http://127.0.0.1:9/pre" }] };
    const pre = [...(settings.hooks.PreToolUse ?? []), foreign, http];
    writeJson(userSettingsPath(f), { ...settings, hooks: { ...settings.hooks, PreToolUse: pre } });
    const c = foreignHooksCheck(facts().f);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("/opt/rewriter");
    expect(c.detail).toContain("http://127.0.0.1:9/pre");
    expect(c.detail).toContain("updatedInput");
  });

  test("hook --version: matches, differs, or is not reported", async () => {
    const same = executable(f.bin, "cops-hook", `[ "$1" = --version ] && echo ${CLI_VERSION}`);
    withPreToolUse(same);
    expect((await hookVersionChecks(facts().f, facts().e))[0]?.status).toBe("ok");

    executable(f.bin, "cops-hook", `[ "$1" = --version ] && echo 9.9.9`);
    const differs = (await hookVersionChecks(facts().f, facts().e))[0];
    expect(differs?.status).toBe("warn");
    expect(differs?.detail).toContain("9.9.9");

    installHook(f, socket);
    const source = (await hookVersionChecks(facts().f, facts().e))[0];
    expect(source?.status).toBe("warn");
    expect(source?.detail).toContain("does not report a version");
  });
});
