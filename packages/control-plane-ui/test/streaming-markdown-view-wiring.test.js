import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const card = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
const dock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
const message = fs.readFileSync(new URL("../src/components/ai-session/AiSessionStreamingMarkdown.vue", import.meta.url), "utf8");
const animatedText = fs.readFileSync(new URL("../src/components/ai-session/AiSessionAnimatedTextNode.vue", import.meta.url), "utf8");
const codeBlock = fs.readFileSync(new URL("../src/components/ai-session/AiSessionCodeBlock.vue", import.meta.url), "utf8");

test("board, instance session cards, and selected details use the streaming Markdown view", () => {
  for (const source of [card, result]) {
    assert.match(source, /AiSessionStreamingMarkdown/);
    assert.match(source, /:is-latest=/);
  }
  for (const source of [dock, panel]) {
    assert.match(source, /AiSessionResult/);
    assert.match(source, /:is-latest=/);
  }
  assert.match(panel, /<AiSessionStreamingMarkdown/);
  assert.match(panel, /import AiSessionStreamingMarkdown from "\.\.\/\.\.\/\.\.\/components\/ai-session\/AiSessionStreamingMarkdown\.vue"/);
  assert.match(panel, /<AiSessionToolActivity/);
  assert.match(panel, /import AiSessionToolActivity from "\.\.\/\.\.\/\.\.\/components\/ai-session\/AiSessionToolActivity\.vue"/);
  assert.match(result, /v-show="displayContent"/);
  assert.match(result, /useStreamingMessagesStore/);
});

test("selected session details use the streaming message view", () => {
  assert.match(panel, /AiSessionResult/);
  assert.match(result, /AiSessionStreamingMarkdown/);
  assert.match(message, /activeMessage\(props\.instanceId, props\.sessionId\)/);
  assert.match(message, /streamingState\.value\?\.receivedText \?\? props\.content/);
  assert.match(result, /streamingMessages\.activeMessage\(props\.instanceId, props\.session\.id\)/);
  assert.match(result, /props\.isLatest/);
});

test("detail exposes an intent-aware shadcn return-to-latest control", () => {
  assert.match(panel, /<Button[\s\S]*?v-if="!isFollowingLatest"[\s\S]*?@click="followLatest"/);
  assert.match(panel, /<ArrowDown :size="16" \/>/);
  assert.match(panel, /new ResizeObserver\(\(\) => scrollFollow\?\.notifyContentResize\(\)\)/);
  assert.match(panel, /data-task-handoff-scroll-viewport/);
  assert.match(panel, /watch\(\(\) => `\$\{props\.instance\.id\}\\u0000\$\{selectedSession\.value\?\.id \|\| ""\}`/);
});

test("streaming Markdown uses markstream pacing with independent character reveal", () => {
  assert.match(message, /useSmoothMarkdownStream/);
  assert.match(message, /const pacing = useSmoothMarkdownStream\(\{/);
  assert.match(message, /minCharsPerSecond: 30/);
  assert.match(message, /maxCharsPerSecond: 240/);
  assert.match(message, /maxCommitFps: 30/);
  assert.match(message, /maxCharsPerCommit: 12/);
  assert.match(message, /pacing\.enqueue\(content\.slice\(previousReceivedContent\.length\)\)/);
  assert.match(message, /:smooth-streaming="false"/);
  assert.match(message, /:typewriter="false"/);
  assert.match(message, /:final="isFinal"/);
  assert.match(message, /:fade="false"/);
  assert.match(message, /activeCharacterAnimations\.value === 0/);
  assert.match(message, /text: AiSessionAnimatedTextNode/);
  assert.match(animatedText, /new Intl\.Segmenter\(undefined, \{ granularity: "grapheme" \}\)/);
  assert.match(animatedText, /v-for="segment in pendingSegments"/);
  assert.match(animatedText, /:key="segment\.id"/);
  assert.match(animatedText, /animation: ai-session-character-fade 150ms ease-out both/);
  assert.match(animatedText, /@animationend\.stop="settleSegment\(segment\.id\)"/);
});

test("streaming Markdown keeps the existing session typography, semantic colors, code blocks, and tables", () => {
  assert.match(message, /class="ai-session-streaming-markdown"/);
  assert.match(message, /--ms-text-body: 1em/);
  assert.match(message, /--ms-leading-body: 1\.55/);
  assert.match(message, /--ms-flow-codeblock-y: 0\.75em/);
  assert.match(message, /--list-marker: var\(--markdown-text-color, var\(--text-strong, currentColor\)\)/);
  assert.match(message, /--list-counter-marker: var\(--markdown-text-color, var\(--text-strong, currentColor\)\)/);
  assert.match(message, /--blockquote-fg: var\(--markdown-muted-color, var\(--text-muted, currentColor\)\)/);
  assert.match(message, /--blockquote-border: var\(--markdown-border-color, var\(--line-strong, currentColor\)\)/);
  assert.match(message, /--hr-border: var\(--markdown-border-color, var\(--line, currentColor\)\)/);
  assert.match(message, /--link-color: var\(--markdown-link-color, var\(--brand-accent, currentColor\)\)/);
  assert.match(message, /--footnote-border: var\(--markdown-border-color, var\(--line, currentColor\)\)/);
  assert.match(message, /setCustomComponents\(markdownScopeId/);
  assert.match(message, /code_block: AiSessionCodeBlock/);
  assert.match(codeBlock, /renderCodeBlock/);
  assert.match(message, /\.hljs-keyword/);
  assert.match(message, /:deep\(pre code\)/);
  assert.match(message, /:deep\(\.table-node-wrapper\)/);
  assert.match(message, /scrollbar-gutter: auto/);
  assert.match(message, /:deep\(table\.table-node\)/);
  assert.match(message, /\.table-node tbody tr:nth-child\(even\)/);
  assert.match(message, /--markdown-table-hover-bg/);
});
