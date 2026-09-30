import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyLoadError, PolicySet, type PolicySnapshot } from "./policies.ts";
import { policyModule } from "./testing/policies.ts";

let dir: string;
let set: PolicySet | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-cops-policies-"));
  set = null;
});

afterEach(() => {
  set?.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  writeFileSync(join(dir, file), text);
}

function nextEvent<T>(register: (fn: (value: T) => void) => void, ms = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reload event")), ms);
    register((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe("boot", () => {
  test("loads the directory", async () => {
    write("alpha.ts", policyModule("alpha"));
    set = await PolicySet.load(dir);
    expect(set.current().policies.map((p) => p.name)).toEqual(["alpha"]);
    expect(set.current().generation).toBe(1);
  });

  test("a loader problem at boot is fatal (the daemon never runs a partial set)", async () => {
    write("alpha.ts", policyModule("alpha"));
    write("broken.ts", "export default { name: 1 };\n");
    await expect(PolicySet.load(dir)).rejects.toBeInstanceOf(PolicyLoadError);
  });

  test("a missing directory is fatal", async () => {
    await expect(PolicySet.load(join(dir, "nope"))).rejects.toBeInstanceOf(PolicyLoadError);
  });
});

describe("reload", () => {
  test("picks up a new file and a changed version", async () => {
    write("alpha.ts", policyModule("alpha"));
    set = await PolicySet.load(dir);
    write("beta.ts", policyModule("beta"));
    write("alpha.ts", policyModule("alpha", 7));
    const result = await set.reload();
    expect(result.applied).toBe(true);
    const names = set.current().policies.map((p) => `${p.name}@${p.version}`);
    expect(names).toEqual(["alpha@7", "beta@1"]);
    expect(set.current().generation).toBe(2);
  });

  test("a reload with problems keeps the previous set and reports them", async () => {
    write("alpha.ts", policyModule("alpha"));
    set = await PolicySet.load(dir);
    write("typo.ts", "export default { name: 'x' ;\n");
    const result = await set.reload();
    expect(result.applied).toBe(false);
    expect(result.problems.join("\n")).toContain("typo.ts");
    expect(set.current().policies.map((p) => p.name)).toEqual(["alpha"]);
    expect(set.current().generation).toBe(1);
  });

  test("a reload that would leave zero policies is refused", async () => {
    write("alpha.ts", policyModule("alpha"));
    set = await PolicySet.load(dir);
    rmSync(join(dir, "alpha.ts"));
    const result = await set.reload();
    expect(result.applied).toBe(false);
    expect(set.current().policies).toHaveLength(1);
  });

  test("watching the directory reloads on change", async () => {
    write("alpha.ts", policyModule("alpha"));
    let onReload: (s: PolicySnapshot) => void = () => {};
    set = await PolicySet.load(dir, { onReload: (s) => onReload(s), debounceMs: 20 });
    set.watch();
    const reloaded = nextEvent<PolicySnapshot>((fn) => {
      onReload = fn;
    });
    write("beta.ts", policyModule("beta"));
    expect((await reloaded).policies).toHaveLength(2);
  });

  test("watching reports a rejected reload", async () => {
    write("alpha.ts", policyModule("alpha"));
    let onRejected: (p: string[]) => void = () => {};
    set = await PolicySet.load(dir, { onRejected: (p) => onRejected(p), debounceMs: 20 });
    set.watch();
    const rejected = nextEvent<string[]>((fn) => {
      onRejected = fn;
    });
    write("zeta.ts", "export default 42;\n");
    expect((await rejected).join("\n")).toContain("zeta.ts");
    expect(set.current().policies).toHaveLength(1);
  });
});
