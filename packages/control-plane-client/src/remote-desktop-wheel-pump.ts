export const REMOTE_DESKTOP_WHEEL_STEP = 40;

export type RemoteDesktopWheelStep = { x: number; y: number };

/**
 * Turns bursty touch or browser wheel movement into at most one native wheel
 * notch per frame. The native input boundary keeps the sub-notch remainder, so
 * repeated small steps are not rounded away independently.
 */
export class RemoteDesktopWheelPump {
  private pendingX = 0;
  private pendingY = 0;

  add(deltaX: number, deltaY: number) {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.pendingX = clamp(this.pendingX + deltaX, -10_000, 10_000);
    this.pendingY = clamp(this.pendingY + deltaY, -10_000, 10_000);
  }

  take(): RemoteDesktopWheelStep | undefined {
    const x = clamp(this.pendingX, -REMOTE_DESKTOP_WHEEL_STEP, REMOTE_DESKTOP_WHEEL_STEP);
    const y = clamp(this.pendingY, -REMOTE_DESKTOP_WHEEL_STEP, REMOTE_DESKTOP_WHEEL_STEP);
    if (Math.abs(x) < 0.001 && Math.abs(y) < 0.001) {
      this.pendingX = 0;
      this.pendingY = 0;
      return undefined;
    }
    this.pendingX = clamp(this.pendingX - x, -10_000, 10_000);
    this.pendingY = clamp(this.pendingY - y, -10_000, 10_000);
    return { x, y };
  }

  clear() {
    this.pendingX = 0;
    this.pendingY = 0;
  }

  get idle() {
    return Math.abs(this.pendingX) < 0.001 && Math.abs(this.pendingY) < 0.001;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
