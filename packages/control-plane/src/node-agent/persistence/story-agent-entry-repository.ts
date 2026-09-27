import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;
const STORY_AGENT_ENTRY_COLUMNS = new Set(["story_id", "agent_id", "created_at"]);

export type StoryAgentEntryRecord = {
  storyId: string;
  revision: string;
  agentIds: string[];
};

export type StoryAgentEntryDiagnostic = (message: string, details: Record<string, unknown>) => void;

function runImmediate<T>(client: DatabaseSync, operation: () => T): T {
  if ((client as DatabaseSync & { isTransaction?: boolean }).isTransaction) return operation();
  client.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    client.exec("COMMIT");
    return result;
  } catch (error) {
    client.exec("ROLLBACK");
    throw error;
  }
}

export function storyAgentEntryRevision(agentIds: string[]) {
  return crypto.createHash("sha256").update(JSON.stringify([...new Set(agentIds)].sort())).digest("hex");
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
      "SELECT * FROM na_story_agent_entries WHERE story_id = ? ORDER BY agent_id",
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
    const agentIds = rows.map((row) => String(row.agent_id));
    return { storyId, revision: storyAgentEntryRevision(agentIds), agentIds };
  }

  replace(storyId: string, agentIds: string[], timestamp = new Date().toISOString()): StoryAgentEntryRecord {
    return runImmediate(this.client, () => {
      const normalized = [...new Set(agentIds)].sort();
      this.client.prepare("DELETE FROM na_story_agent_entries WHERE story_id = ?").run(storyId);
      const insert = this.client.prepare(
        "INSERT INTO na_story_agent_entries (story_id, agent_id, created_at) VALUES (?, ?, ?)",
      );
      for (const agentId of normalized) insert.run(storyId, agentId, timestamp);
      return this.get(storyId);
    });
  }
}
