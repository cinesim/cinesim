import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export interface DropdownSelectOption<Value extends string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
}

export interface DropdownSelectProps<Value extends string> extends Omit<
  ComponentProps<"button">,
  "children" | "onChange" | "value"
> {
  options: readonly DropdownSelectOption<Value>[];
  value: Value;
  onValueChange: (value: Value) => void;
  popupClassName?: string;
}

/**
 * A compact, keyboard-accessible select for editor controls. Unlike the native
 * Select, its popup is rendered by Base UI and receives Cinesim styling.
 */
export function DropdownSelect<Value extends string>({
  className,
  options,
  value,
  onValueChange,
  popupClassName,
  ...triggerProps
}: DropdownSelectProps<Value>) {
  return (
    <BaseSelect.Root
      items={options}
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onValueChange(nextValue);
      }}
    >
      <BaseSelect.Trigger
        className={cn(
          "flex h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-panel-muted px-2.5 text-ui text-primary outline-none transition-colors hover:border-border-strong hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...triggerProps}
      >
        <BaseSelect.Value className="min-w-0 truncate" />
        <BaseSelect.Icon className="shrink-0 text-muted">
          <ChevronDown aria-hidden="true" size={14} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          align="end"
          alignItemWithTrigger={false}
          className="z-[80] isolate outline-none"
          sideOffset={4}
        >
          <BaseSelect.Popup
            className={cn(
              "min-w-[var(--anchor-width)] max-h-[var(--available-height)] overflow-y-auto rounded-md border border-border-strong bg-panel p-1 text-primary shadow-lg shadow-black/20 outline-none",
              popupClassName,
            )}
          >
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  className="flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 text-left text-ui text-secondary outline-none data-[highlighted]:bg-surface data-[highlighted]:text-primary data-[selected]:text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                  disabled={option.disabled}
                  value={option.value}
                >
                  <span className="grid size-4 shrink-0 place-items-center">
                    <BaseSelect.ItemIndicator>
                      <Check size={13} />
                    </BaseSelect.ItemIndicator>
                  </span>
                  <BaseSelect.ItemText className="min-w-0 truncate">
                    {option.label}
                  </BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
