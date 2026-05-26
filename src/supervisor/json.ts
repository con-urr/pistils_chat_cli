export function toJsonSafe(value: unknown): unknown {
  return toJsonSafeInner(value, new WeakSet<object>());
}

function toJsonSafeInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(item => toJsonSafeInner(item, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[circular]';
    }
    seen.add(value);

    const maybeTimestamp = value as { toDate?: () => Date };
    if (typeof maybeTimestamp.toDate === 'function') {
      try {
        return maybeTimestamp.toDate().toISOString();
      } catch {
        return String(value);
      }
    }

    const maybeIdentity = value as { toHexString?: () => string };
    if (typeof maybeIdentity.toHexString === 'function') {
      try {
        return maybeIdentity.toHexString();
      } catch {
        return String(value);
      }
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toJsonSafeInner(item, seen);
    }
    seen.delete(value);
    return output;
  }

  return String(value);
}

export function stringifyJsonSafe(value: unknown, pretty = true) {
  return `${JSON.stringify(toJsonSafe(value), null, pretty ? 2 : undefined)}\n`;
}
