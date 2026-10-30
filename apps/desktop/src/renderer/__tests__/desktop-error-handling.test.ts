import { describe, it, expect } from "vitest";

/** Regression coverage for catch blocks accepting Error objects or string failures. */

/** Helper that mirrors the pattern used in catch blocks */
function extractErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Compilation failed";
}

describe("Desktop error message extraction", () => {
  it("extracts message from a standard Error object", () => {
    const error = new Error("Something went wrong");
    expect(extractErrorMessage(error)).toBe("Something went wrong");
  });

  it("extracts message from a plain string failure", () => {
    // Backend failures can carry a plain string.
    const error = "Compilation failed\n\n! Undefined control sequence.";
    expect(extractErrorMessage(error)).toBe(
      "Compilation failed\n\n! Undefined control sequence.",
    );
  });

  it("extracts message from an empty string", () => {
    expect(extractErrorMessage("")).toBe("");
  });

  it("falls back to generic message for non-string, non-Error values", () => {
    expect(extractErrorMessage(42)).toBe("Compilation failed");
    expect(extractErrorMessage(null)).toBe("Compilation failed");
    expect(extractErrorMessage(undefined)).toBe("Compilation failed");
    expect(extractErrorMessage({ code: 1 })).toBe("Compilation failed");
  });

  it("a plain string is NOT instanceof Error (the root cause of the bug)", () => {
    const backendError: unknown = "Compilation failed\n\n! Missing $ inserted.";
    expect(backendError instanceof Error).toBe(false);
    expect(typeof backendError === "string").toBe(true);
  });
});
