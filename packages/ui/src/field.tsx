import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface FieldProps extends Omit<ComponentProps<typeof BaseField.Root>, "className"> {
  className?: string;
}

export function Field({ className, ...props }: FieldProps) {
  return <BaseField.Root data-slot="field" className={cn("grid gap-4", className)} {...props} />;
}

export function FieldContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="field-content" className={cn("min-w-0", className)} {...props} />;
}

export interface FieldLabelProps extends Omit<ComponentProps<typeof BaseField.Label>, "className"> {
  className?: string;
}

export function FieldLabel({ className, ...props }: FieldLabelProps) {
  return (
    <BaseField.Label
      data-slot="field-label"
      className={cn("text-ui font-medium text-primary", className)}
      {...props}
    />
  );
}

export interface FieldDescriptionProps extends Omit<
  ComponentProps<typeof BaseField.Description>,
  "className"
> {
  className?: string;
}

export function FieldDescription({ className, ...props }: FieldDescriptionProps) {
  return (
    <BaseField.Description
      data-slot="field-description"
      className={cn("mt-0.5 text-ui-xs leading-4 text-muted", className)}
      {...props}
    />
  );
}
