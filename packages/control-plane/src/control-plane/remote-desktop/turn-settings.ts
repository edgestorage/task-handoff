import fs from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { CustomTurnUpdateSchema, type CustomTurnSettings, type CustomTurnUpdate } from "@task-handoff/protocol/control-plane-desktop";
import type { DesktopIceConfig } from "@task-handoff/protocol/remote-desktop";
import type { SecretEnvelopeService } from "../persistence/secret-envelope.ts";
import { DesktopTurnRecordSchema, type DesktopTurnRecord, type DesktopTurnRepository } from "./turn-record.ts";
import { readLegacyDesktopTurn } from "./turn.ts";

const context = "control-plane:desktop-turn";
const Clock = z.object({ measuredAt: z.number(), offsetMs: z.number(), synchronized: z.boolean() }).strip();
function error(code: string, statusCode: number) { return Object.assign(new Error(code), { code, statusCode }); }
export class DesktopTurnSettingsService {
  private record: DesktopTurnRecord = { revision: 0, enabled: false, urls: [], authentication: "password", username: "" };
  private writes: Promise<unknown> = Promise.resolve();
  private readonly repository: DesktopTurnRepository;
  private readonly secrets: SecretEnvelopeService;
  private readonly now: () => number;
  constructor(repository: DesktopTurnRepository, secrets: SecretEnvelopeService, now = Date.now) {
    this.repository = repository;
    this.secrets = secrets;
    this.now = now;
  }
  async init() {
    const stored = await this.repository.get();
    if (stored) { this.record = stored; return; }
    // Compatibility for v0.0.51: import the deployment configuration once.
    // Preserve its clock monitor requirement; subsequent edits use DB authority.
    const legacy = readLegacyDesktopTurn();
    const record = legacy ? DesktopTurnRecordSchema.parse({ revision: 1, enabled: true,
      urls: legacy.urls, authentication: "shared-secret", username: "",
      secretCiphertext: this.secrets.seal(legacy.secret, context), legacyClock: legacy.clock,
    }) : this.record;
    await this.repository.put(record);
    this.record = record;
  }
  snapshot(): CustomTurnSettings {
    const { secretCiphertext, legacyClock: _clock, ...fields } = this.record;
    return { ...fields, secretConfigured: !!secretCiphertext, configured: fields.enabled && !!fields.urls.length && !!secretCiphertext };
  }
  update(input: CustomTurnUpdate): Promise<CustomTurnSettings> {
    const next = this.writes.then(async () => {
      const value = CustomTurnUpdateSchema.parse(input);
      if (value.expectedRevision !== this.record.revision) throw error("REMOTE_DESKTOP_TURN_REVISION_CONFLICT", 409);
      const sameAuth = value.authentication === this.record.authentication;
      const secretCiphertext = value.secret ? this.secrets.seal(value.secret, context) : sameAuth ? this.record.secretCiphertext : undefined;
      if (value.enabled && !secretCiphertext) throw error("REMOTE_DESKTOP_TURN_SECRET_REQUIRED", 400);
      // An imported HMAC configuration retains its clock-health contract until
      // credentials/authentication are replaced. UI-owned HMAC uses host time,
      // as standard coturn REST authentication does; hosts must synchronize time.
      const legacyClock = sameAuth && !value.secret ? this.record.legacyClock : undefined;
      const record = DesktopTurnRecordSchema.parse({ ...value, revision: this.record.revision + 1, secretCiphertext, legacyClock });
      await this.repository.put(record);
      this.record = record;
      return this.snapshot();
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
  issue(): DesktopIceConfig {
    if (!this.snapshot().configured) return { iceServers: [], iceCredentialsExpiresAt: null };
    try {
      const config = this.record;
      const now = this.now();
      if (config.legacyClock) {
        const health = Clock.parse(JSON.parse(fs.readFileSync(config.legacyClock.file, "utf8")));
        if (!health.synchronized || Math.abs(health.offsetMs) > config.legacyClock.maxSkewMs || now - health.measuredAt > 60_000 || health.measuredAt > now + config.legacyClock.maxSkewMs) throw new Error();
      }
      const secret = this.secrets.open(config.secretCiphertext!, context);
      if (config.authentication === "password") return { iceServers: [{ urls: config.urls, username: config.username, credential: secret }], iceCredentialsExpiresAt: null };
      const expiry = Math.floor(now / 1000) + 600;
      const username = `${expiry}:${randomBytes(18).toString("base64url")}`;
      return { iceServers: [{ urls: config.urls, username, credential: createHmac("sha1", secret).update(username).digest("base64") }], iceCredentialsExpiresAt: expiry * 1000 };
    } catch { throw error("REMOTE_DESKTOP_TURN_UNAVAILABLE", 409); }
  }
}
