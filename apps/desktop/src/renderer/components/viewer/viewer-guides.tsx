import { Check, Grid3X3 } from "@cinesim/ui";
import { cn, Menu, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuTrigger } from "@cinesim/ui";

export interface ViewerGuides {
  actionSafe: boolean;
  center: boolean;
  columns: number;
  grid: boolean;
  rows: number;
  titleSafe: boolean;
}

export const DEFAULT_VIEWER_GUIDES: ViewerGuides = {
  grid: false,
  rows: 3,
  columns: 3,
  center: false,
  actionSafe: false,
  titleSafe: false,
};

export function ViewerGuideMenu({
  guides,
  onChange,
}: {
  guides: ViewerGuides;
  onChange: (guides: ViewerGuides) => void;
}) {
  function toggle(key: "grid" | "center" | "actionSafe" | "titleSafe") {
    onChange({ ...guides, [key]: !guides[key] });
  }

  return (
    <Menu>
      <MenuTrigger
        aria-label="Viewer guides"
        title="Viewer guides"
        className={cn(
          "grid size-8 place-items-center rounded-md text-secondary hover:bg-surface hover:text-primary",
          Object.values(guides).some((value) => value === true) && "bg-surface text-primary",
        )}
      >
        <Grid3X3 size={14} />
      </MenuTrigger>
      <MenuContent align="end" className="w-56 p-2">
        <MenuGroup>
          <MenuLabel>Composition guides</MenuLabel>
          <GuideToggle active={guides.grid} label="Grid" onClick={() => toggle("grid")} />
          <GuideToggle active={guides.center} label="Center" onClick={() => toggle("center")} />
          <GuideToggle
            active={guides.actionSafe}
            label="Action safe"
            onClick={() => toggle("actionSafe")}
          />
          <GuideToggle
            active={guides.titleSafe}
            label="Title safe"
            onClick={() => toggle("titleSafe")}
          />
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border pt-2">
            <GuideCountInput
              label="Columns"
              value={guides.columns}
              onChange={(columns) => onChange({ ...guides, columns })}
            />
            <GuideCountInput
              label="Rows"
              value={guides.rows}
              onChange={(rows) => onChange({ ...guides, rows })}
            />
          </div>
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

function GuideToggle({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <MenuItem
      closeOnClick={false}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-secondary hover:bg-surface hover:text-primary"
      onClick={onClick}
    >
      <span className="grid size-4 place-items-center">{active && <Check size={13} />}</span>
      {label}
    </MenuItem>
  );
}

function GuideCountInput({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <label className="grid gap-1 text-ui-xs text-muted">
      {label}
      <input
        className="h-8 rounded-md border border-border bg-panel-muted px-2 text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus"
        type="number"
        min={1}
        max={12}
        value={value}
        onChange={(event) => onChange(Math.min(12, Math.max(1, Number(event.target.value) || 1)))}
      />
    </label>
  );
}

export function ViewerGuideOverlay({ guides }: { guides: ViewerGuides }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 text-white/55 [filter:drop-shadow(0_0_1px_rgb(0_0_0/0.9))]"
    >
      {guides.grid && (
        <>
          {Array.from({ length: Math.max(0, guides.columns - 1) }, (_, index) => (
            <span
              key={`column:${index}`}
              className="absolute inset-y-0 w-px bg-current"
              style={{ left: `${((index + 1) / guides.columns) * 100}%` }}
            />
          ))}
          {Array.from({ length: Math.max(0, guides.rows - 1) }, (_, index) => (
            <span
              key={`row:${index}`}
              className="absolute inset-x-0 h-px bg-current"
              style={{ top: `${((index + 1) / guides.rows) * 100}%` }}
            />
          ))}
        </>
      )}
      {guides.center && (
        <>
          <span className="absolute inset-y-0 left-1/2 w-px bg-current" />
          <span className="absolute inset-x-0 top-1/2 h-px bg-current" />
        </>
      )}
      {guides.actionSafe && <span className="absolute inset-[5%] border border-current" />}
      {guides.titleSafe && <span className="absolute inset-[10%] border border-current" />}
    </div>
  );
}
