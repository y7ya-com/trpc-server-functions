/**
 * Minimal Standard Schema v1 interfaces + duck-typed detection and invocation.
 *
 * We don't take a hard dep on `@standard-schema/spec` because it is peer-only
 * at the consumer level and we just need to interoperate with any validator
 * that implements the protocol (valibot, zod, arktype, etc.).
 *
 * Docs: https://standardschema.dev
 */

export interface StandardSchemaIssue {
  message: string;
  path?: readonly (string | number | symbol)[];
}

export interface StandardSchemaSuccessResult<Output> {
  value: Output;
  issues?: undefined;
}

export interface StandardSchemaFailureResult {
  issues: readonly StandardSchemaIssue[];
}

export type StandardSchemaResult<Output> =
  | StandardSchemaSuccessResult<Output>
  | StandardSchemaFailureResult;

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

export type InputParserFunction<TInput> = (value: unknown) => TInput;

export type AnyInputParser<TInput = unknown> =
  | StandardSchemaV1<unknown, TInput>
  | InputParserFunction<TInput>;

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    "~standard" in value &&
    typeof (value as StandardSchemaV1)["~standard"]?.validate === "function"
  );
}

export class StandardSchemaValidationError extends Error {
  readonly issues: readonly StandardSchemaIssue[];

  constructor(issues: readonly StandardSchemaIssue[]) {
    const first = issues[0];
    const suffix = first ? `: ${first.message}` : "";
    super(`Server function input validation failed${suffix}`);
    this.name = "StandardSchemaValidationError";
    this.issues = issues;
  }
}

/**
 * Normalize any accepted input parser shape into a synchronous-or-async
 * `(value) => parsed` function. Returns `null` when no parser was supplied.
 */
export function resolveInputParser<TInput>(
  parser: unknown,
): ((value: unknown) => TInput | Promise<TInput>) | null {
  if (parser == null) {
    return null;
  }

  if (isStandardSchema(parser)) {
    return async (value) => {
      const result = await parser["~standard"].validate(value);
      if (result.issues) {
        throw new StandardSchemaValidationError(result.issues);
      }
      return result.value as TInput;
    };
  }

  if (typeof parser === "function") {
    return parser as (value: unknown) => TInput;
  }

  return null;
}
