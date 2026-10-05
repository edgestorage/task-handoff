import { randomUUID } from "node:crypto";
import { InstanceCreateInputSchema, InstanceDeleteInputSchema, UpdateInstanceInputSchema, type AppManagementJob } from "@task-handoff/protocol/control-plane";
import { CustomAppCatalogUpdateInputSchema } from "@task-handoff/protocol/app-catalog";
import { CLI_EXIT_CODES, ThctlError } from "../errors.ts";
import { guardApprovalProtocol } from "../operation-approvals.ts";
import { assertActive, openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import type { ThctlConnection } from "../control-plane.ts";
import { optionString, readJsonFile, requireArgument, requireOption } from "./support.ts";

function requireInstanceId(invocation: CliInvocation) {
  const instanceId = invocation.args.instanceId?.trim();
  if (!instanceId) throw new ThctlError("CLI_ARGUMENT_MISSING", "Missing required argument <instanceId>.", 2);
  return instanceId;
}

const INSTANCE_COLUMNS = [
  { key: "id", header: "instance" },
  { key: "name", header: "name", width: 24 },
  { key: "status", header: "status" },
  { key: "health", header: "health" },
  { key: "connectionStatus", header: "connection" },
  { key: "nodeId", header: "node" },
  { key: "runtime.type", header: "runtime" },
  { key: "workspace.status", header: "workspace" },
  { key: "aiSessions.runningCount", header: "running" },
];

export async function instanceList(context: CliContext, invocation: CliInvocation) {
  const connection = await openConnection(context);
  const entries = await connection.client.resources.instanceBoard(context.signal);
  const nodeId = typeof invocation.options.node === "string" ? invocation.options.node.trim() : "";
  const filtered = nodeId ? entries.filter((entry) => entry.nodeId === nodeId) : entries;
  return { data: filtered, columns: INSTANCE_COLUMNS, message: filtered.length ? undefined : "No controlled instances matched." };
}

export async function instanceShow(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const connection = await openConnection(context);
  const entries = await connection.client.resources.instanceBoard(context.signal);
  const entry = entries.find((candidate) => candidate.id === instanceId);
  if (!entry) {
    throw new ThctlError("CLI_INSTANCE_NOT_FOUND", `No controlled instance \`${instanceId}\` is visible to this account.`, 7, { instanceId });
  }
  return { data: entry, columns: INSTANCE_COLUMNS };
}

function lifecycleHandler(action: "start" | "stop" | "restart") {
  return async (context: CliContext, invocation: CliInvocation) => {
    const instanceId = requireInstanceId(invocation);
    const connection = await openConnection(context);
    const result = await performWrite(
      context,
      `instance ${action} ${instanceId}`,
      () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/${action}`, body: {} }),
      () => connection.client.resources.instanceAction(instanceId, action),
    );
    if (!result) return;
    return {
      data: result,
      columns: [{ key: "id", header: "instance" }, { key: "status", header: "status" }],
      message: `Instance \`${instanceId}\` is ${result.status}.`,
    };
  };
}

export const instanceStart = lifecycleHandler("start");
export const instanceStop = lifecycleHandler("stop");
export const instanceRestart = lifecycleHandler("restart");

const INSTANCE_CREATE_COLUMNS = [
  { key: "id", header: "instance" },
  { key: "name", header: "name", width: 24 },
  { key: "nodeId", header: "node" },
  { key: "status", header: "status" },
  { key: "startOutcome.status", header: "start" },
];

const INSTANCE_DELETE_COLUMNS = [
  { key: "instanceId", header: "instance" },
  { key: "containerDeleted", header: "container" },
  { key: "completed", header: "completed" },
];

/** create 的复杂入参来自 --config 文件（POST /api/controlled-instances 的 wire body），
 *  --name/--node/--start 只覆盖同名 wire 字段，不新增协议字段。 */
export async function instanceCreate(context: CliContext, invocation: CliInvocation) {
  const configFile = requireOption(invocation, "config");
  const input = readJsonFile(configFile, InstanceCreateInputSchema, "instance config");
  const name = optionString(invocation, "name");
  const nodeId = optionString(invocation, "node");
  const body = {
    ...input,
    ...(name ? { name } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(invocation.options.start === true ? { start: true } : {}),
  };
  const connection = await openConnection(context);
  const created = await performWrite(
    context,
    "instance create",
    () => ({ method: "POST", path: "/api/controlled-instances", body }),
    () => connection.client.resources.createInstance(body),
  );
  if (!created) return;
  const message = created.startOutcome.status === "failed"
    ? `Instance \`${created.id}\` created but start failed: ${created.startOutcome.error?.message ?? "unknown error"}.`
    : created.startOutcome.status === "started"
      ? `Instance \`${created.id}\` created; start requested (status: ${created.status}).`
      : `Instance \`${created.id}\` created (status: ${created.status}).`;
  return { data: created, columns: INSTANCE_CREATE_COLUMNS, message };
}

export async function instanceDelete(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const input = InstanceDeleteInputSchema.parse({ deleteVolumes: invocation.options.volumes === true });
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    `instance delete ${instanceId}`,
    () => ({ method: "DELETE", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}`, body: input }),
    () => guardApprovalProtocol(connection, () => connection.client.approvals.deleteInstance(instanceId, input)),
  );
  if (!result) return;
  if (!result.completed) {
    throw new ThctlError(
      "CLI_INSTANCE_DELETE_INCOMPLETE",
      `Instance \`${instanceId}\` deletion is incomplete; re-run the same command after resolving the failed volumes.`,
      CLI_EXIT_CODES.conflict,
      { instanceId, volumeResults: result.volumeResults },
    );
  }
  return {
    data: result,
    columns: INSTANCE_DELETE_COLUMNS,
    message: result.retainedVolumes.length
      ? `Instance \`${instanceId}\` deleted; ${result.retainedVolumes.length} volume(s) retained (pass --volumes to delete them).`
      : `Instance \`${instanceId}\` deleted.`,
  };
}

export async function instanceRename(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const name = invocation.args.name?.trim();
  if (!name) throw new ThctlError("CLI_ARGUMENT_MISSING", "Missing required argument <name>.", 2);
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    `instance rename ${instanceId}`,
    () => ({ method: "PATCH", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}`, body: { name } }),
    () => connection.client.resources.updateInstanceName(instanceId, name),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "id", header: "instance" },
      { key: "name", header: "name", width: 24 },
    ],
    message: `Instance \`${instanceId}\` renamed to \`${result.name}\`.`,
  };
}

const INSTANCE_UPDATE_COLUMNS = [
  { key: "id", header: "instance" },
  { key: "name", header: "name", width: 24 },
  { key: "status", header: "status" },
  { key: "connectionStatus", header: "connection" },
  { key: "nodeId", header: "node" },
  { key: "config.defaultCodexPermissionMode", header: "permission" },
  { key: "config.aiSessionHistoryLimit", header: "history" },
  { key: "config.aiSessionAttachmentRetentionDays", header: "retention" },
];

/** 更新实例设置：复杂字段（codexSettings、modelSelection 等）统一走 --config 文件，避免堆大量平铺选项。 */
export async function instanceUpdate(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const configFile = requireOption(invocation, "config");
  const input = readJsonFile(configFile, UpdateInstanceInputSchema, "instance update config");
  const connection = await openConnection(context);
  const updated = await performWrite(
    context,
    `instance update ${instanceId}`,
    () => ({ method: "PATCH", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}`, body: input }),
    () => connection.client.resources.updateInstance(instanceId, input),
  );
  if (!updated) return;
  return {
    data: updated,
    columns: INSTANCE_UPDATE_COLUMNS,
    message: `Instance \`${instanceId}\` updated.`,
  };
}

const APP_MANAGEMENT_COLUMNS = [
  { key: "id", header: "app" },
  { key: "name", header: "name", width: 24 },
  { key: "kind", header: "kind" },
  { key: "state", header: "state" },
  { key: "managementSource", header: "source" },
  { key: "version", header: "version" },
  { key: "canInstall", header: "install" },
  { key: "canUninstall", header: "uninstall" },
  { key: "activeJobId", header: "job" },
];

const APP_JOB_COLUMNS = [
  { key: "id", header: "job" },
  { key: "appId", header: "app" },
  { key: "operation", header: "operation" },
  { key: "state", header: "state" },
  { key: "phase", header: "phase" },
  { key: "updatedAt", header: "updated" },
];

const APP_JOB_TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const APP_JOB_POLL_INTERVAL_MS = 1000;
const APP_JOB_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

function appJobMessage(job: AppManagementJob) {
  if (job.state === "succeeded") return `App \`${job.appId}\` ${job.operation} succeeded.`;
  if (APP_JOB_TERMINAL_STATES.has(job.state)) {
    return `App \`${job.appId}\` ${job.operation} ${job.state}${job.error ? `: ${job.error.message}` : "."}`;
  }
  return `App \`${job.appId}\` ${job.operation} job \`${job.id}\` is ${job.state}${job.phase ? ` (${job.phase})` : ""}; pass --wait to follow it to completion.`;
}

/** 安装/卸载是实例上的异步任务；--wait 轮询到终态再返回，Ctrl+C 可随时中断。 */
async function waitForAppJob(context: CliContext, connection: ThctlConnection, instanceId: string, initial: AppManagementJob) {
  let job = initial;
  const deadline = Date.now() + APP_JOB_WAIT_TIMEOUT_MS;
  while (!APP_JOB_TERMINAL_STATES.has(job.state)) {
    if (Date.now() >= deadline) {
      throw new ThctlError(
        "CLI_APP_JOB_TIMEOUT",
        `Timed out waiting for app ${job.operation} job \`${job.id}\` (state: ${job.state}).`,
        CLI_EXIT_CODES.conflict,
        { instanceId, jobId: job.id, state: job.state },
      );
    }
    await context.sleep(APP_JOB_POLL_INTERVAL_MS);
    assertActive(context.signal);
    job = (await connection.client.apps.job(instanceId, job.id, context.signal)).job;
  }
  return job;
}

export async function instanceAppList(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const connection = await openConnection(context);
  const snapshot = await connection.client.apps.management(instanceId, context.signal);
  if (context.output.json) return { data: snapshot };
  const activeJobs = snapshot.activeJobs.length;
  return {
    data: snapshot.apps,
    columns: APP_MANAGEMENT_COLUMNS,
    message: snapshot.apps.length
      ? (activeJobs ? `${activeJobs} app job(s) in progress.` : undefined)
      : `No managed apps reported for instance \`${instanceId}\`.`,
  };
}

function instanceAppOperation(operation: "install" | "uninstall") {
  return async (context: CliContext, invocation: CliInvocation) => {
    const instanceId = requireInstanceId(invocation);
    const appId = requireArgument(invocation, "appId");
    const requestId = optionString(invocation, "request-id") ?? randomUUID();
    const wait = invocation.options.wait === true;
    const connection = await openConnection(context);
    const result = await performWrite(
      context,
      `instance app ${operation} ${instanceId}`,
      () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/${encodeURIComponent(appId)}/${operation}`, body: { requestId } }),
      () => connection.client.apps[operation](instanceId, appId, requestId),
    );
    if (!result) return;
    const job = wait ? await waitForAppJob(context, connection, instanceId, result.job) : result.job;
    return appJobResult(context, job, invocation.options.logs === true);
  };
}

export const instanceAppInstall = instanceAppOperation("install");
export const instanceAppUninstall = instanceAppOperation("uninstall");

export async function instanceAppJob(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const jobId = requireArgument(invocation, "jobId");
  const wait = invocation.options.wait === true;
  const connection = await openConnection(context);
  let job = (await connection.client.apps.job(instanceId, jobId, context.signal)).job;
  if (wait) job = await waitForAppJob(context, connection, instanceId, job);
  return appJobResult(context, job, invocation.options.logs === true);
}

const APP_CATALOG_COLUMNS = [
  { key: "id", header: "app" },
  { key: "name", header: "name", width: 24 },
  { key: "kind", header: "kind" },
  { key: "description", header: "description", width: 60 },
];

export async function instanceAppCatalog(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const connection = await openConnection(context);
  const catalog = await connection.client.apps.catalog(instanceId, context.signal);
  if (context.output.json) return { data: catalog };
  return {
    data: catalog.items,
    columns: APP_CATALOG_COLUMNS,
    message: catalog.items.length ? undefined : `Instance \`${instanceId}\` reports no launchable apps.`,
  };
}

export async function instanceAppCatalogCustom(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const connection = await openConnection(context);
  const catalog = await connection.client.apps.customCatalog(instanceId, context.signal);
  if (context.output.json) return { data: catalog };
  return {
    data: catalog.items,
    columns: APP_CATALOG_COLUMNS,
    message: catalog.items.length
      ? `Custom app catalog v${catalog.schemaVersion} has ${catalog.items.length} app(s).`
      : "The custom app catalog is empty.",
  };
}

/** 自定义目录是整表替换：--config 提供 {"items": [...]}，避免逐项增删的中间态。 */
export async function instanceAppCatalogCustomUpdate(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireInstanceId(invocation);
  const configFile = requireOption(invocation, "config");
  const input = readJsonFile(configFile, CustomAppCatalogUpdateInputSchema, "custom app catalog config");
  const connection = await openConnection(context);
  const catalog = await performWrite(
    context,
    `instance app catalog custom update ${instanceId}`,
    () => ({ method: "PATCH", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/catalog/custom`, body: input }),
    () => connection.client.apps.updateCustomCatalog(instanceId, input),
  );
  if (!catalog) return;
  if (context.output.json) return { data: catalog };
  return {
    data: catalog.items,
    columns: APP_CATALOG_COLUMNS,
    message: `Custom app catalog updated with ${catalog.items.length} app(s).`,
  };
}

/** 作业日志只随 AppManagementJob.logTail 传输；默认不刷屏，--logs 时附在结果后面。 */
function appJobResult(context: CliContext, job: AppManagementJob, includeLogs = false) {
  const message = appJobMessage(job);
  if (!includeLogs || !job.logTail) return { data: job, columns: APP_JOB_COLUMNS, message };
  return {
    data: job,
    columns: APP_JOB_COLUMNS,
    message: `${message}\n${job.logTail.trimEnd()}`,
  };
}
