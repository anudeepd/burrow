import { Menu as BMenu } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import { Tooltip } from "./tooltip";

export const MenuRoot = BMenu.Root;
export const MenuTrigger = BMenu.Trigger;

export function MenuGroup({ children, "data-testid": testId }: { children: ReactNode; "data-testid"?: string }) {
  return <BMenu.Group data-testid={testId}>{children}</BMenu.Group>;
}

export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return <BMenu.GroupLabel className="px-2 py-1 text-micro font-medium text-ink-4">{children}</BMenu.GroupLabel>;
}

export function MenuContent({
  children,
  className,
  align = "end",
}: {
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
}) {
  return (
    <BMenu.Portal>
      <BMenu.Positioner align={align} sideOffset={6} className="z-popover">
        <BMenu.Popup
          className={cn("burrow-pop min-w-44 rounded-lg bg-fabric-2 p-1 text-body shadow-(--shadow-overlay) outline-none", className)}
        >
          {children}
        </BMenu.Popup>
      </BMenu.Positioner>
    </BMenu.Portal>
  );
}

const itemCls =
  "flex h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 text-body text-ink-2 outline-none data-highlighted:bg-fabric-3 data-highlighted:text-ink data-disabled:opacity-45";

export function MenuItem({
  children,
  onClick,
  shortcut,
  disabled,
  wrap = false,
  className,
  ariaLabel,
  href,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  shortcut?: ReactNode;
  disabled?: boolean;
  /** Allow longer labels to wrap for dense menus such as DAG dependency lists. */
  wrap?: boolean;
  className?: string;
  ariaLabel?: string;
  href?: string;
  title?: string;
}) {
  const item = (
    <BMenu.Item
      render={href ? <a href={href}>{children}</a> : undefined}
      className={cn(itemCls, wrap && "h-auto min-h-7 items-start py-1.5", className)}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <span className={cn("min-w-0 flex-1", wrap ? "whitespace-normal break-words" : "truncate")}>{children}</span>
      {shortcut && <span className="text-micro text-ink-4">{shortcut}</span>}
    </BMenu.Item>
  );
  return title ? <Tooltip label={title}>{item}</Tooltip> : item;
}

export function MenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
  closeOnClick = false,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  closeOnClick?: boolean;
}) {
  return (
    <BMenu.CheckboxItem className={itemCls} checked={checked} onCheckedChange={onCheckedChange} closeOnClick={closeOnClick}>
      <span className="grid size-4 place-items-center">
        <BMenu.CheckboxItemIndicator className="transition-opacity duration-(--dur-fast) ease-(--ease-out)">
          <Check className="size-3.5 text-live" aria-hidden="true" />
        </BMenu.CheckboxItemIndicator>
      </span>
      <span className="flex-1 truncate">{children}</span>
    </BMenu.CheckboxItem>
  );
}

export function MenuRadioGroup<T extends string>({
  value,
  onValueChange,
  options,
  label,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  label?: string;
}) {
  return (
    <BMenu.Group>
      {label && <BMenu.GroupLabel className="px-2 py-1 text-micro font-medium text-ink-4">{label}</BMenu.GroupLabel>}
      <BMenu.RadioGroup value={value} onValueChange={(v) => onValueChange(v as T)}>
        {options.map((o) => (
          <BMenu.RadioItem key={o.value} value={o.value} className={itemCls} closeOnClick={false}>
            <span className="grid size-4 place-items-center">
              <BMenu.RadioItemIndicator className="transition-opacity duration-(--dur-fast) ease-(--ease-out)">
                <Check className="size-3.5 text-live" aria-hidden="true" />
              </BMenu.RadioItemIndicator>
            </span>
            <span className="flex-1 truncate">{o.label}</span>
          </BMenu.RadioItem>
        ))}
      </BMenu.RadioGroup>
    </BMenu.Group>
  );
}

export function MenuSeparator() {
  return <BMenu.Separator className="my-1 h-px bg-seam" />;
}
