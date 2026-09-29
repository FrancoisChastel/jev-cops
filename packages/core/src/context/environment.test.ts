import { describe, expect, test } from "bun:test";
import { bashPre, CTX_HOME } from "../../../../tests/fixtures/context/index.ts";
import { resolveContextConfig } from "./config.ts";
import { environmentScore } from "./environment.ts";

const CFG = resolveContextConfig({ home: CTX_HOME });
const MAIN = { repo: "/work/repo", branch: "main", dirty: false, default_branch: "main" };
const FEATURE = { ...MAIN, branch: "feat/x" };

describe("environmentScore: weighted exposure", () => {
  test("feature branch, clean, interactive, sandboxed, no host: 0", async () => {
    const n = await bashPre("ls", { git: FEATURE, sandbox: "openshell" });
    expect(environmentScore(n, CFG)).toEqual({ value: 0, why: [] });
  });

  test.each([
    ["default branch", { git: MAIN }, 0.3],
    ["cwd outside repo", { git: FEATURE, cwd: "/work/other" }, 0.2],
    ["dirty tree", { git: { ...FEATURE, dirty: true } }, 0.1],
    ["headless", { git: FEATURE, mode: "headless" as const }, 0.2],
    ["no sandbox", { git: FEATURE, sandbox: "none" as const }, 0.1],
  ])("%s adds its weight", async (label, shape, weight) => {
    const n = await bashPre("ls", { sandbox: "openshell", ...shape });
    const score = environmentScore(n, CFG);
    expect(score.value).toBe(weight);
    expect(score.why).toEqual([label]);
  });

  test("no repo at all counts as cwd outside repo", async () => {
    const n = await bashPre("ls", { git: null, sandbox: "openshell" });
    expect(environmentScore(n, CFG).value).toBe(0.2);
  });

  test("main/master count as default when default_branch is unknown", async () => {
    const git = { repo: "/work/repo", branch: "master" };
    const n = await bashPre("ls", { git, sandbox: "openshell" });
    expect(environmentScore(n, CFG).why).toEqual(["default branch"]);
  });

  test("target host credential class: prod 0.3, staging 0.15, dev 0, unknown 0.05", async () => {
    const cfg = resolveContextConfig({
      home: CTX_HOME,
      environment: {
        hostClasses: {
          "db.prod.example": "prod",
          "db.stg.example": "staging",
          "dev.example": "dev",
        },
      },
    });
    const score = async (host: string) =>
      environmentScore(
        await bashPre(`curl https://${host}`, { git: FEATURE, sandbox: "openshell" }),
        cfg,
      ).value;
    expect(await score("db.prod.example")).toBe(0.3);
    expect(await score("db.stg.example")).toBe(0.15);
    expect(await score("dev.example")).toBe(0);
    expect(await score("other.example")).toBe(0.05);
  });

  test("the highest host class wins across hosts", async () => {
    const cfg = resolveContextConfig({ environment: { hostClasses: { "p.example": "prod" } } });
    const n = await bashPre("curl https://x.example https://p.example", {
      git: FEATURE,
      sandbox: "openshell",
    });
    expect(environmentScore(n, cfg).value).toBe(0.3);
  });

  test("the sum is clamped to 1", async () => {
    const cfg = resolveContextConfig({ environment: { hostClasses: { "p.example": "prod" } } });
    const n = await bashPre("curl https://p.example", {
      git: { ...MAIN, dirty: true },
      cwd: "/elsewhere",
      mode: "headless",
      sandbox: "none",
    });
    expect(environmentScore(n, cfg).value).toBe(1);
  });

  test("git push --force on the default branch, headless: ≥ 0.5", async () => {
    const n = await bashPre("git push --force", { git: MAIN, mode: "headless" });
    expect(environmentScore(n, CFG).value).toBeGreaterThanOrEqual(0.5);
  });
});
