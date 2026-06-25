/**
 * Plain-domain-JSON -> Firestore REST `fields` typed-value encoder (spec 0019).
 *
 * The committed `emulator-data/{empty,seeded}/` fixtures are PLAIN domain JSON
 * (the human-readable PLAN §4 shapes). This module encodes them to the Firestore
 * emulator REST `documents` write format on the fly, so the fixtures stay
 * readable and never drift from the domain types (we do NOT commit pre-encoded
 * REST payloads — spec 0019 Seed mechanism).
 *
 * Supported value kinds: string, number (integer vs double), boolean, null,
 * arrays, nested maps, and ISO-8601 date strings tagged for timestamp encoding
 * via the `{ __timestamp: string }` marker (Firestore `timestampValue`). The
 * marker keeps the plain JSON explicit about which strings are timestamps (e.g.
 * `addedAt`) rather than guessing from the value.
 */

/** A plain-JSON timestamp marker: `{ __timestamp: "2026-06-24T10:00:00.000Z" }`. */
export interface TimestampMarker {
  __timestamp: string;
}

function isTimestampMarker(value: unknown): value is TimestampMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__timestamp' in value &&
    typeof (value as TimestampMarker).__timestamp === 'string'
  );
}

/** Encode a single plain JS value to a Firestore REST typed value. */
export function encodeValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (isTimestampMarker(value)) {
    return { timestampValue: value.__timestamp };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === 'object') {
    return {
      mapValue: { fields: encodeFields(value as Record<string, unknown>) },
    };
  }
  throw new Error(
    `Cannot encode value of type ${typeof value}: ${JSON.stringify(value)}`,
  );
}

/** Encode a plain JS object to a Firestore REST `fields` map. */
export function encodeFields(
  data: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = encodeValue(value);
  }
  return fields;
}
