import { z } from "zod";
import { CustomTurnSettingsSchema } from "@task-handoff/protocol/control-plane-desktop";

// Private singleton in cp_metadata; only CP reads/writes it. No extra public
// entity ID: this record belongs to the panel, not a node or viewer session.
export const DesktopTurnRecordSchema = CustomTurnSettingsSchema.omit({ configured: true, secretConfigured: true }).extend({
  secretCiphertext: z.string().optional(),
  legacyClock: z.object({ file: z.string(), maxSkewMs: z.number().positive() }).strip().optional(),
}).strip();
export type DesktopTurnRecord = z.infer<typeof DesktopTurnRecordSchema>;

export interface DesktopTurnRepository {
  get(): Promise<DesktopTurnRecord | undefined>;
  put(record: DesktopTurnRecord): Promise<void>;
}
