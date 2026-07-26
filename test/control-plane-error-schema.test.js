const assert = require("node:assert/strict");
const test = require("node:test");
const { z } = require("zod");

const {
  ControlPlaneHttpErrorResponseSchema,
  controlPlaneErrorPayload,
} = require("../packages/control-plane/src/server.ts");

test("control-plane HTTP errors preserve stable code and structured metadata", () => {
  const error = Object.assign(new Error("Folder was not found."), {
    statusCode: 404,
    code: "NODE_LOCAL_FOLDER_NOT_FOUND",
    details: { nodeId: "node-1", folderId: "folder-1" },
    retryable: false,
  });

  assert.deepEqual(controlPlaneErrorPayload(error), {
    statusCode: 404,
    code: "NODE_LOCAL_FOLDER_NOT_FOUND",
    message: "Folder was not found.",
    details: { nodeId: "node-1", folderId: "folder-1" },
    retryable: false,
  });
});

test("control-plane HTTP error response schema is strict", () => {
  const valid = {
    error: {
      code: "NODE_LOCAL_FOLDER_NOT_FOUND",
      message: "Folder was not found.",
      details: { nodeId: "node-1" },
      retryable: false,
    },
  };

  assert.deepEqual(ControlPlaneHttpErrorResponseSchema.parse(valid), valid);
  assert.equal(ControlPlaneHttpErrorResponseSchema.safeParse({ ...valid, extra: true }).success, false);
  assert.equal(ControlPlaneHttpErrorResponseSchema.safeParse({ error: { ...valid.error, extra: true } }).success, false);
});

test("validation failures have a stable code and schema-compatible payload", () => {
  const payload = controlPlaneErrorPayload(new z.ZodError([{
    code: "invalid_type",
    expected: "string",
    path: ["name"],
    message: "Invalid input: expected string, received number",
  }]));

  assert.equal(payload.statusCode, 400);
  assert.equal(payload.code, "VALIDATION_ERROR");
  assert.equal(ControlPlaneHttpErrorResponseSchema.safeParse({
    error: { code: payload.code, message: payload.message },
  }).success, true);
});
