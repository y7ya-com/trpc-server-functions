import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { __internal } from "../plugin.js";

const { createDiscoveryContext } = __internal;

describe("createDiscoveryContext", () => {
  it("falls back to the default include glob when only regex patterns are given", () => {
    const ctx = createDiscoveryContext([/foo/], undefined);
    assert.ok(ctx.globInclude.length > 0);
    assert.match(ctx.globInclude[0]!, /\*/);
  });

  it("applies regex excludes via the filter even when fast-glob can't", () => {
    // fast-glob ignores regex patterns, but our filter still runs over every
    // discovered file. This is the regression fixture for the 'regex
    // exclude silently ignored' bug: before the fix, a regex exclude was
    // dropped from both fast-glob AND the filter path (because the filter
    // was reconstructed without it). Now both agree.
    const ctx = createDiscoveryContext(undefined, [/\.generated\.ts$/]);
    assert.equal(ctx.filter("/project/src/foo.generated.ts"), false);
    assert.equal(ctx.filter("/project/src/foo.ts"), true);
  });

  it("honors string-glob excludes", () => {
    const ctx = createDiscoveryContext(undefined, ["**/generated/**"]);
    assert.equal(ctx.filter("/project/src/generated/x.ts"), false);
    assert.equal(ctx.filter("/project/src/features/x.ts"), true);
  });

  it("always excludes the __trpc_server_functions__ output directory", () => {
    const ctx = createDiscoveryContext(undefined, undefined);
    assert.equal(
      ctx.filter("/project/src/generated/__trpc_server_functions__/a.ts"),
      false,
    );
  });
});
