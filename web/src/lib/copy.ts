/**
 * Copy text across secure and non-secure origins.
 *
 * The asynchronous Clipboard API is restricted to secure contexts. Burrow commonly runs over plain HTTP inside a
 * cluster, so use the user-gesture-compatible `execCommand` path when that API is missing or rejects the write.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // A permission denial can still be handled by the legacy copy command in the click's user-activation window.
  }

  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "-9999px",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    fontSize: "16px",
  });

  const active = document.activeElement;
  document.body.append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  }
}
