import { describe, expect, test } from "bun:test";
import { describeCaseFileContract } from "../../../../tests/fixtures/context/casefile-contract.ts";
import { createCaseFile, InMemoryCaseFileStore, openCaseFile } from "./casefile.ts";

describeCaseFileContract("InMemoryCaseFileStore", (opts) => new InMemoryCaseFileStore(opts));

describe("InMemoryCaseFileStore", () => {
  test("root() returns the same case file for the same session", () => {
    const store = new InMemoryCaseFileStore();
    expect(store.root("sess_a")).toBe(store.root("sess_a"));
    expect(store.root("sess_a")).not.toBe(store.root("sess_b"));
  });

  test("a linked session keeps its first root and resolves when reopened without parent", () => {
    const store = new InMemoryCaseFileStore();
    expect(store.link("sess_c", "sess_p")).toBe("sess_p");
    expect(store.link("sess_c", "sess_other")).toBe("sess_p");
    expect(openCaseFile(store, "sess_c", null).sessionId).toBe("sess_c");
    expect(store.rootOf("sess_c")).toBe("sess_p");
  });

  test("a session named as its own parent stays a root", () => {
    const store = new InMemoryCaseFileStore();
    expect(openCaseFile(store, "sess_x", "sess_x").parentId).toBeNull();
  });

  test("createCaseFile builds a single root with the injected clock", () => {
    const cf = createCaseFile("sess_a", { now: () => 42 });
    expect(cf.now()).toBe(42);
    expect(cf.parentId).toBeNull();
  });
});
