import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("plugin-sdk placeholder", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("plugin-sdk");
  });
});
