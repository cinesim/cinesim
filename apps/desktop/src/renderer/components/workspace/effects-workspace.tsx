import { timeUs, type Project, type SequenceId } from "@cinesim/core";
import { LANGUAGE_REFERENCE } from "@cinesim/compiler";
import {
  evaluateAnimation,
  irTimeUs,
  type IrAnimation,
  type IrEffect,
  type IrProgram,
  type IrSceneNode,
  type IrValue,
} from "@cinesim/ir";
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
  label: string;
  originStartUs: number;
  animation: IrAnimation;
}

function ownAnimations(
  nodeId: string,
  label: string,
  originStartUs: number,
  animations: readonly IrAnimation[] | undefined,
): EditableAnimation[] {
  return (animations ?? []).map((animation) => ({ nodeId, label, originStartUs, animation }));
}

function effectAnimations(
  effects: readonly IrEffect[],
  scope: string,
  originStartUs: number,
): EditableAnimation[] {
  return effects.flatMap((effect) =>
    ownAnimations(effect.id, `${scope} / ${effect.kind}`, originStartUs, effect.animations),
  );
}

function sceneAnimations(
  node: IrSceneNode,
  scope: string,
  originStartUs: number,
): EditableAnimation[] {
  return [
    ...ownAnimations(node.id, `${scope} / ${node.kind}`, originStartUs, node.animations),
    ...effectAnimations(node.effects, `${scope} / ${node.kind}`, originStartUs),
    ...node.children.flatMap((child) => sceneAnimations(child, scope, originStartUs)),
  ];
}

function allAnimations(program: IrProgram, selectedClipId: string | null): EditableAnimation[] {
  const result = program.compositions.flatMap((composition) => [
    ...composition.timeline.tracks.flatMap((track) => [
      ...effectAnimations(track.effects, track.name, 0),
      ...(track.adjustments ?? []).flatMap((adjustment) => [
        ...ownAnimations(
          adjustment.id,
          `${track.name} / adjustment`,
          adjustment.timelineStartUs,
          adjustment.animations,
        ),
        ...effectAnimations(
          adjustment.effects,
          `${track.name} / adjustment`,
          adjustment.timelineStartUs,
        ),
      ]),
      ...track.clips.flatMap((clip) => [
        ...ownAnimations(clip.id, clip.name ?? clip.id, clip.timelineStartUs, clip.animations),
        ...effectAnimations(clip.effects, clip.name ?? clip.id, clip.timelineStartUs),
        ...(clip.content
          ? sceneAnimations(clip.content, clip.name ?? clip.id, clip.timelineStartUs)
          : []),
      ]),
    ]),
    ...composition.timeline.captionTracks.flatMap((track) =>
      track.cues.flatMap((cue) =>
        ownAnimations(cue.id, `${track.name} / ${cue.text}`, cue.startUs, cue.animations),
      ),
    ),
  ]);
  return result.sort((left, right) => {
    const leftSelected =
      left.nodeId === selectedClipId || left.label.includes(selectedClipId ?? "\0");
    const rightSelected =
      right.nodeId === selectedClipId || right.label.includes(selectedClipId ?? "\0");
    return Number(rightSelected) - Number(leftSelected) || left.label.localeCompare(right.label);
  });
}

function editableValue(value: IrValue): string {
  if ("value" in value) return String(value.value);
  if ("values" in value) return value.values.join(", ");
  if (value.kind === "resource") return value.assetId;
  return String(value.valueUs / 1_000_000);
}

function parsedValue(input: string, reference: IrValue): IrValue | null {
  switch (reference.kind) {
    case "string":
    case "color":
      return { ...reference, value: input };
    case "resource":
      return { ...reference, assetId: input };
    case "vector":
      return parsedTuple(input, reference, 2);
    case "rectangle":
      return parsedTuple(input, reference, 4);
    case "time":
      return parsedTime(input);
    case "boolean":
      return null;
    default:
      return parsedNumber(input, reference);
  }
}

function parsedTuple(input: string, reference: IrValue, length: number): IrValue | null {
  const values = input.split(",").map(Number);
  return values.length === length && values.every(Number.isFinite)
    ? ({ ...reference, values } as IrValue)
    : null;
}

function parsedTime(input: string): IrValue | null {
  const seconds = Number(input);
  return Number.isFinite(seconds) && seconds >= 0
    ? { kind: "time", valueUs: irTimeUs(Math.round(seconds * 1_000_000)) }
    : null;
}

function parsedNumber(input: string, reference: IrValue): IrValue | null {
  const value = Number(input);
  return Number.isFinite(value) ? ({ ...reference, value } as IrValue) : null;
}

