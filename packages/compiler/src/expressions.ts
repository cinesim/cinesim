import {
  irTimeUs,
  type BindingKind,
  type IrEditTarget,
  type IrTimeUs,
  type IrValue,
  type IrValueKind,
  type SourceSpan,
} from "@cinesim/ir";
import { node, nodes, optionalNode, type AstNode } from "./ast";
import { fail } from "./compiler-errors";
import type { AttributeValue, BoundNode, CompileContext } from "./compiler-model";
import { attributes, jsxAttributeName, literalValue, nodeLocation } from "./jsx-syntax";

const COLOR = /^(?:#[\da-f]{3,8}|transparent)$/iu;

function expressionValue(
  value: IrValue,
  source: SourceSpan,
  bindingKind: BindingKind = "direct",
): AttributeValue {
  return {
    value,
    bindingKind,
    readSpan: source,
    edit: { expected: value.kind, source, strategy: "replace-expression" },
  };
}

function numberArgument(value: IrValue, helper: string): number {
  if (value.kind !== "number" || !Number.isFinite(value.value)) {
    throw new Error(`${helper} expects a finite number.`);
  }
  return value.value;
}

function typedNumber(value: IrValue): number | undefined {
  switch (value.kind) {
    case "number":
    case "length":
    case "angle":
    case "decibels":
    case "percent":
      return value.value;
    case "time":
      return value.valueUs;
    default:
      return undefined;
  }
}

function calculate(operator: string, left: number, right: number, origin: SourceSpan): number {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    default:
      fail("ARITHMETIC_OPERATOR", `Unsupported arithmetic operator ${operator}.`, origin);
  }
}

function arithmeticValue(
  operator: string,
  left: IrValue,
  right: IrValue,
  origin: SourceSpan,
): IrValue {
  const leftNumber = typedNumber(left);
  const rightNumber = typedNumber(right);
  if (leftNumber === undefined || rightNumber === undefined) {
    fail("ARITHMETIC_TYPE", `Operator ${operator} requires numeric typed values.`, origin);
  }
  const output = calculate(operator, leftNumber, rightNumber, origin);
  if (!Number.isFinite(output)) {
    fail("ARITHMETIC_VALUE", "Arithmetic must produce a finite value.", origin);
  }
  if (left.kind === "time" && (right.kind === "time" || right.kind === "number")) {
    return { kind: "time", valueUs: irTimeUs(Math.round(output)) };
  }
  if (right.kind === "number") {
    switch (left.kind) {
      case "length":
      case "angle":
      case "decibels":
      case "percent":
        return { ...left, value: output };
    }
  }
  return { kind: "number", value: output };
}

function evaluateLiteral(ast: AstNode, origin: SourceSpan): AttributeValue {
  const literal = literalValue(ast);
  if (typeof literal === "string")
    return expressionValue({ kind: "string", value: literal }, origin);
  if (typeof literal === "number" && Number.isFinite(literal)) {
    return expressionValue({ kind: "number", value: literal }, origin);
  }
  if (typeof literal === "boolean") {
    return expressionValue({ kind: "boolean", value: literal }, origin);
  }
  fail("VALUE_LITERAL", "Only string, number, and boolean literals are supported.", origin);
}

function evaluateIdentifier(
  ast: AstNode,
  context: CompileContext,
  origin: SourceSpan,
): AttributeValue {
  const name = String(ast.name);
  const value = context.environment.get(name);
  if (value === undefined) {
    fail(
      "UNKNOWN_IDENTIFIER",
      `Unknown identifier ${name}. Source is never executed as JavaScript.`,
      origin,
    );
  }
  return value;
}

function evaluateUnary(
  ast: AstNode,
  context: CompileContext,
  assets: ReadonlySet<string>,
  origin: SourceSpan,
): AttributeValue {
  if (ast.operator !== "-") {
    fail(
      "UNSAFE_EXPRESSION",
      `Unsupported ${ast.type} expression. Source is parsed and lowered, never executed.`,
      origin,
    );
  }
  const argument = evaluateExpression(node(ast.argument, "unary argument"), context, assets);
  return {
    value: { kind: "number", value: -numberArgument(argument.value, "Unary minus") },
    bindingKind: "computed",
    readSpan: origin,
  };
}

