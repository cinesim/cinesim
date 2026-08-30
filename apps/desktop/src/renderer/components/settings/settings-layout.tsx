import { Field, FieldContent, FieldDescription, FieldLabel } from "@cinesim/ui";

export function SettingsHeading({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="mb-7 flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl border border-border bg-panel text-secondary">
        {icon}
      </span>
      <div>
        <h1 className="text-ui-lg font-semibold tracking-tight">{title}</h1>
        <p className="text-ui text-muted">{detail}</p>
      </div>
    </div>
  );
}

export function SettingRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <Field className="p-4 sm:grid-cols-[minmax(0,1fr)_minmax(230px,0.9fr)] sm:items-center">
      <FieldContent>
        <FieldLabel>{title}</FieldLabel>
        <FieldDescription>{detail}</FieldDescription>
      </FieldContent>
      <div className="min-w-0">{children}</div>
    </Field>
  );
}
