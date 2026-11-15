import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewerSource = readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceRemoteDesktopViewer.vue", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const previewSource = readFileSync(new URL("../src/components/remote-desktop/SessionRemoteDesktopFloatingPreview.vue", import.meta.url), "utf8");
const sessionCardSource = readFileSync(new URL("../src/components/remote-desktop/SessionRemoteDesktopCard.vue", import.meta.url), "utf8");

test("auto-connect starts only after viewer setup has initialized runtime state", () => {
  assert.match(viewerSource, /function connectIfAutoConnectReady\(\)/);
  assert.match(viewerSource, /watch\(\[canConnect, sourcesLoading\],[\s\S]*?\{ flush: "post" \}\);/);
  assert.doesNotMatch(viewerSource, /watch\(\[canConnect, sourcesLoading\],[\s\S]{0,240}?immediate: true/);
  assert.match(viewerSource, /onMounted\(\(\) => \{\s*connectIfAutoConnectReady\(\);/);
});

test("remote desktop preview stays open across unrelated session summary updates", () => {
  assert.match(panelSource, /watch\(\[\(\) => props\.instance\.id, \(\) => selectedSession\.value\?\.id, \(\) => sessionRemoteDesktopPreviewPresentation\.value\]/);
  assert.doesNotMatch(panelSource, /watch\(\(\) => \[props\.instance\.id, selectedSession\.value\?\.id\] as const/);
});

test("session preview presentation switches between the floating window and an inline surface", () => {
  assert.match(panelSource, /const remoteDesktopPreviewOpen = computed\(\(\) => remoteDesktopPreviewRequested\.value && sessionRemoteDesktopPreviewPresentation\.value === "floating"\)/);
  assert.match(panelSource, /<SessionRemoteDesktopInlinePreview[\s\S]*?remoteDesktopInlineExpanded && sessionRemoteDesktopPreviewPresentation === 'expanded'/);
  assert.match(panelSource, /if \(sessionRemoteDesktopPreviewPresentation\.value === "expanded"\) \{\s*remoteDesktopInlineExpanded\.value = !remoteDesktopInlineExpanded\.value;/);
});

test("switching a session preview source keeps the inline surface expanded", () => {
  assert.doesNotMatch(panelSource, /watch\(\(\) => selectedSessionRemoteDesktopLink\.value\?\.target\.sourceRef/);
  assert.match(panelSource, /function updateSelectedSessionRemoteDesktopTarget\(target: SessionRemoteDesktopTarget\) \{\s*const session = selectedSession\.value;\s*if \(!session\) return;\s*rememberSessionRemoteDesktopLink\(/);
});

test("session preview card does not render a redundant expand or collapse chevron", () => {
  assert.doesNotMatch(sessionCardSource, /Chevron(?:Up|Down)/);
  assert.doesNotMatch(sessionCardSource, /session-remote-desktop-card-chevron/);
});

test("every surface honors explicit inactivity while an omitted active prop defaults to visible", () => {
  assert.match(viewerSource, /\{ active: true \}/);
  assert.match(viewerSource, /function surfacePaused\(\) \{\s*return documentVisible\.value === false \|\| props\.active === false;/);
});

test("floating preview controls keep their click target instead of being captured by the frame", () => {
  assert.doesNotMatch(previewSource, /class="session-remote-desktop-preview"[\s\S]{0,300}@pointerdown\.capture=/);
  assert.match(previewSource, /function startDrag\(event: PointerEvent\)[\s\S]*?setPointerCapture\?\.\(event\.pointerId\);/);
});


test("floating preview keeps its DOM alive through the exit transition", () => {
  assert.match(previewSource, /visible: boolean;/);
  assert.match(previewSource, /const PRESENCE_EXIT_DURATION_MS = 140;/);
  assert.match(previewSource, /v-if="present"/);
  assert.match(previewSource, /<template v-if="!preference\.collapsed">/);

  assert.match(previewSource, /is-presence-entering/);
  assert.match(previewSource, /is-presence-exiting/);
  assert.match(panelSource, /<SessionRemoteDesktopFloatingPreview[\s\S]*?:visible="remoteDesktopPreviewOpen"/);
  assert.doesNotMatch(panelSource, /v-if="remoteDesktopPreviewOpen && selectedSession/);
});

test("floating preview close resets the requested state through its owning action", () => {
  assert.match(panelSource, /@close="closeSessionRemoteDesktopPreview"/);
  assert.doesNotMatch(panelSource, /@close="remoteDesktopPreviewOpen\s*=\s*false"/);
  assert.match(panelSource, /function closeSessionRemoteDesktopPreview\(\) \{\s*remoteDesktopPreviewRequested\.value = false;\s*remoteDesktopInlineExpanded\.value = false;\s*\}/);
});
