import type {
  IrClip,
  IrComposition,
  IrEditTarget,
  IrEffect,
  IrNodeTemplate,
  IrSceneNode,
  IrTrack,
  IrValue,
} from "@cinesim/ir";

function rawValue(value: IrValue): string | number | boolean {
  switch (value.kind) {
    case "boolean":
    case "number":
    case "string":
    case "color":
    case "angle":
    case "decibels":
    case "percent":
      return value.value;
    case "length":
      return `${value.value}px`;
    case "resource":
      return value.assetId;
    case "time":
      return `${value.valueUs}us`;
    case "vector":
    case "rectangle":
      return value.values.join(", ");
  }
}

export function printIrExpression(value: IrValue): string {
  switch (value.kind) {
    case "boolean":
    case "number":
      return String(value.value);
    case "string":
    case "color":
      return JSON.stringify(value.value);
    case "angle":
      return `deg(${value.value})`;
    case "decibels":
      return `db(${value.value})`;
    case "percent":
      return `percent(${value.value})`;
    case "length":
      return `px(${value.value})`;
    case "resource":
      return `asset(${JSON.stringify(value.assetId)})`;
    case "time":
      return `microseconds(${value.valueUs})`;
    case "vector":
      return `vec2(${value.values.join(", ")})`;
    case "rectangle":
      return `rect(${value.values.join(", ")})`;
  }
}

export function replacementText(target: IrEditTarget, value: IrValue): string {
  return target.strategy === "replace-jsx-string"
    ? JSON.stringify(rawValue(value))
    : printIrExpression(value);
}

export function jsxAttribute(name: string, value: IrValue): string {
  return value.kind === "string" || value.kind === "color"
    ? `${name}=${JSON.stringify(value.value)}`
    : `${name}={${printIrExpression(value)}}`;
}

function sceneSource(node: IrSceneNode, indent: string): string {
  const properties = Object.entries(node.props).map(
    ([name, value]) =>
      `${name}=${value.kind === "string" || value.kind === "color" ? JSON.stringify(value.value) : `{${printIrExpression(value)}}`}`,
  );
  const opening = `<${node.kind} id=${JSON.stringify(node.id)}${properties.length === 0 ? "" : ` ${properties.join(" ")}`}`;
  const children = [
    ...node.children.map((child) => sceneSource(child, `${indent}  `)),
    ...node.effects.map((effect) => effectSource(effect, `${indent}  `)),
  ];
  if (children.length === 0 && node.animations.length === 0) return `${indent}${opening} />`;
  const animations = node.animations.map((animation) =>
    [
      `${indent}  <animate property=${JSON.stringify(animation.property)}>`,
      ...animation.keyframes.map(
        (keyframe) =>
          `${indent}    <key at={microseconds(${keyframe.at})} value={${printIrExpression(keyframe.value)}} easing=${JSON.stringify(keyframe.easing)} />`,
      ),
      `${indent}  </animate>`,
    ].join("\n"),
  );
  return [`${indent}${opening}>`, ...animations, ...children, `${indent}</${node.kind}>`].join(
    "\n",
  );
}

function effectSource(effect: IrEffect, indent: string): string {
  return sceneSource(
    {
      id: effect.id,
      kind: effect.kind,
      props: { enabled: { kind: "boolean", value: effect.enabled }, ...effect.props },
      animations: [],
      effects: [],
      children: effect.children,
    },
    indent,
  );
}

function clipSource(clip: IrClip, indent: string): string {
  const attributes = [
    `id=${JSON.stringify(clip.id)}`,
    ...(clip.name === undefined ? [] : [`name=${JSON.stringify(clip.name)}`]),
    ...(clip.assetId === undefined ? [] : [`asset={asset(${JSON.stringify(clip.assetId)})}`]),
    ...(clip.compositionId === undefined
      ? []
      : [`composition=${JSON.stringify(clip.compositionId)}`]),
    ...(clip.mediaKind === undefined ? [] : [`media=${JSON.stringify(clip.mediaKind)}`]),
    ...(clip.linkedClipId === undefined ? [] : [`linked=${JSON.stringify(clip.linkedClipId)}`]),
    `start={microseconds(${clip.timelineStartUs})}`,
    `in={microseconds(${clip.sourceStartUs})}`,
    `duration={microseconds(${clip.durationUs})}`,
    `playbackRate={${clip.playbackRate}}`,
    `enabled={${clip.enabled}}`,
    `reverse={${clip.reverse}}`,
    `freeze={${clip.freeze}}`,
    `loop={${clip.loop}}`,
    `fadeIn={microseconds(${clip.fades.inUs})}`,
    `fadeOut={microseconds(${clip.fades.outUs})}`,
    `x={px(${clip.transform.x})}`,
    `y={px(${clip.transform.y})}`,
    `anchorX={percent(${clip.transform.anchorX})}`,
    `anchorY={percent(${clip.transform.anchorY})}`,
    `scaleX={${clip.transform.scaleX}}`,
    `scaleY={${clip.transform.scaleY}}`,
    `rotation={deg(${clip.transform.rotation})}`,
    `opacity={${clip.transform.opacity}}`,
    `z={${clip.transform.zIndex}}`,
    `fit=${JSON.stringify(clip.transform.fit)}`,
    `cornerRadius={px(${clip.transform.cornerRadius})}`,
    `blendMode=${JSON.stringify(clip.transform.blendMode)}`,
    `gain={db(${clip.audio.gainDb})}`,
    `pan={${clip.audio.pan}}`,
    `muted={${clip.audio.muted}}`,
  ];
  const children = [
    ...(clip.content === undefined ? [] : [sceneSource(clip.content, `${indent}  `)]),
    ...clip.effects.map((effect) => effectSource(effect, `${indent}  `)),
  ];
  if (children.length === 0) return `${indent}<clip ${attributes.join(" ")} />`;
  return [`${indent}<clip ${attributes.join(" ")}>`, ...children, `${indent}</clip>`].join("\n");
}

