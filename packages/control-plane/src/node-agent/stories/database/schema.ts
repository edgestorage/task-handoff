import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { StoryAutomationPolicy, StoryAutomationRun, StoryAutomationSchedule, StorySessionPreset } from "@task-handoff/protocol/stories";
import type { StoryAutomationExecutionInput } from "./records.ts";

export const migrationLedger = sqliteTable("na_migration_ledger", {
  id: text("id").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: text("applied_at").notNull(),
  details: text("details", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

export const stories = sqliteTable("na_stories", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  archivedAt: text("archived_at"),
  maxIdleAiSessions: integer("max_idle_ai_sessions").notNull().default(5),
  nextDocumentSequence: integer("next_document_sequence").notNull().default(1),
}, (table) => [
  check("na_stories_max_idle_check", sql`${table.maxIdleAiSessions} BETWEEN 1 AND 50`),
  check("na_stories_next_document_sequence_check", sql`${table.nextDocumentSequence} > 0`),
  index("na_stories_created_idx").on(table.createdAt),
]);

export const actions = sqliteTable("na_story_actions", {
  storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  title: text("title").notNull(),
  promptTemplate: text("prompt_template").notNull(),
  targetInstanceId: text("target_instance_id"),
  sessionPreset: text("session_preset_json", { mode: "json" }).$type<StorySessionPreset>(),
  displayOrder: integer("display_order").notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyId, table.id] }),
  index("na_story_actions_order_idx").on(table.storyId, table.displayOrder, table.id),
]);

export const documents = sqliteTable("na_story_documents", {
  storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  storyPath: text("story_path").notNull(),
  title: text("title").notNull(),
  indexedSequence: integer("indexed_sequence").notNull(),
  displayOrder: integer("display_order").notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyId, table.storyPath] }),
  uniqueIndex("na_story_documents_sequence_uq").on(table.storyId, table.indexedSequence),
  index("na_story_documents_page_idx").on(table.storyId, table.indexedSequence, table.storyPath),
  index("na_story_documents_display_idx").on(table.storyId, table.displayOrder, table.storyPath),
  check("na_story_documents_sequence_check", sql`${table.indexedSequence} > 0`),
]);

export const automations = sqliteTable("na_story_automations", {
  id: text("id").primaryKey(),
  storyId: text("story_id").notNull(),
  actionId: text("action_id").notNull(),
  schedule: text("schedule_json", { mode: "json" }).$type<StoryAutomationSchedule>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  policy: text("policy_json", { mode: "json" }).$type<StoryAutomationPolicy>().notNull(),
  scheduleAnchorAt: text("schedule_anchor_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  foreignKey({ columns: [table.storyId, table.actionId], foreignColumns: [actions.storyId, actions.id], name: "na_story_automations_action_fk" }).onDelete("restrict"),
  index("na_story_automations_story_idx").on(table.storyId),
  index("na_story_automations_enabled_idx").on(table.enabled),
]);

export const automationRuns = sqliteTable("na_story_automation_runs", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
  eventType: text("event_type", { enum: ["manual", "schedule"] }).notNull(),
  status: text("status", { enum: ["queued", "dispatching", "running", "completed", "failed", "skipped"] }).notNull(),
  scheduledFor: text("scheduled_for").notNull(),
  targetInstanceId: text("target_instance_id").notNull(),
  aiSessionId: text("ai_session_id"),
  error: text("error_json", { mode: "json" }).$type<NonNullable<StoryAutomationRun["error"]>>(),
  queuedAt: text("queued_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  executionKey: text("execution_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  executionInput: text("execution_input_json", { mode: "json" }).$type<StoryAutomationExecutionInput>().notNull(),
}, (table) => [
  uniqueIndex("na_story_automation_runs_execution_key_uq").on(table.executionKey),
  index("na_story_automation_runs_automation_time_idx").on(table.automationId, table.queuedAt),
  index("na_story_automation_runs_status_idx").on(table.status, table.scheduledFor),
]);

export const fileMutations = sqliteTable("na_story_file_mutations", {
  id: text("id").primaryKey(),
  storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "restrict" }),
  operation: text("operation", { enum: ["write", "rename", "delete"] }).notNull(),
  storyPath: text("story_path").notNull(),
  nextStoryPath: text("next_story_path"),
  title: text("title"),
  temporaryName: text("temporary_name"),
  backupName: text("backup_name"),
  phase: text("phase", { enum: ["receiving", "prepared", "files-staged", "database-committed", "cleanup"] }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("na_story_file_mutations_story_idx").on(table.storyId, table.createdAt)]);

export const deletionIntents = sqliteTable("na_story_deletion_intents", {
  storyId: text("story_id").primaryKey(),
  phase: text("phase", { enum: ["prepared", "files-staged", "database-committed", "cleanup"] }).notNull(),
  trashName: text("trash_name"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
