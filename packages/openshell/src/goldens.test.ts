import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS } from "../goldens/scenarios.ts";
import { compilePolicy } from "./compile.ts";
import { JUDGE_RULE } from "./fragments/judge-route.ts";
import { renderReport } from "./report.ts";
import { parsePolicyYaml } from "./schema.ts";

const DIR = join(import.meta.dir, "..", "goldens");
const UPDATE = process.env.JEV_COPS_UPDATE_GOLDENS === "1";

function golden(file: string, actual: string): string {
  const path = join(DIR, file);
  if (UPDATE) writeFileSync(path, actual);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("goldens: byte-identical", () => {
  for (const { name, input } of SCENARIOS) {
    test(name, () => {
      const out = compilePolicy(input);
      expect(renderReport(out)).toBe(golden(`${name}.report.txt`, renderReport(out)));
      const yamlPath = join(DIR, `${name}.yaml`);
      if (out.yaml === null) {
        expect(existsSync(yamlPath)).toBe(false);
        return;
      }
      expect(out.yaml).toBe(golden(`${name}.yaml`, out.yaml));
      expect(parsePolicyYaml(out.yaml).ok).toBe(true);
    });
  }
});

describe("goldens: T1 and T13 hold in every emitted policy", () => {
  const emitted = SCENARIOS.map((s) => ({ s, out: compilePolicy(s.input) })).filter(
    (x) => x.out.policy !== null,
  );

  test("no judge provider host appears in any policy", () => {
    for (const { out } of emitted) {
      for (const host of ["openrouter.ai", "typesafe.ai", "llm.corp.example"]) {
        expect(out.yaml ?? "").not.toContain(host);
      }
    }
  });

  test("the judge rule lists one binary (Claude Code: not the agent's) and four routes", () => {
    for (const { s, out } of emitted) {
      const rule = out.policy?.network_policies?.[JUDGE_RULE];
      expect(rule?.binaries).toHaveLength(1);
      if (s.input.harness === "claude-code") {
        expect(s.input.layout.agentBinaries).not.toContain(rule?.binaries?.[0]?.path ?? "");
      }
      expect(rule?.endpoints?.[0]?.rules).toHaveLength(4);
    }
  });

  test("the refused scenario names the Landlock reason", () => {
    const refused = SCENARIOS.filter((s) => s.name === "refused-home-in-workspace");
    expect(refused).toHaveLength(1);
    for (const s of refused) {
      expect(compilePolicy(s.input).refusals.join("\n")).toContain(
        "Landlock grants, never revokes",
      );
    }
  });
});
