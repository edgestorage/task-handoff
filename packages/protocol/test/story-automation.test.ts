import assert from "node:assert/strict";
import test from "node:test";
import {
  StoryActionSchema,
  StoryAutomationInputSchema,
  StoryAutomationScheduleSchema,
  StoryAutomationUpdateInputSchema,
  StoryAutomationWithActionInputSchema,
} from "../src/stories.ts";

test("Story Action treats braces literally and rejects removed parameters", () => {
  const action = StoryActionSchema.parse({ id: "action_1", title: "Deploy", promptTemplate: "Deploy {{environment}}" });
  assert.equal(action.promptTemplate, "Deploy {{environment}}");
  assert.equal(StoryActionSchema.safeParse({ ...action, parameters: [] }).success, false);
});

test("Story Automation owns strict schedule and policy wire models without parameter values", () => {
  const input = {
    storyId: "story_1",
    actionId: "action_1",
    schedule: { scheduleKind: "interval", intervalMs: 60_000 },
    enabled: true,
    policy: { maxConcurrentRuns: 1, whenBusy: "queue" },
  };
  assert.equal(StoryAutomationInputSchema.safeParse(input).success, true);
  assert.equal(StoryAutomationInputSchema.safeParse({ ...input, parameterValues: { environment: "prod" } }).success, false);
  assert.equal(StoryAutomationScheduleSchema.safeParse({ scheduleKind: "interval", intervalMs: 59_999 }).success, false);
  assert.equal(StoryAutomationScheduleSchema.safeParse({ scheduleKind: "monthly", dayOfMonth: 15, timeOfDay: "09:00", timezone: "UTC" }).success, true);
  assert.equal(StoryAutomationScheduleSchema.safeParse({ scheduleKind: "monthly", dayOfMonth: -1, timeOfDay: "09:00", timezone: "UTC" }).success, true);
  assert.equal(StoryAutomationScheduleSchema.safeParse({ scheduleKind: "monthly", dayOfMonth: -2, timeOfDay: "09:00", timezone: "UTC" }).success, true);
  assert.equal(StoryAutomationScheduleSchema.safeParse({ scheduleKind: "monthly", dayOfMonth: -3, timeOfDay: "09:00", timezone: "UTC" }).success, true);
  assert.equal(StoryAutomationScheduleSchema.safeParse({ scheduleKind: "monthly", dayOfMonth: 0, timeOfDay: "09:00", timezone: "UTC" }).success, false);
  assert.equal(StoryAutomationScheduleSchema.safeParse({ scheduleKind: "monthly", dayOfMonth: 32, timeOfDay: "09:00", timezone: "UTC" }).success, false);
});

test("Story Automation ownership cannot be changed by an update", () => {
  assert.equal(StoryAutomationUpdateInputSchema.safeParse({ storyId: "story_2" }).success, false);
  assert.deepEqual(StoryAutomationUpdateInputSchema.parse({ enabled: false }), { enabled: false });
});

test("Story Automation with Action has one strict create command input", () => {
  const input = {
    action: { id: "action_1", title: "Deploy", promptTemplate: "Deploy", targetInstanceId: "instance_1" },
    automation: { schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: true, policy: { maxConcurrentRuns: 1, whenBusy: "skip" } },
  };
  assert.equal(StoryAutomationWithActionInputSchema.safeParse(input).success, true);
  assert.equal(StoryAutomationWithActionInputSchema.safeParse({ ...input, automation: { ...input.automation, storyId: "story_1" } }).success, false);
});
