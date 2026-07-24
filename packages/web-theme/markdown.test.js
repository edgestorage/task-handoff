import assert from "node:assert/strict";
import test from "node:test";
import { highlightSource, renderMarkdown } from "./markdown.ts";

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
