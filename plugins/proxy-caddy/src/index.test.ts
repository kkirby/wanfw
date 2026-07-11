import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("proxy-caddy placeholder", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("proxy-caddy");
  });
});
