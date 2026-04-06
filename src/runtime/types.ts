import type { AnyProcedure, TRPCRouterRecord } from "@trpc/server";

export type MaybePromise<T> = T | Promise<T>;

export interface CreateServerFnOptions<TInput> {
  input?: unknown;
  meta?: Record<string, unknown>;
}

export type ServerFnProcedureType = "query" | "mutation";

export interface InternalServerFnMeta {
  id: string;
  routeKey: string;
  exportName: string;
  relativePath: string;
  procedureType: ServerFnProcedureType;
}

export interface ServerFnCallOptions {
  transport?: ServerFnTransport;
}

export interface ServerFnTransport {
  query<TInput, TOutput>(path: string, input: TInput): Promise<TOutput>;
  mutation<TInput, TOutput>(path: string, input: TInput): Promise<TOutput>;
}

export interface ServerFnHandlerArgs<TInput, TContext> {
  ctx: TContext;
  input: TInput;
}

export type ServerFnHandler<TInput, TOutput, TContext = unknown> = (
  args: ServerFnHandlerArgs<TInput, TContext>,
) => MaybePromise<TOutput>;

export interface ServerFnQueryOptions<TInput, TOutput> {
  queryKey: readonly ["serverFn", string, TInput];
  queryFn: () => Promise<TOutput>;
  meta: {
    path: string;
    input: TInput;
  };
}

export interface ServerFnMutationOptions<TInput, TOutput> {
  mutationKey: readonly ["serverFn", string];
  mutationFn: (input: TInput) => Promise<TOutput>;
  meta: {
    path: string;
  };
}

interface BaseServerFn<TInput, TOutput> {
  readonly id: string;
  readonly routeKey: string;
  readonly procedureType: ServerFnProcedureType;
  readonly inputSchema: unknown;
  readonly userMeta: Record<string, unknown> | undefined;
  call(input: TInput, options?: ServerFnCallOptions): Promise<TOutput>;
}

export interface QueryServerFn<TInput, TOutput> extends BaseServerFn<TInput, TOutput> {
  readonly procedureType: "query";
  queryOptions(
    input: TInput,
    options?: ServerFnCallOptions,
  ): ServerFnQueryOptions<TInput, TOutput>;
}

export interface MutationServerFn<TInput, TOutput>
  extends BaseServerFn<TInput, TOutput> {
  readonly procedureType: "mutation";
  mutationOptions(options?: ServerFnCallOptions): ServerFnMutationOptions<TInput, TOutput>;
}

export type ServerFn<TInput, TOutput, TContext = unknown> =
  | QueryServerFn<TInput, TOutput>
  | MutationServerFn<TInput, TOutput>;

export interface InternalServerFnDefinition<TInput, TOutput, TContext = unknown> {
  options: CreateServerFnOptions<TInput>;
  meta: InternalServerFnMeta;
  handler?: ServerFnHandler<TInput, TOutput, TContext>;
}

export interface ServerFnManifestEntry {
  id: string;
  routeKey: string;
  exportName: string;
  relativePath: string;
  procedureType: ServerFnProcedureType;
}

export interface ServerFnReferenceEntry extends ServerFnManifestEntry {
  reference: ServerFn<any, any>;
}

export interface ProcedureBuilderLike {
  input?: (schema: any) => ProcedureBuilderLike;
  query: (resolver: (args: { ctx: any; input: any }) => unknown) => AnyProcedure;
  mutation: (resolver: (args: { ctx: any; input: any }) => unknown) => AnyProcedure;
}

export type TRPCProcedureRecord = TRPCRouterRecord;
