export type BrowserDeviceMetrics = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
};

export type BrowserDevicePreset = BrowserDeviceMetrics & {
  id: string;
  labelKey: string;
};

export const BROWSER_DEVICE_MAX_DIMENSION = 4_096;
export const CUSTOM_BROWSER_DEVICE_ID = "custom";
export const BROWSER_DEVICE_ZOOM_FIT = "fit";
export const BROWSER_DEVICE_ZOOM_PERCENTAGES = Object.freeze([50, 75, 100, 125, 150] as const);

export const BROWSER_DEVICE_PRESETS: readonly BrowserDevicePreset[] = Object.freeze([
  { id: "iphone-15-pro", labelKey: "sessions.browserDevices.iphone15Pro", width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
  { id: "pixel-7", labelKey: "sessions.browserDevices.pixel7", width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true },
  { id: "ipad-air", labelKey: "sessions.browserDevices.ipadAir", width: 820, height: 1_180, deviceScaleFactor: 2, mobile: true },
  { id: "surface-pro-7", labelKey: "sessions.browserDevices.surfacePro7", width: 912, height: 1_368, deviceScaleFactor: 1.2, mobile: false },
  { id: "desktop", labelKey: "sessions.browserDevices.desktop", width: 1_440, height: 900, deviceScaleFactor: 1, mobile: false },
]);

export const DEFAULT_BROWSER_DEVICE_PRESET = BROWSER_DEVICE_PRESETS[0];

export function browserDevicePreset(id: string) {
  return BROWSER_DEVICE_PRESETS.find((preset) => preset.id === id);
}

export function browserDevicePresetForMetrics(metrics: BrowserDeviceMetrics) {
  return BROWSER_DEVICE_PRESETS.find((preset) => (
    preset.width === metrics.width
    && preset.height === metrics.height
    && preset.mobile === metrics.mobile
    && Math.abs(preset.deviceScaleFactor - metrics.deviceScaleFactor) < 0.001
  ));
}

export function normalizeBrowserDeviceDimension(value: unknown) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 && numeric <= BROWSER_DEVICE_MAX_DIMENSION
    ? numeric
    : undefined;
}

export function browserDeviceZoomScale(value: string) {
  if (value === BROWSER_DEVICE_ZOOM_FIT) return undefined;
  const percentage = Number(value);
  return BROWSER_DEVICE_ZOOM_PERCENTAGES.some((option) => option === percentage)
    ? percentage / 100
    : undefined;
}

export function browserDeviceEmulationParams(metrics: BrowserDeviceMetrics) {
  return {
    width: metrics.width,
    height: metrics.height,
    deviceScaleFactor: metrics.deviceScaleFactor,
    mobile: metrics.mobile,
    screenOrientation: metrics.width >= metrics.height
      ? { type: "landscapePrimary", angle: 90 }
      : { type: "portraitPrimary", angle: 0 },
  };
}

export function rotateBrowserDeviceMetrics(metrics: BrowserDeviceMetrics): BrowserDeviceMetrics {
  return { ...metrics, width: metrics.height, height: metrics.width };
}
