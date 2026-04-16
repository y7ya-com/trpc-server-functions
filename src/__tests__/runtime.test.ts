import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
  clearServerFnTransport,
  createServerFn,
  createTRPCClientTransport,
  createTRPCProcedureRecord,
  getInternalServerFnDefinition,
  isStandardSchema,
  resolveInputParser,
  setServerFnTransport,
  StandardSchemaValidationError,
  withServerFnMetadata,
  type ServerFnReferenceEntry,
  type StandardSchemaV1,
} from "../runtime/index.js";

function makeStandardSchema<T>(
  validate: (value: unknown) => T,
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        try {
          return { value: validate(value) };
        } catch (error) {
          return {
            issues: [{ message: error instanceof Error ? error.message : "invalid" }],
          };
        }
      },
    },
  };
}

describe("resolveInputParser", () => {
  it("returns null when no parser is supplied", () => {
    assert.equal(resolveInputParser(undefined), null);
    assert.equal(resolveInputParser(null), null);
  });

  it("wraps Standard Schema validators", async () => {
    const schema = makeStandardSchema((value) => {
      if (typeof value !== "number") throw new Error("not a number");
      return value * 2;
    });

    const parser = resolveInputParser<number>(schema);
    assert.ok(parser);
    assert.equal(await parser!(3), 6);
  });

  it("throws a StandardSchemaValidationError on failure", async () => {
    const schema = makeStandardSchema(() => {
      throw new Error("bad input");
    });
    const parser = resolveInputParser(schema);
    assert.ok(parser);

    await assert.rejects(Promise.resolve(parser!("x")), (error: unknown) => {
      assert.ok(error instanceof StandardSchemaValidationError);
      assert.match((error as Error).message, /bad input/);
      return true;
    });
  });

  it("passes plain functions through unchanged", async () => {
    const parser = resolveInputParser<string>((value: unknown) => String(value));
    assert.equal(await parser!(42), "42");
  });

  it("returns null for unusable shapes", () => {
    assert.equal(resolveInputParser({ whatever: true }), null);
  });
});

describe("isStandardSchema", () => {
  it("detects Standard Schema objects", () => {
    assert.equal(isStandardSchema(makeStandardSchema(() => undefined)), true);
  });

  it("rejects plain objects", () => {
    assert.equal(isStandardSchema({ validate: () => undefined }), false);
    assert.equal(isStandardSchema(null), false);
    assert.equal(isStandardSchema(undefined), false);
  });
});

describe("createServerFn", () => {
  afterEach(() => {
    clearServerFnTransport();
  });

  it("throws when input is not a Standard Schema or function", () => {
    assert.throws(
      () => createServerFn({ input: { notASchema: true } as never }),
      /Standard Schema validator or a .*function/,
    );
  });

  it("invokes the handler directly on the server-side fast path with no parser", async () => {
    const fn = createServerFn<{ name: string }>().query(async ({ input }) => `hi ${input.name}`);
    assert.equal(await fn.call({ name: "Ada" }), "hi Ada");
  });

  it("validates input through the Standard Schema parser before calling the handler", async () => {
    const schema = makeStandardSchema((value) => {
      if (typeof value !== "number") throw new Error("not a number");
      return value + 1;
    });

    const fn = createServerFn<number>({ input: schema }).query(async ({ input }) => input);

    assert.equal(await fn.call(10), 11);
    await assert.rejects(fn.call("not a number" as never), /not a number/);
  });

  it("throws a clear error from assertTransformed when metadata is missing", async () => {
    // Simulate a client-side reference that was never transformed: handler is
    // stripped to `undefined` and the routeKey is empty, so both the handler
    // fast path and the transport fast path are disabled. Only path that can
    // fire is the `assertTransformed` guard — we want that message to name
    // the file/export so the developer can trace it.
    const reference = createServerFn<number>().query(undefined);
    await assert.rejects(reference.call(0), /missing generated metadata/);
  });

  it("falls back to the configured transport when the handler is absent", async () => {
    const reference = createServerFn<{ id: number }, unknown>().query(
      undefined,
      {
        id: "virtual:a.ts:pong",
        routeKey: "sf_pong",
        exportName: "pong",
        relativePath: "a.ts",
        procedureType: "query",
      },
    );

    const calls: Array<{ path: string; input: unknown }> = [];
    setServerFnTransport({
      async query<_TInput, TOutput>(path: string, input: unknown) {
        calls.push({ path, input });
        return { ok: true } as TOutput;
      },
      async mutation() {
        throw new Error("unreachable");
      },
    });

    const result = await reference.call({ id: 7 });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [{ path: "sf_pong", input: { id: 7 } }]);
  });

  it("surfaces internal definition via getInternalServerFnDefinition", () => {
    const reference = createServerFn<number>().query(async ({ input }) => input);
    const definition = getInternalServerFnDefinition(reference);
    assert.ok(definition);
    assert.ok(definition!.handler);
  });
});

