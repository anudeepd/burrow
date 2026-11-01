import { afterEach, describe, expect, it } from "vitest";
import { getRouter } from "./router";

afterEach(() => {
  document.querySelector('meta[property="csp-nonce"]')?.remove();
});

describe("router CSP configuration", () => {
  it("uses no nonce when the document does not declare one", () => {
    expect(getRouter().options.ssr?.nonce).toBeUndefined();
  });

  it("forwards the document nonce into router SSR options", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("property", "csp-nonce");
    meta.content = "request-nonce";
    document.head.append(meta);
    expect(getRouter().options.ssr?.nonce).toBe("request-nonce");
  });
});
