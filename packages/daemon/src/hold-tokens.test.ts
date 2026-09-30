import { describe, expect, test } from "bun:test";
import { holdTokenSchema, sha256Hex } from "@jev-cops/core";
import { HOLD_TOKEN_BYTES, hashHoldToken, mintHoldToken, sameHash } from "./hold-tokens.ts";

describe("hold tokens", () => {
  test("a minted token is 32 random bytes as base64url and valid for the verdict schema", () => {
    const { token } = mintHoldToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(HOLD_TOKEN_BYTES);
    expect(holdTokenSchema.safeParse(token).success).toBe(true);
  });

  test("only the SHA-256 of the token is kept", () => {
    const { token, hash } = mintHoldToken();
    expect(hash).toBe(sha256Hex(token));
    expect(hashHoldToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });

  test("two tokens never repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintHoldToken().token));
    expect(seen.size).toBe(200);
  });

  test("sameHash is true only for equal hashes, false on a length mismatch", () => {
    const { hash } = mintHoldToken();
    expect(sameHash(hash, hash)).toBe(true);
    expect(sameHash(hash, mintHoldToken().hash)).toBe(false);
    expect(sameHash(hash, hash.slice(1))).toBe(false);
    expect(sameHash("", "")).toBe(false);
  });
});
