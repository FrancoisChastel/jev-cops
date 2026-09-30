import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { installPiExtension, PI_GAPS } from "@jev-cops/adapter-pi/install";
import { type DoctorFixture, doctorEnv, doctorFixture, executable } from "../testing/doctor.ts";
import { gapChecks, piChecks } from "./doctor-pi.ts";

let f: DoctorFixture;
let socket = "";
beforeEach(() => {
  f = doctorFixture();
  socket = join(f.root, "copsd.sock");
});
afterEach(() => f.dispose());

const quiet = { print: () => {}, env: {} };
const named = (checks: ReturnType<typeof piChecks>, name: string) =>
  checks.filter((c) => c.name === name);

describe("doctor: the Pi extension", () => {
  test("Pi not detected under --harness all: one warning, nothing else", () => {
    const checks = piChecks(doctorEnv(f), socket, false);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ group: "pi", status: "warn" });
    expect(checks[0]?.detail).toContain("not detected");
  });

  test("asked for (or pi on PATH) with no extension: fail", () => {
    expect(piChecks(doctorEnv(f), socket, true)[0]?.status).toBe("fail");
    executable(f.bin, "pi", "exit 0");
    const [missing] = piChecks(doctorEnv(f), socket, false);
    expect(missing?.status).toBe("fail");
    expect(missing?.detail).toContain("cops install pi");
  });

  test("a global install with the socket baked in: extension, socket and content ok", () => {
    installPiExtension({ ...quiet, global: true, home: f.home, socket });
    const checks = piChecks(doctorEnv(f), socket, false);
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["extension", "ok"],
      ["socket", "ok"],
      ["extension content", "ok"],
    ]);
  });

  test("PI_CODING_AGENT_DIR is where the global extension lives", () => {
    const agentDir = join(f.root, "pi-agent");
    installPiExtension({ ...quiet, global: true, env: { PI_CODING_AGENT_DIR: agentDir }, socket });
    const checks = piChecks(doctorEnv(f, { PI_CODING_AGENT_DIR: agentDir }), socket, true);
    expect(named(checks, "extension")[0]?.detail).toContain(agentDir);
  });

  test("a baked socket that is not copsd's fails; an edited file warns", () => {
    installPiExtension({
      ...quiet,
      global: true,
      home: f.home,
      socket: join(f.root, "other.sock"),
    });
    expect(named(piChecks(doctorEnv(f), socket, true), "socket")[0]?.status).toBe("fail");
    const file = join(f.home, ".pi", "agent", "extensions", "jev-cops.ts");
    appendFileSync(file, "\n// edited\n");
    const content = named(piChecks(doctorEnv(f), socket, true), "extension content")[0];
    expect(content?.status).toBe("warn");
    expect(content?.detail).toContain("Reinstall");
  });

  test("an unbaked project install: loads after project trust; socket resolved from the environment", () => {
    installPiExtension({ ...quiet, projectDir: f.project });
    const def = join(f.home, ".jev-cops", "copsd.sock");
    const checks = piChecks(doctorEnv(f), def, false);
    expect(named(checks, "extension")[0]?.detail).toContain("trusted");
    expect(named(checks, "socket")[0]?.status).toBe("ok");
    expect(named(piChecks(doctorEnv(f), socket, false), "socket")[0]?.status).toBe("warn");
    const viaEnv = piChecks(doctorEnv(f, { JEV_COPS_SOCKET: socket }), socket, false);
    expect(named(viaEnv, "socket")[0]?.status).toBe("ok");
  });

  test("a file without the installer's socket line is not jev-cops's extension", () => {
    const dir = join(f.home, ".pi", "agent", "extensions");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "jev-cops.ts"), "export default function () {}\n");
    const checks = piChecks(doctorEnv(f), socket, true);
    expect(named(checks, "socket")[0]?.status).toBe("warn");
    expect(named(checks, "extension content")[0]?.status).toBe("warn");
  });
});

describe("doctor: gaps are always printed", () => {
  test("one gap check per string, in order", () => {
    const gaps = gapChecks("pi gaps", PI_GAPS);
    expect(gaps.map((g) => g.detail)).toEqual([...PI_GAPS]);
    expect(gaps.every((g) => g.status === "gap" && g.group === "pi gaps")).toBe(true);
  });
});
