import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("story decisions reuse the directory card header and flat row pattern", () => {
  const panel = read("src/apps/control-plane/story/StoryDecisionPanel.vue");

  // The directory section owns the border; the panel only paints the card surface.
  assert.match(panel, /\.story-decisions\s*\{\s*background:\s*var\(--surface-raised\);\s*\}/);

  // Directory header: full-bleed divider, strong 13px title, 12px card padding.
  assert.match(panel, /\.story-decisions-heading\s*\{[^}]*min-height:\s*38px;[^}]*border-bottom:\s*1px solid var\(--line\);[^}]*padding:\s*4px 12px;/);
  assert.match(panel, /\.story-decisions-heading h3\s*\{[^}]*color:\s*var\(--text-strong\);[^}]*font-size:\s*13px;[^}]*font-weight:\s*500;/);

  // Rows: full-bleed separators with 12px horizontal padding instead of nested cards.
  assert.match(panel, /\.story-decision-row\s*\{[^}]*border-top:\s*1px solid var\(--line\);[^}]*padding:\s*10px 12px;/);
  assert.match(panel, /\.story-decisions-heading \+ \.story-decision-row\s*\{\s*border-top:\s*0;\s*\}/);
  assert.doesNotMatch(panel, /\.story-decision-row\s*\{[^}]*background:\s*var\(--surface-inset\)/);

  // States keep the card padding instead of hugging the section border.
  assert.match(panel, /\.story-decision-state\s*\{[^}]*padding:\s*11px 12px;/);
  assert.match(panel, /\.story-decision-empty-state\s*\{[^}]*justify-content:\s*center;[^}]*min-height:\s*64px;[^}]*padding:\s*16px 12px;/);
});

test("decision rows trail the status pill and delegate answering to the shared answer block", () => {
  const panel = read("src/apps/control-plane/story/StoryDecisionPanel.vue");

  // The status pill trails the row like other resource rows; question and meta stack in the content column.
  assert.match(panel, /\.story-decision-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\) auto;[^}]*column-gap:\s*8px;/);
  assert.match(panel, /\.story-decision-copy\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/);
  assert.match(panel, /\.story-decision-status\s*\{[^}]*border:\s*1px solid var\(--line\);[^}]*font-size:\s*12px;/);
  assert.match(panel, /\.story-decision-status\[data-status="pending"\]\s*\{[^}]*background:\s*var\(--status-warning-bg\);[^}]*color:\s*var\(--status-warning\);/);
  assert.match(panel, /\.story-decision-status\[data-status="decided"\]\s*\{[^}]*background:\s*var\(--status-success-bg\);[^}]*color:\s*var\(--status-success\);/);
  assert.match(panel, /\.story-decision-question\s*\{[^}]*color:\s*var\(--text-strong\);[^}]*font-size:\s*13px;/);

  // Pending decisions answer through the shared block instead of an inline form.
  assert.match(panel, /\.story-decision-actions\s*\{[^}]*grid-column:\s*1 \/ -1;/);
  assert.match(panel, /<StoryDecisionAnswer[\s\S]*?:decision="decision"[\s\S]*?:disabled="disabled"[\s\S]*?:busy="busyId === decision\.id"[\s\S]*?@submit="\(input\) => submit\(decision, input\)"[\s\S]*?@cancel="cancel\(decision\)"/);
  assert.match(panel, /import StoryDecisionAnswer from "\.\/StoryDecisionAnswer\.vue"/);
  assert.doesNotMatch(panel, /story-decision-option/);
  assert.doesNotMatch(panel, /<Textarea/);

  // The outcome (reply plus continued turn) is one clamped meta line instead of a read-only notice.
  assert.match(panel, /\.story-decision-meta\s*\{[^}]*overflow:\s*hidden;[^}]*font-size:\s*12px;/);
  assert.match(panel, /\{\{ decisionMeta\(decision\) \}\}/);
  assert.doesNotMatch(panel, /stories\.decisions\.readOnly/);

  // History stays behind the shared disclosure pattern with the session-style guide line.
  assert.match(panel, /\.story-decision-history-summary\s*\{[^}]*width:\s*100%;[^}]*padding:\s*10px 12px;/);
  assert.match(panel, /\.story-decision-history-summary\[aria-expanded="true"\] svg\s*\{\s*transform:\s*rotate\(90deg\);\s*\}/);
  assert.match(panel, /\.story-decision-history-content\s*\{[^}]*margin-left:\s*12px;[^}]*border-left:\s*1px solid var\(--line-subtle\);/);
});

test("the shared answer block renders numbered options and reveals the reply field on selection", () => {
  const answer = read("src/apps/control-plane/story/StoryDecisionAnswer.vue");

  // Options are numbered rows; the selected row and its number both pick up the accent tone.
  assert.match(answer, /class="story-decision-choices" role="radiogroup"/);
  assert.match(answer, /role="radio"[\s\S]*?class="story-decision-choice"[\s\S]*?:aria-checked="selectedOptionId === option\.id"/);
  assert.match(answer, /class="story-decision-choice-index" aria-hidden="true">\{\{ index \+ 1 \}\}/);
  assert.match(answer, /class="story-decision-choice-index" aria-hidden="true">\{\{ decision\.options\.length \+ 1 \}\}/);
  assert.doesNotMatch(answer, /Check/);
  assert.match(answer, /\.story-decision-choice\[aria-checked="true"\]\s*\{[^}]*background:\s*var\(--brand-accent-soft\);/);
  assert.match(answer, /\.story-decision-choice\[aria-checked="true"\] \.story-decision-choice-index\s*\{[^}]*background:\s*var\(--brand-accent\);[^}]*color:\s*var\(--brand-accent-foreground\);/);
  assert.match(answer, /\.story-decision-choice-index\s*\{[^}]*border-radius:\s*6px;[^}]*font-variant-numeric:\s*tabular-nums;/);

  // The free-text reply is one more option: its field only appears once that row is picked.
  assert.match(answer, /:aria-checked="replySelected"/);
  assert.match(answer, /v-if="replySelected" class="story-decision-reply"/);
  assert.match(answer, /\.story-decision-reply\s*\{[^}]*margin:2px 0 2px 30px;/);

  // Submit and cancel stay left aligned under the list.
  assert.match(answer, /\.story-decision-buttons\s*\{[^}]*display:flex;[^}]*gap:8px;/);
  assert.doesNotMatch(answer, /\.story-decision-buttons\s*\{[^}]*justify-content:\s*flex-end/);

  // Submit is a bordered outline action like the other inline card actions, not the primary color button.
  assert.match(answer, /<Button variant="outline" size="sm" :disabled="disabled \|\| busy \|\| !canSubmit" @click="submit">/);
});
