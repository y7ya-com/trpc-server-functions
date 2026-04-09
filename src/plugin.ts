import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { parse } from "@babel/parser";
import traverseModule, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import fg from "fast-glob";
import MagicString from "magic-string";
import { createFilter, normalizePath, type Plugin, type ViteDevServer } from "vite";

import {
  PACKAGE_NAME,
  RESOLVED_VIRTUAL_TRPC_SERVER_FUNCTIONS_MODULE,
  VIRTUAL_TRPC_SERVER_FUNCTIONS_MODULE,
} from "./constants.js";

export type Pattern = string | RegExp | readonly (string | RegExp)[];

export interface TrpcServerFunctionsPluginOptions {
  include?: Pattern;
  exclude?: Pattern;
  procedure: {
    importPath: string;
    exportName: string;
  };
  generatedModulePath?: string;
}

export interface GenerateServerFunctionsModuleOptions {
  root?: string;
  include?: Pattern;
  exclude?: Pattern;
  procedure: {
    importPath: string;
    exportName: string;
  };
  generatedModulePath: string;
}

interface DiscoveryGlobs {
  include: string[];
  ignore: string[];
}

interface TopLevelBindingInfo {
  bindingPath: NodePath<t.Node>;
  statementPath: NodePath<t.Node>;
}

interface RawServerFnMatch {
  localName: string;
  callStart: number;
  callEnd: number;
  handlerStart: number;
  handlerEnd: number;
  hasInjectedMeta: boolean;
  procedureType: "query" | "mutation";
}

interface DiscoveredServerFn extends RawServerFnMatch {
  id: string;
  routeKey: string;
  exportName: string;
  relativePath: string;
  filePath: string;
}

const DEFAULT_INCLUDE = ["**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/__trpc_server_functions__/**",
];
const GENERATED_SERVER_MODULE_DIRNAME = "__trpc_server_functions__";
const traverse =
  (traverseModule as unknown as { default?: typeof import("@babel/traverse").default })
    .default ??
  (traverseModule as unknown as typeof import("@babel/traverse").default);

function createRouteKey(relativePath: string, exportName: string) {
  const withoutExtension = relativePath.replace(/\.[^./]+$/, "");
  const hash = createHash("sha256")
    .update(`${withoutExtension}:${exportName}`)
    .digest("hex")
    .slice(0, 24);

  return `sf_${hash}`;
}

function toArray<T>(value: T | readonly T[] | undefined) {
  if (value == null) {
    return [];
  }

  return Array.isArray(value) ? [...value] : [value];
}

function isGlobPattern(value: Pattern): value is string {
  return typeof value === "string";
}

function resolveDiscoveryGlobs(include?: Pattern, exclude?: Pattern): DiscoveryGlobs {
  const includePatterns = toArray(include).filter(isGlobPattern);
  const excludePatterns = toArray(exclude).filter(isGlobPattern);

  return {
    include: includePatterns.length > 0 ? includePatterns : DEFAULT_INCLUDE,
    ignore: [...DEFAULT_EXCLUDE, ...excludePatterns],
  };
}

function isCreateServerFnReference(
  node: t.Expression | t.V8IntrinsicIdentifier,
  aliases: ReadonlySet<string>,
) {
  if (t.isIdentifier(node) && aliases.has(node.name)) {
    return true;
  }

  if (t.isTSInstantiationExpression(node)) {
    return isCreateServerFnReference(node.expression, aliases);
  }

  return (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.property, { name: "createServerFn" })
  );
}

function getServerFnCall(
  expression: t.Expression | null | undefined,
  aliases: ReadonlySet<string>,
): RawServerFnMatch | null {
  if (!expression || !t.isCallExpression(expression)) {
    return null;
  }

  if (
    !t.isMemberExpression(expression.callee) ||
    expression.callee.computed ||
    !t.isIdentifier(expression.callee.property) ||
    !["query", "mutation"].includes(expression.callee.property.name)
  ) {
    return null;
  }

  const builderCall = expression.callee.object;

  if (
    !t.isCallExpression(builderCall) ||
    !isCreateServerFnReference(builderCall.callee, aliases)
  ) {
    return null;
  }

  const handlerArgument = expression.arguments[0];

  if (!handlerArgument || handlerArgument.type === "SpreadElement") {
    return null;
  }

  if (
    expression.start == null ||
    expression.end == null ||
    handlerArgument.start == null ||
    handlerArgument.end == null
  ) {
    return null;
  }

  return {
    localName: "",
    callStart: expression.start,
    callEnd: expression.end,
    handlerStart: handlerArgument.start,
    handlerEnd: handlerArgument.end,
    hasInjectedMeta: expression.arguments.length > 1,
    procedureType:
      expression.callee.property.name === "mutation" ? "mutation" : "query",
  };
}

