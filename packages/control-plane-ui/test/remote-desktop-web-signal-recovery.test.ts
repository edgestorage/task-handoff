import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewer = readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceRemoteDesktopViewer.vue", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/remoteDesktop.ts", import.meta.url), "utf8");

test("a transient browser signaling close renews the tunnel without stopping the viewer session", () => {
  const closeHandler = viewer.slice(
    viewer.indexOf("socket.onclose = (event) =>"),
    viewer.indexOf("function setConnectionMethodEnabled"),
  );
  assert.match(closeHandler, /signalReconnecting\.value = true/);
  assert.match(closeHandler, /suspend\(\)/);
  assert.match(closeHandler, /scheduleSignalResume\("REMOTE_DESKTOP_SIGNAL_CLOSED", true\)/);
  assert.doesNotMatch(closeHandler, /stopRemoteDesktopSession\(/);
  assert.doesNotMatch(closeHandler, /cleanup\(\);\n\s*error\.value = message/);
});

test("browser signaling recovery exchanges the existing session for a fresh ticket", () => {
  assert.match(api, /remote-desktop-sessions\/\$\{encodeURIComponent\(viewerSessionId\)\}\/signal/);
  assert.match(viewer, /await resumeRemoteDesktopSignal\(props\.instanceId, current\.snapshot\.viewerSessionId\)/);
  assert.match(viewer, /session\.value = \{ \.\.\.current, signalUrl: ticket\.signalUrl, ticketExpiresAt: ticket\.ticketExpiresAt \}/);
});

test("the replacement tunnel re-arms input and refreshes stale revisions", () => {
  const readyHandler = viewer.slice(
    viewer.indexOf('} else if (value.type === "ready") {'),
    viewer.indexOf('} else if (value.type === "iceConfiguration"'),
  );
  assert.match(readyHandler, /const resumed = signalReconnecting\.value/);
  assert.match(readyHandler, /resumeWanted\(\)/);
  assert.match(viewer, /code === "REMOTE_DESKTOP_STALE_EPOCH".*refreshInputResumeSnapshot\(code\)/);
  assert.match(viewer, /recoverRemoteDesktopSession\(props\.instanceId, current\.snapshot\.viewerSessionId\)/);
});
