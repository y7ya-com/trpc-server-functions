import {
  isStandardSchema,
  resolveInputParser,
} from "./standard-schema.js";
import type {
  CreateServerFnOptions,
  InternalServerFnDefinition,
  InternalServerFnMeta,
  MutationServerFn,
  QueryServerFn,
  ServerFn,
  ServerFnCallOptions,
  ServerFnHandler,
  ServerFnProcedureType,
  ServerFnTransport,
} from "./types.js";

const SERVER_FUNCTION_SYMBOL = Symbol.for("trpc-server-functions.definition");

let defaultTransport: ServerFnTransport | null = null;

function resolveTransport(options?: ServerFnCallOptions): ServerFnTransport {
  const transport = options?.transport ?? defaultTransport;

  if (transport) {
    return transport;
  }

  throw new Error(
    "No server function transport is configured. Call setServerFnTransport(...) or pass a transport explicitly.",
  );
}

function describeLocation(meta: InternalServerFnMeta) {
  if (meta.exportName && meta.relativePath) {
    return `${meta.exportName} (${meta.relativePath})`;
  }
  return meta.exportName || meta.relativePath || "<anonymous server function>";
}

function assertTransformed(meta: InternalServerFnMeta) {
  if (meta.routeKey) {
    return;
  }

  throw new Error(
    `${describeLocation(meta)} is missing generated metadata. ` +
      `Ensure the Vite plugin transformed this module before using it, or re-run the codegen CLI.`,
  );
}

export function setServerFnTransport(transport: ServerFnTransport) {
  defaultTransport = transport;
}

export function clearServerFnTransport() {
  defaultTransport = null;
}

export function createTRPCClientTransport(client: {
  query(path: string, input: unknown): Promise<unknown>;
  mutation(path: string, input: unknown): Promise<unknown>;
}): ServerFnTransport {
  return {
    async query<TInput, TOutput>(path: string, input: TInput) {
      return (await client.query(path, input)) as TOutput;
    },
    async mutation<TInput, TOutput>(path: string, input: TInput) {
      return (await client.mutation(path, input)) as TOutput;
    },
  };
}

class ServerFnBuilder<TInput, TContext> {
  constructor(private readonly options: CreateServerFnOptions<TInput>) {}

  private compile<TOutput>(
    procedureType: ServerFnProcedureType,
    handler: ServerFnHandler<TInput, TOutput, TContext> | undefined,
    meta?: InternalServerFnMeta,
  ): ServerFn<TInput, TOutput, TContext> {
    const resolvedMeta: InternalServerFnMeta = meta ?? {
      id: "",
      routeKey: "",
      exportName: "",
      relativePath: "",
      procedureType,
    };

    const builderOptions = this.options;
    const parseInputIfConfigured = resolveInputParser<TInput>(builderOptions.input);

    const callWithTransport = async (input: TInput, options?: ServerFnCallOptions) => {
      // Server-side fast path: when the original handler is attached (i.e.
      // the module was loaded in the server bundle, not stripped by the
      // client transform), invoke it directly instead of going through the
      // transport. This lets a server-fn handler call another server fn
      // locally — e.g. a route-level wrapper that delegates to a shared
      // util — without requiring a transport to be configured.
      //
      // On the client build the handler was overwritten to `undefined` by
      // the plugin, so this branch never fires there and behavior is
      // unchanged (go through the configured transport).
      if (handler) {
        // Mirror tRPC's `procedure.input(validator)` step so direct calls
        // see the same parsed/validated input the transport path does.
        // If no parser was supplied, pass through unchanged.
        const validatedInput = parseInputIfConfigured
          ? ((await parseInputIfConfigured(input)) as TInput)
          : input;
        return handler({ input: validatedInput, ctx: undefined as TContext });
      }
      assertTransformed(resolvedMeta);
      const transport = resolveTransport(options);
      return resolvedMeta.procedureType === "mutation"
        ? transport.mutation<TInput, TOutput>(resolvedMeta.routeKey, input)
        : transport.query<TInput, TOutput>(resolvedMeta.routeKey, input);
    };

    if (procedureType === "mutation") {
      const compiled = {
        id: resolvedMeta.id,
        routeKey: resolvedMeta.routeKey,
        procedureType: "mutation",
        inputSchema: this.options.input,
        userMeta: this.options.meta,
        call(input: TInput, options?: ServerFnCallOptions) {
          return callWithTransport(input, options);
        },
        mutationOptions(options?: ServerFnCallOptions) {
          assertTransformed(resolvedMeta);
          return {
            mutationKey: ["serverFn", resolvedMeta.routeKey] as const,
            mutationFn: (input: TInput) => callWithTransport(input, options),
            meta: {
              path: resolvedMeta.routeKey,
            },
          };
        },
        [SERVER_FUNCTION_SYMBOL]: {
          options: this.options,
          meta: resolvedMeta,
          handler,
        } satisfies InternalServerFnDefinition<TInput, TOutput, TContext>,
      } satisfies MutationServerFn<TInput, TOutput> & {
        [SERVER_FUNCTION_SYMBOL]: InternalServerFnDefinition<TInput, TOutput, TContext>;
      };

      return compiled;
    }

    const compiled = {
      id: resolvedMeta.id,
      routeKey: resolvedMeta.routeKey,
      procedureType: "query",
      inputSchema: this.options.input,
      userMeta: this.options.meta,
      call(input: TInput, options?: ServerFnCallOptions) {
        return callWithTransport(input, options);
      },
      queryOptions(input: TInput, options?: ServerFnCallOptions) {
        assertTransformed(resolvedMeta);
        return {
          queryKey: ["serverFn", resolvedMeta.routeKey, input] as const,
          queryFn: () => callWithTransport(input, options),
          meta: {
            path: resolvedMeta.routeKey,
            input,
          },
        };
      },
      [SERVER_FUNCTION_SYMBOL]: {
        options: this.options,
        meta: resolvedMeta,
        handler,
      } satisfies InternalServerFnDefinition<TInput, TOutput, TContext>,
    } satisfies QueryServerFn<TInput, TOutput> & {
      [SERVER_FUNCTION_SYMBOL]: InternalServerFnDefinition<TInput, TOutput, TContext>;
    };

    return compiled;
  }