function analyzeModule(code: string, filePath: string, root: string) {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  const declarations = new Map<string, RawServerFnMatch>();
  const exportMap = new Map<string, string>();
  const createServerFnAliases = new Set<string>(["createServerFn"]);

  const captureDeclaration = (declaration: t.VariableDeclaration) => {
    for (const declarator of declaration.declarations) {
      if (!t.isIdentifier(declarator.id)) {
        continue;
      }

      if (
        declarator.init &&
        t.isTSInstantiationExpression(declarator.init) &&
        isCreateServerFnReference(declarator.init.expression, createServerFnAliases)
      ) {
        createServerFnAliases.add(declarator.id.name);
      }

      const match = getServerFnCall(declarator.init, createServerFnAliases);

      if (!match) {
        continue;
      }

      declarations.set(declarator.id.name, {
        ...match,
        localName: declarator.id.name,
      });
    }
  };

  for (const statement of ast.program.body) {
    if (t.isVariableDeclaration(statement)) {
      captureDeclaration(statement);
      continue;
    }

    if (!t.isExportNamedDeclaration(statement)) {
      continue;
    }

    if (statement.declaration && t.isVariableDeclaration(statement.declaration)) {
      captureDeclaration(statement.declaration);

      for (const declarator of statement.declaration.declarations) {
        if (t.isIdentifier(declarator.id) && !exportMap.has(declarator.id.name)) {
          exportMap.set(declarator.id.name, declarator.id.name);
        }
      }
    }

    for (const specifier of statement.specifiers) {
      if (
        t.isExportSpecifier(specifier) &&
        t.isIdentifier(specifier.local) &&
        t.isIdentifier(specifier.exported) &&
        !exportMap.has(specifier.local.name)
      ) {
        exportMap.set(specifier.local.name, specifier.exported.name);
      }
    }
  }

  const relativePath = normalizePath(path.relative(root, filePath));
  const discovered: DiscoveredServerFn[] = [];

  for (const [localName, exportName] of exportMap) {
    const match = declarations.get(localName);

    if (!match) {
      continue;
    }

    const id = `${relativePath}:${exportName}`;

    discovered.push({
      ...match,
      exportName,
      filePath,
      id,
      routeKey: createRouteKey(relativePath, exportName),
      relativePath,
    });
  }

  return discovered;
}

function isWithinHandler(position: number, matches: readonly DiscoveredServerFn[]) {
  return matches.some(
    (match) => position >= match.handlerStart && position <= match.handlerEnd,
  );
}

function isTopLevelBindingPath(path: NodePath<t.Node>) {
  if (
    path.isImportSpecifier() ||
    path.isImportDefaultSpecifier() ||
    path.isImportNamespaceSpecifier()
  ) {
    return true;
  }

  if (path.isVariableDeclarator()) {
    const declarationPath = path.parentPath;
    const containerPath = declarationPath.parentPath;

    return (
      declarationPath.isVariableDeclaration() &&
      containerPath != null &&
      (containerPath.isProgram() || containerPath.isExportNamedDeclaration()) &&
      !containerPath.isExportNamedDeclaration()
    );
  }

  if (path.isFunctionDeclaration() || path.isClassDeclaration()) {
    const containerPath = path.parentPath;

    return containerPath?.isProgram() === true;
  }

  return false;
}

function getBindingKey(path: NodePath<t.Node>, name: string) {
  if (path.node.start == null) {
    return null;
  }

  return `${name}:${path.node.start}`;
}

function collectClientPrunableBindings(
  code: string,
  matches: readonly DiscoveredServerFn[],
) {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  const usage = new Map<
    string,
    {
      bindingPath: NodePath<t.Node>;
      insideOnly: boolean;
    }
  >();

  traverse(ast, {
    Identifier(path: NodePath<t.Identifier>) {
      if (!path.isReferencedIdentifier()) {
        return;
      }

      const binding = path.scope.getBinding(path.node.name);

      if (!binding || !isTopLevelBindingPath(binding.path)) {
        return;
      }

      const key = getBindingKey(binding.path, path.node.name);

      if (!key || path.node.start == null) {
        return;
      }

      const record = usage.get(key) ?? {
        bindingPath: binding.path,
        insideOnly: true,
      };

      if (!isWithinHandler(path.node.start, matches)) {
        record.insideOnly = false;
      }

      usage.set(key, record);
    },
  });

  return [...usage.values()]
    .filter((entry) => entry.insideOnly)
    .map((entry) => entry.bindingPath);
}

function removeListNode(
  magicString: MagicString,
  node: t.Node,
  siblings: readonly t.Node[],
) {
  if (node.start == null || node.end == null) {
    return;
  }

  const index = siblings.findIndex((sibling) => sibling === node);

  if (index === -1) {
    return;
  }

  if (siblings.length === 1) {
    magicString.remove(node.start, node.end);
    return;
  }

  if (index < siblings.length - 1) {
    const nextNode = siblings[index + 1];

    if (nextNode?.start != null) {
      magicString.remove(node.start, nextNode.start);
    }

    return;
  }

  const previousNode = siblings[index - 1];

  if (previousNode?.end != null) {
    magicString.remove(previousNode.end, node.end);
  }
}

