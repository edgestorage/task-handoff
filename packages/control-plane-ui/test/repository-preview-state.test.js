import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import * as locations from "../src/apps/control-plane/instance-detail/repositoryFilePath.ts";
import * as previews from "../src/apps/control-plane/instance-detail/repositoryPreview.ts";
import * as links from "../src/components/ai-session/markdown-link-target.ts";

const componentRoot = new URL("../src/apps/control-plane/instance-detail/", import.meta.url);
class ApiError extends Error { constructor(code) { super(code); this.code = code; } }
const tick = async () => { await new Promise(setImmediate); await vue.nextTick(); };
const context = { availability: "not-worktree", displayName: "project", repositoryRoot: "/workspace/project", cwdRelativePath: "session/subdir" };
const entry = (path, kind = "file") => ({ path, name: path.split("/").at(-1), kind, traversable: kind === "directory" });

function mountComponent(name, initialProps, modules) {
  const source = fs.readFileSync(new URL(name, componentRoot), "utf8");
  const script = compileScript(parse(source).descriptor, { id: name });
  const compiled = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)((key) => {
    if (key === "vue") return vue;
    if (key === "vue-i18n") return { useI18n: () => ({ t: (key) => key }) };
    if (key in modules) return modules[key];
    if (key.endsWith(".vue") || key.startsWith("../../../components/ui/") || key === "@lucide/vue") return {};
    throw new Error(`Unexpected import: ${key}`);
  }, exports);
  const props = vue.reactive(initialProps);
  const events = [];
  let state;
  const component = {
    ...exports.default,
    setup(input, ctx) { state = exports.default.setup(input, ctx); return state; },
    render: () => null,
  };
  const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ render: () => vue.h(component, { ...props, onOpenFile: (value) => events.push(value) }) });
  app.mount({});
  return { props, state, events, stop: () => app.unmount() };
}

async function workspace(t, apiOverrides = {}, propOverrides = {}) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = {};
  globalThis.window = { setTimeout, clearTimeout };
  const calls = [];
  const api = {
    async getRepositoryDirectory(_target, path) { calls.push(["directory", path]); return { path, entries: path ? [entry("docs/guide.md")] : [entry("docs", "directory"), entry("README.md")] }; },
    async getRepositoryFile(_target, path) { calls.push(["text", path]); return { path, content: "# Heading\n\nBody", version: "version", byteLength: 15, mode: {} }; },
    async getRepositoryFileContentHeaders(_target, path) { calls.push(["raw", path]); return new Headers({ "content-type": "video/mp4" }); },
    async searchRepositoryPaths(_target, query) { return { entries: [entry(`${query}.md`)], truncated: false }; },
    ...apiOverrides,
  };
  const mounted = mountComponent("RepositoryWorkspace.vue", { context, instanceId: "instance", sessionId: "session", sessionKind: "ai-session", pathSearchSupported: true, fileContentSupported: true, ...propOverrides }, {
    "@tanstack/vue-query": { useQueryClient: () => ({ setQueryData() {} }) },
    "../../../api/client": { ApiError },
    "../../../api/repository": api,
    "./repositoryFilePath": locations,
    "./repositoryPreview": previews,
  });
  t.after(() => { mounted.stop(); globalThis.document = previousDocument; globalThis.window = previousWindow; });
  await tick();
  return { ...mounted, calls };
}

test("the initial browser uses loaded root files and shares expanded/search state with the breadcrumb picker", async (t) => {
  const { state, calls } = await workspace(t);
  assert.equal(state.activeTab.value, undefined);
  assert.deepEqual(state.breadcrumbSegments.value.map((part) => part.label), ["project"]);
  assert.deepEqual(state.workspaceTreeNodes.value.map((node) => node.path), ["docs", "README.md"]);
  await state.toggleDirectory(entry("docs", "directory"));
  await state.updateBreadcrumbPicker(0, state.breadcrumbSegments.value[0], true);
  assert.deepEqual(state.workspaceTreeNodes.value.map((node) => node.path), ["docs", "docs/guide.md", "README.md"]);
  assert.equal(calls.filter(([type, path]) => type === "directory" && path === "").length, 1);
  state.fileSearch.value = "read";
  await new Promise((resolve) => setTimeout(resolve, 210));
  assert.equal(state.workspaceTreeNodes.value[0].path, "read.md");
  state.openBreadcrumbIndex.value = undefined;
  await tick();
  assert.equal(state.fileSearch.value, "read");
  assert.equal(state.workspaceTreeNodes.value[0].path, "read.md");
});

test("Markdown defaults to rendered preview and source-line requests always select source, including cached files", async (t) => {
  const { state, calls } = await workspace(t);
  await state.openFile({ path: "README.md" });
  await tick();
  assert.equal(state.activeTabIsMarkdown.value, true);
  assert.equal(state.markdownView.value, "preview");
  state.setMarkdownView("source");
  assert.equal(state.markdownView.value, "source");
  await state.openFile({ path: "README.md", line: 2 });
  await tick();
  state.setMarkdownView("preview");
  await state.openFile({ path: "README.md", line: 2 });
  assert.equal(state.markdownView.value, "source");
  assert.equal(calls.filter(([type]) => type === "text").length, 1);
  await state.openFile({ path: "index.ts" });
  assert.equal(state.activeTabIsMarkdown.value, false);
});

