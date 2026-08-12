const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  AI_SESSION_MAX_INLINE_FILE_BYTES,
  AiSessionMessageAttachmentSchema,
  AiSessionMessageAttachmentRefSchema,
  AiSessionMessageInputSchema,
} = require("../packages/protocol/src/ai-sessions.ts");
const { materializeAiSessionAttachments, prepareCodexAiSessionAttachments, withAttachmentPathFallback } = require("../packages/ai-session-runtime/src/ai-session-attachments.ts");
const { assertAiSessionRuntimePathSupport } = require("../packages/control-plane/src/control-plane/application/service.ts");

function inlineFile(size) {
  return {
    id: "attachment_1",
    kind: "file",
    name: "notes.txt",
    mime: "text/plain",
    size,
    source: { type: "inline", encoding: "base64", data: "YQ==" },
  };
}

test("inline files must be smaller than 500 KiB", () => {
  assert.equal(AiSessionMessageAttachmentSchema.safeParse(inlineFile(AI_SESSION_MAX_INLINE_FILE_BYTES - 1)).success, true);
  assert.equal(AiSessionMessageAttachmentSchema.safeParse(inlineFile(AI_SESSION_MAX_INLINE_FILE_BYTES)).success, false);
});

test("runtime path references use the target instance filesystem namespace", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-runtime-attachment-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "large-model.bin");
  fs.writeFileSync(filePath, "runtime-path-content");
  const reference = {
    id: "runtime_attachment_1",
    kind: "file",
    name: "large-model.bin",
    mime: "application/octet-stream",
    size: Number.MAX_SAFE_INTEGER,
    source: { type: "runtime-path", path: filePath },
  };

  assert.equal(AiSessionMessageAttachmentRefSchema.safeParse(reference).success, true);
  assert.equal(AiSessionMessageInputSchema.safeParse({ message: "inspect", attachments: [reference], references: [] }).success, true);
  const canonicalFilePath = fs.realpathSync(filePath);
  assert.equal(materializeAiSessionAttachments([reference], dir)[0].path, canonicalFilePath);

  let providerMessage = "";
  await withAttachmentPathFallback("inspect", [reference], dir, async (message) => { providerMessage = message; });
  assert.match(providerMessage, new RegExp(`文件路径：${canonicalFilePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("Codex attachments use data URLs only for small inline images", (t) => {
  const attachmentDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-attachments-"));
  const previousDir = process.env.TASK_HANDOFF_AI_SESSION_ATTACHMENT_DIR;
  process.env.TASK_HANDOFF_AI_SESSION_ATTACHMENT_DIR = attachmentDir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.TASK_HANDOFF_AI_SESSION_ATTACHMENT_DIR;
    else process.env.TASK_HANDOFF_AI_SESSION_ATTACHMENT_DIR = previousDir;
    fs.rmSync(attachmentDir, { recursive: true, force: true });
  });
  const small = {
    id: "small_image",
    kind: "image",
    name: "small.png",
    mime: "image/png",
    size: 3,
    source: { type: "inline", encoding: "base64", data: "cG5n" },
  };
  const largeData = Buffer.alloc(AI_SESSION_MAX_INLINE_FILE_BYTES + 1, 1).toString("base64");
  const large = {
    ...small,
    id: "large_image",
    name: "large.png",
    size: Buffer.byteLength(largeData, "base64"),
    source: { type: "inline", encoding: "base64", data: largeData },
  };
  const file = inlineFile(1);

  const prepared = prepareCodexAiSessionAttachments("inspect", [small, large, file]);
  assert.deepEqual(prepared.inputs[0], { type: "image", url: "data:image/png;base64,cG5n" });
  assert.equal(prepared.inputs[1].type, "localImage");
  assert.equal(fs.statSync(prepared.inputs[1].path).isFile(), true);
  assert.doesNotMatch(prepared.message, /图片路径/);
  assert.match(prepared.message, /文件路径：/);
});

test("Codex runtime images use canonical localImage inputs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-codex-runtime-image-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "screen.png");
  fs.writeFileSync(imagePath, "png");
  const prepared = prepareCodexAiSessionAttachments("inspect", [{
    id: "runtime_image",
    kind: "image",
    name: "screen.png",
    mime: "image/png",
    size: 3,
    source: { type: "runtime-path", path: imagePath },
  }], root);
  assert.deepEqual(prepared, {
    message: "inspect",
    inputs: [{ type: "localImage", path: fs.realpathSync(imagePath) }],
  });
});

test("runtime paths must resolve to absolute regular files", () => {
  const reference = {
    id: "runtime_attachment_2",
    kind: "file",
    name: "notes.txt",
    mime: "text/plain",
    size: 1,
    source: { type: "runtime-path", path: "relative/notes.txt" },
  };
  assert.throws(() => materializeAiSessionAttachments([reference], path.resolve(".")), /must be absolute/);
  assert.throws(
    () => materializeAiSessionAttachments([{ ...reference, source: { type: "runtime-path", path: path.resolve("missing-runtime-attachment.txt") } }], path.resolve(".")),
    (error) => error.code === "AI_SESSION_RUNTIME_PATH_NOT_FOUND",
  );
  assert.throws(
    () => materializeAiSessionAttachments([{ ...reference, source: { type: "runtime-path", path: path.resolve(".") } }], path.resolve(".")),
    (error) => error.code === "AI_SESSION_RUNTIME_PATH_NOT_FILE",
  );
});

test("runtime paths cannot escape the AI session workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-runtime-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-runtime-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const outsidePath = path.join(outside, "secret.txt");
  fs.writeFileSync(outsidePath, "secret");
  const reference = {
    id: "runtime_attachment_outside",
    kind: "file",
    name: "secret.txt",
    mime: "text/plain",
    size: 6,
    source: { type: "runtime-path", path: outsidePath },
  };

  assert.throws(
    () => materializeAiSessionAttachments([reference], root),
    (error) => error.code === "AI_SESSION_RUNTIME_PATH_OUTSIDE_WORKSPACE",
  );
  assert.throws(
    () => materializeAiSessionAttachments([reference]),
    (error) => error.code === "AI_SESSION_RUNTIME_PATH_ROOT_UNAVAILABLE",
  );

  const linkPath = path.join(root, "outside-link.txt");
  fs.symlinkSync(outsidePath, linkPath);
  assert.throws(
    () => materializeAiSessionAttachments([{ ...reference, source: { type: "runtime-path", path: linkPath } }], root),
    (error) => error.code === "AI_SESSION_RUNTIME_PATH_OUTSIDE_WORKSPACE",
  );
});

test("client runtime paths are gated to Local Runtime", () => {
  const attachment = {
    id: "runtime_attachment_3",
    kind: "file",
    name: "notes.txt",
    mime: "text/plain",
    size: 1,
    source: { type: "runtime-path", path: path.resolve("notes.txt") },
  };
  assert.doesNotThrow(() => assertAiSessionRuntimePathSupport([attachment], "local"));
  assert.throws(() => assertAiSessionRuntimePathSupport([attachment], "docker"), (error) => error.code === "AI_SESSION_RUNTIME_PATH_UNSUPPORTED");
  assert.throws(() => assertAiSessionRuntimePathSupport([attachment], "kubernetes"), (error) => error.code === "AI_SESSION_RUNTIME_PATH_UNSUPPORTED");
});
