import assert from "node:assert/strict";
import test from "node:test";
import {
  restoreAiSessionAttachmentDraft,
  serializeAiSessionAttachmentDraft,
} from "../src/apps/control-plane/useAiSessionAttachmentDraft.ts";

test("attachment drafts preserve source content without transient upload state", () => {
  const file = new File(["image"], "preview.png", { type: "image/png" });
  const serialized = serializeAiSessionAttachmentDraft([{
    id: "local_image",
    kind: "image",
    name: "preview.png",
    mime: "image/png",
    size: file.size,
    source: { type: "runtime-path", path: "/workspace/preview.png" },
    file,
    previewUrl: "blob:transient",
    uploadProgress: 0.5,
    uploadState: "uploading",
  }]);

  assert.equal(serialized.length, 1);
  assert.equal(serialized[0].file, file);
  assert.equal("previewUrl" in serialized[0], false);
  assert.equal("uploadProgress" in serialized[0], false);
  assert.equal("uploadState" in serialized[0], false);

  const restored = restoreAiSessionAttachmentDraft(serialized);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].source.path, "/workspace/preview.png");
  assert.match(restored[0].previewUrl, /^blob:/);
  URL.revokeObjectURL(restored[0].previewUrl);
});

test("attachment drafts restore inline data and reject malformed records", () => {
  const restored = restoreAiSessionAttachmentDraft([{
    id: "local_file",
    kind: "file",
    name: "notes.txt",
    mime: "text/plain",
    size: 5,
    source: { type: "inline" },
    dataUrl: "data:text/plain;base64,aGVsbG8=",
  }, {
    id: "missing_data",
    kind: "file",
    name: "bad.txt",
    mime: "text/plain",
    size: 3,
    source: { type: "inline" },
  }]);

  assert.deepEqual(restored, [{
    id: "local_file",
    kind: "file",
    name: "notes.txt",
    mime: "text/plain",
    size: 5,
    source: { type: "inline" },
    dataUrl: "data:text/plain;base64,aGVsbG8=",
  }]);
});
