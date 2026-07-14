import crypto from "node:crypto";

export type ExpiringTokenRecord = {
  token: string;
  expiresAt: string;
};

export type ExpiringTokenStoreOptions = {
  invalidMessage: string;
  invalidCode: string;
  invalidStatusCode?: number;
  tokenBytes: number;
  ttlMs: number;
};

export class ExpiringTokenStore<T extends ExpiringTokenRecord> {
  private readonly records = new Map<string, T>();
  private readonly options: ExpiringTokenStoreOptions;

  constructor(options: ExpiringTokenStoreOptions) {
    this.options = options;
  }

  create(input: Omit<T, "token" | "expiresAt"> & { ttlMs?: number }) {
    const token = crypto.randomBytes(this.options.tokenBytes).toString("base64url");
    const record = {
      ...input,
      token,
      expiresAt: new Date(Date.now() + (input.ttlMs || this.options.ttlMs)).toISOString(),
    } as T;
    this.records.set(token, record);
    return record;
  }

  resolve(token: string, predicate?: (record: T) => boolean) {
    const record = this.records.get(token);
    if (!record) {
      throw this.invalidError();
    }
    if (record.expiresAt <= new Date().toISOString()) {
      this.records.delete(token);
      throw this.invalidError();
    }
    if (predicate && !predicate(record)) {
      throw this.invalidError();
    }
    return record;
  }

  private invalidError() {
    const error = new Error(this.options.invalidMessage);
    Object.assign(error, { statusCode: this.options.invalidStatusCode || 400, code: this.options.invalidCode });
    return error;
  }
}
