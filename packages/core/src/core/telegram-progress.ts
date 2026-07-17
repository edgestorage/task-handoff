export type ChatProgressAction = {
  text: string;
  callbackData: string;
};

export type ChatProgressOptions = {
  actions?: ChatProgressAction[];
  actionRows?: ChatProgressAction[][];
};

type TelegramProgressEntry<Route> = {
  lastText: string;
  lastUpdateAt: number;
  route?: Route;
  options?: ChatProgressOptions;
  lastOptions?: ChatProgressOptions;
  renderOptions?: unknown;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<unknown>;
  pendingText?: string;
  messageId?: number;
  rateLimitedUntil?: number;
};

type TelegramProgressStoreOptions<Route> = {
  entries?: Map<string, TelegramProgressEntry<Route>>;
  updateIntervalMs?: number;
  send: (text: string, route?: Route, options?: ChatProgressOptions) => Promise<unknown>;
  edit: (messageId: number, text: string, route?: Route, options?: ChatProgressOptions, renderOptions?: unknown) => Promise<unknown>;
  delete?: (messageId: number, route?: Route) => Promise<unknown>;
  messageIdFromResult?: (result: unknown) => number | undefined;
  retryAfterMs?: (error: unknown) => number | undefined;
  isMessageTooLong?: (error: unknown) => boolean;
  onLog?: (message: string) => void;
};

