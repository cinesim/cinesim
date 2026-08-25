import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export function Dialog({ ...props }: ComponentProps<typeof BaseDialog.Root>) {
  return <BaseDialog.Root data-slot="dialog" {...props} />;
}

export interface DialogContentProps extends Omit<
  ComponentProps<typeof BaseDialog.Popup>,
  "className"
> {
  className?: string;
  backdropClassName?: string;
  viewportClassName?: string;
  children?: ReactNode;
}

export function DialogContent({
  className,
  backdropClassName,
  viewportClassName,
  children,
  ...props
}: DialogContentProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        data-slot="dialog-backdrop"
        className={cn("fixed inset-0 z-[100] bg-black/55 backdrop-blur-[4px]", backdropClassName)}
      />
      <BaseDialog.Viewport
        data-slot="dialog-viewport"
        className={cn("fixed inset-0 z-[100] grid place-items-center p-6", viewportClassName)}
      >
        <BaseDialog.Popup
          data-slot="dialog-content"
          className={cn(
            "relative m-0 w-full origin-center scale-100 overflow-hidden rounded-xl border border-border-strong bg-panel p-0 text-primary shadow-2xl shadow-black/40 outline-none transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] data-[starting-style]:scale-90 motion-reduce:transition-none",
            className,
          )}
          {...props}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export interface DialogCloseProps extends Omit<
  ComponentProps<typeof BaseDialog.Close>,
  "className"
> {
  className?: string;
}

export function DialogClose({ className, ...props }: DialogCloseProps) {
  return (
    <BaseDialog.Close
      data-slot="dialog-close"
      className={cn(
        "grid size-8 place-items-center rounded-md text-muted hover:bg-surface hover:text-primary focus-visible:ring-2 focus-visible:ring-focus",
        className,
      )}
      {...props}
    />
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      data-slot="dialog-header"
      className={cn("flex h-12 items-center border-b border-border px-4", className)}
      {...props}
    />
  );
}

export interface DialogTitleProps extends Omit<
  ComponentProps<typeof BaseDialog.Title>,
  "className"
> {
  className?: string;
}

export function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <BaseDialog.Title
      data-slot="dialog-title"
      className={cn("text-ui-xs font-semibold uppercase tracking-[0.12em] text-primary", className)}
      {...props}
    />
  );
}

export interface DialogDescriptionProps extends Omit<
  ComponentProps<typeof BaseDialog.Description>,
  "className"
> {
  className?: string;
}

export function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <BaseDialog.Description
      data-slot="dialog-description"
      className={cn("text-ui text-muted", className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      data-slot="dialog-footer"
      className={cn("flex items-center justify-end gap-2", className)}
      {...props}
    />
  );
}
