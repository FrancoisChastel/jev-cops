import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScript, parseScript, SCRIPT_SCHEMA } from "./script.ts";

const ls = { call: { tool: "Bash", input: { command: "ls" } } };

describe("parseScript", () => {
  test("reads scenarios, alternatives, text steps and defaults", () => {
    const s = parseScript({
      schema: SCRIPT_SCHEMA,
      models: ["gpt-fake"],
      scenarios: {
        ls: { steps: [ls, { text: "done" }] },
        alt: {
          steps: [
            {
              call: [
                { tool: "Bash", input: { command: "ls" } },
                { tool: "bash", input: { command: "ls" } },
              ],
            },
          ],
        },
      },
    });
    expect(s.defaultText).toBe("ok");
    expect(s.doneText).toBe("Noted the tool result.");
    expect(s.models).toEqual(["gpt-fake"]);
    expect(s.scenarios.get("ls")).toEqual([
      { kind: "call", alternatives: [{ tool: "Bash", input: { command: "ls" } }] },
      { kind: "text", text: "done" },
    ]);
    expect(s.scenarios.get("alt")?.[0]).toMatchObject({ kind: "call" });
  });

  test("custom default and done texts", () => {
    const s = parseScript({
      schema: SCRIPT_SCHEMA,
      default_text: "hi",
      done_text: "bye",
      scenarios: { a: { steps: [ls] } },
    });
    expect([s.defaultText, s.doneText, s.models]).toEqual(["hi", "bye", []]);
  });

  const bad: Array<[string, unknown, string]> = [
    ["not an object", [], "root"],
    ["wrong schema", { schema: "x", scenarios: {} }, "schema"],
    ["no scenarios", { schema: SCRIPT_SCHEMA }, "scenarios"],
    ["bad name", { schema: SCRIPT_SCHEMA, scenarios: { "Bad Name": { steps: [ls] } } }, "name"],
    ["empty steps", { schema: SCRIPT_SCHEMA, scenarios: { a: { steps: [] } } }, "non-empty"],
    ["step not object", { schema: SCRIPT_SCHEMA, scenarios: { a: { steps: [1] } } }, "object"],
    ["no call", { schema: SCRIPT_SCHEMA, scenarios: { a: { steps: [{}] } } }, "call or text"],
    [
      "empty call list",
      { schema: SCRIPT_SCHEMA, scenarios: { a: { steps: [{ call: [] }] } } },
      "call or text",
    ],
    [
      "tool missing",
      { schema: SCRIPT_SCHEMA, scenarios: { a: { steps: [{ call: { input: {} } }] } } },
      "tool",
    ],
    [
      "input not object",
      { schema: SCRIPT_SCHEMA, scenarios: { a: { steps: [{ call: { tool: "x", input: 1 } }] } } },
      "input",
    ],
    [
      "alternative not object",
      { schema: SCRIPT_SCHEMA, scenarios: { a: { steps: [{ call: ["x"] }] } } },
      "tool and input",
    ],
    ["models not strings", { schema: SCRIPT_SCHEMA, models: [1], scenarios: {} }, "models"],
    ["default not string", { schema: SCRIPT_SCHEMA, default_text: 1, scenarios: {} }, "default"],
  ];
  for (const [name, raw, where] of bad) {
    test(`refuses ${name}`, () => {
      expect(() => parseScript(raw)).toThrow(where);
    });
  }
});

describe("loadScript", () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-api-script-"));

  test("reads a file", () => {
    const path = join(dir, "ok.json");
    writeFileSync(
      path,
      JSON.stringify({ schema: SCRIPT_SCHEMA, scenarios: { a: { steps: [ls] } } }),
    );
    expect(loadScript(path).scenarios.size).toBe(1);
  });

  test("the committed live scenarios parse", () => {
    const s = loadScript(join(import.meta.dir, "..", "scenarios.json"));
    expect([...s.scenarios.keys()]).toContain("push-main");
    expect(s.scenarios.get("tainted-rm")).toHaveLength(2);
  });

  test("names the file on invalid JSON or a missing file", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{");
    expect(() => loadScript(path)).toThrow(path);
    expect(() => loadScript(join(dir, "missing.json"))).toThrow("missing.json");
  });
});
