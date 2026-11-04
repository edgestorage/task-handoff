import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { runInTransaction } from "./transaction-journal.ts";

type Row = Record<string, unknown>;
const STORY_AGENT_ENTRY_COLUMNS = new Set(["story_id", "agent_id", "orchestration_id", "created_at"]);

export type StoryAgentEntryReference = { agentId: string; orchestrationId: string };

export type StoryAgentEntryRecord = {
  storyId: string;
  revision: string;
  entries: StoryAgentEntryReference[];
};

export type StoryAgentEntryDiagnostic = (message: string, details: Record<string, unknown>) => void;

/** revision 只由入口对集合派生：顺序无关，重复提交相同集合不会伪造出新修订。 */
export function storyAgentEntryRevision(entries: readonly StoryAgentEntryReference[]) {
  const normalized = [...new Map(entries.map((entry) => [`${entry.agentId}\u001f${entry.orchestrationId}`, entry])).values()]
    .sort((left, right) => (left.agentId === right.agentId
      ? left.orchestrationId.localeCompare(right.orchestrationId)
      : left.agentId.localeCompare(right.agentId)));
  return crypto.createHash("sha256").update(JSON.stringify(normalized.map((entry) => [entry.agentId, entry.orchestrationId]))).digest("hex");
}

export class StoryAgentEntryRepository {
  private readonly client: DatabaseSync;
  private diagnostic?: StoryAgentEntryDiagnostic;

  constructor(client: DatabaseSync) {
    this.client = client;
  }

  setDiagnostic(sink: StoryAgentEntryDiagnostic) {
    this.diagnostic = sink;
  }

  get(storyId: string): StoryAgentEntryRecord {
    const rows = this.client.prepare(
      "SELECT * FROM na_story_agent_entries WHERE story_id = ? ORDER BY agent_id, orchestration_id",
    ).all(storyId) as Row[];
    for (const row of rows) {
      const unknownColumns = Object.keys(row).filter((column) => !STORY_AGENT_ENTRY_COLUMNS.has(column));
      if (unknownColumns.length) {
        this.diagnostic?.("Story Agent entry row contains unknown columns; they are ignored on read.", {
          storyId,
          agentId: row.agent_id,
          columns: unknownColumns,
        });
      }
    }
    const entries = rows.map((row) => ({ agentId: String(row.agent_id), orchestrationId: String(row.orchestration_id) }));
    return { storyId, revision: storyAgentEntryRevision(entries), entries };
  }

  replace(storyId: string, entries: readonly StoryAgentEntryReference[], timestamp = new Date().toISOString()): StoryAgentEntryRecord {
    return runInTransaction(this.client, () => {
      const normalized = [...new Map(entries.map((entry) => [`${entry.agentId}\u001f${entry.orchestrationId}`, entry])).values()]
        .sort((left, right) => (left.agentId === right.agentId
          ? left.orchestrationId.localeCompare(right.orchestrationId)
          : left.agentId.localeCompare(right.agentId)));
      this.client.prepare("DELETE FROM na_story_agent_entries WHERE story_id = ?").run(storyId);
      const insert = this.client.prepare(
        "INSERT INTO na_story_agent_entries (story_id, agent_id, orchestration_id, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const entry of normalized) insert.run(storyId, entry.agentId, entry.orchestrationId, timestamp);
      return this.get(storyId);
    });
  }
}
