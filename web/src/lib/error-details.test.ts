import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "~/api/client";
import { copyText, describeError, errorDetails, simpleErrorText } from "./error-details";

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("error presentation", () => {
  it("keeps only the first non-empty line in the simple state", () => {
    expect(simpleErrorText("\n  first line  \nsecond line")).toBe("first line");
    expect(simpleErrorText("one line")).toBe("one line");
    expect(simpleErrorText("\n \n")).toBe("");
  });

  it("describes ApiErrors with their hint and full envelope", () => {
    const error = new ApiError(
      "upstream rejected\nstack line",
      "http",
      502,
      "upstream_status",
      { url: "http://rm:8088/ws", status: 503 },
      "Try again",
      null,
      { error: { code: "upstream_status" } },
    );
    const described = describeError(error);
    expect(described.message).toBe("upstream rejected");
    expect(described.hint).toBe("Try again");
    expect(described.details).toContain('"kind": "http"');
    expect(described.details).toContain('"status": 502');
    expect(described.details).toContain('"code": "upstream_status"');
    expect(described.details).toContain('"url": "http://rm:8088/ws"');
    expect(described.details).toContain('"body"');
    expect(described.details).toContain('"stack"');
    expect(describeError(new ApiError("", "network", null)).message).toBe("Unknown error");
  });

  it("summarizes technical messages and keeps the raw payload in details", () => {
    const java = new ApiError(
      "java.lang.IllegalStateException: the ResourceManager log directory is not configured\n\tat org.apache.hadoop.RM.getLogDir(RM.java:4321)",
      "http",
      503,
    );
    const described = describeError(java);
    expect(described.message).toBe("The upstream service returned HTTP 503.");
    expect(described.details).toContain("IllegalStateException");
    expect(described.details).toContain("at org.apache.hadoop");

    expect(describeError(new Error("at Object.<anonymous> (file.js:1:2)")).message).toBe("The request failed.");
    expect(describeError("<html><body>login</body></html>").message).toBe("The request failed.");
    expect(describeError(new ApiError("java.io.IOException: broken", "http", 502)).message).toBe("The upstream service returned HTTP 502.");
    expect(describeError(new ApiError("java.lang.IllegalStateException: shape", "schema", null)).message).toBe(
      "The upstream response did not match the expected shape.",
    );
    expect(describeError(new ApiError("no route", "http", 404)).message).toBe("no route");
  });

  it("describes Error objects, including causes and empty messages", () => {
    const described = describeError(new Error("network down", { cause: new Error("socket closed") }));
    expect(described.message).toBe("network down");
    expect(described.details).toContain('"name": "Error"');
    expect(described.details).toContain('"socket closed"');
    expect(describeError(new Error("")).message).toBe("Unknown error");
  });

  it("normalises non-Error values into a simple line plus technical details", () => {
    expect(describeError("raw failure\nstack line")).toEqual({
      message: "raw failure",
      details: "raw failure\nstack line",
    });
    expect(describeError({ message: "object failure", hint: "Retry", code: 42 })).toMatchObject({
      message: "object failure",
      hint: "Retry",
    });
    expect(describeError({ hint: "only a hint" })).toMatchObject({
      message: "An unexpected error occurred",
      hint: "only a hint",
    });
    expect(describeError(42)).toEqual({ message: "An unexpected error occurred", details: "42" });
    expect(describeError(undefined)).toEqual({ message: "An unexpected error occurred", details: "undefined" });
  });

  it("handles circular values and values JSON cannot serialise", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(errorDetails(circular)).toContain('"[circular]"');
    expect(errorDetails(1n)).toBe("1");
    expect(errorDetails([new Error("in a list")])).toContain('"in a list"');
  });

  it("reports clipboard success and failure without throwing", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await expect(copyText("details")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("details");
    writeText.mockRejectedValueOnce(new Error("denied"));
    await expect(copyText("details")).resolves.toBe(false);
  });
});
