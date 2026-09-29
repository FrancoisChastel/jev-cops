import { describe, expect, test } from "bun:test";
import { canonicalJson, safeStringify, sha256Hex } from "./hash.ts";

describe("canonicalJson", () => {
  test("sorts keys at every level so key order never changes the output", () => {
    const a = canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  test("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("renders cycles as [Circular] and non-JSON values as null", () => {
    // Arrange
    const cyclic: Record<string, unknown> = { f: () => 1, u: undefined, n: 10n };
    cyclic.self = cyclic;

    // Act
    const json = canonicalJson(cyclic);

    // Assert
    expect(json).toBe('{"f":null,"n":"10","self":"[Circular]","u":null}');
  });

  test("keeps an own __proto__ key as data", () => {
    const value = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    expect(canonicalJson(value)).toBe('{"__proto__":{"x":1}}');
  });
});

describe("sha256Hex", () => {
  test("matches the known digest of the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("safeStringify", () => {
  test("is JSON.stringify for ordinary values, keeping key order", () => {
    expect(safeStringify({ b: 1, a: 2 })).toBe('{"b":1,"a":2}');
  });

  test("does not throw on a cycle", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(safeStringify(cyclic)).toBe('{"a":1,"self":"[Circular]"}');
  });
});
