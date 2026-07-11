import { describe, expect, it } from "vitest";
import { EXIT_CODES, EXIT_CODE_DESCRIPTIONS } from "./exit-codes.js";

describe("EXIT_CODES (spec §11 / plan interpretation 7)", () => {
  it("matches the documented table exactly", () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      internalError: 1,
      usage: 2,
      pendingApprovalExists: 3,
      validationFailure: 4,
      notFound: 5,
      refused: 6,
      daemonUnreachable: 7,
    });
  });

  it("every code has a documented description", () => {
    for (const name of Object.keys(EXIT_CODES) as Array<keyof typeof EXIT_CODES>) {
      expect(EXIT_CODE_DESCRIPTIONS[name]).toBeTruthy();
    }
  });

  it("codes are unique", () => {
    const values = Object.values(EXIT_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});
