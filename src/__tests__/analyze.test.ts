import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { __internal } from "../plugin.js";

const { analyzeModule, injectMetadata } = __internal;

function analyze(code: string, filePath = "/project/src/a.ts") {
  return analyzeModule(code, filePath, "/project");
}

describe("analyzeModule — export detection", () => {
  it("discovers a direct export const with createServerFn().query(...)", () => {
    const { discovered, allMatches } = analyze(`
      import { createServerFn } from "trpc-server-functions";
      export const foo = createServerFn().query(async () => 1);
    `);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]!.exportName, "foo");
    assert.equal(discovered[0]!.procedureType, "query");
    assert.equal(allMatches.length, 1);
  });

  it("discovers mutations", () => {
    const { discovered } = analyze(`
      import { createServerFn } from "trpc-server-functions";
      export const save = createServerFn().mutation(async () => 1);
    `);
    assert.equal(discovered[0]!.procedureType, "mutation");
  });

  it("discovers via renamed import (createServerFn as foo)", () => {
    const { discovered, allMatches } = analyze(`
      import { createServerFn as c } from "trpc-server-functions";
      export const thing = c<{ x: number }>().query(async () => 1);
    `);
    assert.equal(discovered.length, 1);
    assert.equal(allMatches.length, 1);
  });

  it("discovers via a non-generic local alias (createServerFn reassignment)", () => {
    // Regression: previously the alias scan only matched TSInstantiationExpression
    // (i.e. `const make = createServerFn<Foo>`). A plain reassignment was
    // invisible, leaking server code into the client bundle.
    const { discovered, allMatches } = analyze(`
      import { createServerFn } from "trpc-server-functions";
      const make = createServerFn;
      export const thing = make().query(async () => 1);
    `);
    assert.equal(discovered.length, 1);
    assert.equal(allMatches.length, 1);
  });

  it("discovers via a generic-instantiated alias", () => {
    const { discovered } = analyze(`
      import { createServerFn } from "trpc-server-functions";
      const make = createServerFn<{ x: number }>;
      export const thing = make().query(async () => 1);
    `);
    assert.equal(discovered.length, 1);
  });

  it("catches nested matches for client-side handler stripping", () => {
    // Wrapper class methods like `apps/app/src/lib/server-fn.ts` produce
    // nested createServerFn().query(handler) call sites that aren't bound to
    // any export. They still need handler-stripping on the client, otherwise
    // the wrapper closure's import chain pulls server modules into the
    // browser bundle. Nested calls must show up in allMatches.
    const { allMatches, discovered } = analyze(`
      import { createServerFn } from "trpc-server-functions";
      class Builder {
        make() {
          return createServerFn().query(async () => 1);
        }
      }
      export const exposed = new Builder();
    `);
    assert.equal(allMatches.length, 1);
    assert.equal(discovered.length, 0);
  });

  it("ignores unrelated .query() call sites that aren't built on createServerFn", () => {
    const { allMatches, discovered } = analyze(`
      import { db } from "./db";
      export const rows = db.query("SELECT 1");
    `);
    assert.equal(allMatches.length, 0);
    assert.equal(discovered.length, 0);
  });
});

describe("injectMetadata — SSR vs client", () => {
  const code = `
import { createServerFn } from "trpc-server-functions";
export const foo = createServerFn().query(async () => 1);
`;

  it("injects metadata on the SSR build without stripping the handler", () => {
    const { discovered, allMatches, ast } = analyze(code);
    const result = injectMetadata(code, ast, discovered, allMatches, true);
    assert.ok(result);
    assert.match(result!.code, /routeKey: "sf_[a-f0-9]{24}"/);
    // Handler should still be present — server needs to execute it.
    assert.match(result!.code, /async \(\) => 1/);
  });

  it("strips the handler on the client build", () => {
    const { discovered, allMatches, ast } = analyze(code);
    const result = injectMetadata(code, ast, discovered, allMatches, false);
    assert.ok(result);
    // The handler has been replaced with `undefined` and the metadata
    // object appended as the second argument.
    assert.match(result!.code, /\.query\(undefined,\s*\{/);
    assert.doesNotMatch(result!.code, /async \(\) => 1/);
  });

  it("strips imports that are only referenced inside handlers on the client build", () => {
    const src = `
import { createServerFn } from "trpc-server-functions";
import { serverOnly } from "./server-only";
export const foo = createServerFn().query(async () => serverOnly());
`;
    const { discovered, allMatches, ast } = analyze(src);
    const clientResult = injectMetadata(src, ast, discovered, allMatches, false);
    assert.ok(clientResult);
    // The server-only import should be pruned from the client-side output,
    // otherwise the client bundle drags server-only code in via its import
    // chain.
    assert.doesNotMatch(clientResult!.code, /server-only/);
    // But createServerFn must stay — it's used at module scope to build the
    // exported reference.
    assert.match(clientResult!.code, /createServerFn/);
  });

  it("keeps imports referenced outside handlers on the client build", () => {
    const src = `
import { createServerFn } from "trpc-server-functions";
import { sharedUtil } from "./shared";
console.log(sharedUtil);
export const foo = createServerFn().query(async () => sharedUtil());
`;
    const { discovered, allMatches, ast } = analyze(src);
    const clientResult = injectMetadata(src, ast, discovered, allMatches, false);
    assert.ok(clientResult);
    assert.match(clientResult!.code, /sharedUtil/);
  });

  it("returns null when there is nothing to transform", () => {
    const empty = `export const x = 1;`;
    const analysis = analyze(empty);
    const result = injectMetadata(empty, analysis.ast, analysis.discovered, analysis.allMatches, false);
    assert.equal(result, null);
  });

  it("is idempotent: pre-injected metadata is not re-injected", () => {
    const src = `
import { createServerFn } from "trpc-server-functions";
export const foo = createServerFn().query(async () => 1, { id: "x", routeKey: "sf_y", exportName: "foo", relativePath: "a.ts", procedureType: "query" });
`;
    const analysis = analyze(src);
    // hasInjectedMeta should be true so injectMetadata on SSR returns null
    // (nothing else to change).
    const result = injectMetadata(src, analysis.ast, analysis.discovered, analysis.allMatches, true);
    assert.equal(result, null);
  });
});
