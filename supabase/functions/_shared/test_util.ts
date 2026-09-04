// deno test 用の最小限アサーションヘルパー。外部依存を増やさないため、
// jsr:@std/assert 等は使わず標準構文のみで実装する。

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

export function assert(value: unknown, msg?: string): asserts value {
  if (!value) throw new Error(msg ?? "assertion failed");
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      msg ??
        `assertEquals failed:\n  actual:   ${JSON.stringify(actual)}\n  expected: ${
          JSON.stringify(expected)
        }`,
    );
  }
}

export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void {
  if (deepEqual(actual, expected)) {
    throw new Error(msg ?? `assertNotEquals failed: both were ${JSON.stringify(actual)}`);
  }
}

export function assertThrows(fn: () => unknown, msg?: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(msg ?? "assertThrows failed: function did not throw");
  }
}
