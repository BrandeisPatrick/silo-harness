// Field checks for settings.json and provider entries. Each check is a function that returns null for a good value
// and a reason for a bad one, and carries the JSON Schema of what it accepts, so docs/settings.schema.json is
// generated from the same code that validates (see settingsSchema() in settings.ts). No dependencies: the
// command-line tool loads this too.

import { ENV_NAME } from './env';

export type JsonSchema = Record<string, unknown>;
export type Check = ((v: unknown) => string | null) & { schema: JsonSchema };

const mk = (schema: JsonSchema, fn: (v: unknown) => string | null): Check => Object.assign(fn, { schema });

/** The same check with a description in its schema (what an editor shows on hover). */
export const describe = (c: Check, description: string): Check => mk({ ...c.schema, description }, (v) => c(v));

export const kind = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : typeof v === 'string' ? 'a string' : typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'true/false' : typeof v;

export const str = mk({ type: 'string' }, (v) => (typeof v === 'string' ? null : `expected a string, got ${kind(v)}`));
export const nonEmpty = mk({ type: 'string', minLength: 1 }, (v) => (typeof v === 'string' ? (v.trim() ? null : 'expected a value, got an empty string') : `expected a string, got ${kind(v)}`));
export const bool = mk({ type: 'boolean' }, (v) => (typeof v === 'boolean' ? null : `expected true or false, got ${kind(v)}`));
export const oneOf = (...values: string[]): Check =>
  mk({ type: 'string', enum: values }, (v) => (typeof v === 'string' && values.includes(v) ? null : `expected one of ${values.map((x) => `"${x}"`).join(', ')}${typeof v === 'string' ? '' : `, got ${kind(v)}`}`));
export const positiveInt = mk({ type: 'integer', minimum: 1 }, (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? null : `expected a whole number above 0${typeof v === 'number' ? '' : `, got ${kind(v)}`}`));
export const nonNegative = mk({ type: 'number', minimum: 0 }, (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? null : `expected a number of 0 or more${typeof v === 'number' ? '' : `, got ${kind(v)}`}`));
export const between = (lo: number, hi: number): Check =>
  mk({ type: 'number', minimum: lo, maximum: hi }, (v) => (typeof v === 'number' && v >= lo && v <= hi ? null : `expected a number from ${lo} to ${hi}${typeof v === 'number' ? '' : `, got ${kind(v)}`}`));
export const intBetween = (lo: number, hi: number): Check =>
  mk({ type: 'integer', minimum: lo, maximum: hi }, (v) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? null : `expected a whole number from ${lo} to ${hi}${typeof v === 'number' ? '' : `, got ${kind(v)}`}`));
export const timeOfDay = mk({ type: 'string', pattern: '^([01]?\\d|2[0-3]):[0-5]\\d$' }, (v) =>
  typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? null : `expected a time of day as "HH:MM" (24-hour), e.g. "03:00"${typeof v === 'string' ? '' : `, got ${kind(v)}`}`,
);
export const httpUrl = mk({ type: 'string', pattern: '^https?://' }, (v) => {
  if (typeof v !== 'string') return `expected a URL, got ${kind(v)}`;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'expected an http:// or https:// URL';
  } catch {
    return v.trim() ? 'expected an http:// or https:// URL' : 'expected a URL, got an empty string';
  }
});
export const envName = mk({ type: 'string', pattern: ENV_NAME.source }, (v) =>
  typeof v === 'string' && ENV_NAME.test(v) ? null : typeof v === 'string' ? 'not a valid variable name (letters, digits and _, not starting with a digit)' : `expected the name of an environment variable, got ${kind(v)}`,
);
export const stringList = mk({ type: 'array', items: { type: 'string', minLength: 1 } }, (v) => {
  if (!Array.isArray(v)) return `expected a list of strings, got ${kind(v)}`;
  const i = v.findIndex((x) => typeof x !== 'string' || !x.trim());
  return i < 0 ? null : `item ${i + 1}: expected a non-empty string, got ${typeof v[i] === 'string' ? 'an empty string' : kind(v[i])}`;
});
/** Header names as HTTP allows them (a token), values as strings */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const headerMap = mk({ type: 'object', propertyNames: { pattern: HEADER_NAME.source }, additionalProperties: { type: 'string' } }, (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `expected an object of "Header-Name": "value" pairs, got ${kind(v)}`;
  for (const [k, x] of Object.entries(v)) {
    if (!HEADER_NAME.test(k)) return `"${k}" is not a valid header name`;
    if (typeof x !== 'string') return `${k}: expected a string, got ${kind(x)}`;
  }
  return null;
});
