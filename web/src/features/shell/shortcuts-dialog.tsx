import { Kbd } from "~/ui/button";
import { Modal } from "~/ui/dialog";
import { SHORTCUTS } from "./shortcuts";

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" description="Everything is reachable without a mouse.">
      <div data-testid="shortcuts-dialog" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {groups.map((group) => (
          <section key={group}>
            <h3 className="mb-1 text-micro font-semibold tracking-[0.08em] text-ink-4 uppercase">{group}</h3>
            <dl className="divide-y divide-seam-soft">
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <div key={`${group}-${s.what}`} className="flex items-center justify-between gap-3 py-1">
                  <dt className="text-small text-ink-2">{s.what}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
