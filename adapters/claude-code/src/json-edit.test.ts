import { describe, expect, test } from "bun:test";
import { patchJsonText } from "./json-edit.ts";

const parse = (t: string | null) => JSON.parse(t ?? "null") as unknown;

/** Patches `text` to `next`, checks the value, and returns the text. */
function patched(text: string, next: unknown): string {
  const out = patchJsonText(text, next);
  expect(out).not.toBeNull();
  expect(JSON.stringify(parse(out))).toBe(JSON.stringify(next));
  return out ?? "";
}

describe("patchJsonText: only what changes is rewritten", () => {
  test("an unchanged value gives the text back, whatever its layout", () => {
    const text = '{ "a" :[1,2],\n\n  "b":"x" }  \n';
    expect(patchJsonText(text, { a: [1, 2], b: "x" })).toBe(text);
  });

  test("a scalar changes in place", () => {
    const text = '{\n  "a": 1,\n  "b": ["keep",  "this"]\n}\n';
    expect(patched(text, { a: 2, b: ["keep", "this"] })).toBe(
      '{\n  "a": 2,\n  "b": ["keep",  "this"]\n}\n',
    );
  });

  test("a member removed first, in the middle or last takes its separator with it", () => {
    const text = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
    expect(patched(text, { b: 2, c: 3 })).toBe('{\n  "b": 2,\n  "c": 3\n}\n');
    expect(patched(text, { a: 1, c: 3 })).toBe('{\n  "a": 1,\n  "c": 3\n}\n');
    expect(patched(text, { a: 1, b: 2 })).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
    expect(patched(text, { a: 1 })).toBe('{\n  "a": 1\n}\n');
    expect(patched('{"a":[1,2,3,4]}', { a: [1, 4] })).toBe('{"a":[1,4]}');
  });

  test("the last member replaced by another: removed and appended in one place", () => {
    const text = '{\n  "a": 1,\n  "b": 2\n}\n';
    expect(patched(text, { a: 1, c: { d: true } })).toBe(
      '{\n  "a": 1,\n  "c": {\n    "d": true\n  }\n}\n',
    );
  });

  test("appended members follow the container's own separator and spacing", () => {
    expect(patched('{"a":1}', { a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
    expect(patched('{ "a": 1 }', { a: 1, b: 2 })).toBe('{ "a": 1, "b": 2 }');
    expect(patched('{\n\t"a": 1\n}', { a: 1, b: { c: 1 } })).toBe(
      '{\n\t"a": 1,\n\t"b": {\n\t\t"c": 1\n\t}\n}',
    );
    expect(patched('{\r\n  "a": 1\r\n}\r\n', { a: 1, b: [1] })).toBe(
      '{\r\n  "a": 1,\r\n  "b": [\r\n    1\r\n  ]\r\n}\r\n',
    );
  });

  test("a one-line container in a pretty file gets one-line values", () => {
    const text = '{\n  "h": {"x": [1]}\n}\n';
    expect(patched(text, { h: { x: [1], y: { z: 2 } } })).toBe(
      '{\n  "h": {"x": [1], "y": {"z":2}}\n}\n',
    );
  });

  test("empty containers get their first entries one per line (or on the one line)", () => {
    expect(patched("{}\n", { a: 1 })).toBe('{\n  "a": 1\n}\n');
    expect(patched('{\n  "a": []\n}\n', { a: [{ b: 1 }] })).toBe(
      '{\n  "a": [\n    {\n      "b": 1\n    }\n  ]\n}\n',
    );
    expect(patched('{"a":{}}', { a: { b: 1 } })).toBe('{"a":{"b":1}}');
    expect(patched('{"a":[1],"b":{}}', { a: [], b: {} })).toBe('{"a":[],"b":{}}');
  });

  test("an element changed in place, one removed, one appended", () => {
    const text = '[\n  {"k": 1, "v": "old"},\n  {"k": 2},\n  {"k": 3}\n]';
    expect(patched(text, [{ k: 1, v: "new" }, { k: 3 }, { k: 4 }])).toBe(
      '[\n  {"k": 1, "v": "new"},\n  {"k": 3},\n  {\n    "k": 4\n  }\n]',
    );
  });

  test("strings with escapes and every scalar kind are read", () => {
    const text = '{"s": "a\\"b\\\\", "n": -1.5e3, "t": true, "f": false, "z": null}';
    expect(patched(text, { s: 'a"b\\', n: -1500, t: true, f: false, z: null, x: 1 })).toBe(
      '{"s": "a\\"b\\\\", "n": -1.5e3, "t": true, "f": false, "z": null, "x": 1}',
    );
  });
});

describe("patchJsonText: what takes more than a local edit", () => {
  test("keys reordered or inserted before kept ones: that object is rewritten", () => {
    const text = '{\n  "o": {"a": 1, "b": 2},\n  "p": 1\n}\n';
    expect(patched(text, { o: { b: 2, a: 1 }, p: 1 })).toBe(
      '{\n  "o": {"b":2,"a":1},\n  "p": 1\n}\n',
    );
    expect(patched(text, { o: { z: 0, a: 1, b: 2 }, p: 1 })).toBe(
      '{\n  "o": {"z":0,"a":1,"b":2},\n  "p": 1\n}\n',
    );
  });

  test("an element inserted mid-array, or every member replaced: that container is rewritten", () => {
    const text = '{\n  "a": [1, 3],\n  "b": ["x"]\n}\n';
    expect(patched(text, { a: [1, 2, 3], b: ["x"] })).toBe('{\n  "a": [1,2,3],\n  "b": ["x"]\n}\n');
    const multi = '{\n  "a": [\n    "x"\n  ]\n}\n';
    expect(patched(multi, { a: [{ y: 1 }] })).toBe('{\n  "a": [\n    {"y":1}\n  ]\n}\n');
    const all = '{\n  "a": {\n    "x": 1\n  }\n}\n';
    expect(patched(all, { a: { y: 2 } })).toBe('{\n  "a": {\n    "y": 2\n  }\n}\n');
  });

  test("a type change is a replacement of that value", () => {
    expect(patched('{"a": [1]}', { a: { b: 1 } })).toBe('{"a": {"b":1}}');
    expect(patched('{\n  "a": {}\n}', { a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
  });

  test.each([
    ["the root replaced (keys reordered at the top)", '{"a":1,"b":2}', { b: 2, a: 1 }],
    ["a root of another type", "[1]", { a: 1 }],
    ["a duplicate key", '{"a":1,"a":2}', { a: 3 }],
    ["text that is not JSON", '{"a":1,}', { a: 1 }],
    ["trailing text", '{"a":1} x', { a: 2 }],
    ["an unterminated string", '{"a":"x', { a: 1 }],
    ["a missing value", '{"a":}', { a: 1 }],
  ])("null (the caller writes it afresh): %s", (_name, text, next) => {
    expect(patchJsonText(text, next)).toBeNull();
  });
});
