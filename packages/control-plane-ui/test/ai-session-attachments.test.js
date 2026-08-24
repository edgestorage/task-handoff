import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("composer supports generic files and Local Runtime path references", () => {
  const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
  assert.match(composer, /kind: "image" \| "file"/);
  assert.match(composer, /maxFileAttachmentBytes\?: number/);
  assert.match(composer, /file\.size >= \(props\.maxFileAttachmentBytes \|\| AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES\)/);
  assert.match(composer, /runtimePathAccess === "desktop-local"/);
  assert.match(composer, /runtimePathWithinWorkspace\(filePath, props\.mentionContext\.cwd\)/);
  assert.match(composer, /t\("sessions\.composer\.runtimePathOutside"\)/);
  assert.match(composer, /showControlPlaneToast\(outsideWorkspaceFiles\.has\(file\)/);
  assert.doesNotMatch(composer, /ai-session-composer__error/);
  assert.match(composer, /source: \{ type: "runtime-path", path: runtimePath \}/);
  assert.match(composer, /attachment\.kind === 'file'/);
});

test("composer image attachments expose upload progress, contain previews, and image copy", () => {
  const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
  const upload = fs.readFileSync(new URL("../src/components/ai-session/attachmentUpload.ts", import.meta.url), "utf8");
  const transport = fs.readFileSync(new URL("../src/api/sharedClient.ts", import.meta.url), "utf8");
  assert.match(composer, /role="progressbar"/);
  assert.match(composer, /object-fit: contain/);
  assert.match(composer, /openImagePreview\(attachment\)/);
  assert.match(composer, /ai-session-composer__image-dialog/);
  assert.match(composer, /<ContextMenuItem @select="copyAttachmentImage\(attachment\)">/);
  assert.match(composer, /navigator\.clipboard\.write\(\[new ClipboardItem/);
  assert.match(composer, /imageBlobAsPng/);
  assert.match(upload, /attachment\.uploadState = "uploading"/);
  assert.match(upload, /attachment\.uploadProgress = Math\.max\(0, Math\.min\(1, progress\)\)/);
  assert.match(transport, /requestJsonWithUploadProgress/);
  assert.doesNotMatch(transport, /onUploadProgress:/);
});

test("composer converts only long pure text pastes through the existing file attachment path", () => {
  const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
  assert.match(composer, /classifyAiSessionPastedText\(text, pastedTextSequence\.value \+ 1, props\.maxFileAttachmentBytes/);
  assert.match(composer, /if \(files\.length\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*addFiles\(files\)/);
  assert.match(composer, /decision\.disposition === "inline"\) return/);
  assert.match(composer, /new globalThis\.File\(\[decision\.file\.text\]/);
  assert.match(composer, /addFiles\(\[file\], new Map/);
  assert.match(composer, /<FileText v-if="attachment\.textPresentation"/);
  assert.match(composer, /attachment\.textPresentation\.summary/);
  assert.match(composer, /sessions\.composer\.textLength/);
});

test("conversation detail renders retained image and file metadata without a UI attachment overlay", () => {
  const attachments = fs.readFileSync(new URL("../src/components/ai-session/AiSessionMessageAttachments.vue", import.meta.url), "utf8");
  const timeline = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTimelineView.vue", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
  assert.match(timeline, /turn\.userMessages/);
  assert.match(timeline, /<AiSessionMessageAttachments/);
  assert.match(attachments, /contentState === 'available'/);
  assert.match(attachments, /object-fit: contain/);
  assert.match(attachments, /<Dialog/);
  assert.match(attachments, /<ContextMenuItem @select="copyImage\(attachment\)">/);
  assert.match(attachments, /navigator\.clipboard\.write/);
  assert.match(attachments, /attachment\.contentState === 'expired'/);
  assert.match(attachments, /'Expired' : 'Missing'/);
  assert.match(panel, /getAiSessionDetail/);
  assert.match(panel, /watch\(\(\) => `\$\{props\.instance\.id\}\\u0000\$\{selectedSession\.value\?\.id \|\| ""\}`/);
  assert.doesNotMatch(panel, /selectedSession\.value\?\.updatedAt[\s\S]{0,200}getAiSessionDetail/);
  assert.match(panel, /selectedConversationSession \|\| selectedSession/);
  assert.match(panel, /return \{ \.\.\.session, turns: mergeAiSessionSummaryTurnsWithDetail\(session\.turns, detail\.turns\) \};/);
  assert.doesNotMatch(panel, /session\.turns\s*=.*attachments/);
});

test("desktop runtime paths are limited to the control-plane local node", () => {
  const mentions = fs.readFileSync(new URL("../src/components/ai-session/useAiSessionMentions.ts", import.meta.url), "utf8");
  const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
  assert.match(mentions, /instance\.runtime\?\.type === "local"/);
  assert.match(mentions, /instance\.node\?\.labels\[CONTROL_PLANE_LOCAL_NODE_LABEL\] === "true"/);
  assert.match(board, /runtimePathAccess: desktopRuntimePathAccess\(card\.instance\)/);
  assert.match(panel, /runtimePathAccess: desktopRuntimePathAccess\(props\.instance\)/);
});

test("desktop preload exposes Electron's supported File path bridge", () => {
  const preload = fs.readFileSync(new URL("../../../apps/desktop-shell/src/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /webUtils/);
  assert.match(preload, /getPathForFile: \(file\) => webUtils\.getPathForFile\(file\)/);
});
