import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "../goldens/scenarios.ts";
import { writeBunScript } from "../testing/script.ts";
import { compilePolicy } from "./compile.ts";
import { emitPolicy } from "./emit.ts";
import { JUDGE_PROVIDER_HOSTS } from "./fragments/judge-hosts.ts";
import { findProver, proverBoundary, proverCheck } from "./prover.ts";
import type { OpenShellPolicy } from "./schema.ts";

const dir = mkdtempSync(join(tmpdir(), "jev-cops-prover-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CANDIDATE: OpenShellPolicy = {
  version: 1,
  filesystem_policy: { read_only: ["/usr"], read_write: ["/tmp"] },
  landlock: { compatibility: "best_effort" },
  network_policies: {
    judge: { endpoints: [{ host: "openrouter.ai", port: 443 }] },
    mixed: {
      endpoints: [
        { host: "api.typesafe.ai", port: 443 },
        { host: "registry.npmjs.org", port: 443 },
      ],
    },
  },
};

describe("proverBoundary", () => {
  test("drops judge-host endpoints, keeps paths, requires hard Landlock", () => {
    const b = proverBoundary(CANDIDATE, JUDGE_PROVIDER_HOSTS);
    expect(Object.keys(b.network_policies ?? {})).toEqual(["mixed"]);
    expect(b.network_policies?.mixed?.endpoints).toEqual([
      { host: "registry.npmjs.org", port: 443 },
    ]);
    expect(b.filesystem_policy).toEqual(CANDIDATE.filesystem_policy);
    expect(b.landlock).toEqual({ compatibility: "hard_requirement" });
  });
});

describe("proverCheck against a scripted prover", () => {
  const argvFile = join(dir, "argv.json");
  const fake = writeBunScript(
    dir,
    "fake-prover",
    `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
const mode = process.argv[3].includes("bad") ? "bad" : "ok";
if (mode === "bad") { console.log("not json"); process.exit(2); }
console.log(JSON.stringify({ result: "within_boundary", exit_code: 0, reason: null }));`,
  );

  test("documented argv, JSON result", async () => {
    const r = await proverCheck(fake, "/tmp/c.yaml", "/tmp/b.yaml");
    expect(r).toMatchObject({ result: "within_boundary", exitCode: 0, reason: null });
    expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
      "check",
      "/tmp/c.yaml",
      "--boundary",
      "/tmp/b.yaml",
      "--output",
      "json",
    ]);
  });

  test("unparseable output is not a pass", async () => {
    const r = await proverCheck(fake, "/tmp/bad.yaml", "/tmp/b.yaml");
    expect(r.result).toBe("unreadable");
    expect(r.exitCode).toBe(2);
  });

  test("findProver looks only at absolute PATH entries", () => {
    expect(findProver(`relative:${dir}`)).toBeNull();
  });
});

describe("goldens within their boundaries (openshell-prover, optional)", () => {
  const prover = findProver();
  test("every emitted golden passes openshell-prover check", async () => {
    if (prover === null) {
      console.log("prover not installed: boundary check skipped");
      return;
    }
    for (const { name, input } of SCENARIOS) {
      const out = compilePolicy(input);
      if (out.policy === null || out.yaml === null) continue;
      const candidate = join(dir, `${name}.yaml`);
      const boundary = join(dir, `${name}.boundary.yaml`);
      writeFileSync(candidate, out.yaml);
      const meta = { version: "boundary", inputsHash: out.inputsHash };
      writeFileSync(boundary, emitPolicy(proverBoundary(out.policy, out.judgeHosts), meta));
      const r = await proverCheck(prover, candidate, boundary);
      expect(`${name}: ${r.result}`).toBe(`${name}: within_boundary`);
    }
  });
});
