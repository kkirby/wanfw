import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("cert-letsencrypt-dns01 plugin", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("cert-letsencrypt-dns01");
  });
});
