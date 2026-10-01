import { ControlPlaneTriggerTemplateInputSchema } from "@task-handoff/protocol/triggers";
import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, writeSteps, type CliContext, type CliInvocation } from "../runtime.ts";
import { optionString, readJsonFile, requireArgument, requireOption } from "./support.ts";

const TRIGGER_COLUMNS = [
  { key: "configHash", header: "trigger" },
  { key: "config.name", header: "name", width: 24 },
  { key: "config.source.type", header: "source" },
  { key: "deploymentCount", header: "deployments" },
  { key: "enabledCount", header: "enabled" },
  { key: "runningCount", header: "running" },
  { key: "errorCount", header: "errors" },
];

function summaryRow(trigger: Record<string, unknown>) {
  return {
    ...trigger,
    deploymentCount: Array.isArray(trigger.deployments) ? (trigger.deployments as unknown[]).length : 0,
  };
}

export async function triggerList(context: CliContext, invocation: CliInvocation) {
  const instanceId = optionString(invocation, "instance");
  const connection = await openConnection(context);
  const view = await connection.client.triggers.list(context.signal);
  const triggers = instanceId
    ? view.triggers.filter((trigger) => trigger.deployments.some((deployment) => deployment.instanceId === instanceId))
    : view.triggers;
  if (context.output.json) return { data: { ...view, triggers } };
  return { data: triggers.map(summaryRow), columns: TRIGGER_COLUMNS, message: triggers.length ? undefined : "No triggers matched." };
}

export async function triggerShow(context: CliContext, invocation: CliInvocation) {
  const configHash = requireArgument(invocation, "configHash");
  const instanceId = optionString(invocation, "instance");
  const connection = await openConnection(context);
  const view = await connection.client.triggers.list(context.signal);
  const trigger = view.triggers.find((candidate) => candidate.configHash === configHash);
  if (!trigger) {
    throw new ThctlError("CLI_TRIGGER_NOT_FOUND", `No trigger \`${configHash}\` is visible in the control plane registry.`, 7, { configHash });
  }
  const scoped = instanceId
    ? { ...trigger, deployments: trigger.deployments.filter((deployment) => deployment.instanceId === instanceId) }
    : trigger;
  if (instanceId && scoped.deployments.length === 0) {
    throw new ThctlError("CLI_TRIGGER_DEPLOYMENT_NOT_FOUND", `Trigger \`${configHash}\` has no deployment on instance \`${instanceId}\`.`, 7, { configHash, instanceId });
  }
  if (context.output.json) return { data: scoped };
  return { data: summaryRow(scoped), columns: TRIGGER_COLUMNS };
}

/**
 * 控制平面模板与实例绑定是两次写请求：dry-run 会逐步输出，
 * 非交互环境必须显式 --yes 才会发送。
 */
export async function triggerCreate(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const configFile = requireOption(invocation, "config");
  const input = readJsonFile(configFile, ControlPlaneTriggerTemplateInputSchema, "trigger config");
  const connection = await openConnection(context);
  const created = await performWrite(
    context,
    "trigger create",
    () => writeSteps([
      { method: "POST", path: "/api/triggers", body: input },
      { method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/triggers`, body: { configHash: "<created>" } },
    ]),
    async () => {
      const trigger = await connection.client.triggers.create(input);
      const binding = await connection.client.triggers.bindSession(instanceId, sessionId, trigger.configHash);
      return { trigger, binding };
    },
  );
  if (!created) return;
  return {
    data: created,
    columns: TRIGGER_COLUMNS,
    message: `Trigger \`${created.trigger.configHash}\` created and bound to AI session \`${sessionId}\`.`,
  };
}

export async function triggerUpdate(context: CliContext, invocation: CliInvocation) {
  const configHash = requireArgument(invocation, "configHash");
  const configFile = requireOption(invocation, "config");
  const input = readJsonFile(configFile, ControlPlaneTriggerTemplateInputSchema, "trigger config");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "trigger update",
    () => ({ method: "PUT", path: `/api/triggers/${encodeURIComponent(configHash)}`, body: input }),
    () => connection.client.triggers.update(configHash, input),
  );
  if (!result) return;
  return { data: result, message: `Trigger \`${configHash}\` updated.` };
}

export async function triggerRemove(context: CliContext, invocation: CliInvocation) {
  const configHash = requireArgument(invocation, "configHash");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "trigger remove",
    () => ({ method: "DELETE", path: `/api/triggers/${encodeURIComponent(configHash)}` }),
    () => connection.client.triggers.remove(configHash),
  );
  if (!result) return;
  return { data: result, message: `Trigger \`${configHash}\` removed.` };
}

export async function triggerRun(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const configHash = requireArgument(invocation, "configHash");
  const deploymentId = optionString(invocation, "deployment");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "trigger run",
    () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/triggers/${encodeURIComponent(configHash)}/run`, body: deploymentId ? { deploymentId } : {} }),
    () => connection.client.triggers.run(instanceId, configHash, deploymentId),
  );
  if (!result) return;
  return { data: result, message: `Trigger \`${configHash}\` run requested on instance \`${instanceId}\`.` };
}
