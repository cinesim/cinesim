import { Parser } from "acorn";
import jsx from "acorn-jsx";

export interface AstNode {
  type: string;
  start: number;
  end: number;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  [key: string]: unknown;
}

const JsxParser = Parser.extend(jsx());

export function parseJavaScript(source: string): AstNode {
  return JsxParser.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  }) as unknown as AstNode;
}

export function node(value: unknown, description: string): AstNode {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { type?: unknown }).type !== "string"
  ) {
    throw new Error(`Expected ${description}.`);
  }
  return value as AstNode;
}

export function optionalNode(value: unknown): AstNode | undefined {
  return value === null || value === undefined ? undefined : node(value, "syntax node");
}

export function nodes(value: unknown, description: string): AstNode[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${description}.`);
  return value.map((item) => node(item, description));
}

export function stringField(value: unknown, description: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${description}.`);
  return value;
}
