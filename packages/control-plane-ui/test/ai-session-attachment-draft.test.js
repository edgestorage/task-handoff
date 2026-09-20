import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, isProxy, reactive, ref } from "vue";
import {
  restoreAiSessionAttachmentDraft,
  serializeAiSessionAttachmentDraft,
  useAiSessionAttachmentDraft,
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

test("attachment drafts strip Vue proxies before IndexedDB structured cloning", () => {
  const attachment = reactive({
    id: "local_image",
    kind: "image",
    name: "pasted.png",
    mime: "image/png",
    size: 5,
    source: { type: "inline" },
    dataUrl: "data:image/png;base64,aW1hZ2U=",
    textPresentation: { summary: "pasted", codePointLength: 6 },
  });
  assert.equal(isProxy(attachment.source), true);
  assert.throws(() => structuredClone({ source: attachment.source }), { name: "DataCloneError" });

  const [serialized] = serializeAiSessionAttachmentDraft([attachment]);
  assert.equal(isProxy(serialized.source), false);
  assert.equal(isProxy(serialized.textPresentation), false);
  assert.deepEqual(structuredClone(serialized), serialized);
});

test("attachment draft state revokes preview URLs when its key changes or scope is disposed", () => {
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const revoked = [];
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    const draftKey = ref("");
    const scope = effectScope();
    const attachments = scope.run(() => useAiSessionAttachmentDraft(draftKey));
    attachments.value = [{
      id: "local_image_a",
      kind: "image",
      name: "a.png",
      mime: "image/png",
      size: 1,
      source: { type: "runtime-path", path: "/workspace/a.png" },
      previewUrl: "blob:preview-a",
    }];

    draftKey.value = "session-b";
    assert.deepEqual(revoked, ["blob:preview-a"]);
    attachments.value = [{
      id: "local_image_b",
      kind: "image",
      name: "b.png",
      mime: "image/png",
      size: 1,
      source: { type: "runtime-path", path: "/workspace/b.png" },
      previewUrl: "blob:preview-b",
    }];

    scope.stop();
    assert.deepEqual(revoked, ["blob:preview-a", "blob:preview-b"]);
  } finally {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});
