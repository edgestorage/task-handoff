import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("shared dialogs preserve a 50px viewport margin", () => {
  const dialog = read("components/ui/dialog/DialogContent.vue");
  const alertDialog = read("components/ui/alert-dialog/AlertDialogContent.vue");

  assert.match(dialog, /:style="\[\{ maxHeight: 'calc\(100dvh - 100px\)' \}, props\.style\]"/);
  assert.match(alertDialog, /:style="\{ maxHeight: 'calc\(100dvh - 100px\)' \}"/);
});

test("long Story action dialogs scroll only their form body", () => {
  const story = read("apps/control-plane/story/StoryView.vue");
  const actionEditor = read("apps/control-plane/story/StoryActionEditorContent.vue");

  assert.match(story, /<ScrollArea class="story-action-editor-scroll" :horizontal="false">\s*<StoryActionEditorContent/);
  assert.match(actionEditor, /<div class="story-editor-fields story-action-editor-fields">/);
  assert.match(story, /:global\(\.story-editor-dialog\.story-action-editor-dialog\) \{[^}]*max-width:840px;[^}]*grid-template-rows:auto minmax\(0,1fr\) auto;[^}]*overflow:hidden;/);
  assert.match(story, /:global\(\.story-action-editor-scroll\) \{ min-height:0; \}/);
  assert.match(story, /:global\(\.story-editor-dialog\) \{ max-width:460px; \}/);
});
