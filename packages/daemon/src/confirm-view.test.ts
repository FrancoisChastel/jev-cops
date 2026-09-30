import { describe, expect, test } from "bun:test";
import { bearerToken, type ConfirmView, ConfirmViews } from "./confirm-view.ts";

function view(id: string): ConfirmView {
  return { event_id: id, verdict: "hold", reason: "r", raw: `rm ${id}`, detail: "d", summary: "s" };
}

describe("ConfirmViews", () => {
  test("a view lives until its token expires, and resolve forgets it", () => {
    const views = new ConfirmViews();
    views.put(view("a"), 100);
    expect(views.get("a", 99)).toEqual(view("a"));
    expect(views.get("a", 100)).toBeNull();
    expect(views.get("a", 0)).toBeNull();
    views.put(view("b"), 100);
    views.delete("b");
    expect(views.get("b", 0)).toBeNull();
  });

  test("past the cap the oldest view is dropped, never the newest", () => {
    const views = new ConfirmViews(2);
    views.put(view("a"), 100);
    views.put(view("b"), 100);
    views.put(view("a"), 100);
    views.put(view("c"), 100);
    expect(views.get("b", 0)).toBeNull();
    expect(views.get("a", 0)).not.toBeNull();
    expect(views.get("c", 0)).not.toBeNull();
  });
});

describe("bearerToken", () => {
  test.each([
    ["Bearer abc_-9", "abc_-9"],
    ["bearer abc", "abc"],
    ["Bearer   abc  ", "abc"],
    ["Basic abc", undefined],
    ["Bearer", undefined],
    ["Bearer a b", undefined],
    [`Bearer ${"x".repeat(257)}`, undefined],
    [null, undefined],
  ])("%p → %p", (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });
});
