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

function assertTransformed(meta: InternalServerFnMeta) {
  if (meta.routeKey) {
    return;
  }

  throw new Error(
    "This server function is missing generated metadata. Ensure the Vite plugin transformed the module before using it.",
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

    const callWithTransport = (input: TInput, options?: ServerFnCallOptions) => {
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
  return new ServerFnBuilder<TInput, TContext>(options);
}

export function getInternalServerFnDefinition<TInput, TOutput, TContext = unknown>(
  value: unknown,
) {
  if (!value || typeof value !== "object" || !(SERVER_FUNCTION_SYMBOL in value)) {
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
    throw new Error("Expected a server function reference while attaching generated metadata.");
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
