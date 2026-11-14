import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import type { DesktopIceConfig } from "@task-handoff/protocol/remote-desktop";

const Region = z.object({ urls: z.array(z.string().url()).min(1).max(16) }).strip();
const Config = z.object({ region: z.string().min(1), regions: z.record(z.string(), Region), secretFile: z.string().optional(), clockHealthFile: z.string(), maxClockSkewMs: z.number().positive().max(30_000).default(5000) }).strip();
const Clock = z.object({ measuredAt: z.number(), offsetMs: z.number(), synchronized: z.boolean() }).strip();
// Compatibility for v0.0.51: read only for the one-time DB import. Do not
// expose deployment paths or shared secrets through the settings API.
export function readLegacyDesktopTurn() {
  const file = process.env.TASK_HANDOFF_DESKTOP_TURN_CONFIG;
  if (!file) return undefined;
  const config = Config.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const urls = config.regions[config.region]?.urls;
  const secret = process.env.TASK_HANDOFF_DESKTOP_TURN_SECRET ?? (config.secretFile ? fs.readFileSync(config.secretFile, "utf8").trim() : "");
  if (!urls?.length || !secret) throw new Error("REMOTE_DESKTOP_TURN_IMPORT_INVALID");
  return { urls, secret, clock: { file: config.clockHealthFile, maxSkewMs: config.maxClockSkewMs } };
}
/** Deployment-owned configuration and health evidence, never a business record.
 * Health is measured by the deployment's CP/coturn clock monitor, not a browser.
 * No stored/session credentials and no default public relay. */
export class DesktopTurnIssuer {
  constructor(private readonly configuration: unknown, private readonly environmentSecret?: string, private readonly now = Date.now) {}
  static fromEnvironment() {
    const file = process.env.TASK_HANDOFF_DESKTOP_TURN_CONFIG;
    return new DesktopTurnIssuer(file ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined, process.env.TASK_HANDOFF_DESKTOP_TURN_SECRET);
  }
  issue(): DesktopIceConfig {
    if (this.configuration === undefined) return { iceServers: [], iceCredentialsExpiresAt: null };
    try {
      const config = Config.parse(this.configuration);
      const region = config.regions[config.region]; if (!region) throw new Error();
      for (const value of region.urls) {
        if (!/^(turn:.*\?transport=(udp|tcp)|turns:.*\?transport=tcp)$/.test(value)) throw new Error();
      }
      const health = Clock.parse(JSON.parse(fs.readFileSync(config.clockHealthFile, "utf8")));
      const now = this.now();
      if (!health.synchronized || Math.abs(health.offsetMs) > config.maxClockSkewMs || now - health.measuredAt > 60_000 || health.measuredAt > now + config.maxClockSkewMs) throw new Error();
      const secret = this.environmentSecret ?? (config.secretFile ? fs.readFileSync(config.secretFile, "utf8").trim() : "");
      if (!secret) throw new Error();
      const expiry = Math.floor(now / 1000) + 600;
      const username = `${expiry}:${randomBytes(18).toString("base64url")}`;
      const credential = createHmac("sha1", secret).update(username).digest("base64");
      return { iceServers: [{ urls: region.urls, username, credential }], iceCredentialsExpiresAt: expiry * 1000 };
    } catch { throw Object.assign(new Error("Remote desktop TURN configuration or clock health is unavailable."), { code: "REMOTE_DESKTOP_TURN_UNAVAILABLE", statusCode: 409 }); }
  }
}