function pruneClientOnlyBindings(
  magicString: MagicString,
  code: string,
  matches: readonly DiscoveredServerFn[],
) {
  const bindingPaths = collectClientPrunableBindings(code, matches).sort((left, right) => {
    const leftStart = left.node.start ?? 0;
    const rightStart = right.node.start ?? 0;
    return rightStart - leftStart;
  });
  const handledNodes = new Set<t.Node>();
  const importRemovalCounts = new Map<t.ImportDeclaration, number>();
  const variableRemovalCounts = new Map<t.VariableDeclaration, number>();

  for (const bindingPath of bindingPaths) {
    if (
      (bindingPath.isImportSpecifier() ||
        bindingPath.isImportDefaultSpecifier() ||
        bindingPath.isImportNamespaceSpecifier()) &&
      t.isImportDeclaration(bindingPath.parentPath.node)
    ) {
      const declaration = bindingPath.parentPath.node;
      importRemovalCounts.set(declaration, (importRemovalCounts.get(declaration) ?? 0) + 1);
      continue;
    }

    if (bindingPath.isVariableDeclarator() && t.isVariableDeclaration(bindingPath.parentPath.node)) {
      const declaration = bindingPath.parentPath.node;
      variableRemovalCounts.set(declaration, (variableRemovalCounts.get(declaration) ?? 0) + 1);
    }
  }

  for (const bindingPath of bindingPaths) {
    if (
      bindingPath.isImportSpecifier() ||
      bindingPath.isImportDefaultSpecifier() ||
      bindingPath.isImportNamespaceSpecifier()
    ) {
      const declaration = bindingPath.parentPath.node;

      if (!t.isImportDeclaration(declaration) || handledNodes.has(declaration)) {
        continue;
      }

      if (importRemovalCounts.get(declaration) === declaration.specifiers.length) {
        if (declaration.start != null && declaration.end != null) {
          magicString.remove(declaration.start, declaration.end);
          handledNodes.add(declaration);
        }
        continue;
      }

      removeListNode(magicString, bindingPath.node, declaration.specifiers);
      continue;
    }

    if (bindingPath.isVariableDeclarator()) {
      const declaration = bindingPath.parentPath.node;

      if (!t.isVariableDeclaration(declaration) || handledNodes.has(declaration)) {
        continue;
      }

      if (
        declaration.declarations.length === 1 ||
        variableRemovalCounts.get(declaration) === declaration.declarations.length
      ) {
        const container = bindingPath.parentPath.parentPath?.node;

        if (container?.start != null && container.end != null) {
          magicString.remove(container.start, container.end);
          handledNodes.add(declaration);
        }
        continue;
      }

      removeListNode(magicString, bindingPath.node, declaration.declarations);
      continue;
    }

    if (
      (bindingPath.isFunctionDeclaration() || bindingPath.isClassDeclaration()) &&
      bindingPath.node.start != null &&
      bindingPath.node.end != null
    ) {
      magicString.remove(bindingPath.node.start, bindingPath.node.end);
    }
  }
}

function injectMetadata(code: string, matches: readonly DiscoveredServerFn[], ssr: boolean) {
  if (matches.length === 0) {
    return null;
  }

  const magicString = new MagicString(code);
  let changed = false;

  for (const match of matches) {
    if (!match.hasInjectedMeta) {
      const metadata = `{ id: ${JSON.stringify(match.id)}, routeKey: ${JSON.stringify(
        match.routeKey,
      )}, exportName: ${JSON.stringify(match.exportName)}, relativePath: ${JSON.stringify(
        match.relativePath,
      )}, procedureType: ${JSON.stringify(match.procedureType)} }`;

      magicString.appendRight(match.handlerEnd, `, ${metadata}`);
      changed = true;
    }

    if (!ssr) {
      magicString.overwrite(match.handlerStart, match.handlerEnd, "undefined");
      changed = true;
    }
  }

  if (!ssr) {
    pruneClientOnlyBindings(magicString, code, matches);
    changed = true;
  }

  if (!changed) {
    return null;
  }

  return {
    code: magicString.toString(),
    map: magicString.generateMap({ hires: true }),
  };
}

function toProjectImportPath(root: string, filePath: string) {
  return `/${normalizePath(path.relative(root, filePath))}`;
}

function resolveFromRoot(root: string, filePath: string) {
  return normalizePath(
    path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath),
  );
}

function getGeneratedServerModulesRoot(generatedModulePath: string) {
  return normalizePath(
    path.join(path.dirname(generatedModulePath), GENERATED_SERVER_MODULE_DIRNAME),
  );
}