function trackSource(track: IrTrack, indent: string): string {
  const opening = `<track id=${JSON.stringify(track.id)} kind=${JSON.stringify(track.kind)} name=${JSON.stringify(track.name)} muted={${track.muted}} locked={${track.locked}}`;
  const children = [
    ...track.clips.map((clip) => clipSource(clip, `${indent}  `)),
    ...track.effects.map((effect) => effectSource(effect, `${indent}  `)),
  ];
  if (children.length === 0) return `${indent}${opening} />`;
  return [`${indent}${opening}>`, ...children, `${indent}</track>`].join("\n");
}

function compositionSource(composition: IrComposition): string {
  const exportName = `composition_${composition.id.replaceAll(/[^a-zA-Z0-9_$]/gu, "_")}`;
  const tracks = composition.timeline.tracks.map((track) => trackSource(track, "      "));
  return [
    `export const ${exportName} = (`,
    `  <composition id=${JSON.stringify(composition.id)} name=${JSON.stringify(composition.name)} width={${composition.width}} height={${composition.height}} fps={${composition.frameRate}} background=${JSON.stringify(composition.background)}>`,
    `    <timeline id=${JSON.stringify(composition.timeline.id)}>`,
    ...tracks,
    ...composition.timeline.notes.map(
      (note) =>
        `      <note id=${JSON.stringify(note.id)} at={microseconds(${note.atUs})}${note.durationUs === undefined ? "" : ` duration={microseconds(${note.durationUs})}`} kind=${JSON.stringify(note.kind)} text=${JSON.stringify(note.text)} />`,
    ),
    ...composition.timeline.markers.map(
      (marker) =>
        `      <marker id=${JSON.stringify(marker.id)} at={microseconds(${marker.atUs})} name=${JSON.stringify(marker.name)}${marker.color === undefined ? "" : ` color=${JSON.stringify(marker.color)}`} />`,
    ),
    ...composition.timeline.transitions.map(
      (transition) =>
        `      <transition id=${JSON.stringify(transition.id)} from=${JSON.stringify(transition.fromClipId)} to=${JSON.stringify(transition.toClipId)} kind=${JSON.stringify(transition.kind)} duration={microseconds(${transition.durationUs})} />`,
    ),
    "    </timeline>",
    "  </composition>",
    ");",
  ].join("\n");
}

export function printNodeTemplate(template: IrNodeTemplate, indent = ""): string {
  if (template.kind === "composition") return compositionSource(template.composition);
  if (template.kind === "track") return trackSource(template.track, indent);
  if (template.kind === "clip") return clipSource(template.clip, indent);
  if (template.kind === "scene") return sceneSource(template.node, indent);
  if (template.kind === "marker") {
    return `${indent}<marker id=${JSON.stringify(template.marker.id)} at={microseconds(${template.marker.atUs})} name=${JSON.stringify(template.marker.name)}${template.marker.color === undefined ? "" : ` color=${JSON.stringify(template.marker.color)}`} />`;
  }
  if (template.kind === "note") {
    return `${indent}<note id=${JSON.stringify(template.note.id)} at={microseconds(${template.note.atUs})}${template.note.durationUs === undefined ? "" : ` duration={microseconds(${template.note.durationUs})}`} kind=${JSON.stringify(template.note.kind)} text=${JSON.stringify(template.note.text)} />`;
  }
  return `${indent}<transition id=${JSON.stringify(template.transition.id)} from=${JSON.stringify(template.transition.fromClipId)} to=${JSON.stringify(template.transition.toClipId)} kind=${JSON.stringify(template.transition.kind)} duration={microseconds(${template.transition.durationUs})} />`;
}
