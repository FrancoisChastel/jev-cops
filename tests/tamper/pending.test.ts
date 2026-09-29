import { describe, expect, test } from "bun:test";
import { pending } from "./pending.ts";

describe("pending: the body of a threat's test.todo", () => {
  test("throws naming the milestone, so `bun test --todo` reports it unimplemented", () => {
    expect(pending("M2 (OpenShell)")).toThrow("pending until M2 (OpenShell)");
  });
});
