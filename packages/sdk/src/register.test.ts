import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePolicy, VERDICTS } from "./index.ts";
import { registerSdkModule } from "./register.ts";

const dir = mkdtempSync(join(tmpdir(), "jvsdk-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("registerSdkModule", () => {
  test("a policy outside any package resolves @jevdict/sdk to this SDK's own copy", async () => {
    // Arrange: /tmp has no node_modules and no tsconfig path for the package.
    const file = join(dir, "outside.ts");
    writeFileSync(
      file,
      `import { definePolicy, VERDICTS } from "@jevdict/sdk";
export const verdicts = VERDICTS;
export const define = definePolicy;
export default definePolicy({
  name: "outside", version: 1, owner: "tests",
  when: () => true, decide: () => "allow", reason: "loaded from outside the repo",
});
`,
    );

    // Act
    registerSdkModule();
    registerSdkModule();
    const mod = (await import(file)) as {
      default: { name: string };
      verdicts: unknown;
      define: unknown;
    };

    // Assert
    expect(mod.default.name).toBe("outside");
    expect(mod.verdicts).toBe(VERDICTS);
    expect(mod.define).toBe(definePolicy);
  });
});