test("media uses raw metadata instead of the text reader and chooses a viewer from the authoritative MIME", async (t) => {
  const { state, calls } = await workspace(t);
  await state.openFile({ path: "recording.PNG" });
  assert.deepEqual(calls.filter(([type]) => type === "text"), []);
  assert.equal(state.activeTab.value.kind, "media");
  assert.equal(state.activeTab.value.previewKind, "video");
  assert.equal(state.openingFilePath.value, undefined);
});

test("unknown binary and large text files use a download view after an explicit text-reader rejection", async (t) => {
  const { state } = await workspace(t, {
    async getRepositoryFile() { throw new ApiError("REPOSITORY_FILE_BINARY"); },
    async getRepositoryFileContentHeaders() { return new Headers({ "content-type": "application/octet-stream" }); },
  });
  await state.openFile({ path: "archive.bin" });
  assert.equal(state.activeTab.value.previewKind, "download");
  assert.equal(state.fileOpenError.value, undefined);
});

test("v0.0.49 instances without raw-file capability keep text browsing and never receive content requests", async (t) => {
  const { state, calls } = await workspace(t, {}, { fileContentSupported: false });
  await state.openFile({ path: "README.md" });
  assert.equal(state.activeTab.value.kind, "file");
  await state.openFile({ path: "photo.png" });
  assert.equal(calls.some(([type]) => type === "raw"), false);
});

test("a late media response cannot replace a subsequently selected text file", async (t) => {
  let finish;
  const { state } = await workspace(t, { getRepositoryFileContentHeaders: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = state.openFile({ path: "movie.mp4" });
  assert.equal(state.openingFilePath.value, "movie.mp4");
  await state.openFile({ path: "README.md" });
  finish(new Headers({ "content-type": "video/mp4" }));
  await pending;
  assert.equal(state.activeTab.value.path, "README.md");
  assert.equal(state.tabs.value.length, 1);
});

test("viewer selection covers browser-supported images, audio, video, PDF and unknown files", () => {
  for (const [mime, kind] of [["image/svg+xml", "image"], ["video/webm", "video"], ["audio/mpeg", "audio"], ["application/pdf", "pdf"], ["application/zip", "download"]]) {
    assert.equal(previews.repositoryMediaKind(`${mime}; charset=utf-8`), kind);
  }
});

test("Markdown images resolve relative to the document rather than the session cwd and cannot escape the repository", async (t) => {
  const mounted = mountComponent("RepositoryMarkdownPreview.vue", {
    content: "", context, path: "docs/guide.md", target: { instanceId: "i", sessionId: "s", sessionKind: "ai-session" }, fileContentSupported: true,
  }, {
    "../../../api/repository": { repositoryFileContentUrl: (_target, path) => `/raw?${new URLSearchParams({ path })}` },
    "../../../components/ai-session/markdown-link-target": links,
    "../../../lib/desktopBridge": {},
  });
  t.after(mounted.stop);
  assert.equal(mounted.state.resolveImageSrc("./images/a%20b.png"), "/raw?path=docs%2Fimages%2Fa+b.png");
  assert.equal(mounted.state.resolveImageSrc("../../secret.png"), undefined);
  assert.equal(mounted.state.resolveImageSrc("javascript:alert(1)"), undefined);
  assert.equal(mounted.state.resolveImageSrc("https://example.com/a.png"), "https://example.com/a.png");
  mounted.props.fileContentSupported = false;
  await vue.nextTick();
  assert.equal(mounted.state.resolveImageSrc("./a.png"), undefined);
});

test("Markdown file links use the document directory and same-file source fragments preserve the requested line", async (t) => {
  const previousElement = globalThis.Element;
  globalThis.Element = class { closest() { return this; } getAttribute() { return this.href; } };
  const mounted = mountComponent("RepositoryMarkdownPreview.vue", {
    content: "", context, path: "docs/guide.md", target: {}, fileContentSupported: true,
  }, {
    "../../../api/repository": {},
    "../../../components/ai-session/markdown-link-target": links,
    "../../../lib/desktopBridge": {},
  });
  t.after(() => { mounted.stop(); globalThis.Element = previousElement; });
  const click = async (href) => {
    const target = new Element();
    target.href = href;
    let prevented = false;
    await mounted.state.handleLinkClick({ target, preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true);
  };
  await click("../README.md");
  assert.deepEqual(mounted.events[0], { path: "README.md", line: undefined, column: undefined });
  await click("#L12");
  assert.deepEqual(mounted.events[1], { path: "docs/guide.md", line: 12, column: undefined });
  await click("#section");
  await click("javascript:alert(1)");
  assert.equal(mounted.events.length, 2);
});
