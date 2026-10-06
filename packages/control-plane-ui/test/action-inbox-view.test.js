import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
const workbenchStyles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");
const inbox = fs.readFileSync(new URL("../src/apps/control-plane/action-inbox/ActionInbox.vue", import.meta.url), "utf8");

test("collapsed entry appears between the user/settings control and the right sidebar", () => {
  const userMenu = workbench.indexOf('<DropdownMenu v-else>');
  const collapsedIcon = workbench.indexOf('v-if="!standaloneMode && actionInboxCollapsed"');
  const sidebar = workbench.indexOf('<PanelRight :size="16"');
  assert.ok(userMenu < collapsedIcon && collapsedIcon < sidebar);
  assert.match(workbench, /class="control-plane-icon-button action-inbox-trigger"[\s\S]*:class="\{ 'action-inbox-trigger-empty': !actionInboxItems\.length \}"/);
  assert.match(workbench, /@click="expandActionInbox"/);
  assert.match(workbench, /function expandActionInbox\(\) \{\s*if \(!actionInboxItems\.value\.length && !actionInboxError\.value\) return;/);
  assert.match(workbenchStyles, /\.control-plane-actions \.control-plane-icon-button\.inline-flex\s*\{[\s\S]*border:\s*1px solid transparent;/);
  assert.match(workbenchStyles, /\.action-inbox-trigger-count\s*\{[\s\S]*position:\s*absolute;[\s\S]*border-radius:\s*999px;/);
  assert.match(workbench, /<ActionInbox\s+v-if="!standaloneMode"[\s\S]*?@collapse="actionInboxCollapsed = true"/);
});

test("collapsed entry animates its own divider slot so the left controls slide left", () => {
  const slot = workbench.indexOf('<div v-if="!standaloneMode && actionInboxCollapsed" class="action-inbox-slot">');
  const slotDivider = workbench.indexOf('<span class="story-resource-toggle-divider" aria-hidden="true" />', slot);
  const trigger = workbench.indexOf('class="control-plane-icon-button action-inbox-trigger"', slot);
  assert.ok(slot < slotDivider && slotDivider < trigger);
  assert.match(workbench, /<Transition name="action-inbox-slot">/);
  assert.match(workbenchStyles, /\.action-inbox-slot\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?width:\s*39px;/);
  assert.match(workbenchStyles, /\.action-inbox-slot-enter-active,\s*\.action-inbox-slot-leave-active\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?transition:[^;]*width/);
  assert.match(workbenchStyles, /\.action-inbox-slot-enter-from,\s*\.action-inbox-slot-leave-to\s*\{\s*width:\s*0;/);
  assert.match(workbenchStyles, /\.action-inbox-slot-enter-from,\s*\.action-inbox-slot-leave-to\s*\{\s*width:\s*0;\s*margin-left:\s*-8px;/);
  assert.match(workbenchStyles, /transition:[^;]*margin-left 180ms/);
});

test("expanded inbox renders one panel with the collapse tab jutting out of its top border", () => {
  assert.match(inbox, /<aside v-if="!collapsed && \(items\.length \|\| error\)" class="action-inbox"/);
  assert.doesNotMatch(inbox, /action-inbox-empty/);
  // The collapse control is a capsule handle on the panel edge, rendered ahead of the panel surface.
  assert.match(inbox, /<Button variant="outline" size="sm" class="action-inbox-collapse"[\s\S]*?\{\{ t\('navigation\.collapseApprovals'\) \}\}[\s\S]*?<div class="action-inbox-panel">/);
  assert.doesNotMatch(inbox, /action-inbox-panel-head/);
  assert.match(inbox, /v-for="item in visibleItems"/);
  assert.match(inbox, /v-if="items.length > visibleCount"[^>]*:aria-label=/);
  assert.match(inbox, /\.action-inbox \{[^}]*position: fixed;/);
});

test("the expanded inbox sizes its scroll stack to the rendered cards", () => {
  assert.match(inbox, /<div ref="itemsElement" class="action-inbox-items">/);
  // The stack keeps the whole panel inside the available height once the protruding handle is accounted for.
  assert.match(inbox, /const panelHandleHeight = 31;/);
  assert.match(inbox, /const stackHeight = computed\(\(\) => Math\.min\(itemsHeight\.value, Math\.max\(0, availableHeight\.value - panelHandleHeight\)\)\)/);
  assert.match(inbox, /itemsResizeObserver = new ResizeObserver\(\(\) => \{ itemsHeight\.value = element\.offsetHeight; \}\)/);
  assert.doesNotMatch(inbox, /visibleCount \* 200/);
});

test("the floating inbox panel animates in and out from the toolbar trigger", () => {
  assert.match(inbox, /<Transition name="action-inbox-panel">\s*<aside v-if="!collapsed/);
  assert.match(inbox, /\.action-inbox-panel-enter-active,\s*\.action-inbox-panel-leave-active\s*\{[\s\S]*?transition:[^;]*transform/);
  assert.match(inbox, /\.action-inbox-panel-enter-from,\s*\.action-inbox-panel-leave-to\s*\{\s*opacity:\s*0;\s*transform:/);
  assert.match(inbox, /\.action-inbox-panel-leave-active > \*\s*\{\s*pointer-events:\s*none;/);
  assert.match(inbox, /\.action-inbox \{[^}]*position: fixed;[^}]*transform-origin:\s*top right;/);
});

test("operation cards show a label for every protected action and only server-supplied safe details", () => {
  for (const operation of ["instance.delete", "node.remove", "node.update.apply", "node.external-listener.set", "user.access.set", "user.role.update", "user.role.remove", "identity-provider.update", "identity-provider.remove", "git-credential.assign"]) {
    assert.ok(inbox.includes(`"${operation}": "navigation.`), operation);
  }
  assert.match(inbox, /v-for="detail in item\.request\.details"/);
  assert.doesNotMatch(inbox, /preflightToken|clientSecret/);
});

test("every card leads with one header row that carries its source", () => {
  assert.equal((inbox.match(/<header class="action-inbox-head">/g) ?? []).length, 3);
  assert.equal((inbox.match(/<span class="action-inbox-kind/g) ?? []).length, 3);
  assert.equal((inbox.match(/<span class="action-inbox-source"/g) ?? []).length, 2);
  assert.doesNotMatch(inbox, /<div class="action-inbox-kind">/);
  for (const icon of ["ShieldQuestion", "ShieldCheck"]) {
    assert.match(inbox, new RegExp(`<${icon} :size="13" aria-hidden="true" />`), icon);
  }
  // Story cards label the kind without an icon; the Story name itself carries the Story icon and leads to its detail.
  assert.match(inbox, /<span class="action-inbox-kind action-inbox-kind-label-only">\{\{ t\('navigation\.storyDecision'\) \}\}<\/span>/);
  assert.doesNotMatch(inbox, /MessageCircleQuestion/);
  assert.match(inbox, /action-inbox-source action-inbox-story-link" :title="item\.story\.title" @click="emit\('open-story', item\)"/);
  assert.match(inbox, /<BookOpen class="action-inbox-story-icon" :size="13" aria-hidden="true" \/>/);
  assert.match(inbox, /<span class="action-inbox-story-title">\{\{ item\.story\.title \}\}<\/span>/);
  assert.match(inbox, /action-inbox-source" :title="item\.request\.targetId">\{\{ item\.request\.targetId \}\}<\/span>/);
  assert.match(inbox, /action-inbox-source" :title="`\$\{item\.instanceName\} · \$\{item\.session\.agent\}`">\{\{ item\.instanceName \}\} · \{\{ item\.session\.agent \}\}<\/span>/);
  assert.doesNotMatch(inbox, /action-inbox-context">\{\{ item\.instanceName \}\}/);
  assert.match(inbox, /\.action-inbox-head \{ display: flex; align-items: center; gap: 8px; min-width: 0; margin-bottom: 6px; \}/);
  assert.match(inbox, /\.action-inbox-kind \{ display: inline-flex;[\s\S]*?font-size: 12px; font-weight: 500;/);
  assert.match(inbox, /\.action-inbox-kind-label-only \{ padding: 2px 8px; \}/);
  assert.match(inbox, /\.action-inbox-source \{ flex: 1 1 auto; min-width: 0; overflow: hidden;[\s\S]*?text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(inbox, /\.action-inbox-story-link \{ display: inline-flex;[\s\S]*?cursor: pointer;/);
  assert.match(inbox, /\.action-inbox-story-link:not\(:disabled\):hover \.action-inbox-story-title \{ text-decoration: underline; \}/);
  assert.match(inbox, /\.action-inbox-story-title \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
});

test("the question stays grouped with its answer block and separated from the header", () => {
  assert.match(inbox, /\.action-inbox-card \{ display: grid; align-content: start; gap: 4px;/);
  assert.match(inbox, /\.action-inbox-head \{[^}]*margin-bottom: 6px; \}/);
  assert.match(inbox, /\.action-inbox-card \{[^}]*padding: 12px;/);
  assert.match(inbox, /\.action-inbox-title \{ font-size: 14px; margin: 0;/);
  assert.match(inbox, /\.action-inbox-actions \{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; \}/);
  assert.doesNotMatch(inbox, /\.action-inbox-answer \{/);
});

test("the single panel owns the shadow and splits its rows with shared dividers", () => {
  // The whole surface is one element, so the shared shadow color stays neutral without clipping inside the scroll viewport.
  assert.match(inbox, /\.action-inbox-panel \{ width: 100%; display: grid;[^}]*border-radius: 12px 0 12px 12px;[^}]*box-shadow: 0 4px 28px var\(--shadow-color\);[^}]*overflow: hidden; \}/);
  assert.doesNotMatch(inbox, /\.action-inbox-card \{[^}]*box-shadow/);
  assert.doesNotMatch(inbox, /box-shadow: [^;]*var\(--line\)/);
  // The collapse head and the decision content share one divider; stacked decisions split the same way.
  assert.match(inbox, /\.action-inbox-panel > \* \+ \* \{ border-top: 1px solid var\(--line\); \}/);
  assert.match(inbox, /\.action-inbox-items \{ display: grid; \}/);
  assert.match(inbox, /\.action-inbox-items > \* \+ \* \{ border-top: 1px solid var\(--line\); \}/);
});

test("the collapse tab merges into the panel top border and the error surface rides the panel edges", () => {
  assert.match(inbox, /\.action-inbox-collapse \{ position: relative; z-index: 1; margin: 0 0 -1px 0; border: 1px solid var\(--line-strong\); border-bottom: 0; border-radius: 10px 10px 0 0; background: var\(--surface-overlay\); color: var\(--text-strong\); box-shadow: none; \}/);
  // A concave fillet rounds the junction where the tab base meets the panel's top border: the arc stroke and the fill under it are the crescent outside the quarter circle, so the flare bends inward.
  assert.match(inbox, /\.action-inbox-collapse::before \{ content: ""; position: absolute; left: -12px; bottom: 0; width: 12px; height: 12px; background: var\(--line-strong\); -webkit-mask: radial-gradient\(circle at 0 0, transparent 11px, #000 11px, #000 12px, transparent 12px\); mask: radial-gradient\(circle at 0 0, transparent 11px, #000 11px, #000 12px, transparent 12px\); \}/);
  assert.match(inbox, /\.action-inbox-collapse::after \{ content: ""; position: absolute; left: -12px; bottom: 0; width: 12px; height: 12px; background: var\(--surface-overlay\); -webkit-mask: radial-gradient\(circle at 0 0, transparent 12px, #000 12px\); mask: radial-gradient\(circle at 0 0, transparent 12px, #000 12px\); \}/);
  assert.match(inbox, /\.action-inbox-collapse:not\(:disabled\):hover \{ background: var\(--surface-hover\); \}/);
  assert.match(inbox, /\.action-inbox-collapse:not\(:disabled\):hover::before \{ background: var\(--surface-hover\); \}/);
  assert.match(inbox, /\.action-inbox-collapse:not\(:disabled\):hover::after \{ background: var\(--surface-hover\); \}/);
  assert.match(inbox, /\.action-inbox-error \{ padding: 10px 12px;/);
});