const DEFAULT_PROGRESS_UPDATE_MS = 1000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function defaultMessageIdFromResult(value: unknown) {
  const id = Number(asRecord(value).message_id);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progressActionRows(options?: ChatProgressOptions) {
  if (Array.isArray(options?.actionRows)) {
    return options.actionRows;
  }
  return (Array.isArray(options?.actions) ? options.actions : []).map((action) => [action]);
}

function progressOptionsEqual(left?: ChatProgressOptions, right?: ChatProgressOptions) {
  const leftRows = progressActionRows(left);
  const rightRows = progressActionRows(right);
  return leftRows.length === rightRows.length && leftRows.every((leftRow, rowIndex) => {
    const rightRow = rightRows[rowIndex];
    return leftRow.length === rightRow.length && leftRow.every((leftAction, actionIndex) => {
      const rightAction = rightRow[actionIndex];
      return leftAction.text === rightAction?.text && leftAction.callbackData === rightAction.callbackData;
    });
  });
}

class TelegramProgressStore<Route = unknown> {
  readonly entries: Map<string, TelegramProgressEntry<Route>>;
  private readonly updateIntervalMs: number;
  private readonly send: TelegramProgressStoreOptions<Route>["send"];
  private readonly edit: TelegramProgressStoreOptions<Route>["edit"];
  private readonly deleteMessage: TelegramProgressStoreOptions<Route>["delete"];
  private readonly messageIdFromResult: NonNullable<TelegramProgressStoreOptions<Route>["messageIdFromResult"]>;
  private readonly retryAfterMs: TelegramProgressStoreOptions<Route>["retryAfterMs"];
  private readonly isMessageTooLong: TelegramProgressStoreOptions<Route>["isMessageTooLong"];
  private readonly onLog: TelegramProgressStoreOptions<Route>["onLog"];

  constructor(options: TelegramProgressStoreOptions<Route>) {
    this.entries = options.entries || new Map();
    this.updateIntervalMs = options.updateIntervalMs || DEFAULT_PROGRESS_UPDATE_MS;
    this.send = options.send;
    this.edit = options.edit;
    this.deleteMessage = options.delete;
    this.messageIdFromResult = options.messageIdFromResult || defaultMessageIdFromResult;
    this.retryAfterMs = options.retryAfterMs;
    this.isMessageTooLong = options.isMessageTooLong;
    this.onLog = options.onLog;
  }

  remember(key: string, messageId: number, text: string, route?: Route, options?: ChatProgressOptions, renderOptions?: unknown) {
    const previous = this.entries.get(key);
    if (previous) {
      clearTimeout(previous.timer);
      previous.timer = undefined;
      previous.pendingText = undefined;
    }
    this.entries.set(key, {
      lastText: text,
      lastUpdateAt: Date.now(),
      messageId,
      route,
      options,
      lastOptions: options,
      renderOptions,
    });
    return previous;
  }

  rekey(currentKey: string, nextKey: string) {
    if (currentKey === nextKey) {
      return this.entries.has(currentKey);
    }
    const existing = this.entries.get(currentKey);
    if (!existing || this.entries.has(nextKey)) {
      return false;
    }
    clearTimeout(existing.timer);
    existing.timer = undefined;
    this.entries.delete(currentKey);
    this.entries.set(nextKey, existing);
    if (existing.pendingText) {
      const delay = existing.rateLimitedUntil
        ? Math.max(0, existing.rateLimitedUntil - Date.now())
        : Math.max(0, this.updateIntervalMs - (Date.now() - existing.lastUpdateAt));
      this.scheduleFlush(nextKey, delay);
    }
    return true;
  }

  scheduleFlush(key: string, delay: number) {
    const existing = this.entries.get(key);
    if (!existing || existing.timer) {
      return;
    }
    existing.timer = setTimeout(() => {
      existing.timer = undefined;
      const nextText = existing.pendingText;
      existing.pendingText = undefined;
      if (nextText) {
        void this.applyUpdate(key, nextText, existing.route, existing.options);
      }
    }, delay);
  }

  markRateLimited(key: string, value: string, retryAfterMs: number, route?: Route) {
    const existing = this.entries.get(key);
    if (!existing) {
      return;
    }
    existing.rateLimitedUntil = Date.now() + retryAfterMs;
    existing.pendingText = value;
    existing.route = route || existing.route;
    this.scheduleFlush(key, retryAfterMs);
  }

  async applyUpdate(key: string, value: string, route?: Route, options?: ChatProgressOptions) {
    let existing = this.entries.get(key);
    const expectedEntry = existing;
    const targetRoute = route || existing?.route;
    const progressOptions = options || existing?.options;
    try {
      if (existing) {
        existing.route = targetRoute;
        existing.options = progressOptions;
      }
      if (existing?.pending) {
        await existing.pending;
      }
      existing = this.entries.get(key);
      if (expectedEntry && existing !== expectedEntry) {
        return false;
      }
      if (existing?.messageId) {
        if (existing.lastText === value && progressOptionsEqual(existing.lastOptions, progressOptions)) {
          return true;
        }
        const elapsed = Date.now() - (existing.lastUpdateAt || 0);
        if (elapsed < this.updateIntervalMs) {
          existing.pendingText = value;
          existing.route = targetRoute || existing.route;
          existing.options = progressOptions || existing.options;
          this.scheduleFlush(key, this.updateIntervalMs - elapsed);
          return true;
        }
        await this.edit(existing.messageId, value, targetRoute || existing.route, progressOptions);
        existing.lastText = value;
        existing.lastOptions = progressOptions;
        existing.lastUpdateAt = Date.now();
        existing.rateLimitedUntil = undefined;
        return true;
      }
      const entry: TelegramProgressEntry<Route> = { lastText: value, lastUpdateAt: Date.now(), route: targetRoute, options: progressOptions, lastOptions: progressOptions };
      entry.pending = this.send(value, targetRoute, progressOptions)
        .then((message) => {
          const messageId = this.messageIdFromResult(message);
          if (messageId) {
            entry.messageId = messageId;
          }
        })
        .finally(() => {
          entry.pending = undefined;
        });
      this.entries.set(key, entry);
      await entry.pending;
      if (this.entries.get(key) !== entry) {
        return false;
      }
      entry.rateLimitedUntil = undefined;
      return Boolean(entry.messageId);
    } catch (error) {
      const retryAfterMs = this.retryAfterMs?.(error);
      if (retryAfterMs) {
        this.markRateLimited(key, value, retryAfterMs, targetRoute);
      }
      this.onLog?.(`Telegram progress update skipped: ${errorMessage(error)}`);
      return false;
    }
  }

  update(key: string, text: unknown, route?: Route, options?: ChatProgressOptions) {
    const value = String(text || "").trim();
    if (!value) {
      return;
    }
    const existing = this.entries.get(key);
    if (existing) {
      existing.route = route || existing.route;
      existing.options = options || existing.options;
    }
    if (existing?.lastText === value && progressOptionsEqual(existing.lastOptions, options || existing.options) && !existing.pending && !existing.pendingText) {
      return;
    }
    const now = Date.now();
    if (existing?.rateLimitedUntil) {
      if (existing.rateLimitedUntil > now) {
        existing.pendingText = value;
        this.scheduleFlush(key, existing.rateLimitedUntil - now);
        return;
      }
      existing.rateLimitedUntil = undefined;
    }
    if (existing?.pending && !existing.messageId) {
      existing.pendingText = value;
      this.scheduleFlush(key, this.updateIntervalMs);
      return;
    }
    if (!existing || !existing.messageId) {
      void this.applyUpdate(key, value, route, options);
      return;
    }
    const elapsed = Date.now() - (existing.lastUpdateAt || 0);
    if (elapsed >= this.updateIntervalMs) {
      clearTimeout(existing.timer);
      existing.timer = undefined;
      existing.pendingText = undefined;
      void this.applyUpdate(key, value, route || existing.route, options || existing.options);
      return;
    }
    existing.pendingText = value;
    this.scheduleFlush(key, this.updateIntervalMs - elapsed);
  }

  async finish(key: string, text: string, route?: Route, options?: ChatProgressOptions, renderOptions?: unknown) {
    const existing = this.entries.get(key);
    if (!existing) {
      return false;
    }
    try {
      clearTimeout(existing.timer);
      existing.timer = undefined;
      existing.pendingText = undefined;
      if (existing.pending) {
        await existing.pending;
      }
      this.entries.delete(key);
      if (!existing.messageId) {
        return false;
      }
      const progressOptions = options || existing.options;
      if (existing.lastText === text && progressOptionsEqual(existing.lastOptions, progressOptions)) {
        return true;
      }
      await this.edit(existing.messageId, text, route || existing.route, progressOptions, renderOptions || existing.renderOptions);
      return true;
    } catch (error) {
      this.entries.delete(key);
      if (this.isMessageTooLong?.(error)) {
        this.onLog?.("Telegram progress finish too long; sending result as multiple messages");
      } else {
        this.onLog?.(`Telegram progress finish skipped: ${errorMessage(error)}`);
      }
      return false;
    }
  }

  async delete(key: string, route?: Route) {
    const existing = this.entries.get(key);
    if (!existing) {
      return false;
    }
    try {
      clearTimeout(existing.timer);
      existing.timer = undefined;
      existing.pendingText = undefined;
      if (existing.pending) {
        await existing.pending;
      }
      this.entries.delete(key);
      if (!this.deleteMessage || !existing.messageId) {
        return false;
      }
      await this.deleteMessage(existing.messageId, route || existing.route);
      return true;
    } catch (error) {
      this.entries.delete(key);
      this.onLog?.(`Telegram progress delete skipped: ${errorMessage(error)}`);
      return false;
    }
  }

  async flush(key: string) {
    const existing = this.entries.get(key);
    if (existing?.pending) {
      await existing.pending;
    }
    if (existing?.timer) {
      clearTimeout(existing.timer);
      existing.timer = undefined;
      const nextText = existing.pendingText;
      existing.pendingText = undefined;
      if (nextText) {
        await this.applyUpdate(key, nextText, existing.route, existing.options);
      }
    }
  }

  async wait(ms: number) {
    await sleep(ms);
  }
}

export { TelegramProgressStore };
export type { TelegramProgressEntry, TelegramProgressStoreOptions };
