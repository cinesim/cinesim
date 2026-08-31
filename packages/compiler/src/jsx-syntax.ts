import type { SourceSpan } from "@cinesim/ir";
import { node, nodes, optionalNode, stringField, type AstNode } from "./ast";
import type { ModuleRecord } from "./compiler-model";

export function literalValue(ast: AstNode): unknown {
  return ast.value;
}

export function identifierName(ast: AstNode, description = "identifier"): string {
  if (ast.type !== "Identifier" && ast.type !== "JSXIdentifier") {
    throw new Error(`Expected ${description}.`);
  }
  return stringField(ast.name, description);
}

export function nodeLocation(module: ModuleRecord, ast: AstNode): SourceSpan {
  const location = ast.loc;
  return {
    uri: module.uri,
    revision: module.revision,
    start: {
      line: location?.start.line ?? 1,
      column: (location?.start.column ?? ast.start) + 1,
      offset: ast.start,
    },
    end: {
      line: location?.end.line ?? 1,
      column: (location?.end.column ?? ast.end) + 1,
      offset: ast.end,
    },
  };
}

export function displayLocation(span: SourceSpan): string {
  return `${span.uri}:${span.start.line}:${span.start.column}`;
}

export function openingElement(ast: AstNode): AstNode {
  return node(ast.openingElement, "JSX opening element");
}

export function closingElement(ast: AstNode): AstNode | undefined {
  return optionalNode(ast.closingElement);
}

export function jsxElementName(ast: AstNode): string {
  const name = node(openingElement(ast).name, "JSX element name");
  if (name.type !== "JSXIdentifier") {
    throw new Error("Namespaced and member JSX names are not supported.");
  }
  return identifierName(name, "JSX element name");
}

export function attributes(ast: AstNode): AstNode[] {
  return nodes(openingElement(ast).attributes, "JSX attributes");
}

export function jsxChildren(ast: AstNode): AstNode[] {
  return nodes(ast.children, "JSX children");
}

export function jsxAttributeName(ast: AstNode): string {
  return identifierName(node(ast.name, "JSX attribute name"), "JSX attribute name");
}
