const WEB_BODY_SIZE = 14;
const MOBILE_BODY_SIZE = 16;

export function mobileWebMetric(webPixels: number) {
  return Math.ceil(webPixels * MOBILE_BODY_SIZE / WEB_BODY_SIZE);
}

export const mobileWebTypeSize = mobileWebMetric;

export const mobileWebType = {
  body: mobileWebMetric(14),
  meta: mobileWebMetric(13),
  small: mobileWebMetric(12),
  tiny: mobileWebMetric(11),
  bodyLine: mobileWebMetric(14 * 1.45),
  metaLine: mobileWebMetric(18),
  smallLine: mobileWebMetric(12 * 1.45),
  timeLine: mobileWebMetric(20),
} as const;
