import { getInternalServerFnDefinition } from "./createServerFn.js";
import { isStandardSchema } from "./standard-schema.js";
import type {
  ProcedureBuilderLike,
  ServerFnReferenceEntry,
  TRPCProcedureRecord,
} from "./types.js";

/**
 * Passthrough parser used when a server function doesn't declare one.
 *
 * In tRPC v11, if you never call `procedure.input(...)`, the resolver
 * receives `undefined` as `input` — the raw request body is silently
 * dropped. That surprises route-level wrappers that delegate to inner
 * server fns (the wrapper has no parser, but the inner fn does). Installing
 * a passthrough parser unconditionally makes the behaviour predictable:
 * the inner fn — or the wrapper's own runtime checks — always see the raw
 * input and can validate themselves.
 */
const passthroughParser = (value: unknown) => value;

export function createTRPCProcedureRecord(
  baseProcedure: ProcedureBuilderLike,
  entries: readonly ServerFnReferenceEntry[],
): TRPCProcedureRecord {
  const record: TRPCProcedureRecord = {};

  for (const entry of entries) {
    const definition = getInternalServerFnDefinition(entry.reference);

    if (!definition) {
      throw new Error(
        `Expected ${entry.exportName} in ${entry.relativePath} to be a compiled server function. ` +
          `Did the Vite plugin run on this file?`,
      );
    }

    if (!definition.handler) {
      throw new Error(
        `Server handler for ${entry.exportName} in ${entry.relativePath} was stripped from the current build. ` +
          `The generated router must be imported only from the server bundle.`,
      );
    }

    let procedure = baseProcedure;

    if (typeof procedure.input === "function") {
      const userParser = definition.options.input;
      const parserForTrpc = userParser != null && (isStandardSchema(userParser) || typeof userParser === "function")
        ? userParser
        : passthroughParser;
      procedure = procedure.input(parserForTrpc);
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
