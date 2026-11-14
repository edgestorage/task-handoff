import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE,
  SESSION_REMOTE_DESKTOP_PREVIEW_COLLAPSED_HEIGHT,
  SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT,
  SESSION_REMOTE_DESKTOP_PREVIEW_MAX_MEDIA_ASPECT_RATIO,
  SESSION_REMOTE_DESKTOP_PREVIEW_MIN_MEDIA_ASPECT_RATIO,
  SESSION_REMOTE_DESKTOP_PREVIEW_TOP_MARGIN,
  clampSessionRemoteDesktopPreviewFrame,
  resizeSessionRemoteDesktopPreviewFrame,
  sessionRemoteDesktopPreviewAspectRatio,
  sessionRemoteDesktopPreviewLayout,
  sessionRemoteDesktopPreviewPreferenceForFrame,
  sessionRemoteDesktopPreviewPreferenceForCollapse,
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

test("expanded and collapsed previews stay below the titlebar when restored, dragged and resized", () => {
  for (const topInset of [42, 44, 56]) {
    const bounds = { ...viewport, topInset };
    const minY = topInset + SESSION_REMOTE_DESKTOP_PREVIEW_TOP_MARGIN;
    for (const collapsed of [false, true]) {
      const preference = { ...DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE, collapsed, yRatio: 0 };
      const restored = sessionRemoteDesktopPreviewLayout(bounds, preference);
      assert.equal(restored.y, minY);
      const dragged = clampSessionRemoteDesktopPreviewFrame({ ...restored, y: -100 }, bounds);
      assert.equal(dragged.y, minY);
      const saved = sessionRemoteDesktopPreviewPreferenceForFrame({ collapsed, frame: dragged, viewport: bounds });
      assert.equal(saved.yRatio, 0);
      assert.equal(sessionRemoteDesktopPreviewLayout(bounds, saved).y, minY);
      if (!collapsed) {
        const resized = resizeSessionRemoteDesktopPreviewFrame({ dx: 40, edge: "right", frame: dragged, mediaAspectRatio: 9 / 16, viewport: bounds });
        assert.equal(resized.y, minY);
      }
    }
    const tall = sessionRemoteDesktopPreviewLayout(bounds, DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE, 2);
    assert.ok(tall.y >= minY);
    assert.ok(tall.y + tall.height <= bounds.height - 24);
  }
});

test("collapse moves down to the same bottom edge and expansion restores the frame", () => {
  const bounds = { ...viewport, topInset: 56 };
  for (const yRatio of [0, 0.4, 1]) {
    const preference = { ...DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE, xRatio: 0.7, yRatio };
    const frame = sessionRemoteDesktopPreviewLayout(bounds, preference);
    const collapsedPreference = sessionRemoteDesktopPreviewPreferenceForCollapse({ collapsed: true, frame, preference, viewport: bounds, mediaAspectRatio: 9 / 16 });
    const collapsed = sessionRemoteDesktopPreviewLayout(bounds, collapsedPreference);
    assert.equal(collapsed.y + collapsed.height, frame.y + frame.height);
    assert.ok(collapsed.y > frame.y);
    const expandedPreference = sessionRemoteDesktopPreviewPreferenceForCollapse({ collapsed: false, frame: collapsed, preference: collapsedPreference, viewport: bounds, mediaAspectRatio: 9 / 16 });
    const expanded = sessionRemoteDesktopPreviewLayout(bounds, expandedPreference);
    for (const key of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(expanded[key] - frame[key]) < 0.001);
  }
});

test("both lower corners follow diagonal and vertical movement while retaining aspect ratio", () => {
  const frame = { x: 300, y: 100, width: 320, height: 234 };
  for (const edge of ["left", "right"] as const) {
    const resized = resizeSessionRemoteDesktopPreviewFrame({ dx: edge === "left" ? -64 : 64, dy: 36, edge, frame, mediaAspectRatio: 9 / 16, viewport });
    assert.equal(resized.width, 384);
    assert.equal(resized.height, 270);
    assert.equal(edge === "left" ? resized.x + resized.width : resized.x, edge === "left" ? frame.x + frame.width : frame.x);
    assert.ok(resizeSessionRemoteDesktopPreviewFrame({ dx: 0, dy: 64, edge, frame, mediaAspectRatio: 9 / 16, viewport }).width > frame.width);
  }
});
