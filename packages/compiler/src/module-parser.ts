import { node, nodes, optionalNode, parseJavaScript, type AstNode } from "./ast";
import { fail } from "./compiler-errors";
import type { ModuleRecord } from "./compiler-model";
import { identifierName, literalValue, nodeLocation } from "./jsx-syntax";
import type { CompilerSource } from "./types";

function declarationVariables(declaration: AstNode): Array<{ name: string; value: AstNode }> {
  if (declaration.type !== "VariableDeclaration") return [];
  return nodes(declaration.declarations, "variable declarations").flatMap((declarator) => {
    const id = node(declarator.id, "variable id");
    const value = optionalNode(declarator.init);
    return id.type === "Identifier" && value !== undefined
      ? [{ name: identifierName(id), value }]
      : [];
  });
}

function recordImport(module: ModuleRecord, statement: AstNode): void {
  const source = literalValue(node(statement.source, "import source"));
  if (typeof source !== "string") {
    fail("IMPORT_SOURCE", "Import sources must be strings.", nodeLocation(module, statement));
  }
  for (const specifier of nodes(statement.specifiers, "import specifiers")) {
    if (specifier.type !== "ImportSpecifier") {
      fail(
        "IMPORT_FORM",
        "Only named component imports are supported.",
        nodeLocation(module, specifier),
      );
    }
    const local = identifierName(node(specifier.local, "local import name"));
    const importedNode = node(specifier.imported, "imported name");
    const imported =
      importedNode.type === "Identifier"
        ? identifierName(importedNode)
        : String(literalValue(importedNode));
    module.imports.set(local, { local, imported, source });
  }
}

function recordComponent(module: ModuleRecord, declaration: AstNode): void {
  const name = identifierName(node(declaration.id, "component function name"));
  if (name[0] !== name[0]?.toUpperCase()) {
    fail(
      "COMPONENT_CASE",
      `Component ${name} must be capitalized.`,
      nodeLocation(module, declaration),
    );
  }
  module.components.set(name, declaration);
}

function recordVariables(module: ModuleRecord, declaration: AstNode, exported: boolean): void {
  for (const variable of declarationVariables(declaration)) {
    module.variables.set(variable.name, variable.value);
    if (exported && variable.value.type === "JSXElement") {
      module.compositionExports.set(variable.name, variable.value);
    }
  }
}

function recordExportSpecifiers(module: ModuleRecord, statement: AstNode): void {
  for (const specifier of nodes(statement.specifiers, "export specifiers")) {
    const local = identifierName(node(specifier.local, "export local"));
    const exportedName = identifierName(node(specifier.exported, "export name"));
    const value = module.variables.get(local);
    if (value?.type === "JSXElement") module.compositionExports.set(exportedName, value);
  }
}

function indexStatement(module: ModuleRecord, statement: AstNode): void {
  if (statement.type === "ImportDeclaration") return recordImport(module, statement);
  if (statement.type === "ExportDefaultDeclaration") {
    module.defaultExport = node(statement.declaration, "default export");
    return;
  }
  const exported = statement.type === "ExportNamedDeclaration";
  const declaration = exported ? optionalNode(statement.declaration) : statement;
  if (declaration?.type === "FunctionDeclaration") recordComponent(module, declaration);
  if (declaration !== undefined) recordVariables(module, declaration, exported);
  else if (exported) recordExportSpecifiers(module, statement);
}

export function parseModule(uri: string, loaded: CompilerSource): ModuleRecord {
  let program: AstNode;
  try {
    program = parseJavaScript(loaded.source);
  } catch (error) {
    fail("JS_PARSE", error instanceof Error ? error.message : String(error));
  }
  const module: ModuleRecord = {
    uri,
    ...loaded,
    program,
    imports: new Map(),
    components: new Map(),
    variables: new Map(),
    compositionExports: new Map(),
  };
  nodes(program.body, "module statements").forEach((statement) =>
    indexStatement(module, statement),
  );
  return module;
}

export function compositionElements(entry: ModuleRecord): AstNode[] {
  const exported = [...entry.compositionExports.values()];
  if (exported.length > 0) return exported;
  if (entry.defaultExport?.type === "JSXElement") return [entry.defaultExport];
  if (entry.defaultExport?.type === "Identifier") {
    const value = entry.variables.get(identifierName(entry.defaultExport));
    if (value?.type === "JSXElement") return [value];
  }
  fail(
    "DEFAULT_EXPORT",
    `${entry.uri} must export at least one composition and default-export one statically.`,
  );
}
