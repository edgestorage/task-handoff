import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api/client.ts";
import { requestJsonWithUploadProgress } from "../src/api/xhrUpload.ts";

class FakeXhr {
  upload = {};
  headers = new Map();
  method = "";
  url = "";
  async = false;
  timeout = 0;
  withCredentials = false;
  status = 0;
  statusText = "";
  responseText = "";
  sentBody = undefined;

  open(method, url, async) {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name, value) {
    this.headers.set(name, value);
  }

  send(body) {
    this.sentBody = body;
  }

  abort() {
    this.onabort?.();
  }
}

test("XHR transport sends the original Blob and reports browser upload progress", async () => {
  const xhr = new FakeXhr();
  const body = new Blob([new Uint8Array(16)]);
  const progress = [];
  const result = requestJsonWithUploadProgress(
    "/api/upload",
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body },
    (value) => progress.push(value),
    () => xhr,
  );

  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, "/api/upload");
  assert.equal(xhr.sentBody, body);
  assert.equal(xhr.headers.get("content-type"), "application/octet-stream");
  xhr.upload.onprogress({ lengthComputable: true, loaded: 8, total: 16 });
  xhr.status = 201;
  xhr.responseText = JSON.stringify({ data: { id: "attachment-1" } });
  xhr.onload();

  assert.deepEqual(progress, [0.5]);
  assert.deepEqual(await result, { data: { id: "attachment-1" } });
});

test("XHR transport preserves structured API errors", async () => {
  const xhr = new FakeXhr();
  const result = requestJsonWithUploadProgress(
    "/api/upload",
    { method: "POST", body: new Blob([new Uint8Array(1)]) },
    () => undefined,
    () => xhr,
  );

  xhr.status = 400;
  xhr.statusText = "Bad Request";
  xhr.responseText = JSON.stringify({ error: { code: "AI_SESSION_ATTACHMENT_INVALID", message: "Invalid attachment.", retryable: false } });
  xhr.onload();

  await assert.rejects(result, (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "AI_SESSION_ATTACHMENT_INVALID");
    assert.equal(error.status, 400);
    assert.equal(error.message, "Invalid attachment.");
    return true;
  });
});
