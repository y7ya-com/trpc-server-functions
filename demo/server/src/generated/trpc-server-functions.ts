import { createTRPCProcedureRecord, withServerFnMetadata } from "trpc-server-functions";
import type { ServerFnReferenceEntry } from "trpc-server-functions";
import { publicProcedure as __baseProcedure } from "../trpc.ts";
import { getCount as __serverFn0 } from "../../../client/src/App.tsx";
import { incrementCount as __serverFn1 } from "../../../client/src/App.tsx";

const __entries: ServerFnReferenceEntry[] = [
  { id: "src/App.tsx:getCount", routeKey: "src_App__getCount__ce80f62f", exportName: "getCount", relativePath: "src/App.tsx", procedureType: "query", reference: withServerFnMetadata(__serverFn0, { id: "src/App.tsx:getCount", routeKey: "src_App__getCount__ce80f62f", exportName: "getCount", relativePath: "src/App.tsx", procedureType: "query" }) },
  { id: "src/App.tsx:incrementCount", routeKey: "src_App__incrementCount__4d7388ff", exportName: "incrementCount", relativePath: "src/App.tsx", procedureType: "mutation", reference: withServerFnMetadata(__serverFn1, { id: "src/App.tsx:incrementCount", routeKey: "src_App__incrementCount__4d7388ff", exportName: "incrementCount", relativePath: "src/App.tsx", procedureType: "mutation" }) },
];

export function trpcServerFunctions() {
  return createTRPCProcedureRecord(__baseProcedure, __entries);
}

export const serverFnManifest = __entries.map(({ id, routeKey, exportName, relativePath, procedureType }) => ({
  id,
  routeKey,
  exportName,
  relativePath,
  procedureType,
}));