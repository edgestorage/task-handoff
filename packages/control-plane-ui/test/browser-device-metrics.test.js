import assert from "node:assert/strict";
import test from "node:test";
import {
  browserDeviceEmulationParams,
  browserDevicePresetForMetrics,
  BROWSER_DEVICE_PRESETS,
  normalizeBrowserDeviceDimension,
  rotateBrowserDeviceMetrics,
} from "../src/apps/control-plane/instance-detail/browserDeviceMetrics.ts";

test("device presets cover common phone, tablet, and desktop viewports", () => {
  assert.deepEqual(BROWSER_DEVICE_PRESETS.map((preset) => preset.width), [393, 412, 820, 912, 1_440]);
  assert.equal(BROWSER_DEVICE_PRESETS.filter((preset) => preset.mobile).length, 3);
});

test("agent metrics map back to a known preset when dimensions, DPR, and mobile mode match", () => {
  assert.equal(browserDevicePresetForMetrics({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true })?.id, "iphone-15-pro");
  assert.equal(browserDevicePresetForMetrics({ width: 393, height: 852, deviceScaleFactor: 2, mobile: true }), undefined);
  assert.equal(browserDevicePresetForMetrics({ width: 852, height: 393, deviceScaleFactor: 3, mobile: true }), undefined);
});

test("device dimensions are bounded and rotation keeps the page viewport as the source of truth", () => {
  assert.equal(normalizeBrowserDeviceDimension("800"), 800);
  assert.equal(normalizeBrowserDeviceDimension(0), undefined);
  assert.equal(normalizeBrowserDeviceDimension(4_097), undefined);
  assert.equal(normalizeBrowserDeviceDimension("not-a-number"), undefined);
  assert.deepEqual(
    rotateBrowserDeviceMetrics({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true }),
    { width: 852, height: 393, deviceScaleFactor: 3, mobile: true },
  );
});

test("emulation params carry the viewport and a matching screen orientation", () => {
  assert.deepEqual(browserDeviceEmulationParams({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true }), {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });
  assert.deepEqual(browserDeviceEmulationParams({ width: 852, height: 393, deviceScaleFactor: 3, mobile: true }).screenOrientation, {
    type: "landscapePrimary",
    angle: 90,
  });
});
