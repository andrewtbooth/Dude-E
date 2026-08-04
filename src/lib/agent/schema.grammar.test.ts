/**
 * Keeps the structured-output schema under the API's grammar-size limit.
 *
 * ## Why this exists
 *
 * `output_config.format` is compiled server-side into a decoding grammar. Past
 * a certain size the request is rejected outright:
 *
 *   400 invalid_request_error — "The compiled grammar is too large, which
 *   would cause performance issues. Simplify your tool schemas or reduce the
 *   number of strict tools."
 *
 * That is a whole-app outage — no analysis can run at all — and nothing else in
 * the pipeline catches it. The schema typechecks, the tests pass, and the
 * request fails only when a real classification is attempted against the live
 * API. It is the same shape of gap as the entrypoint flag regression: the first
 * execution of the thing is in production.
 *
 * ## What is actually being bounded
 *
 * A JSON grammar has to accept an object's required properties, and its cost
 * grows sharply with how many sit side by side on one object rather than with
 * how deeply they nest. Measuring the sum of 2^(properties) over every distinct
 * object is a *proxy*, not the API's own formula — which is not published — but
 * it tracks the thing that actually blew the budget: the candidate object
 * carrying thirteen fields flat was ~89% of the total on its own.
 *
 * So the thresholds below are not derived from a documented limit. They are set
 * just above the current measured value, to catch growth rather than to certify
 * headroom. If the API rejects a request that passes this test, lower them and
 * regroup further; the fix is always to nest, not to delete a field.
 */

import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { describe, expect, it } from "vitest";
import {
  classificationResultSchema,
  descriptionResultSchema,
  resultSchemaFor,
} from "./schema";

/** Value measured on the schema that the API rejected, for reference. */
const REJECTED_AT = 9224;

interface Measurement {
  /** Sum of 2^(property count) over every distinct object in the schema. */
  permutationSurface: number;
  /** Total schema nodes once every `$ref` is expanded. */
  nodes: number;
  /** The widest object, which is what dominates the surface. */
  widest: { path: string; properties: number };
}

function measure(zodSchema: Parameters<typeof betaZodOutputFormat>[0]): Measurement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = (betaZodOutputFormat(zodSchema) as any).schema;
  const defs = schema.$defs ?? {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deref = (node: any): any =>
    node?.$ref ? deref(defs[String(node.$ref).replace("#/$defs/", "")]) : node;

  let permutationSurface = 0;
  let nodes = 0;
  let widest = { path: "$", properties: 0 };
  const counted = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(node: any, path: string): void {
    node = deref(node);
    if (!node || typeof node !== "object") return;
    nodes += 1;

    if (node.properties && !counted.has(path)) {
      counted.add(path);
      const count = Object.keys(node.properties).length;
      permutationSurface += 2 ** count;
      if (count > widest.properties) widest = { path, properties: count };
    }

    for (const [key, value] of Object.entries(node.properties ?? {})) {
      walk(value, `${path}.${key}`);
    }
    if (node.items) walk(node.items, `${path}[]`);
    for (const branch of ["anyOf", "oneOf", "allOf"] as const) {
      for (const sub of node[branch] ?? []) walk(sub, path);
    }
  }

  walk(schema, "$");
  return { permutationSurface, nodes, widest };
}

describe("structured-output grammar size", () => {
  it("part-number mode stays far below the size that was rejected", () => {
    const { permutationSurface } = measure(classificationResultSchema);
    expect(permutationSurface).toBeLessThan(2_000);
    // The margin is the point: a schema that merely squeaks under whatever the
    // real limit is will fail again on the next field someone adds.
    expect(permutationSurface).toBeLessThan(REJECTED_AT / 4);
  });

  it("description mode drops the part-research shape it can never populate", () => {
    const full = measure(classificationResultSchema);
    const description = measure(descriptionResultSchema);
    expect(description.permutationSurface).toBeLessThan(full.permutationSurface);
    expect(description.nodes).toBeLessThan(full.nodes);
  });

  it.each([
    ["part-number", classificationResultSchema],
    ["description", descriptionResultSchema],
  ])("no %s object is wide enough to dominate the grammar", (_label, schema) => {
    const { widest } = measure(schema);
    // 13 was the candidate object that blew the budget. Ten is a ceiling with
    // room to breathe; past it, group the new fields rather than raising this.
    expect(
      widest.properties,
      `${widest.path} has ${widest.properties} properties — group related ` +
        `fields into a nested object instead of widening it further`,
    ).toBeLessThanOrEqual(10);
  });

  it("routes each mode to the schema it will actually be constrained by", () => {
    expect(resultSchemaFor("PART_NUMBER")).toBe(classificationResultSchema);
    expect(resultSchemaFor("DESCRIPTION")).toBe(descriptionResultSchema);
  });
});