  query<TOutput>(
    handler: ServerFnHandler<TInput, TOutput, TContext>,
  ): QueryServerFn<TInput, TOutput>;
  query<TOutput>(
    handler: ServerFnHandler<TInput, TOutput, TContext> | undefined,
    meta?: InternalServerFnMeta,
  ): QueryServerFn<TInput, TOutput>;
  query<TOutput>(
    handler: ServerFnHandler<TInput, TOutput, TContext> | undefined,
    meta?: InternalServerFnMeta,
  ): QueryServerFn<TInput, TOutput> {
    return this.compile("query", handler, meta) as QueryServerFn<TInput, TOutput>;
  }

  mutation<TOutput>(
    handler: ServerFnHandler<TInput, TOutput, TContext>,
  ): MutationServerFn<TInput, TOutput>;
  mutation<TOutput>(
    handler: ServerFnHandler<TInput, TOutput, TContext> | undefined,
    meta?: InternalServerFnMeta,
  ): MutationServerFn<TInput, TOutput>;
  mutation<TOutput>(
    handler: ServerFnHandler<TInput, TOutput, TContext> | undefined,
    meta?: InternalServerFnMeta,
  ): MutationServerFn<TInput, TOutput> {
    return this.compile("mutation", handler, meta) as MutationServerFn<TInput, TOutput>;
  }
}

export function createServerFn<TInput = void, TContext = unknown>(
  options: CreateServerFnOptions<TInput> = {},
) {
  // Surface a clear error when someone passes a value that looks like a
  // parser but isn't — catches `{ input: someSchema }` where `someSchema`
  // is misconfigured (e.g. a Zod *instance* without `.parse`, or a Valibot
  // pipe returned incorrectly).
  if (
    options.input != null &&
    !isStandardSchema(options.input) &&
    typeof options.input !== "function"
  ) {
    throw new Error(
      "createServerFn({ input }) must be a Standard Schema validator or a (value) => parsed function.",
    );
  }

  return new ServerFnBuilder<TInput, TContext>(options);
}

export function getInternalServerFnDefinition<TInput, TOutput, TContext = unknown>(
  value: unknown,
) {
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function") ||
    !(SERVER_FUNCTION_SYMBOL in value)
  ) {
    return null;
  }

  return (value as {
    [SERVER_FUNCTION_SYMBOL]: InternalServerFnDefinition<TInput, TOutput, TContext>;
  })[SERVER_FUNCTION_SYMBOL];
}

export function withServerFnMetadata<TInput, TOutput, TContext = unknown>(
  reference: ServerFn<TInput, TOutput, TContext>,
  meta: InternalServerFnMeta,
) {
  const definition = getInternalServerFnDefinition<TInput, TOutput, TContext>(reference);

  if (!definition) {
    throw new Error(
      `Expected ${describeLocation(meta)} to be a compiled server function reference ` +
        `when attaching generated metadata. Did the caller pass the export produced by createServerFn(...)?`,
    );
  }

  Object.defineProperty(reference, SERVER_FUNCTION_SYMBOL, {
    value: {
      ...definition,
      meta,
    } satisfies InternalServerFnDefinition<TInput, TOutput, TContext>,
    configurable: true,
  });

  return reference;
}
