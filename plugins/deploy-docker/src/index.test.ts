import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("deploy-docker placeholder", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("deploy-docker");
  });
});
