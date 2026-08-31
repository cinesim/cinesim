function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stable(record[key])]),
  );
}

export function serializeIr(value: unknown): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}
