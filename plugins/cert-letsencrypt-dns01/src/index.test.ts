import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("cert-letsencrypt-dns01 placeholder", () => {
  it("exports a package name", () => {
    expect(PACKAGE_NAME).toBe("cert-letsencrypt-dns01");
  });
});