describe("createTRPCClientTransport", () => {
  it("forwards query/mutation to the underlying client", async () => {
    const transport = createTRPCClientTransport({
      query: async (p, i) => ({ q: [p, i] }),
      mutation: async (p, i) => ({ m: [p, i] }),
    });

    assert.deepEqual(await transport.query("sf_a", 1), { q: ["sf_a", 1] });
    assert.deepEqual(await transport.mutation("sf_b", 2), { m: ["sf_b", 2] });
  });
});

describe("createTRPCProcedureRecord", () => {
  /**
   * Fake procedure builder that records the chain of calls. This is how we
   * verify that the router always installs an `.input(...)` parser — even
   * when the user never declared one — so tRPC v11 doesn't silently drop
   * the raw input on the way to the handler.
   */
  function fakeProcedureBuilder() {
    const state: {
      inputParsers: unknown[];
      kind: "query" | "mutation" | null;
      resolver: ((args: { ctx: unknown; input: unknown }) => unknown) | null;
    } = { inputParsers: [], kind: null, resolver: null };

    const builder: any = {
      input(parser: unknown) {
        state.inputParsers.push(parser);
        return builder;
      },
      query(resolver: any) {
        state.kind = "query";
        state.resolver = resolver;
        return {} as any;
      },
      mutation(resolver: any) {
        state.kind = "mutation";
        state.resolver = resolver;
        return {} as any;
      },
    };

    return { builder, state };
  }

  const meta = {
    id: "src/a.ts:foo",
    routeKey: "sf_abc123",
    exportName: "foo",
    relativePath: "src/a.ts",
    procedureType: "query" as const,
  };

  it("installs a passthrough parser when the server fn has no input declared", async () => {
    const reference = withServerFnMetadata(
      createServerFn<{ raw: number }>().query(async ({ input }) => input),
      meta,
    );
    const { builder, state } = fakeProcedureBuilder();

    createTRPCProcedureRecord(builder, [
      {
        ...meta,
        reference,
      } satisfies ServerFnReferenceEntry,
    ]);

    assert.equal(state.inputParsers.length, 1);
    assert.equal(typeof state.inputParsers[0], "function");

    // The installed parser must pass the raw value through unchanged — this
    // is what lets a route-level wrapper forward input to an inner server fn
    // even when neither fn declares its own parser.
    const parser = state.inputParsers[0] as (value: unknown) => unknown;
    const raw = { raw: 42 };
    assert.equal(parser(raw), raw);

    // And the resolver must receive the input the parser returned.
    const result = await state.resolver!({ ctx: null, input: raw });
    assert.deepEqual(result, raw);
  });

  it("passes through the user-supplied parser when one is declared", () => {
    const userParser = (value: unknown) => value as { x: number };
    const reference = withServerFnMetadata(
      createServerFn<{ x: number }>({ input: userParser }).query(
        async ({ input }) => input,
      ),
      meta,
    );
    const { builder, state } = fakeProcedureBuilder();

    createTRPCProcedureRecord(builder, [
      { ...meta, reference } satisfies ServerFnReferenceEntry,
    ]);

    assert.equal(state.inputParsers[0], userParser);
  });

  it("passes through Standard Schema validators unchanged", () => {
    const schema = makeStandardSchema((v) => v as number);
    const reference = withServerFnMetadata(
      createServerFn<number>({ input: schema }).query(async ({ input }) => input),
      meta,
    );
    const { builder, state } = fakeProcedureBuilder();

    createTRPCProcedureRecord(builder, [
      { ...meta, reference } satisfies ServerFnReferenceEntry,
    ]);

    assert.equal(state.inputParsers[0], schema);
  });

  it("throws a descriptive error for a stripped handler", () => {
    const stripped = withServerFnMetadata(
      createServerFn<number>().query(undefined),
      meta,
    );
    const { builder } = fakeProcedureBuilder();

    assert.throws(
      () => createTRPCProcedureRecord(builder, [{ ...meta, reference: stripped }]),
      /was stripped from the current build/,
    );
  });
});
