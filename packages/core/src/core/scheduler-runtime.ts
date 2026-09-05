import crypto from "node:crypto";
import { CronExpressionParser } from "cron-parser";

export type SchedulerSchedule =
  | { type: "interval"; intervalMs: number }
  | { type: "daily"; timeOfDay: string; timezone: string }
  | { type: "weekly"; weekdays: number[]; timeOfDay: string; timezone: string }
  | { type: "monthly"; dayOfMonth: number; timeOfDay: string; timezone: string };

export type SchedulerPolicy = {
  cooldownMs?: number;
  maxConcurrentRuns: number;
  whenBusy: "skip" | "queue";
};

export type SchedulerSkipReason = "cooldown" | "busy" | "queue-full" | "scheduler-stopped" | "job-disabled";

export type SchedulerExecutionAdapter<T> = {
  execute(event: T): Promise<void>;
  skipped(event: T, reason: SchedulerSkipReason): void;
};

type Timer = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
type QueuedEvent<T> = { event: T; policy: SchedulerPolicy };

export class SchedulerExecutionRuntime<T> {
  private readonly timers = new Map<string, Timer>();
  private readonly running = new Map<string, number>();
  private readonly queued = new Map<string, QueuedEvent<T>[]>();
  private readonly lastStartedAt = new Map<string, number>();
  private accepting = true;
  private readonly adapter: SchedulerExecutionAdapter<T>;
  private readonly maxQueuedPerJob: number;
  private readonly now: () => number;

  constructor(
    adapter: SchedulerExecutionAdapter<T>,
    maxQueuedPerJob = 100,
    now: () => number = Date.now,
  ) {
    this.adapter = adapter;
    this.maxQueuedPerJob = maxQueuedPerJob;
    this.now = now;
  }

  start() {
    this.accepting = true;
  }

  setTimer(key: string, timer: Timer) {
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.timers.set(key, timer);
  }

  clearTimer(key: string) {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  clearQueued(key: string, reason: SchedulerSkipReason = "job-disabled") {
    const queue = this.queued.get(key);
    if (!queue) return;
    for (const entry of queue) this.adapter.skipped(entry.event, reason);
    this.queued.delete(key);
  }

  submit(key: string, event: T, policy: SchedulerPolicy) {
    if (!this.accepting) {
      this.adapter.skipped(event, "scheduler-stopped");
      return "skipped" as const;
    }
    const now = this.now();
    const lastStartedAt = this.lastStartedAt.get(key);
    if (policy.cooldownMs && lastStartedAt !== undefined && now - lastStartedAt < policy.cooldownMs) {
      this.adapter.skipped(event, "cooldown");
      return "skipped" as const;
    }
    if ((this.running.get(key) ?? 0) >= policy.maxConcurrentRuns) {
      if (policy.whenBusy === "skip") {
        this.adapter.skipped(event, "busy");
        return "skipped" as const;
      }
      const queue = this.queued.get(key) ?? [];
      if (queue.length >= this.maxQueuedPerJob) {
        this.adapter.skipped(event, "queue-full");
        return "skipped" as const;
      }
      queue.push({ event, policy });
      this.queued.set(key, queue);
      return "queued" as const;
    }
    this.begin(key, event, policy);
    return "started" as const;
  }

  stop() {
    this.accepting = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const queue of this.queued.values()) {
      for (const entry of queue) this.adapter.skipped(entry.event, "scheduler-stopped");
    }
    this.queued.clear();
  }

  private begin(key: string, event: T, policy: SchedulerPolicy) {
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    this.lastStartedAt.set(key, this.now());
    const finish = () => {
      const remaining = (this.running.get(key) ?? 1) - 1;
      if (remaining > 0) this.running.set(key, remaining);
      else this.running.delete(key);
      this.drain(key);
    };
    void this.adapter.execute(event).then(finish, finish);
  }

  private drain(key: string) {
    if (!this.accepting) return;
    const queue = this.queued.get(key);
    if (!queue?.length) return;
    const next = queue[0]!;
    if ((this.running.get(key) ?? 0) >= next.policy.maxConcurrentRuns) return;
    queue.shift();
    if (!queue.length) this.queued.delete(key);
    this.begin(key, next.event, next.policy);
  }
}

function timezoneDateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month") - 1, day: value("day") };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function monthlyCronTime(dayOfMonth: number, month: number, hour: number, minute: number, timezone: string, now: Date) {
  return CronExpressionParser
    .parse(`0 ${minute} ${hour} ${dayOfMonth} ${month} *`, { currentDate: now, strict: true, tz: timezone })
    .next()
    .toDate();
}

function nextRelativeMonthlyTime(dayOfMonth: number, hour: number, minute: number, timezone: string, now: Date) {
  const current = timezoneDateParts(now, timezone);
  const candidates: Date[] = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const targetMonth = new Date(Date.UTC(current.year, current.month + offset, 1));
    const year = targetMonth.getUTCFullYear();
    const month = targetMonth.getUTCMonth();
    const actualDay = daysInMonth(year, month) + dayOfMonth + 1;
    candidates.push(monthlyCronTime(actualDay, month + 1, hour, minute, timezone, now));
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0]!;
}

export function nextSchedulerTime(schedule: SchedulerSchedule, now: Date, anchor = now) {
  if (schedule.type === "interval") {
    const elapsed = Math.max(0, now.getTime() - anchor.getTime());
    const slots = Math.floor(elapsed / schedule.intervalMs) + 1;
    return new Date(anchor.getTime() + slots * schedule.intervalMs);
  }
  const [hour, minute] = schedule.timeOfDay.split(":").map(Number);
  if (schedule.type === "monthly" && schedule.dayOfMonth < 0) {
    return nextRelativeMonthlyTime(schedule.dayOfMonth, hour, minute, schedule.timezone, now);
  }
  const weekdays = schedule.type === "weekly" ? [...new Set(schedule.weekdays)].sort((a, b) => a - b).join(",") : "*";
  const daysOfMonth = schedule.type === "monthly" ? String(schedule.dayOfMonth) : "*";
  return CronExpressionParser
    .parse(`0 ${minute} ${hour} ${daysOfMonth} * ${weekdays}`, { currentDate: now, strict: true, tz: schedule.timezone })
    .next()
    .toDate();
}

export function schedulerExecutionKey(jobKey: string, eventType: string, scheduledFor: string) {
  return `sch_${crypto.createHash("sha256").update(`${jobKey}\0${eventType}\0${scheduledFor}`).digest("hex").slice(0, 32)}`;
}
