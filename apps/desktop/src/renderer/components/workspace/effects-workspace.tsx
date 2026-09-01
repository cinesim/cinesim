import { timeUs, type Project, type SequenceId } from "@cinesim/core";
import { LANGUAGE_REFERENCE } from "@cinesim/compiler";
import type { IrAnimation, IrProgram, IrValue } from "@cinesim/ir";
import type { DesktopProjectSession, EditorLayoutState } from "../../../shared/contracts";
import { useRendererStore } from "../../store/renderer-store-context";
import { EditWorkspace } from "./edit-workspace";

const EFFECT_IDS = ["colorgrade", "blur", "vignette", "chromakey", "shadow", "grain"];
const EFFECTS = EFFECT_IDS.flatMap((id) => {
  const entry = LANGUAGE_REFERENCE.find((candidate) => candidate.id === `element:${id}`);
  return entry ? [entry] : [];
});

export function EffectsWorkspace({
  session,
  project,
  sequenceId,
  initialLayout,
  mediaPoolOpen,
  inspectorOpen,
  notesOpen,
}: {
  session: DesktopProjectSession;
  project: Project;
  sequenceId: SequenceId;
  initialLayout: EditorLayoutState;
  mediaPoolOpen: boolean;
  inspectorOpen: boolean;
  notesOpen: boolean;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)]">
      <aside
        className="min-h-0 overflow-y-auto border-r border-border bg-panel p-2"
        aria-label="Effects browser"
      >
        <div className="px-1 pb-2 pt-1">
          <h2 className="text-ui font-semibold text-primary">Effects</h2>
          <p className="mt-0.5 text-ui-xs text-muted">WebGPU preview capabilities</p>
        </div>
        <div className="space-y-1">
          {EFFECTS.map((effect) => (
            <article
              key={effect.id}
              className="rounded-md border border-border bg-surface px-2 py-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <code className="text-ui-xs font-medium text-primary">{effect.title}</code>
                <span className="rounded bg-emerald-500/15 px-1 text-[9px] uppercase text-emerald-700 dark:text-emerald-300">
                  {effect.capability.preview}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-4 text-muted">{effect.summary}</p>
            </article>
          ))}
        </div>
        <KeyframeEditor program={session.program} />
      </aside>
      <div className="min-h-0 min-w-0">
        <EditWorkspace
          session={session}
          project={project}
          sequenceId={sequenceId}
          initialLayout={initialLayout}
          mediaPoolOpen={mediaPoolOpen}
          inspectorOpen={inspectorOpen}
          notesOpen={notesOpen}
        />
      </div>
    </div>
  );
}

interface EditableAnimation {
  nodeId: string;
  animation: IrAnimation;
}

function selectedAnimations(
  program: IrProgram,
  selectedClipId: string | null,
): EditableAnimation[] {
  if (!selectedClipId) return [];
  for (const composition of program.compositions) {
    for (const track of composition.timeline.tracks) {
      const clip = track.clips.find(({ id }) => id === selectedClipId);
      if (!clip) continue;
      return [
        ...(clip.animations ?? []).map((animation) => ({ nodeId: clip.id, animation })),
        ...clip.effects.flatMap((effect) =>
          (effect.animations ?? []).map((animation) => ({ nodeId: effect.id, animation })),
        ),
      ];
    }
  }
  return [];
}

function numericValue(value: IrValue): number | null {
  return "value" in value && typeof value.value === "number" ? value.value : null;
}

function KeyframeEditor({ program }: { program: IrProgram }) {
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const execute = useRendererStore((state) => state.execute);
  const animations = selectedAnimations(program, selectedClipId);
  return (
    <section className="mt-3 border-t border-border pt-2" aria-label="Keyframe editor">
      <h3 className="px-1 text-ui-xs font-semibold uppercase tracking-wide text-secondary">
        Keyframes
      </h3>
      {animations.length === 0 ? (
        <p className="px-1 py-2 text-[10px] leading-4 text-muted">
          Select a keyed clip to edit stable time and value points.
        </p>
      ) : (
        animations.map(({ nodeId, animation }) => (
          <div
            key={`${nodeId}:${animation.property}`}
            className="mt-2 rounded-md border border-border p-1.5"
          >
            <code className="text-[10px] text-primary">{animation.property}</code>
            {animation.keyframes.map((keyframe, index) => {
              const value = numericValue(keyframe.value);
              return (
                <div key={index} className="mt-1 grid grid-cols-2 gap-1">
                  <label className="text-[9px] text-muted">
                    Time (s)
                    <input
                      className="mt-0.5 w-full rounded border border-border bg-canvas px-1 py-0.5 text-[10px] text-primary"
                      type="number"
                      min={0}
                      step={0.001}
                      defaultValue={keyframe.at / 1_000_000}
                      onBlur={(event) => {
                        const seconds = Number(event.currentTarget.value);
                        if (Number.isFinite(seconds) && seconds >= 0)
                          void execute({
                            type: "keyframe.set",
                            nodeId,
                            property: animation.property,
                            index,
                            atUs: timeUs(Math.round(seconds * 1_000_000)),
                          });
                      }}
                    />
                  </label>
                  <label className="text-[9px] text-muted">
                    Value
                    <input
                      className="mt-0.5 w-full rounded border border-border bg-canvas px-1 py-0.5 text-[10px] text-primary disabled:opacity-50"
                      type="number"
                      defaultValue={value ?? ""}
                      disabled={value === null}
                      onBlur={(event) => {
                        const next = Number(event.currentTarget.value);
                        if (!Number.isFinite(next) || value === null) return;
                        void execute({
                          type: "keyframe.set",
                          nodeId,
                          property: animation.property,
                          index,
                          value: { ...keyframe.value, value: next } as IrValue,
                        });
                      }}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
}
