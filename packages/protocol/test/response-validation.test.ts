import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { parseResponse, safeParseResponse } from "../src/response-validation.ts";

const ResponseSchema = z.object({
  id: z.string(),
  nested: z.object({ value: z.number() }).strict(),
  choice: z.union([
    z.object({ type: z.literal("a"), label: z.string() }).strict(),
    z.object({ type: z.literal("b"), count: z.number() }).strict(),
  ]),
}).strict();

test("response parsing recursively drops unknown fields, including union members", () => {
  assert.deepEqual(parseResponse(ResponseSchema, {
    id: "record-1",
    futureRoot: true,
    nested: { value: 1, futureNested: true },
    choice: { type: "a", label: "A", futureChoice: true },
  }), {
    id: "record-1",
    nested: { value: 1 },
    choice: { type: "a", label: "A" },
  });
});

test("response parsing still rejects missing required fields and invalid known fields", () => {
  assert.equal(safeParseResponse(ResponseSchema, {
    nested: { value: 1 },
    choice: { type: "a", label: "A" },
  }).success, false);
  assert.equal(safeParseResponse(ResponseSchema, {
    id: "record-1",
    nested: { value: "wrong", futureNested: true },
    choice: { type: "a", label: "A" },
  }).success, false);
});