function getGeneratedServerModulePath(
  generatedModulePath: string,
  originalFilePath: string,
  root: string,
) {
  const relativePath = normalizePath(path.relative(root, originalFilePath)).replace(
    /\.[^./]+$/,
    ".ts",
  );

  return normalizePath(
    path.join(getGeneratedServerModulesRoot(generatedModulePath), relativePath),
  );
}

function toRelativeImportPath(fromFilePath: string, targetFilePath: string) {
  const relativePath = normalizePath(path.relative(path.dirname(fromFilePath), targetFilePath));

  if (relativePath.startsWith(".")) {
    return relativePath;
  }

  return `./${relativePath}`;
}

function getTopLevelStatementPath(path: NodePath<t.Node>) {
  if (path.parentPath?.isImportDeclaration() && path.parentPath.parentPath?.isProgram()) {
    return path.parentPath as NodePath<t.Node>;
  }

  let current: NodePath<t.Node> | null = path;

  while (current) {
    const parent = current.parentPath;

    if (!parent) {
      return null;
    }

    if (parent.isProgram()) {
      return current;
    }

    if (parent.isExportNamedDeclaration() && parent.parentPath?.isProgram()) {
      return parent as NodePath<t.Node>;
    }

    current = parent as NodePath<t.Node>;
  }

  return null;
}

function isGeneratedModuleTopLevelBindingPath(path: NodePath<t.Node>) {
  if (
    path.isImportSpecifier() ||
    path.isImportDefaultSpecifier() ||
    path.isImportNamespaceSpecifier()
  ) {
    return path.parentPath.isImportDeclaration() && path.parentPath.parentPath?.isProgram() === true;
  }

  if (path.isVariableDeclarator()) {
    const declarationPath = path.parentPath;
    const containerPath = declarationPath.parentPath;

    return (
      declarationPath.isVariableDeclaration() &&
      containerPath != null &&
      (containerPath.isProgram() ||
        (containerPath.isExportNamedDeclaration() && containerPath.parentPath?.isProgram() === true))
    );
  }

  if (path.isFunctionDeclaration() || path.isClassDeclaration()) {
    return (
      path.parentPath?.isProgram() === true ||
      (path.parentPath?.isExportNamedDeclaration() === true &&
        path.parentPath.parentPath?.isProgram() === true)
    );
  }

  return false;
}

function collectTopLevelBindings(ast: t.File) {
  const bindings = new Map<string, TopLevelBindingInfo>();

  const register = (name: string, bindingPath: NodePath<t.Node>) => {
    const statementPath = getTopLevelStatementPath(bindingPath);

    if (!statementPath || bindings.has(name)) {
      return;
    }

    bindings.set(name, {
      bindingPath,
      statementPath,
    });
  };

  traverse(ast, {
    ImportSpecifier(path: NodePath<t.ImportSpecifier>) {
      register(path.node.local.name, path as NodePath<t.Node>);
    },
    ImportDefaultSpecifier(path: NodePath<t.ImportDefaultSpecifier>) {
      register(path.node.local.name, path as NodePath<t.Node>);
    },
    ImportNamespaceSpecifier(path: NodePath<t.ImportNamespaceSpecifier>) {
      register(path.node.local.name, path as NodePath<t.Node>);
    },
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (t.isIdentifier(path.node.id) && isGeneratedModuleTopLevelBindingPath(path)) {
        register(path.node.id.name, path as NodePath<t.Node>);
      }
    },
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (path.node.id && isGeneratedModuleTopLevelBindingPath(path)) {
        register(path.node.id.name, path as NodePath<t.Node>);
      }
    },
    ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
      if (path.node.id && isGeneratedModuleTopLevelBindingPath(path)) {
        register(path.node.id.name, path as NodePath<t.Node>);
      }
    },
  });

  return bindings;
}

function collectBindingDependencies(
  bindingInfo: TopLevelBindingInfo,
): Set<string> {
  if (
    bindingInfo.bindingPath.isImportSpecifier() ||
    bindingInfo.bindingPath.isImportDefaultSpecifier() ||
    bindingInfo.bindingPath.isImportNamespaceSpecifier()
  ) {
    return new Set();
  }

  const dependencies = new Set<string>();

  bindingInfo.bindingPath.traverse({
    Identifier(path: NodePath<t.Identifier>) {
      if (!path.isReferencedIdentifier()) {
        return;
      }

      const binding = path.scope.getBinding(path.node.name);

      if (!binding || !isGeneratedModuleTopLevelBindingPath(binding.path)) {
        return;
      }

      if (binding.path.node === bindingInfo.bindingPath.node) {
        return;
      }

      dependencies.add(binding.identifier.name);
    },
  });

  return dependencies;
}

