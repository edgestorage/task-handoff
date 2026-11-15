import fs from "node:fs";
import path from "node:path";
import { atomicWriteJsonSync } from "@task-handoff/core/storage/atomic-write";

/** Sole durable owner of enable intent. Package presence cannot determine this
 * choice. Separate from general instance config so older CP writes preserve it.
 * Missing/legacy fields disable only desktop. Tokens and session state never enter
 * this file; installation enables intent, uninstall clears it, and updates preserve it. */
export class DesktopSettings {
  private readonly file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, "remote-desktop.json"); }
  get(): { enabled: boolean } {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file,"utf8"));
      return { enabled: Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as {enabled?:unknown}).enabled === true) };
    } catch { return { enabled: false }; }
  }
  set(enabled: boolean) {
    atomicWriteJsonSync(this.file,{ enabled });
    return this.get();
  }
  clear() { fs.rmSync(this.file,{force:true}); }
}
