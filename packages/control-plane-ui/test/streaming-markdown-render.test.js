import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("text fenced code blocks retain their content alongside animated text", async () => {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    root,
    server: { middlewareMode: true },
  });

  try {
    const { default: StreamingMarkdown } = await server.ssrLoadModule(
      "/src/components/ai-session/AiSessionStreamingMarkdown.vue",
    );
    const content = [
      "例如：",
      "",
      "```text",
      "实例 A: [开发, GPU]",
      "实例 B: [开发]",
      "```",
      "",
      "展示为：",
    ].join("\n");
    const app = createSSRApp({
      render: () => h(StreamingMarkdown, {
        content,
        instanceId: "instance-test",
        sessionId: "session-test",
      }),
    });
    app.use(createControlPlaneI18nForTest());
    const html = await renderToString(app);
    assert.match(html, /data-node-type="code_block"/);
    assert.match(html, /class="ai-session-highlighted-code"/);
    assert.match(html, /class="markdown-code-copy"/);
    assert.match(html, />Copy<\/button>/);
    assert.match(html, /<pre[^>]*><code>实例 A: \[开发, GPU\]/);
    assert.match(html, /实例 B: \[开发\]/);
  } finally {
    await server.close();
  }
});

test("consecutive fenced code blocks keep flow spacing on the code node wrapper", () => {
  const codeBlock = fs.readFileSync(
    new URL("../src/components/ai-session/AiSessionCodeBlock.vue", import.meta.url),
    "utf8",
  );
  const streamingMarkdown = fs.readFileSync(
    new URL("../src/components/ai-session/AiSessionStreamingMarkdown.vue", import.meta.url),
    "utf8",
  );

  assert.match(codeBlock, /\.ai-session-highlighted-code \{\s*margin: 0\.75em 0;/);
  assert.match(codeBlock, /:deep\(\.markdown-code-block\) \{[\s\S]*?margin: 0;/);
  assert.doesNotMatch(streamingMarkdown, /\.ai-session-highlighted-code > :(?:first|last)-child/);
});