function statementExportsBinding(
  statement: t.Node,
  localName: string,
  exportName: string,
) {
  if (localName !== exportName || !t.isExportNamedDeclaration(statement)) {
    return false;
  }

  if (statement.declaration) {
    if (t.isVariableDeclaration(statement.declaration)) {
      return statement.declaration.declarations.some(
        (declarator) => t.isIdentifier(declarator.id, { name: localName }),
      );
    }

    if (
      (t.isFunctionDeclaration(statement.declaration) ||
        t.isClassDeclaration(statement.declaration)) &&
      statement.declaration.id
    ) {
      return statement.declaration.id.name === localName;
    }

    return false;
  }

  return statement.specifiers.some(
    (specifier) =>
      t.isExportSpecifier(specifier) &&
      t.isIdentifier(specifier.local, { name: localName }) &&
      t.isIdentifier(specifier.exported, { name: exportName }),
  );
}

function generateServerModuleForFile(
  code: string,
  filePath: string,
  extractedModulePath: string,
  matches: readonly DiscoveredServerFn[],
) {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  const bindings = collectTopLevelBindings(ast);
  const requiredBindings = new Set<string>();
  const queue = [...new Set(matches.map((match) => match.localName))];

  while (queue.length > 0) {
    const localName = queue.pop();

    if (!localName || requiredBindings.has(localName)) {
      continue;
    }

    requiredBindings.add(localName);
    const bindingInfo = bindings.get(localName);

    if (!bindingInfo) {
      continue;
    }

    for (const dependency of collectBindingDependencies(bindingInfo)) {
      if (!requiredBindings.has(dependency)) {
        queue.push(dependency);
      }
    }
  }

  const keptStatements = new Set<t.Node>();

  for (const bindingName of requiredBindings) {
    const bindingInfo = bindings.get(bindingName);

    if (bindingInfo) {
      keptStatements.add(bindingInfo.statementPath.node);
    }
  }

  const magicString = new MagicString(code);
  traverse(ast, {
    CallExpression(callPath: NodePath<t.CallExpression>) {
      if (!t.isImport(callPath.node.callee)) {
        return;
      }

      const [sourceArgument] = callPath.node.arguments;

      if (!sourceArgument || sourceArgument.type === "SpreadElement" || !t.isStringLiteral(sourceArgument)) {
        return;
      }

      const importSource = sourceArgument.value;

      if (!importSource.startsWith(".")) {
        return;
      }

      const resolvedImportPath = normalizePath(
        path.resolve(path.dirname(filePath), importSource),
      );
      magicString.overwrite(
        sourceArgument.start ?? 0,
        sourceArgument.end ?? 0,
        JSON.stringify(toRelativeImportPath(extractedModulePath, resolvedImportPath)),
      );
    },
    ImportExpression(importExpressionPath: NodePath<t.ImportExpression>) {
      if (!t.isStringLiteral(importExpressionPath.node.source)) {
        return;
      }

      const importSource = importExpressionPath.node.source.value;

      if (!importSource.startsWith(".")) {
        return;
      }

      const resolvedImportPath = normalizePath(
        path.resolve(path.dirname(filePath), importSource),
      );
      magicString.overwrite(
        importExpressionPath.node.source.start ?? 0,
        importExpressionPath.node.source.end ?? 0,
        JSON.stringify(toRelativeImportPath(extractedModulePath, resolvedImportPath)),
      );
    },
  });

  for (const statement of [...ast.program.body].reverse()) {
    if (t.isImportDeclaration(statement)) {
      const keptSpecifiers = statement.specifiers.filter((specifier) =>
        requiredBindings.has(specifier.local.name),
      );

      if (keptSpecifiers.length === 0) {
        if (statement.start != null && statement.end != null) {
          magicString.remove(statement.start, statement.end);
        }
        continue;
      }

      if (keptSpecifiers.length !== statement.specifiers.length) {
        for (const specifier of statement.specifiers) {
          if (!requiredBindings.has(specifier.local.name)) {
            removeListNode(magicString, specifier, statement.specifiers);
          }
        }
      }

      const importSource = statement.source.value;

      if (typeof importSource === "string" && importSource.startsWith(".")) {
        const resolvedImportPath = normalizePath(
          path.resolve(path.dirname(filePath), importSource),
        );
        magicString.overwrite(
          statement.source.start ?? 0,
          statement.source.end ?? 0,
          JSON.stringify(toRelativeImportPath(extractedModulePath, resolvedImportPath)),
        );
      }

      continue;
    }

    if (!keptStatements.has(statement)) {
      if (statement.start != null && statement.end != null) {
        magicString.remove(statement.start, statement.end);
      }
      continue;
    }

    if (t.isExportNamedDeclaration(statement) && !statement.declaration) {
      if (statement.start != null && statement.end != null) {
        magicString.remove(statement.start, statement.end);
      }
    }
  }

  const exportLines = matches
    .filter((match) => {
      const bindingInfo = bindings.get(match.localName);
      return !bindingInfo || !statementExportsBinding(
        bindingInfo.statementPath.node,
        match.localName,
        match.exportName,
      );
    })
    .map((match) =>
      match.localName === match.exportName
        ? `export { ${match.localName} };`
        : `export { ${match.localName} as ${match.exportName} };`,
    );

  const output = magicString.toString().trim();

  if (exportLines.length === 0) {
    return `${output}\n`;
  }

  return `${output}\n\n${exportLines.join("\n")}\n`;
}

