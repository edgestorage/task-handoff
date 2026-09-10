import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import * as transitions from "../src/components/ai-session/disclosureTransition.ts";
import * as activities from "../src/components/ai-session/timelineActivities.ts";

const source = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTurnHistory.vue", import.meta.url), "utf8");
const script = compileScript(parse(source).descriptor, { id: "history-disclosure-test" });
const compiled = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const modules = {
  vue,
  "vue-i18n": { useI18n: () => ({ t: (key) => key }) },
  "@lucide/vue": {},
  "@task-handoff/web-theme/MarkdownContent.vue": {},
  "./AiSessionActivityGroup.vue": {},
  "./timelineActivities": activities,
  "./disclosureTransition": transitions,
};
const componentExports = {};
new Function("require", "exports", compiled)((name) => {
  assert.ok(name in modules, `Unexpected import: ${name}`);
  return modules[name];
}, componentExports);

function mountHistory(initial = {}) {
  const props = vue.reactive({ nodes: [], loadable: true, loading: false, ...initial });
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
  const app = renderer.createApp({ render: () => vue.h(component, {
    ...props,
    onLoad: () => events.push("load"),
    onRetry: () => events.push("retry"),
  }) });
  app.mount({});
  return { props, events, state, stop: () => app.unmount(), toggle: () => state.toggleHistory({ currentTarget: { closest: () => null } }) };
}

test("lazy history waits for content before starting its single expansion", async (context) => {
  const history = mountHistory();
  context.after(history.stop);
  history.toggle();
  await vue.nextTick();
  assert.deepEqual(history.events, ["load"]);
  assert.equal(history.state.historyRevealed.value, false);
  history.props.loading = true;
  history.props.loadable = false;
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, false);
  history.props.nodes = [{ id: "message" }];
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, false);
  history.props.loading = false;
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, true);
  history.toggle();
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, false);
  history.toggle();
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, true);
  assert.deepEqual(history.events, ["load"]);
});

test("closing during loading does not reveal content when the response arrives", async (context) => {
  const history = mountHistory();
  context.after(history.stop);
  history.toggle();
  await vue.nextTick();
  history.toggle();
  await vue.nextTick();
  history.props.nodes = [{ id: "message" }];
  history.props.loadable = false;
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, false);
});

test("an expanded history stays visible during authoritative refresh", async (context) => {
  const history = mountHistory({ nodes: [{ id: "message" }], loadable: false });
  context.after(history.stop);
  history.toggle();
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, true);
  history.props.loadable = true;
  await vue.nextTick();
  history.props.loading = true;
  history.props.loadable = false;
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, true);
  assert.deepEqual(history.events, ["load"]);
});

test("only the ready history panel participates in the height transition", () => {
  assert.match(source, /<div v-if="historyRevealed" class="ai-session-turn-history-disclosure">/);
  assert.doesNotMatch(source, /v-if="loading && !nodes.length"/);
  assert.match(source, /if \(historyRevealed.value\) beginDisclosureTransition/);
});

test("retry keeps the body collapsed until the response is ready", async (context) => {
  const history = mountHistory({ loadable: false, error: "failed" });
  context.after(history.stop);
  history.state.retryHistory();
  history.props.loading = true;
  history.props.error = undefined;
  await vue.nextTick();
  assert.deepEqual(history.events, ["retry"]);
  assert.equal(history.state.historyRevealed.value, false);
  history.props.nodes = [{ id: "message" }];
  history.props.loading = false;
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, true);
});

test("an empty response never expands an empty loading placeholder", async (context) => {
  const history = mountHistory();
  context.after(history.stop);
  history.toggle();
  await vue.nextTick();
  history.props.loadable = false;
  await vue.nextTick();
  assert.equal(history.state.historyRevealed.value, false);
});
