import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "~/lib/copy";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the Clipboard API when the origin allows it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    await expect(copyText("diagnostics")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("diagnostics");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("copies through the user-gesture fallback when Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const execCommand = vi.fn((command: string) => {
      expect(command).toBe("copy");
      expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement);
      expect((document.activeElement as HTMLTextAreaElement).value).toBe("plain HTTP plan");
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    await expect(copyText("plain HTTP plan")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledOnce();
    expect(document.querySelector("textarea[aria-hidden='true']")).toBeNull();
  });

  it("reports failure when neither clipboard path succeeds", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });

    await expect(copyText("blocked")).resolves.toBe(false);
  });
});
