import { describe, expect, test } from "bun:test";
import { getParser, parseBash } from "./parser.ts";

describe("getParser", () => {
  test("returns the same parser instance on every call", async () => {
    // Act
    const [first, second] = await Promise.all([getParser(), getParser()]);

    // Assert
    expect(first).toBe(second);
  });

  test("parses a pipeline into a program with three commands", async () => {
    // Arrange
    const parser = await getParser();

    // Act
    const tree = parser.parse("echo aGk= | base64 -d | sh");

    // Assert
    expect(tree?.rootNode.toString()).toStartWith("(program (pipeline (command");
    expect(tree?.rootNode.namedChild(0)?.namedChildCount).toBe(3);
    tree?.delete();
  });
});

describe("parseBash", () => {
  test("hands the root node to the visitor and returns its result", async () => {
    // Act
    const type = await parseBash("ls -la", (root) => root.type);

    // Assert
    expect(type).toBe("program");
  });

  test("returns null when the visitor throws, never propagating the error", async () => {
    // Act
    const result = await parseBash("ls", () => {
      throw new Error("boom");
    });

    // Assert
    expect(result).toBeNull();
  });
});
