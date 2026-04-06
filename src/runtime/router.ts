import { getInternalServerFnDefinition } from "./createServerFn.js";
import type { ProcedureBuilderLike, ServerFnReferenceEntry } from "./types.js";

export function createTRPCProcedureRecord(
  baseProcedure: ProcedureBuilderLike,
  entries: readonly ServerFnReferenceEntry[],
) {
  const record: Record<string, unknown> = {};

  for (const entry of entries) {
    const definition = getInternalServerFnDefinition(entry.reference);

    if (!definition) {
      throw new Error(
        `Expected ${entry.exportName} in ${entry.relativePath} to be a compiled server function.`,
      );
    }

    if (!definition.handler) {
      throw new Error(
        `Server handler for ${entry.exportName} in ${entry.relativePath} was stripped from the current build.`,
      );
    }

    let procedure = baseProcedure;

    if (definition.options.input && typeof procedure.input === "function") {
      procedure = procedure.input(definition.options.input);
    }

    if (definition.meta.procedureType === "mutation") {
      record[definition.meta.routeKey] = procedure.mutation(({ ctx, input }) =>
        definition.handler?.({
          ctx,
          input: input as never,
        }),
      );
      continue;
    }

    record[definition.meta.routeKey] = procedure.query(({ ctx, input }) =>
      definition.handler?.({
        ctx,
        input: input as never,
      }),
    );
  }

  return record;
}