function nextAvailableTime(animation: IrAnimation, requested: number): number {
  const occupied = new Set(animation.keyframes.map((keyframe) => keyframe.at as number));
  let result = requested;
  while (occupied.has(result)) result += 1;
  return result;
}

function KeyframeValueEditor({
  value,
  commit,
}: {
  value: IrValue;
  commit: (value: IrValue) => void;
}) {
  if (value.kind === "boolean")
    return (
      <input
        aria-label="Value"
        className="mt-0.5 h-5 w-full accent-blue-500"
        type="checkbox"
        defaultChecked={value.value}
        onChange={(event) => commit({ kind: "boolean", value: event.currentTarget.checked })}
      />
    );
  return (
    <input
      aria-label="Value"
      className="mt-0.5 w-full rounded border border-border bg-canvas px-1 py-0.5 text-[10px] text-primary"
      type={
        value.kind === "string" ||
        value.kind === "color" ||
        value.kind === "resource" ||
        value.kind === "vector" ||
        value.kind === "rectangle"
          ? "text"
          : "number"
      }
      step={value.kind === "time" ? 0.001 : "any"}
      defaultValue={editableValue(value)}
      onBlur={(event) => {
        const parsed = parsedValue(event.currentTarget.value, value);
        if (parsed) commit(parsed);
      }}
    />
  );
}

function KeyframeEditor({ program }: { program: IrProgram }) {
  const selectedClipId = useRendererStore((state) => state.selectedClipId);
  const playheadUs = useRendererStore((state) => state.playheadUs);
  const execute = useRendererStore((state) => state.execute);
  const animations = allAnimations(program, selectedClipId);
  return (
    <section className="mt-3 border-t border-border pt-2" aria-label="Keyframe editor">
      <h3 className="px-1 text-ui-xs font-semibold uppercase tracking-wide text-secondary">
        Keyframes
      </h3>
      {animations.length === 0 ? (
        <p className="px-1 py-2 text-[10px] leading-4 text-muted">
          Add an animate block to a clip, effect, caption cue, mask, or adjustment effect.
        </p>
      ) : (
        animations.map(({ nodeId, label, originStartUs, animation }) => (
          <div
            key={`${nodeId}:${animation.property}`}
            className="mt-2 rounded-md border border-border p-1.5"
          >
            <div className="flex items-start justify-between gap-1">
              <div className="min-w-0">
                <div className="truncate text-[9px] text-muted" title={label}>
                  {label}
                </div>
                <code className="text-[10px] text-primary">{animation.property}</code>
              </div>
              <button
                className="rounded border border-border px-1 text-[9px] text-secondary hover:text-primary"
                type="button"
                onClick={() => {
                  const requested = Math.max(0, playheadUs - originStartUs);
                  const atUs = nextAvailableTime(animation, requested);
                  const value = evaluateAnimation(animation, atUs) ?? animation.keyframes[0]!.value;
                  void execute({
                    type: "keyframe.add",
                    nodeId,
                    property: animation.property,
                    atUs: timeUs(atUs),
                    value,
                    easing: "linear",
                  });
                }}
              >
                + At playhead
              </button>
            </div>
            {animation.keyframes.map((keyframe, index) => {
              return (
                <div key={`${keyframe.at}:${index}`} className="mt-1 grid grid-cols-2 gap-1">
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
                  <div className="text-[9px] text-muted">
                    Value
                    <KeyframeValueEditor
                      value={keyframe.value}
                      commit={(value) =>
                        void execute({
                          type: "keyframe.set",
                          nodeId,
                          property: animation.property,
                          index,
                          value,
                        })
                      }
                    />
                  </div>
                  <label className="text-[9px] text-muted">
                    Easing
                    <select
                      className="mt-0.5 w-full rounded border border-border bg-canvas px-1 py-0.5 text-[10px] text-primary"
                      defaultValue={keyframe.easing}
                      onChange={(event) =>
                        void execute({
                          type: "keyframe.set",
                          nodeId,
                          property: animation.property,
                          index,
                          easing: event.currentTarget.value,
                        })
                      }
                    >
                      {["linear", "hold", "ease-in", "ease-out", "ease-in-out"].map((easing) => (
                        <option key={easing} value={easing}>
                          {easing}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="mt-3 rounded border border-red-500/30 px-1 text-[9px] text-red-600 disabled:opacity-40"
                    type="button"
                    disabled={animation.keyframes.length <= 2}
                    onClick={() =>
                      void execute({
                        type: "keyframe.remove",
                        nodeId,
                        property: animation.property,
                        index,
                      })
                    }
                  >
                    Delete key
                  </button>
                </div>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
}
