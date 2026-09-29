import { describe, expect, test } from "bun:test";
import { hasOption, lookup, optionValue, parseArgs } from "./options.ts";

const VALUE_OPTS = new Set(["-o", "--output", "-X"]);

describe("parseArgs", () => {
  test("splits short bundles, long flags and positionals", () => {
    // Act
    const parsed = parseArgs(["-rf", "--force", "a", "b"], new Set());

    // Assert
    expect(parsed.options.map((o) => o.name)).toEqual(["-r", "-f", "--force"]);
    expect(parsed.positionals).toEqual([
      { value: "a", index: 2 },
      { value: "b", index: 3 },
    ]);
  });

  test("value options take the next word, an attached value or an = value", () => {
    const parsed = parseArgs(["-o", "x", "-XPOST", "--output=y", "--output", "z"], VALUE_OPTS);
    expect(parsed.options.map((o) => [o.name, o.value, o.index])).toEqual([
      ["-o", "x", 1],
      ["-X", "POST", 2],
      ["--output", "y", 3],
      ["--output", "z", 5],
    ]);
    expect(parsed.positionals).toEqual([]);
  });

  test("a value option at the end of a bundle consumes the next word", () => {
    const parsed = parseArgs(["-sX", "PUT", "u"], VALUE_OPTS);
    expect(optionValue(parsed, ["-X"])).toBe("PUT");
    expect(parsed.positionals.map((p) => p.value)).toEqual(["u"]);
  });

  test("-- ends options and a lone - is a positional", () => {
    const parsed = parseArgs(["-a", "--", "-b", "-"], new Set());
    expect(parsed.options.map((o) => o.name)).toEqual(["-a"]);
    expect(parsed.positionals.map((p) => p.value)).toEqual(["-b", "-"]);
  });

  test("stopAtPositional keeps everything after the first positional", () => {
    const parsed = parseArgs(["-n", "5", "rm", "-rf", "x"], new Set(["-n"]), true);
    expect(parsed.positionals.map((p) => [p.value, p.index])).toEqual([
      ["rm", 2],
      ["-rf", 3],
      ["x", 4],
    ]);
  });

  test("does not modify its input", () => {
    const args = Object.freeze(["-o", "x", "y"]);
    expect(() => parseArgs(args, VALUE_OPTS)).not.toThrow();
  });
});

describe("hasOption and optionValue", () => {
  test("find options by any of their names; the last value wins", () => {
    const parsed = parseArgs(["-X", "GET", "--output", "a", "-X", "POST"], VALUE_OPTS);
    expect(hasOption(parsed, ["--nope", "--output"])).toBe(true);
    expect(optionValue(parsed, ["-X", "--request"])).toBe("POST");
    expect(optionValue(parsed, ["-Z"])).toBeNull();
  });
});

describe("lookup", () => {
  test("returns own entries and never Object.prototype members", () => {
    const table: Readonly<Record<string, number>> = { rm: 1 };
    expect(lookup(table, "rm")).toBe(1);
    expect(lookup(table, "constructor")).toBeUndefined();
    expect(lookup(table, "__proto__")).toBeUndefined();
    expect(lookup(table, "toString")).toBeUndefined();
  });
});
