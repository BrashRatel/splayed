// Tiny assertion helpers (jsr:@std/assert isn't reachable from every build environment).
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
  } catch {
    return String(value);
  }
}

export function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (show(actual) !== show(expected)) {
    throw new AssertionError(
      `${message ? message + ": " : ""}expected ${show(expected)}, got ${show(actual)}`,
    );
  }
}

export function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertThrows(
  fn: () => unknown,
  // deno-lint-ignore no-explicit-any
  errorClass?: new (...args: any[]) => Error,
  includes?: string,
): Error {
  try {
    fn();
  } catch (error) {
    checkError(error, errorClass, includes);
    return error as Error;
  }
  throw new AssertionError("expected function to throw");
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  // deno-lint-ignore no-explicit-any
  errorClass?: new (...args: any[]) => Error,
  includes?: string,
): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    checkError(error, errorClass, includes);
    return error as Error;
  }
  throw new AssertionError("expected promise to reject");
}

// deno-lint-ignore no-explicit-any
function checkError(error: unknown, errorClass?: new (...args: any[]) => Error, includes?: string) {
  if (errorClass && !(error instanceof errorClass)) {
    throw new AssertionError(
      `expected ${errorClass.name}, got ${(error as Error)?.name}: ${error}`,
    );
  }
  if (includes && !String((error as Error)?.message).includes(includes)) {
    throw new AssertionError(`expected error message to include "${includes}", got "${error}"`);
  }
}
