const assert = require("node:assert/strict");
const test = require("node:test");

const { relevantEnv } = require("../packages/core/src/core/diagnostics.ts");

test("controlled instance diagnostics redact full provider config content", () => {
  const env = relevantEnv({
    TASK_HANDOFF_INSTANCE_NAME: "TestDocker",
    TASK_HANDOFF_OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: {
        "task-handoff-mdl_example": {
          options: { apiKey: "provider-secret" },
        },
      },
    }),
    TASK_HANDOFF_OPENAI_API_KEY: "sk-example-secret",
  });

  assert.equal(env.TASK_HANDOFF_INSTANCE_NAME, "TestDocker");
  assert.equal(env.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT, "[redacted]");
  assert.equal(env.TASK_HANDOFF_OPENAI_API_KEY, "[redacted]");
  assert.equal(JSON.stringify(env).includes("provider-secret"), false);
  assert.equal(JSON.stringify(env).includes("sk-example-secret"), false);
});