function evaluateBinary(
  ast: AstNode,
  context: CompileContext,
  assets: ReadonlySet<string>,
  origin: SourceSpan,
): AttributeValue {
  const left = evaluateExpression(node(ast.left, "left operand"), context, assets);
  const right = evaluateExpression(node(ast.right, "right operand"), context, assets);
  return {
    value: arithmeticValue(String(ast.operator), left.value, right.value, origin),
    bindingKind: "computed",
    readSpan: origin,
  };
}

const numericHelpers: Readonly<Record<string, (value: number) => IrValue>> = {
  seconds: (value) => ({ kind: "time", valueUs: irTimeUs(Math.round(value * 1_000_000)) }),
  milliseconds: (value) => ({ kind: "time", valueUs: irTimeUs(Math.round(value * 1_000)) }),
  microseconds: (value) => ({ kind: "time", valueUs: irTimeUs(value) }),
  px: (value) => ({ kind: "length", unit: "px", value }),
  percent: (value) => ({ kind: "percent", value }),
  deg: (value) => ({ kind: "angle", unit: "deg", value }),
  db: (value) => ({ kind: "decibels", value }),
};

function evaluateHelper(
  name: string,
  args: readonly AttributeValue[],
  assets: ReadonlySet<string>,
  origin: SourceSpan,
): IrValue {
  const numeric = numericHelpers[name];
  if (numeric !== undefined && args.length === 1) {
    return numeric(numberArgument(args[0]!.value, name));
  }
  if (name === "asset" && args.length === 1 && args[0]!.value.kind === "string") {
    const assetId = args[0]!.value.value;
    if (!/^asset_[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(assetId)) {
      fail("ASSET_ID", `Invalid stable asset id: ${assetId}.`, origin);
    }
    if (!assets.has(assetId)) {
      fail("UNKNOWN_ASSET", `Asset ${assetId} is not declared in cinesim.toml.`, origin);
    }
    return { kind: "resource", assetId };
  }
  if (name === "vec2" && args.length === 2) {
    return {
      kind: "vector",
      values: [numberArgument(args[0]!.value, name), numberArgument(args[1]!.value, name)],
    };
  }
  if (name === "rect" && args.length === 4) {
    return {
      kind: "rectangle",
      values: args.map((argument) => numberArgument(argument.value, name)) as [
        number,
        number,
        number,
        number,
      ],
    };
  }
  fail("UNKNOWN_HELPER", `Unsupported helper ${name}().`, origin);
}

function evaluateCall(
  ast: AstNode,
  context: CompileContext,
  assets: ReadonlySet<string>,
  origin: SourceSpan,
): AttributeValue {
  const callee = node(ast.callee, "helper name");
  if (callee.type !== "Identifier") throw new Error("Expected helper name.");
  const name = String(callee.name);
  const args = nodes(ast.arguments, "helper arguments").map((argument) =>
    evaluateExpression(argument, context, assets),
  );
  return expressionValue(evaluateHelper(name, args, assets, origin), origin);
}

export function evaluateExpression(
  ast: AstNode,
  context: CompileContext,
  assets: ReadonlySet<string>,
): AttributeValue {
  const origin = nodeLocation(context.module, ast);
  switch (ast.type) {
    case "Literal":
      return evaluateLiteral(ast, origin);
    case "Identifier":
      return evaluateIdentifier(ast, context, origin);
    case "UnaryExpression":
      return evaluateUnary(ast, context, assets, origin);
    case "BinaryExpression":
      return evaluateBinary(ast, context, assets, origin);
    case "CallExpression":
      return evaluateCall(ast, context, assets, origin);
    default:
      fail(
        "UNSAFE_EXPRESSION",
        `Unsupported ${ast.type} expression. Source is parsed and lowered, never executed.`,
        origin,
      );
  }
}

function coerceValue(value: IrValue, expected: IrValueKind, origin: SourceSpan): IrValue {
  if (value.kind === expected) return value;
  if (expected === "color" && value.kind === "string") {
    if (!COLOR.test(value.value)) fail("INVALID_COLOR", `Invalid color ${value.value}.`, origin);
    return { kind: "color", value: value.value.toLowerCase() };
  }
  if (expected === "angle" && value.kind === "number") {
    return { kind: "angle", unit: "deg", value: value.value };
  }
  fail("TYPE_MISMATCH", `Expected ${expected}, received ${value.kind}.`, origin);
}

function attributeExpression(
  valueNode: AstNode,
  context: CompileContext,
): {
  expression: AstNode;
  strategy: IrEditTarget["strategy"];
} {
  if (valueNode.type === "JSXExpressionContainer") {
    return {
      expression: node(valueNode.expression, "JSX attribute expression"),
      strategy: "replace-expression",
    };
  }
  if (valueNode.type === "Literal")
    return { expression: valueNode, strategy: "replace-jsx-string" };
  fail(
    "ATTRIBUTE_VALUE",
    "Unsupported JSX attribute value.",
    nodeLocation(context.module, valueNode),
  );
}

export function evaluateAttribute(
  ast: AstNode,
  context: CompileContext,
  assets: ReadonlySet<string>,
  expected?: IrValueKind,
): AttributeValue {
  const attributeOrigin = nodeLocation(context.module, ast);
  const valueNode = optionalNode(ast.value);
  if (valueNode === undefined) {
    const value: IrValue = { kind: "boolean", value: true };
    return expressionValue(
      expected === undefined ? value : coerceValue(value, expected, attributeOrigin),
      attributeOrigin,
    );
  }
  const { expression, strategy } = attributeExpression(valueNode, context);
  const evaluated = evaluateExpression(expression, context, assets);
  const value =
    expected === undefined
      ? evaluated.value
      : coerceValue(evaluated.value, expected, attributeOrigin);
  const direct = expression.type !== "Identifier" && evaluated.bindingKind !== "computed";
  const source = direct ? nodeLocation(context.module, expression) : evaluated.edit?.source;
  return {
    ...evaluated,
    value,
    readSpan: direct ? nodeLocation(context.module, expression) : evaluated.readSpan,
    ...(source === undefined
      ? {}
      : {
          edit: {
            expected: expected ?? value.kind,
            source,
            strategy: direct ? strategy : evaluated.edit!.strategy,
          },
        }),
  };
}

export function stringAttribute(
  element: AstNode,
  name: string,
  context: CompileContext,
  assets: ReadonlySet<string>,
  required: boolean,
): AttributeValue | undefined {
  const attribute = attributes(element).find(
    (candidate) => candidate.type === "JSXAttribute" && jsxAttributeName(candidate) === name,
  );
  if (attribute === undefined) {
    if (required) {
      fail(
        "MISSING_PROPERTY",
        `Missing required ${name} property.`,
        nodeLocation(context.module, element),
      );
    }
    return undefined;
  }
  return evaluateAttribute(attribute, context, assets, "string");
}

export function propertyValue(node: BoundNode, name: string): IrValue | undefined {
  return node.props[name]?.value;
}

export function stringValue(node: BoundNode, name: string, fallback?: string): string {
  const value = propertyValue(node, name);
  if (value === undefined && fallback !== undefined) return fallback;
  if (value?.kind !== "string" && value?.kind !== "color") {
    throw new Error(`${node.kind}.${name} is not a string.`);
  }
  return value.value;
}

export function numberValue(node: BoundNode, name: string, fallback: number): number {
  const value = propertyValue(node, name);
  if (value === undefined) return fallback;
  const numeric = typedNumber(value);
  if (numeric !== undefined) return numeric;
  throw new Error(`${node.kind}.${name} is not numeric.`);
}

export function booleanValue(node: BoundNode, name: string, fallback: boolean): boolean {
  const value = propertyValue(node, name);
  if (value === undefined) return fallback;
  if (value.kind !== "boolean") throw new Error(`${node.kind}.${name} is not boolean.`);
  return value.value;
}

export function timeValue(node: BoundNode, name: string, fallback = 0): IrTimeUs {
  const value = propertyValue(node, name);
  if (value === undefined) return irTimeUs(fallback);
  if (value.kind !== "time") throw new Error(`${node.kind}.${name} is not time.`);
  return value.valueUs;
}
