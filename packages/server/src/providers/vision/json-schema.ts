import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

const BOX_DESCRIPTION =
  'Exactly four numbers [x0, y0, x1, y1], each between 0 and 1, with x0 < x1 and y0 < y1.';

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== 'object') return node;
  const schema = { ...(node as JsonSchema) };
  delete schema.$schema;
  // Fixed-length tuples (normalized boxes) become arrays of the tuple's item type.
  if (Array.isArray(schema.prefixItems)) {
    const first = (schema.prefixItems as unknown[])[0] ?? { type: 'number' };
    const result: JsonSchema = {
      type: 'array',
      items: sanitize(first),
      description: schema.description
        ? `${String(schema.description)} ${BOX_DESCRIPTION}`
        : BOX_DESCRIPTION,
    };
    return result;
  }
  if (schema.items === false) delete schema.items;
  for (const key of ['properties', '$defs', 'definitions']) {
    const value = schema[key];
    if (value && typeof value === 'object') {
      schema[key] = Object.fromEntries(
        Object.entries(value as JsonSchema).map(([name, child]) => [name, sanitize(child)]),
      );
    }
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) {
    if (schema[key] !== undefined) schema[key] = sanitize(schema[key]);
  }
  return schema;
}

/**
 * JSON Schema for a model structured output, generated from a zod schema. Tuples are expressed
 * as arrays with a description (structured outputs do not take `prefixItems`); the zod parse of
 * the reply remains the only accepted truth.
 */
export function modelJsonSchema(schema: z.ZodType): JsonSchema & { type: 'object' } {
  const generated = z.toJSONSchema(schema, { reused: 'inline', unrepresentable: 'any' });
  return sanitize(generated) as JsonSchema & { type: 'object' };
}