function generateServerFunctionsModule(
  entries: readonly DiscoveredServerFn[],
  resolveImportPath: (filePath: string) => string,
  procedureImportPath: string,
  procedureExportName: string,
  includeTypeAnnotations: boolean,
) {
  const sortedEntries = [...entries].sort((left, right) =>
    left.routeKey.localeCompare(right.routeKey),
  );

  const importLines = sortedEntries.map((entry, index) => {
    const importPath = resolveImportPath(entry.filePath);
    return `import { ${entry.exportName} as __serverFn${index} } from ${JSON.stringify(importPath)};`;
  });

  const records = sortedEntries.map(
    (entry, index) =>
      `  { id: ${JSON.stringify(entry.id)}, routeKey: ${JSON.stringify(
        entry.routeKey,
      )}, exportName: ${JSON.stringify(entry.exportName)}, relativePath: ${JSON.stringify(
        entry.relativePath,
      )}, procedureType: ${JSON.stringify(
        entry.procedureType,
      )}, reference: withServerFnMetadata(__serverFn${index}, { id: ${JSON.stringify(
        entry.id,
      )}, routeKey: ${JSON.stringify(entry.routeKey)}, exportName: ${JSON.stringify(
        entry.exportName,
      )}, relativePath: ${JSON.stringify(entry.relativePath)}, procedureType: ${JSON.stringify(
        entry.procedureType,
      )} }) },`,
  );

  return [
    `import { createTRPCProcedureRecord, withServerFnMetadata } from ${JSON.stringify(
      PACKAGE_NAME,
    )};`,
    ...(includeTypeAnnotations
      ? [`import type { ServerFnReferenceEntry } from ${JSON.stringify(PACKAGE_NAME)};`]
      : []),
    `import { ${procedureExportName} as __baseProcedure } from ${JSON.stringify(procedureImportPath)};`,
    ...importLines,
    "",
    `const __entries${includeTypeAnnotations ? ": ServerFnReferenceEntry[]" : ""} = [`,
    ...records,
    "];",
    "",
    "export function trpcServerFunctions() {",
    "  return createTRPCProcedureRecord(__baseProcedure, __entries);",
    "}",
    "",
    "export const serverFnManifest = __entries.map(({ id, routeKey, exportName, relativePath, procedureType }) => ({",
    "  id,",
    "  routeKey,",
    "  exportName,",
    "  relativePath,",
    "  procedureType,",
    "}));",
  ].join("\n");
}

function generateVirtualModule(
  entries: readonly DiscoveredServerFn[],
  options: TrpcServerFunctionsPluginOptions,
  root: string,
) {
  return generateServerFunctionsModule(
    entries,
    (filePath) => toProjectImportPath(root, filePath),
    options.procedure.importPath,
    options.procedure.exportName,
    false,
  );
}

async function discoverProjectEntries(
  root: string,
  filter: (id: string) => boolean,
  globs: DiscoveryGlobs,
) {
  const files = await fg(globs.include, {
    absolute: true,
    cwd: root,
    ignore: globs.ignore,
  });

  const entries = new Map<string, DiscoveredServerFn[]>();

  for (const filePath of files) {
    const normalizedFilePath = normalizePath(filePath);

    if (!filter(normalizedFilePath)) {
      continue;
    }

    const source = await fs.readFile(normalizedFilePath, "utf8");
    const matches = analyzeModule(source, normalizedFilePath, root);

    if (matches.length > 0) {
      entries.set(normalizedFilePath, matches);
    }
  }

  return entries;
}

async function writeGeneratedModule(
  generatedModulePath: string,
  code: string,
) {
  await fs.mkdir(path.dirname(generatedModulePath), { recursive: true });

  let existingCode: string | null = null;

  try {
    existingCode = await fs.readFile(generatedModulePath, "utf8");
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;

    if (fsError.code !== "ENOENT") {
      throw error;
    }
  }

  if (existingCode === code) {
    return false;
  }

  await fs.writeFile(generatedModulePath, code, "utf8");
  return true;
}

