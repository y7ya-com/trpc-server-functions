#!/usr/bin/env node

import { generateServerFunctionsModuleFile } from "./plugin.js";

interface ParsedArgs {
  command: string | null;
  values: Map<string, string[]>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = null, ...rest] = argv;
  const values = new Map<string, string[]>();

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];

    if (!argument?.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = argument.slice(2).split("=", 2);
    const key = rawKey.trim();

    if (!key) {
      continue;
    }

    const nextValue =
      inlineValue ??
      (rest[index + 1]?.startsWith("--") ? undefined : rest[index + 1]);

    if (inlineValue == null && nextValue != null) {
      index += 1;
    }

    if (nextValue == null) {
      continue;
    }

    const existing = values.get(key) ?? [];
    existing.push(nextValue);
    values.set(key, existing);
  }

  return { command, values };
}

function getSingleValue(
  values: ReadonlyMap<string, string[]>,
  key: string,
  fallback?: string,
) {
  const value = values.get(key)?.at(-1);
  return value ?? fallback;
}

function printUsage() {
  console.error(
    [
      "Usage:",
      "  trpc-server-functions generate \\",
      "    --generated-module-path <path> \\",
      "    --procedure-import-path <path> \\",
      "    --procedure-export-name <name> \\",
      "    [--root <path>] [--include <glob>] [--exclude <glob>]",
    ].join("\n"),
  );
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command !== "generate") {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const generatedModulePath = getSingleValue(parsed.values, "generated-module-path");
  const procedureImportPath = getSingleValue(parsed.values, "procedure-import-path");
  const procedureExportName = getSingleValue(parsed.values, "procedure-export-name");

  if (!generatedModulePath || !procedureImportPath || !procedureExportName) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const result = await generateServerFunctionsModuleFile({
    root: getSingleValue(parsed.values, "root"),
    include: parsed.values.get("include"),
    exclude: parsed.values.get("exclude"),
    generatedModulePath,
    procedure: {
      importPath: procedureImportPath,
      exportName: procedureExportName,
    },
  });

  console.log(
    `${result.changed ? "updated" : "unchanged"} ${result.filePath} (${result.entries} entries)`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
