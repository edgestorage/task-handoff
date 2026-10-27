import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  ControlPlaneHttpErrorResponseSchema,
  controlPlaneErrorPayload,
} from "../src/control-plane/http/server.ts";

test("unexpected 5xx errors expose only a stable error and safe request id", () => {
  const error = Object.assign(new Error("insert into cp_cloud_device_pins (...) values ($1, $2)"), {
    code: "22003",
    details: {
      query: "insert into cp_cloud_device_pins (...) values ($1, $2)",
      parameters: ["device-secret", "session-secret"],
    },
  });

  const payload = controlPlaneErrorPayload(error, { requestId: "req_01JTEST" });

  assert.deepEqual(payload, {
    statusCode: 500,
    code: "CONTROL_PLANE_INTERNAL_ERROR",
    message: "The Control Plane could not complete the request.",
    requestId: "req_01JTEST",
  });
  assert.doesNotMatch(JSON.stringify(payload), /insert into|device-secret|session-secret|22003/i);
});

test("explicit 5xx errors also keep diagnostics out of the response", () => {
  const error = Object.assign(new Error("Upstream returned token=tok_secret and SQL parameters."), {
    statusCode: 502,
    code: "NODE_AGENT_RESPONSE_INVALID_JSON",
    details: { token: "tok_secret", response: "raw upstream body" },
    retryable: true,
  });

  const payload = controlPlaneErrorPayload(error, { requestId: 42 });

  assert.deepEqual(payload, {
    statusCode: 502,
    code: "CONTROL_PLANE_INTERNAL_ERROR",
    message: "The Control Plane could not complete the request.",
    retryable: true,
    requestId: "42",
  });
  assert.doesNotMatch(JSON.stringify(payload), /tok_secret|raw upstream body|SQL parameters/);
});

test("classified 4xx errors preserve their public contract", () => {
  const error = Object.assign(new Error("Node node_123 was not found."), {
    statusCode: 404,
    code: "NODE_NOT_FOUND",
    details: { nodeId: "node_123" },
    retryable: false,
  });

  assert.deepEqual(controlPlaneErrorPayload(error, { requestId: "req-4xx" }), {
    statusCode: 404,
    code: "NODE_NOT_FOUND",
    message: "Node node_123 was not found.",
    details: { nodeId: "node_123" },
    retryable: false,
    requestId: "req-4xx",
  });
});

test("validation errors remain structured 400 responses", () => {
  const error = z.object({ name: z.string() }).strict().safeParse({ name: 12 }).error;
  assert.ok(error);

  const payload = controlPlaneErrorPayload(error, { requestId: "req-validation" });

  assert.equal(payload.statusCode, 400);
  assert.equal(payload.code, "VALIDATION_ERROR");
  assert.match(payload.message, /^name: /);
  assert.equal(payload.requestId, "req-validation");
});

test("the normalized error response satisfies the public wire schema", () => {
  const payload = controlPlaneErrorPayload(new Error("raw driver diagnostic"), { requestId: "req-schema" });
  const response = ControlPlaneHttpErrorResponseSchema.parse({
    error: {
      code: payload.code,
      message: payload.message,
      requestId: payload.requestId,
    },
  });

  assert.equal(response.error.code, "CONTROL_PLANE_INTERNAL_ERROR");
  assert.equal(response.error.requestId, "req-schema");
});
