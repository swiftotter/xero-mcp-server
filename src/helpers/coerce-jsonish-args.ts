import { z } from "zod";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

// Some MCP clients serialize a complex tool argument as a JSON *string* instead
// of a JSON array/object — e.g. Cowork sends
//   manualJournalLines: "[{\"lineAmount\":5,...},...]"
// to create-manual-journal, which the array schema (correctly, by the letter of
// it) rejects with "Expected array, received string at manualJournalLines". The
// schema is right and is published right; the encoding on the wire is wrong.
//
// This module makes the ENCODING of array/object arguments tolerant without
// touching what the schema means: every array- and object-typed node in a tool's
// Zod tree is wrapped in a preprocess step that JSON.parses a string that looks
// like JSON. Scalars are deliberately left strict — `confirm: "true"` and
// `page: "1"` are still errors, so the write-confirmation gate can never be
// tripped by a stringified boolean.
//
// The published JSON Schema must not change, and it doesn't: the SDK's zod-v3
// conversion path (zod-to-json-schema) emits the INNER schema for a ZodEffects,
// so clients see the same `type: "array"`, the same items, the same descriptions
// and the same required list as before. That behaviour comes from
// zod-to-json-schema's `effectStrategy`, whose DEFAULT is "input" — note the SDK
// only ever overrides the neighbouring `pipeStrategy` (which governs ZodPipeline,
// not effects), so this rests on a library default the SDK never sets. Which is
// why it is asserted rather than trusted: `npm run verify:schemas` diffs coerced
// against un-coerced registration for every tool, so a change to that default —
// or a lossy rebuild below — fails CI instead of shipping.
//
// The same check also covers a future move to zod v4: the SDK picks its v4
// conversion branch by looking for a `_zod` marker on the schema, and nodes built
// with the v3 API here never carry one, so the v3 branch stays selected until
// this file is deliberately migrated.

// Depth cap: a guard against a pathological/recursive schema, not a real limit —
// the deepest tool schema here is ~3 levels (param -> array -> object -> array).
const MAX_DEPTH = 6;

const parseJsonish = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not JSON after all. Hand the original string back so the client sees the
    // real type error ("Expected array, received string") rather than a
    // confusing complaint about JSON syntax.
    return value;
  }
};

// Rebuilding a Zod node means constructing the same class with the same _def and
// one field swapped, which keeps everything else the node carries (description,
// array min/max checks, object unknown-key policy). Zod's public API has no
// "replace my inner type" operation, hence the _def access.
type AnyDef = Record<string, unknown> & { typeName: z.ZodFirstPartyTypeKind };

const rebuild = (schema: z.ZodTypeAny, patch: Record<string, unknown>): z.ZodTypeAny => {
  const ctor = schema.constructor as new (def: unknown) => z.ZodTypeAny;
  return new ctor({ ...(schema._def as AnyDef), ...patch });
};

const coerceJsonish = (schema: z.ZodTypeAny, depth = 0): z.ZodTypeAny => {
  if (depth >= MAX_DEPTH) return schema;
  const def = schema._def as AnyDef;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const element = coerceJsonish(
        (def as unknown as z.ZodArrayDef).type,
        depth + 1,
      );
      return z.preprocess(parseJsonish, rebuild(schema, { type: element }));
    }

    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const coercedShape: z.ZodRawShape = Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [
          key,
          coerceJsonish(value, depth + 1),
        ]),
      );
      return z.preprocess(
        parseJsonish,
        rebuild(schema, { shape: () => coercedShape }),
      );
    }

    // Wrappers: recurse into the inner type and put the wrapper back, so an
    // optional array still reports as optional to the schema converter.
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = (def as unknown as { innerType: z.ZodTypeAny }).innerType;
      const coerced = coerceJsonish(inner, depth + 1);
      return coerced === inner ? schema : rebuild(schema, { innerType: coerced });
    }

    // Everything else — strings, numbers, booleans, enums, literals, unions,
    // records, tuples, schemas that already carry an effect — is left exactly
    // as declared.
    default:
      return schema;
  }
};

/**
 * Returns the tool's raw Zod shape with every array/object node made tolerant of
 * a JSON-string encoding. The published JSON Schema is unchanged.
 *
 * The walk reads zod-v3 internals, and `ZodRawShapeCompat` can legally hold v4
 * values — the SDK supports mixed shapes. There are none in this codebase, and a
 * v4 value would fall through the `default` case untouched (no `_def.typeName`)
 * rather than break, so a migration loses the tolerance before it loses
 * correctness.
 */
export function coerceJsonishShape(shape: ZodRawShapeCompat): ZodRawShapeCompat {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [
      key,
      coerceJsonish(value as z.ZodTypeAny),
    ]),
  ) as ZodRawShapeCompat;
}
