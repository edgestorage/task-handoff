import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import * as surfaces from "../src/apps/control-plane/instance-detail/sessionRemoteDesktopSurfaces.ts";

function component(name, modules) {
  const source = fs.readFileSync(new URL(`../src/components/remote-desktop/${name}.vue`, import.meta.url), "utf8");
  const script = compileScript(parse(source).descriptor, { id: name, inlineTemplate: true });
  const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function("require", "exports", code)(key => {
    if (key === "vue") return vue;
    if (key.endsWith("sessionRemoteDesktopSurfaces.ts")) return surfaces;
    if (key in modules) return modules[key];
    throw new Error(`Unexpected import ${key}`);
  }, exports);
  return exports.default;
}

const tick = async () => { await vue.nextTick(); await vue.nextTick(); await vue.nextTick(); };

test("real surface templates move one viewer between preview and detail without reconnecting or update loops", async t => {
  let created = 0, destroyed = 0;
  let viewer;
  const records = [], closed = [];
  const Viewer = {
    props: ["instanceId", "active", "preview", "autoConnect", "initialTarget", "capabilities", "canManage", "embedded"],
    emits: ["frame", "selectionChange", "stopped"],
    setup(props, { emit }) {
      created++;
      viewer = { props, emit };
      vue.onBeforeUnmount(() => destroyed++);
      return () => vue.h("section");
    },
  };
  const Host = component("SessionRemoteDesktopSurfaceHost", {
    "../../apps/control-plane/instance-detail/InstanceRemoteDesktopViewer.vue": Viewer,
    "../../apps/control-plane/instance-detail/sessionRemoteDesktopLinks.ts": {
      rememberSessionRemoteDesktopLink: r => records.push(r), removeSessionRemoteDesktopLink() {},
    },
    "../../apps/control-plane/instance-detail/sessionRemoteDesktopEvents.ts": { requestCloseSessionRemoteDesktop: d => closed.push(d) },
  });
  const Surface = component("SessionRemoteDesktopSurface", {});
  const state = vue.reactive({ preview: true, detail: false, visible: true });
  const registry = surfaces.createSessionRemoteDesktopSurfaces();
  const errors = [], drawings = [];
  const node = type => vue.markRaw({ type, children: [], parent: null, getContext: () => ({ drawImage: (...args) => drawings.push(args) }) });
  const remove = n => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; };
  const renderer = vue.createRenderer({
    createElement: node, createText: text => ({ ...node("text"), text }), createComment: node,
    setText(n, text) { n.text = text; }, setElementText(n, text) { n.text = text; },
    patchProp(n, key, _previous, value) { n[key] = value; },
    insert(n, parent, anchor) { remove(n); n.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(n); else parent.children.splice(index, 0, n); },
    remove, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1],
  });
  const app = renderer.createApp({
    setup() {
      vue.provide(surfaces.sessionRemoteDesktopSurfacesKey, registry);
      return () => vue.h("main", [
        state.preview ? vue.h(Surface, { instanceId: "i", sessionId: "s", preview: true, active: state.visible }) : null,
        state.detail ? vue.h(Surface, { instanceId: "i", sessionId: "s" }) : null,
        vue.h(Host, { surfaces: registry, canManage: false }),
      ]);
    },
  });
  app.config.errorHandler = error => errors.push(error);
  app.mount(node("root"));
  t.after(() => app.unmount());
  await tick();
  assert.deepEqual(errors, []);
  assert.equal(created, 1);
  assert.equal(viewer.props.active, true);
  assert.equal(viewer.props.preview, true);
  // Opening details closes the preview in the same render. The temporary lack
  // of a destination must not dispose the shared connection.
  state.preview = false;
  state.detail = true;
  await tick();
  assert.equal(created, 1);
  assert.equal(destroyed, 0);
  assert.equal(viewer.props.preview, false);
  state.preview = true;
  await tick();
  assert.equal(created, 1);
  viewer.emit("frame", { source: {}, width: 1920, height: 1080 });
  assert.equal(drawings.length, 1);
  assert.deepEqual(drawings[0].slice(1), [0, 0, 960, 540]);
  const target = { kind: "window", sourceRef: "w", title: "Editor", subtitle: null, width: 100, height: 100 };
  viewer.emit("selectionChange", target);
  await tick();
  assert.equal(records.at(-1).target, target);
  state.detail = false;
  await tick();
  assert.equal(viewer.props.preview, true);
  assert.equal(created, 1);
  state.visible = false;
  await tick();
  assert.equal(viewer.props.active, false);
  assert.equal(destroyed, 0);
  state.preview = false;
  await tick();
  assert.equal(destroyed, 1);
  assert.equal(closed.length, 0);
  assert.deepEqual(errors, []);
});