async function cleanStaleGeneratedServerModules(
  generatedModulePath: string,
  discoveredByFile: ReadonlyMap<string, readonly DiscoveredServerFn[]>,
  root: string,
) {
  // Safety guard: if nothing was discovered, skip cleanup to avoid wiping the
  // entire generated directory due to a misconfigured filter or cwd issue.
  if (discoveredByFile.size === 0) {
    return;
  }

  const generatedModulesRoot = getGeneratedServerModulesRoot(generatedModulePath);

  let existingFiles: string[];
  try {
    const allEntries = await fs.readdir(generatedModulesRoot, { recursive: true });
    const candidates = (allEntries as string[]).map((entry) =>
      normalizePath(path.join(generatedModulesRoot, entry)),
    );
    // Filter to only files (not directories) — use Promise.all, not .filter(async)
    const statResults = await Promise.all(
      candidates.map(async (filePath) => {
        try {
          const stat = await fs.stat(filePath);
          return stat.isFile() ? filePath : null;
        } catch {
          return null;
        }
      }),
    );
    existingFiles = statResults.filter((f): f is string => f !== null);
  } catch {
    return;
  }

  const expectedPaths = new Set<string>();
  for (const filePath of discoveredByFile.keys()) {
    expectedPaths.add(
      normalizePath(getGeneratedServerModulePath(generatedModulePath, filePath, root)),
    );
  }

  for (const filePath of existingFiles) {
    if (!expectedPaths.has(filePath)) {
      try {
        await fs.rm(filePath, { force: true });
      } catch {
        // Non-fatal
      }
    }
  }

  // Remove now-empty directories (bottom-up)
  try {
    const dirs = (await fs.readdir(generatedModulesRoot, { recursive: true }) as string[])
      .map((entry) => normalizePath(path.join(generatedModulesRoot, entry)))
      .sort((a, b) => b.length - a.length); // deepest first

    for (const dir of dirs) {
      try {
        await fs.rmdir(dir); // only succeeds if empty
      } catch {
        // Not empty or not a dir — skip
      }
    }
  } catch {
    // Non-fatal
  }
}

async function writeGeneratedServerModules(
  generatedModulePath: string,
  discoveredByFile: ReadonlyMap<string, readonly DiscoveredServerFn[]>,
  root: string,
) {
  const extractedModules = new Map<string, string>();

  for (const [filePath, matches] of discoveredByFile) {
    const extractedModulePath = getGeneratedServerModulePath(
      generatedModulePath,
      filePath,
      root,
    );
    const source = await fs.readFile(filePath, "utf8");
    const moduleCode = generateServerModuleForFile(
      source,
      filePath,
      extractedModulePath,
      matches,
    );

    await fs.mkdir(path.dirname(extractedModulePath), { recursive: true });
    await fs.writeFile(extractedModulePath, moduleCode, "utf8");
    extractedModules.set(filePath, extractedModulePath);
  }

  return extractedModules;
}

export async function generateServerFunctionsModuleFile(
  options: GenerateServerFunctionsModuleOptions,
) {
  const projectRoot = normalizePath(path.resolve(options.root ?? process.cwd()));
  const filter = createFilter(
    options.include ?? DEFAULT_INCLUDE,
    options.exclude ?? DEFAULT_EXCLUDE,
  );
  const globs = resolveDiscoveryGlobs(options.include, options.exclude);
  const discoveredByFile = await discoverProjectEntries(
    projectRoot,
    (id) => filter(id),
    globs,
  );
  const entries = [...discoveredByFile.values()].flat().sort((left, right) =>
    left.routeKey.localeCompare(right.routeKey),
  );
  const generatedModulePath = resolveFromRoot(projectRoot, options.generatedModulePath);
  const procedureImportPath = resolveFromRoot(projectRoot, options.procedure.importPath);
  await cleanStaleGeneratedServerModules(generatedModulePath, discoveredByFile, projectRoot);
  const extractedModules = await writeGeneratedServerModules(
    generatedModulePath,
    discoveredByFile,
    projectRoot,
  );
  const moduleCode = generateServerFunctionsModule(
    entries,
    (filePath) =>
      toRelativeImportPath(
        generatedModulePath,
        extractedModules.get(filePath) ?? filePath,
      ),
    toRelativeImportPath(generatedModulePath, procedureImportPath),
    options.procedure.exportName,
    true,
  );
  const changed = await writeGeneratedModule(generatedModulePath, moduleCode);

  return {
    changed,
    entries: entries.length,
    filePath: generatedModulePath,
  };
}

function invalidateVirtualModule(server: ViteDevServer) {
  const module = server.moduleGraph.getModuleById(
    RESOLVED_VIRTUAL_TRPC_SERVER_FUNCTIONS_MODULE,
  );

  if (module) {
    server.moduleGraph.invalidateModule(module);
  }

  return module;
}

