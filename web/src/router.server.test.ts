// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getRouter } from "./router";

describe("router CSP configuration on the server", () => {
  it("uses the request nonce placeholder when there is no document", () => {
    expect(getRouter().options.ssr?.nonce).toBe("__BURROW_CSP_NONCE__");
  });
});
