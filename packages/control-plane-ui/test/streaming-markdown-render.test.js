import assert from "node:assert/strict";
import test from "node:test";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

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
    const html = await renderToString(app);
    assert.match(html, /data-node-type="code_block"/);
    assert.match(html, /class="ai-session-highlighted-code"/);
    assert.match(html, /<pre><code>实例 A: \[开发, GPU\]/);
    assert.match(html, /实例 B: \[开发\]/);
  } finally {
    await server.close();
  }
});
