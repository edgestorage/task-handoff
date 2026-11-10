import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import * as transitions from "../src/components/ai-session/disclosureTransition.ts";

const source = fs.readFileSync(new URL("../src/components/ai-session/AiSessionToolActivity.vue", import.meta.url), "utf8");
const script = compileScript(parse(source).descriptor, { id: "tool-activity-disclosure-test" });
const compiled = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const modules = {
  vue,
  "vue-i18n": { useI18n: () => ({ t: (key) => key }) },
  "@lucide/vue": {},
  "@task-handoff/web-theme/MarkdownContent.vue": {},
  "./AiSessionActivityGroup.vue": {},
  "./disclosureTransition": transitions,
};
const componentExports = {};
new Function("require", "exports", compiled)((name) => {
  assert.ok(name in modules, `Unexpected import: ${name}`);
  return modules[name];
}, componentExports);

function mountActivity(initial = {}) {
  const props = vue.reactive({
    status: "running",
    interactive: true,
    contentLoaded: false,
    loading: false,
    error: "",
    unavailable: false,
    ...initial,
  });
  const events = [];
  let state;
  const component = {
    ...componentExports.default,
    setup(input, context) {
      state = componentExports.default.setup(input, context);
      return state;
    },
    render: () => null,
  };
  const renderer = vue.createRenderer({
    createComment: () => ({}),
    insert() {},
    remove() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp({
    render: () => vue.h(component, {
      ...props,
      onLoad: () => events.push("load"),
    }),
  });
  app.mount({});
  return {
    props,
    events,
    state,
    stop: () => app.unmount(),
    toggle: () => state.toggleExpanded({ currentTarget: { closest: () => null } }),
  };
}

test("tool activity waits for loaded content before starting its expansion", async (context) => {
  const activity = mountActivity();
  context.after(activity.stop);
  activity.toggle();
  await vue.nextTick();
  assert.deepEqual(activity.events, ["load"]);
  assert.equal(activity.state.expandPending.value, true);
  assert.equal(activity.state.expanded.value, false);
  assert.equal(activity.state.awaitingContent.value, true);

  activity.props.loading = true;
  await vue.nextTick();
  assert.equal(activity.state.expanded.value, false);

  activity.props.loading = false;
  activity.props.contentLoaded = true;
  await vue.nextTick();
  assert.equal(activity.state.expandPending.value, false);
  assert.equal(activity.state.expanded.value, true);

  activity.toggle();
  await vue.nextTick();
  assert.equal(activity.state.expanded.value, false);
  activity.toggle();
  await vue.nextTick();
  assert.equal(activity.state.expanded.value, true);
  assert.deepEqual(activity.events, ["load"]);
});

test("closing while tool activity loads does not reveal it when the response arrives", async (context) => {
  const activity = mountActivity();
  context.after(activity.stop);
  activity.toggle();
  await vue.nextTick();
  activity.toggle();
  await vue.nextTick();
  assert.equal(activity.state.expandPending.value, false);
  activity.props.loading = true;
  await vue.nextTick();
  activity.props.loading = false;
  activity.props.contentLoaded = true;
  await vue.nextTick();
  assert.equal(activity.state.expanded.value, false);
});

test("failed tool activity stays collapsed and can retry into the deferred expansion", async (context) => {
  const activity = mountActivity({ error: "offline" });
  context.after(activity.stop);
  activity.toggle();
  await vue.nextTick();
  assert.deepEqual(activity.events, ["load"]);
  assert.equal(activity.state.loadFailed.value, true);
  assert.equal(activity.state.awaitingContent.value, false);
  assert.equal(activity.state.expanded.value, false);

  activity.toggle();
  await vue.nextTick();
  assert.deepEqual(activity.events, ["load", "load"]);
  activity.props.error = "";
  activity.props.loading = true;
  await vue.nextTick();
  assert.equal(activity.state.expanded.value, false);

  activity.props.loading = false;
  activity.props.contentLoaded = true;
  await vue.nextTick();
  assert.equal(activity.state.expanded.value, true);
});
