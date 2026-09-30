import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { resolveFinalReadyAction } from "../src/components/ai-session/aiSessionFinalReady.ts";

test("streaming content or unfinished pacing always drops the final render mode", () => {
  assert.equal(resolveFinalReadyAction({ streaming: true, pacingFinal: true, activeAnimations: 0 }), "reset");
  assert.equal(resolveFinalReadyAction({ streaming: false, pacingFinal: false, activeAnimations: 0 }), "reset");
  assert.equal(resolveFinalReadyAction({ streaming: true, pacingFinal: false, activeAnimations: 4 }), "reset");
});

test("running character animations only postpone the final render mode", () => {
  assert.equal(resolveFinalReadyAction({ streaming: false, pacingFinal: true, activeAnimations: 1 }), "wait");
  assert.equal(resolveFinalReadyAction({ streaming: false, pacingFinal: true, activeAnimations: 60 }), "wait");
});

test("a settled stream with no running animations promotes to the final render mode", () => {
  assert.equal(resolveFinalReadyAction({ streaming: false, pacingFinal: true, activeAnimations: 0 }), "promote");
});

test("animations started by the final re-render never demote the settled final mode", () => {
  let finalReady = false;
  const settle = (state) => {
    const action = resolveFinalReadyAction(state);
    if (action === "reset") finalReady = false;
    else if (action === "promote") finalReady = true;
    return action;
  };

  assert.equal(settle({ streaming: false, pacingFinal: true, activeAnimations: 0 }), "promote");
  assert.equal(finalReady, true);

  // Switching to the final parse can reveal additional characters, which starts
  // fresh reveal animations while the stream itself is already settled.
  assert.equal(settle({ streaming: false, pacingFinal: true, activeAnimations: 60 }), "wait");
  assert.equal(finalReady, true);

  assert.equal(settle({ streaming: false, pacingFinal: true, activeAnimations: 0 }), "promote");
  assert.equal(finalReady, true);

  // A new stream may still demote the final mode.
  assert.equal(settle({ streaming: true, pacingFinal: false, activeAnimations: 0 }), "reset");
  assert.equal(finalReady, false);
});

test("the streaming Markdown view resolves the final mode through the shared state machine", () => {
  const source = fs.readFileSync(
    new URL("../src/components/ai-session/AiSessionStreamingMarkdown.vue", import.meta.url),
    "utf8",
  );
  assert.match(source, /resolveFinalReadyAction\(\{ streaming, pacingFinal, activeAnimations \}\)/);
  assert.match(source, /if \(action === "reset"\) \{\s*finalReady\.value = false;\s*return;\s*\}/);
  assert.doesNotMatch(source, /finalReady\.value = false;\s*if \(streaming \|\| !pacingFinal \|\| activeAnimations > 0\) return;/);
});
