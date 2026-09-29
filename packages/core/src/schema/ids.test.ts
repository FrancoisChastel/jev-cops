import { describe, expect, test } from "bun:test";
import { callIdSchema, eventIdSchema, isUlid, mintEventId, sessionIdSchema } from "./ids.ts";

const VALID_ULID = "01M3PP723DWGXKY6ZN6TC6ZMXZ";

describe("isUlid", () => {
  test("accepts a canonical 26-char Crockford base32 ULID", () => {
    expect(isUlid(VALID_ULID)).toBe(true);
  });

  test.each([
    ["too short", VALID_ULID.slice(0, 25)],
    ["too long", `${VALID_ULID}0`],
    ["excluded letter I", `${VALID_ULID.slice(0, 25)}I`],
    ["excluded letter L", `${VALID_ULID.slice(0, 25)}L`],
    ["excluded letter O", `${VALID_ULID.slice(0, 25)}O`],
    ["excluded letter U", `${VALID_ULID.slice(0, 25)}U`],
    ["lowercase", VALID_ULID.toLowerCase()],
    ["timestamp overflow", `8${VALID_ULID.slice(1)}`],
    ["spec placeholder", "01J9…"],
    ["empty", ""],
  ])("rejects %s", (_label, candidate) => {
    expect(isUlid(candidate)).toBe(false);
  });
});

describe("eventIdSchema", () => {
  test("accepts evt_ followed by a ULID", () => {
    expect(eventIdSchema.safeParse(`evt_${VALID_ULID}`).success).toBe(true);
  });

  test.each([
    ["a bare ULID", VALID_ULID],
    ["the wrong prefix", `call_${VALID_ULID}`],
    ["a malformed ULID", "evt_01J9"],
    ["a non-string", 42],
  ])("rejects %s", (_label, candidate) => {
    expect(eventIdSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("sessionIdSchema and callIdSchema", () => {
  test("accept any non-empty suffix after their prefix", () => {
    expect(sessionIdSchema.safeParse("sess_abc").success).toBe(true);
    expect(callIdSchema.safeParse("call_toolu_01A9bX").success).toBe(true);
  });

  test.each([
    ["sess_", sessionIdSchema],
    ["session_abc", sessionIdSchema],
    ["sess_ has space", sessionIdSchema],
    ["call_", callIdSchema],
    ["toolu_01A9bX", callIdSchema],
  ])("rejects %p", (candidate, schema) => {
    expect(schema.safeParse(candidate).success).toBe(false);
  });
});

describe("mintEventId", () => {
  test("mints ids that its own schema accepts", () => {
    // Act
    const id = mintEventId();

    // Assert
    expect(eventIdSchema.safeParse(id).success).toBe(true);
  });

  test("mints a distinct id on every call", () => {
    // Act
    const ids = new Set(Array.from({ length: 100 }, () => mintEventId()));

    // Assert
    expect(ids.size).toBe(100);
  });
});
