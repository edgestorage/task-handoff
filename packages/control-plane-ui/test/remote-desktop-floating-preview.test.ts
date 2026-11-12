import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE,
  SESSION_REMOTE_DESKTOP_PREVIEW_COLLAPSED_HEIGHT,
  SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT,
  SESSION_REMOTE_DESKTOP_PREVIEW_MAX_MEDIA_ASPECT_RATIO,
  SESSION_REMOTE_DESKTOP_PREVIEW_MIN_MEDIA_ASPECT_RATIO,
  resizeSessionRemoteDesktopPreviewFrame,
  sessionRemoteDesktopPreviewAspectRatio,
  sessionRemoteDesktopPreviewLayout,
  sessionRemoteDesktopPreviewPreferenceForFrame,
} from "../src/apps/control-plane/instance-detail/remoteDesktopFloatingPreview.ts";

const viewport = { width: 1280, height: 800 };

test("opening preview follows the live stream aspect ratio and bottom-right preference", () => {
  const ratio = sessionRemoteDesktopPreviewAspectRatio(1728, 1117);
  const frame = sessionRemoteDesktopPreviewLayout(viewport, DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE, ratio);
  assert.equal(frame.width, 420);
  assert.equal(frame.height, Math.round(420 * ratio) + SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT);
  assert.equal(frame.x + frame.width, viewport.width - 24);
  assert.equal(frame.y + frame.height, viewport.height - 24);
});

test("preview caps extreme aspect ratios and leaves letterbox space inside contain", () => {
  const tall = sessionRemoteDesktopPreviewAspectRatio(100, 1000);
  assert.equal(tall, SESSION_REMOTE_DESKTOP_PREVIEW_MAX_MEDIA_ASPECT_RATIO);
  const tallFrame = sessionRemoteDesktopPreviewLayout(viewport, DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE, tall);
  assert.equal(tallFrame.height, Math.round(tallFrame.width * tall) + SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT);

  const wide = sessionRemoteDesktopPreviewAspectRatio(1000, 100);
  assert.equal(wide, SESSION_REMOTE_DESKTOP_PREVIEW_MIN_MEDIA_ASPECT_RATIO);
  const wideFrame = sessionRemoteDesktopPreviewLayout(viewport, DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE, wide);
  assert.equal(wideFrame.height, Math.round(wideFrame.width * wide) + SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT);
});

test("preview resize keeps aspect ratio and clamps to viewport", () => {
  const ratio = 9 / 16;
  const start = sessionRemoteDesktopPreviewLayout(viewport, DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE, ratio);
  const wider = resizeSessionRemoteDesktopPreviewFrame({ dx: -160, edge: "left", frame: start, mediaAspectRatio: ratio, viewport });
  assert.ok(wider.width > start.width);
  assert.equal(wider.height, Math.round(wider.width * ratio) + SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT);
  assert.ok(wider.x >= 24);
});

test("collapsed preview persists its expanded width for restoration", () => {
  const expanded = sessionRemoteDesktopPreviewLayout(viewport, { ...DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE, width: 480 });
  const preference = sessionRemoteDesktopPreviewPreferenceForFrame({ collapsed: true, expandedWidth: expanded.width, frame: expanded, viewport });
  assert.equal(preference.width, 480);
  const collapsed = sessionRemoteDesktopPreviewLayout(viewport, preference);
  assert.equal(collapsed.height, SESSION_REMOTE_DESKTOP_PREVIEW_COLLAPSED_HEIGHT);
  const restored = sessionRemoteDesktopPreviewLayout(viewport, { ...preference, collapsed: false });
  assert.equal(restored.width, 480);
});