export function trpcServerFunctionsPlugin(
  options: TrpcServerFunctionsPluginOptions,
): Plugin {
  const filter = createFilter(options.include ?? DEFAULT_INCLUDE, options.exclude ?? DEFAULT_EXCLUDE);
  const globs = resolveDiscoveryGlobs(options.include, options.exclude);
  const discoveredByFile = new Map<string, DiscoveredServerFn[]>();

  let projectRoot = normalizePath(process.cwd());
  let generatedModulePath = options.generatedModulePath
    ? resolveFromRoot(process.cwd(), options.generatedModulePath)
    : null;

  const syncGeneratedModule = async () => {
    if (!generatedModulePath) {
      return false;
    }

    const extractedModules = await writeGeneratedServerModules(
      generatedModulePath,
      discoveredByFile,
      projectRoot,
    );
    const moduleCode = generateServerFunctionsModule(
      collectEntries(),
      (filePath) =>
        toRelativeImportPath(
          generatedModulePath as string,
          extractedModules.get(filePath) ?? filePath,
        ),
      toRelativeImportPath(
        generatedModulePath,
        resolveFromRoot(projectRoot, options.procedure.importPath),
      ),
      options.procedure.exportName,
      true,
    );

    return writeGeneratedModule(generatedModulePath, moduleCode);
  };

  const refreshFile = async (filePath: string) => {
    const normalizedFilePath = normalizePath(filePath);

    if (!filter(normalizedFilePath)) {
      discoveredByFile.delete(normalizedFilePath);
      return;
    }

    const source = await fs.readFile(normalizedFilePath, "utf8");
    const matches = analyzeModule(source, normalizedFilePath, projectRoot);

    if (matches.length === 0) {
      discoveredByFile.delete(normalizedFilePath);
      return;
    }

    discoveredByFile.set(normalizedFilePath, matches);
  };

  const collectEntries = () =>
    [...discoveredByFile.values()].flat().sort((left, right) =>
      left.routeKey.localeCompare(right.routeKey),
    );

  return {
    name: "trpc-server-functions",
    enforce: "pre",
    configResolved(config) {
      projectRoot = normalizePath(config.root);
      generatedModulePath = options.generatedModulePath
        ? resolveFromRoot(projectRoot, options.generatedModulePath)
        : null;
    },
    async buildStart() {
      discoveredByFile.clear();
      const entries = await discoverProjectEntries(projectRoot, (id) => filter(id), globs);

      for (const [filePath, matches] of entries) {
        discoveredByFile.set(filePath, matches);
      }

      // Clean up stale generated files from previous runs before syncing.
      // This removes generated copies of source files that have been moved or deleted.
      if (generatedModulePath) {
        await cleanStaleGeneratedServerModules(generatedModulePath, discoveredByFile, projectRoot);
      }

      await syncGeneratedModule();
    },
    configureServer(server) {
      const syncFile = async (filePath: string) => {
        const normalizedFilePath = normalizePath(filePath);

        if (!filter(normalizedFilePath)) {
          return;
        }

        await refreshFile(normalizedFilePath);
        await syncGeneratedModule();
        invalidateVirtualModule(server);
      };

      server.watcher.on("add", async (filePath) => {
        await syncFile(filePath);
        server.ws.send({ type: "full-reload" });
      });

      server.watcher.on("change", async (filePath) => {
        await syncFile(filePath);
      });

      server.watcher.on("unlink", (filePath) => {
        const normalizedFilePath = normalizePath(filePath);
        discoveredByFile.delete(normalizedFilePath);

        // Delete the generated copy of the removed source file
        if (generatedModulePath) {
          const generatedFilePath = getGeneratedServerModulePath(
            generatedModulePath,
            normalizedFilePath,
            projectRoot,
          );
          void fs.rm(generatedFilePath, { force: true });
        }

        void syncGeneratedModule();
        invalidateVirtualModule(server);
        server.ws.send({ type: "full-reload" });
      });
    },
    resolveId(id) {
      if (id === VIRTUAL_TRPC_SERVER_FUNCTIONS_MODULE) {
        return RESOLVED_VIRTUAL_TRPC_SERVER_FUNCTIONS_MODULE;
      }

      return null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_TRPC_SERVER_FUNCTIONS_MODULE) {
        return null;
      }

      return generateVirtualModule(collectEntries(), options, projectRoot);
    },
    async transform(code, id, transformOptions) {
      const filePath = normalizePath(id.split("?", 1)[0] ?? id);

      if (
        !filter(filePath) ||
        !code.includes("createServerFn") ||
        (!code.includes(".query(") &&
          !code.includes(".mutation("))
      ) {
        return null;
      }

      const matches = analyzeModule(code, filePath, projectRoot);

      if (matches.length === 0) {
        return null;
      }

      discoveredByFile.set(filePath, matches);

      return injectMetadata(code, matches, transformOptions?.ssr === true);
    },
    async handleHotUpdate(context) {
      const filePath = normalizePath(context.file);

      if (!filter(filePath)) {
        return;
      }

      const source = await context.read();
      const matches = analyzeModule(source, filePath, projectRoot);

      if (matches.length > 0) {
        discoveredByFile.set(filePath, matches);
      } else {
        discoveredByFile.delete(filePath);
      }

      await syncGeneratedModule();

      const virtualModule = invalidateVirtualModule(context.server);

      if (!virtualModule) {
        return;
      }

      return [virtualModule];
    },
  };
}
