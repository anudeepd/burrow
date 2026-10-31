import { Select as BSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { MouseEventHandler, ReactNode } from "react";
import { cn } from "~/lib/cn";

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
}

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
  placeholder,
  onClick,
}: {
  value: T | null;
  onValueChange: (v: T | null) => void;
  options: SelectOption<T>[];
  /** accessible name (required: there is no visible label by default) */
  label: string;
  className?: string;
  placeholder?: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
  const items = options.map((o) => ({ value: o.value, label: o.label }));
  return (
    <BSelect.Root value={value} onValueChange={(v) => onValueChange(v as T | null)} items={items}>
      <BSelect.Trigger
        aria-label={label}
        onClick={onClick}
        className={cn(
          "burrow-control group inline-flex h-(--ctl-h) items-center justify-between gap-2 rounded-md border border-seam-strong bg-well px-2.5 text-body text-ink",
          "hover:bg-fabric-3 data-popup-open:bg-fabric-3",
          "transition-[background-color,color,transform] duration-(--dur-fast) ease-(--ease-out) motion-safe:motion-ok:active:scale-[0.98]",
          className,
        )}
      >
        <BSelect.Value placeholder={placeholder} className="truncate" />
        <BSelect.Icon>
          <ChevronDown
            className="size-3.5 text-ink-3 transition-transform duration-(--dur-fast) ease-(--ease-out) group-data-popup-open:rotate-180"
            aria-hidden="true"
          />
        </BSelect.Icon>
      </BSelect.Trigger>
      <BSelect.Portal>
        <BSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-popover">
          <BSelect.Popup className="burrow-pop min-w-(--anchor-width) rounded-lg bg-fabric-2 p-1 text-body shadow-(--shadow-overlay) outline-none">
            <BSelect.List className="max-h-72 overflow-auto">
              {options.map((o) => (
                <BSelect.Item
                  key={o.value}
                  value={o.value}
                  className="flex h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 text-ink-2 outline-none data-highlighted:bg-fabric-3 data-highlighted:text-ink"
                >
                  <BSelect.ItemIndicator className="grid size-4 place-items-center transition-opacity duration-(--dur-fast) ease-(--ease-out)">
                    <Check className="size-3.5 text-live" aria-hidden="true" />
                  </BSelect.ItemIndicator>
                  <BSelect.ItemText className="col-start-2 flex-1 truncate">{o.label}</BSelect.ItemText>
                </BSelect.Item>
              ))}
            </BSelect.List>
          </BSelect.Popup>
        </BSelect.Positioner>
      </BSelect.Portal>
    </BSelect.Root>
  );
}
