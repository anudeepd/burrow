import { Switch as BSwitch } from "@base-ui/react/switch";
import { Toggle as BToggle } from "@base-ui/react/toggle";
import { ToggleGroup as BToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import { Tooltip } from "~/ui/tooltip";

export function Switch({
  checked,
  onCheckedChange,
  label,
  className,
  disabled,
  hint,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  className?: string;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const control = (
    <BSwitch.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className={cn(
        "burrow-switch relative inline-flex h-5 w-9 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <span className="burrow-switch-track relative inline-flex h-5 w-9 items-center rounded-full border border-seam-strong bg-well px-0.5 transition-colors duration-(--dur-base) ease-(--ease-out)">
        <BSwitch.Thumb className="block size-3.5 rounded-full bg-ink-3 transition-[background-color,transform] duration-(--dur-base) ease-(--ease-out) data-checked:translate-x-[18px] data-checked:bg-on-live" />
      </span>
    </BSwitch.Root>
  );
  return hint ? <Tooltip label={hint}>{control}</Tooltip> : control;
}

export function Toggle({
  pressed,
  onPressedChange,
  label,
  children,
  className,
  hint,
}: {
  pressed: boolean;
  onPressedChange: (v: boolean) => void;
  label: string;
  children: ReactNode;
  className?: string;
  hint?: ReactNode;
}) {
  const control = (
    <BToggle
      pressed={pressed}
      onPressedChange={onPressedChange}
      aria-label={label}
      className={cn(
        "burrow-control inline-flex h-(--ctl-h) items-center gap-1.5 rounded-md border border-seam px-2.5 text-body text-ink-3 hover:bg-fabric-3 hover:text-ink data-pressed:border-seam-strong data-pressed:bg-fabric-3 data-pressed:text-ink",
        "transition-[background-color,border-color,color,transform] duration-(--dur-fast) ease-(--ease-out) motion-safe:motion-ok:active:scale-[0.97]",
        className,
      )}
    >
      {children}
    </BToggle>
  );
  return hint ? <Tooltip label={hint}>{control}</Tooltip> : control;
}

/** Segmented single-select (theme, time zone). */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: { value: T; label: ReactNode; aria: string; hint?: ReactNode }[];
  label: string;
  className?: string;
}) {
  return (
    <BToggleGroup
      value={[value]}
      onValueChange={(v) => v[0] && onValueChange(v[0] as T)}
      aria-label={label}
      className={cn("inline-flex rounded-md border border-seam bg-well p-0.5", className)}
    >
      {options.map((o) => {
        const toggle = (
          <BToggle
            key={o.value}
            value={o.value}
            aria-label={o.aria}
            className="burrow-control inline-flex h-6 min-w-7 items-center justify-center gap-1 rounded-sm px-1.5 text-small text-ink-3 transition-[background-color,box-shadow,color,transform] duration-(--dur-fast) ease-(--ease-out) hover:text-ink motion-safe:motion-ok:active:scale-[0.96] data-pressed:bg-fabric-3 data-pressed:text-ink data-pressed:shadow-[0_0_0_1px_var(--seam)]"
          >
            {o.label}
          </BToggle>
        );
        return o.hint ? (
          <Tooltip key={o.value} label={o.hint}>
            {toggle}
          </Tooltip>
        ) : (
          toggle
        );
      })}
    </BToggleGroup>
  );
}
