import type { IrEditTarget, IrValue } from "@cinesim/ir";

export interface SourceRewrite {
  source: string;
  revision: string;
  target: IrEditTarget;
  value: IrValue;
}

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
      return `${value.valueUs / 1_000_000}s`;
    case "vector":
    case "rectangle":
      return value.values.join(", ");
  }
}

function expression(value: IrValue): string {
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
      return `seconds(${value.valueUs / 1_000_000})`;
    case "vector":
      return `vec2(${value.values.join(", ")})`;
    case "rectangle":
      return `rect(${value.values.join(", ")})`;
  }
}

export function rewriteSourceValue(input: SourceRewrite): string {
  if (input.revision !== input.target.source.revision) {
    throw new Error("Source changed after compilation; refusing to apply a stale edit.");
  }
  if (input.value.kind !== input.target.expected) {
    throw new Error(`Expected a ${input.target.expected} value, received ${input.value.kind}.`);
  }

  const replacement =
    input.target.strategy === "replace-jsx-string"
      ? JSON.stringify(rawValue(input.value))
      : expression(input.value);
  return `${input.source.slice(0, input.target.source.start.offset)}${replacement}${input.source.slice(
    input.target.source.end.offset,
  )}`;
}
