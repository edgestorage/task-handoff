import assert from "node:assert/strict";
import test from "node:test";
import { handleMarkdownCodeCopy, highlightSource, renderMarkdown } from "./markdown.ts";

test("renderMarkdown renders block Markdown and GFM consistently", () => {
  const html = renderMarkdown([
    "# 标题",
    "",
    "- 苹果",
    "- 香蕉",
    "",
    "1. 第一步",
    "2. 第二步",
    "",
    "| A | B |",
    "| - | - |",
    "| 1 | 2 |",
  ].join("\n"));

  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul>[\s\S]*<li>苹果<\/li>/);
  assert.match(html, /<ol>[\s\S]*<li>第一步<\/li>/);
  assert.match(html, /<div class="markdown-table-wrapper"><table>[\s\S]*<td>2<\/td>/);
});

test("renderMarkdown preserves GFM table column alignment", () => {
  const html = renderMarkdown([
    "| 左对齐 | 居中 | 右对齐 |",
    "| :--- | :---: | ---: |",
    "| Apple | 10 | ¥8.00 |",
  ].join("\n"));

  assert.match(html, /<th align="left">左对齐<\/th>/);
  assert.match(html, /<th align="center">居中<\/th>/);
  assert.match(html, /<th align="right">右对齐<\/th>/);
  assert.match(html, /<td align="right">¥8\.00<\/td>/);
});

test("renderMarkdown preserves Markdown escapes and neutralizes raw HTML", () => {
  const html = renderMarkdown("\\*literal\\*\n\n<script>alert(1)</script>");

  assert.match(html, /<p>\*literal\*<\/p>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("renderMarkdown highlights registered fenced code languages", () => {
  const html = renderMarkdown("```javascript\nconst answer = 42;\n```");

  assert.match(html, /class="hljs language-javascript"/);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<span class="hljs-number">42<\/span>/);
});

test("renderMarkdown optionally renders code language and localized copy controls", () => {
  const html = renderMarkdown("```TypeScript\nconst answer = 42;\n```", {
    codeTools: { copiedLabel: "已复制", copyLabel: "复制", plainTextLabel: "纯文本" },
  });

  assert.match(html, /class="markdown-code-block"/);
  assert.match(html, /class="markdown-code-language">typescript<\/span>/);
  assert.match(html, /class="markdown-code-copy"[^>]*data-copy-label="复制"[^>]*data-copied-label="已复制">复制<\/button>/);
  assert.match(html, /<pre data-language="typescript">/);
});

test("renderMarkdown labels untyped tool-enabled code without changing default output", () => {
  const enhanced = renderMarkdown("```\nplain\n```", {
    codeTools: { copiedLabel: "Copied", copyLabel: "Copy", plainTextLabel: "Plain text" },
  });
  const defaultHtml = renderMarkdown("```\nplain\n```");

  assert.match(enhanced, /class="markdown-code-language">Plain text<\/span>/);
  assert.doesNotMatch(defaultHtml, /markdown-code-toolbar/);
});

test("highlightSource exposes safe reusable syntax highlighting", () => {
  assert.match(highlightSource("const answer = 42;", "typescript"), /hljs-keyword/);
  assert.equal(highlightSource("<script>alert(1)</script>", "unknown"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("renderMarkdown leaves untyped and unknown code blocks as escaped plain text", () => {
  const untyped = renderMarkdown("```\n<div>plain</div>\n```");
  const unknown = renderMarkdown("```not-a-language\n<script>alert(1)</script>\n```");

  assert.doesNotMatch(untyped, /class="hljs/);
  assert.match(untyped, /&lt;div&gt;plain&lt;\/div&gt;/);
  assert.doesNotMatch(unknown, /class="hljs/);
  assert.match(unknown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("renderMarkdown emits KaTeX for inline and block formulas", () => {
  const html = renderMarkdown("行内公式：$E = mc^2$\n\n$$\n\\frac{1}{\\sqrt{2\\pi}}\n$$");

  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /annotation encoding="application\/x-tex">E = mc\^2<\/annotation>/);
});

test("renderMarkdown emits a safe pending container for Mermaid diagrams", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```");

  assert.match(html, /class="markdown-mermaid" data-mermaid-state="pending"/);
  assert.match(html, /<code>graph TD\n  A\[Start\] --&gt; B\[Done\]<\/code>/);
  assert.doesNotMatch(html, /class="hljs/);
});

test("handleMarkdownCodeCopy contains clipboard permission failures", async () => {
  const OriginalElement = globalThis.Element;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  class FakeElement {
    closest(selector) {
      return selector === ".markdown-code-copy" ? button : undefined;
    }
  }
  const button = {
    closest: () => ({ querySelector: () => ({ textContent: "private code" }) }),
    dataset: { copiedLabel: "Copied", copyLabel: "Copy" },
    textContent: "Copy",
  };
  Object.defineProperty(globalThis, "Element", { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } },
  });
  try {
    assert.equal(await handleMarkdownCodeCopy({ target: new FakeElement() }), false);
    assert.equal(button.textContent, "Copy");
  } finally {
    if (OriginalElement === undefined) delete globalThis.Element;
    else Object.defineProperty(globalThis, "Element", { configurable: true, value: OriginalElement });
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});
