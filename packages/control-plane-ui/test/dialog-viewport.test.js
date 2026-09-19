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

test("new instance dialog scrolls only the form panel", () => {
  const modal = read("apps/control-plane/NewInstanceModal.vue");

  assert.match(modal, /<div class="new-instance-body">\s*<fieldset class="new-instance-fields"/);
  assert.match(modal, /<nav class="wizard-steps"[\s\S]*<ScrollArea class="wizard-panel-scroll" :horizontal="false">\s*<div class="wizard-panel">/);
  assert.match(modal, /<\/fieldset>\s*<\/div>\s*<div class="modal-actions">/);
  assert.match(modal, /grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  assert.match(modal, /\.wizard-panel-scroll \{\s*min-width: 0;\s*min-height: 0;/);
});

test("new instance dialog uses light-theme-safe foreground colors", () => {
  const modal = read("apps/control-plane/NewInstanceModal.vue");

  assert.match(modal, /\.panel-close \{[^}]*color: var\(--text-muted\);/);
  assert.match(modal, /\.wizard-steps button\.complete \{\s*color: var\(--brand-accent\);\s*\}/);
  assert.doesNotMatch(modal, /\.panel-close \{[^}]*color: var\(--brand-accent-muted\);/);
  assert.doesNotMatch(modal, /\.wizard-steps button\.complete \{[^}]*color: var\(--brand-accent-muted\);/);
});
