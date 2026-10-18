import { useHotkeySequence, useHotkeys } from "@tanstack/react-hotkeys";
import { useNavigate } from "@tanstack/react-router";

/** Global shortcut help. Shell-wide navigation handlers live below; log search binds inside its mounted view. */
export const SHORTCUTS: { keys: string[]; what: string; group: string }[] = [
  { group: "Navigate", keys: ["⌘", "K"], what: "Open the command palette" },
  { group: "Navigate", keys: ["/"], what: "Open the command palette" },
  { group: "Navigate", keys: ["g", "a"], what: "Go to Applications" },
  { group: "Navigate", keys: ["g", "o"], what: "Go to Overview" },
  { group: "Navigate", keys: ["g", "s"], what: "Go to Scheduler" },
  { group: "Navigate", keys: ["g", "n"], what: "Go to Nodes" },
  { group: "Navigate", keys: ["?"], what: "Show this list" },
  { group: "Search", keys: ["⌘", "F"], what: "Focus log search (Ctrl+F on Windows/Linux)" },
  { group: "Lists", keys: ["↑", "↓"], what: "Move between rows" },
  { group: "Lists", keys: ["j", "k"], what: "Move between rows (vim)" },
  { group: "Lists", keys: ["PgUp", "PgDn"], what: "Move a screen at a time" },
  { group: "Lists", keys: ["Home", "End"], what: "Jump to the first or last row" },
  { group: "Lists", keys: ["↵"], what: "Open the focused row" },
  { group: "Lists", keys: ["Space"], what: "Select the focused row" },
  { group: "Lists", keys: ["⇧", "click"], what: "Add a secondary sort" },
];

/** Global keyboard surface: palette, help, and the vim-ish `g`-prefixed navigation. */
export function useShellHotkeys({ onPalette, onHelp }: { onPalette: () => void; onHelp: () => void }): void {
  const navigate = useNavigate();
  useHotkeys(
    [
      { hotkey: "Mod+K", callback: onPalette },
      { hotkey: "/", callback: onPalette },
      { hotkey: "?", callback: onHelp },
    ],
    { conflictBehavior: "replace" },
  );
  useHotkeySequence(["G", "A"], () => void navigate({ to: "/apps" }));
  useHotkeySequence(["G", "O"], () => void navigate({ to: "/", search: { window: "all" } }));
  useHotkeySequence(["G", "S"], () => void navigate({ to: "/scheduler" }));
  useHotkeySequence(["G", "N"], () => void navigate({ to: "/nodes" }));
}
