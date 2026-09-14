import { describe, it, expect } from "vitest";
import { TaigaError, extractMessage, describeHttpError } from "../src/errors.js";

describe("extractMessage", () => {
  it("extracts _error_message string", () => {
    expect(extractMessage({ _error_message: "boom" })).toBe("boom");
  });

  it("extracts detail array's first string element", () => {
    expect(extractMessage({ detail: ["first", "second"] })).toBe("first");
  });

  it("skips non-string _error_message and continues to detail", () => {
    // This test must FAIL before the fix and pass after — RED/GREEN evidence for Finding 1
    expect(extractMessage({ _error_message: { code: 5 }, detail: "Real message" })).toBe(
      "Real message",
    );
  });

  it("extracts field errors when no direct message", () => {
    const result = extractMessage({ version: ["The object has changed"] });
    expect(result).toContain("version");
    expect(result).toContain("The object has changed");
  });

  it("returns undefined for null, undefined, empty string, and empty object", () => {
    expect(extractMessage(null)).toBeUndefined();
    expect(extractMessage(undefined)).toBeUndefined();
    expect(extractMessage("")).toBeUndefined();
    expect(extractMessage({})).toBeUndefined();
  });

  it("treats a blank _error_message as no message at all", () => {
    // Taiga's /resolver answers a miss with exactly `{"_error_message": ""}`
    // and HTTP 404. Accepting "" here made every "no such #ref" error come
    // back as an empty string: `"" ?? fallback` is "", so describeHttpError's
    // default could not rescue it either.
    expect(extractMessage({ _error_message: "" })).toBeUndefined();
    expect(extractMessage({ _error_message: "   " })).toBeUndefined();
    expect(extractMessage({ detail: [""] })).toBeUndefined();
  });

  it("falls through a blank _error_message to a usable detail", () => {
    expect(extractMessage({ _error_message: "", detail: "Real message" })).toBe(
      "Real message",
    );
  });

  it("does not throw on malformed input", () => {
    expect(() => extractMessage({ non_field_errors: 123 })).not.toThrow();
    expect(() => extractMessage({ _error_message: null })).not.toThrow();
  });
});

describe("describeHttpError", () => {
  it("401 mentions TAIGA_USERNAME and TAIGA_PASSWORD", () => {
    const error = describeHttpError(401, {});
    expect(error.message).toContain("TAIGA_USERNAME");
    expect(error.message).toContain("TAIGA_PASSWORD");
    expect(error.status).toBe(401);
  });

  it("404 surfaces extracted detail message", () => {
    const error = describeHttpError(404, { detail: "Not found." });
    expect(error.message).toContain("Not found.");
  });

  it("404 with a blank _error_message still produces a non-empty message", () => {
    const error = describeHttpError(404, { _error_message: "" });
    expect(error.message.trim()).not.toBe("");
    expect(error.message).toContain("Not found in Taiga.");
  });

  it("503 mentions the status code and does not mention TAIGA_PASSWORD value", () => {
    const error = describeHttpError(503, {});
    expect(error.message).toContain("503");
    expect(error.message).not.toContain("TAIGA_PASSWORD");
  });

  it("returns a TaigaError instance with correct status", () => {
    const error = describeHttpError(500, {});
    expect(error).toBeInstanceOf(TaigaError);
    expect(error.status).toBe(500);
  });
});
