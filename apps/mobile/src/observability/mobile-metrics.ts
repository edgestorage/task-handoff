export type MobileMetricName =
  | 'connection.result'
  | 'snapshot.recovery'
  | 'stream.gap'
  | 'message.first-delta'
  | 'action.error'
  | 'profile.warning'
  | 'render.duration';

export type MobileMetric = {
  name: MobileMetricName;
  at: string;
  value?: number;
  dimensions: Readonly<Record<string, string>>;
};

const ALLOWED_DIMENSIONS = new Set(['result', 'reason', 'action', 'screen', 'network', 'platform']);

export class MobileMetrics {
  private readonly entries: MobileMetric[] = [];
  record(name: MobileMetricName, dimensions: Record<string, string> = {}, value?: number) {
    const safeDimensions = Object.fromEntries(Object.entries(dimensions).filter(([key]) => ALLOWED_DIMENSIONS.has(key)).map(([key, item]) => [key, item.slice(0, 80)]));
    this.entries.push({ name, at: new Date().toISOString(), value, dimensions: safeDimensions });
    if (this.entries.length > 500) this.entries.splice(0, this.entries.length - 500);
  }
  snapshot() { return [...this.entries]; }
  clear() { this.entries.length = 0; }
}

export const mobileMetrics = new MobileMetrics();
