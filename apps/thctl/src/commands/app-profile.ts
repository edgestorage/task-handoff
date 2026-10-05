import { z } from "zod";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { parseWithSchema, requireArgument, requireOption } from "./support.ts";

/** 与 protocol `AppProfileCreateInputSchema`/`AppProfileRenameInputSchema` 的 name 约束对齐。 */
const PROFILE_NAME_SCHEMA = z.string().trim().min(1).max(60);

const PROFILE_COLUMNS = [
  { key: "id", header: "profile" },
  { key: "name", header: "name", width: 24 },
  { key: "isDefault", header: "default" },
  { key: "runningSessionId", header: "session" },
  { key: "diskUsageBytes", header: "disk" },
  { key: "updatedAt", header: "updated" },
];

function profileTarget(invocation: CliInvocation) {
  return {
    instanceId: requireArgument(invocation, "instanceId"),
    appId: requireArgument(invocation, "appId"),
  };
}

export async function appProfileList(context: CliContext, invocation: CliInvocation) {
  const { instanceId, appId } = profileTarget(invocation);
  const connection = await openConnection(context);
  const view = await connection.client.appProfiles.list(instanceId, appId, context.signal);
  if (context.output.json) return { data: view };
  return {
    data: view.profiles,
    columns: PROFILE_COLUMNS,
    message: view.profiles.length ? undefined : `No browser profiles matched app \`${appId}\`.`,
  };
}

export async function appProfileCreate(context: CliContext, invocation: CliInvocation) {
  const { instanceId, appId } = profileTarget(invocation);
  const name = parseWithSchema(PROFILE_NAME_SCHEMA, requireOption(invocation, "name"), "--name");
  const connection = await openConnection(context);
  const profile = await performWrite(
    context,
    "app-profile create",
    () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/${encodeURIComponent(appId)}/profiles`, body: { name } }),
    () => connection.client.appProfiles.create(instanceId, appId, name),
  );
  if (!profile) return;
  return {
    data: profile,
    columns: PROFILE_COLUMNS,
    message: `Browser profile \`${profile.name}\` created for app \`${appId}\`.`,
  };
}

export async function appProfileRename(context: CliContext, invocation: CliInvocation) {
  const { instanceId, appId } = profileTarget(invocation);
  const profileId = requireArgument(invocation, "profileId");
  const name = parseWithSchema(PROFILE_NAME_SCHEMA, requireOption(invocation, "name"), "--name");
  const connection = await openConnection(context);
  const profile = await performWrite(
    context,
    "app-profile rename",
    () => ({ method: "PATCH", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/${encodeURIComponent(appId)}/profiles/${encodeURIComponent(profileId)}`, body: { name } }),
    () => connection.client.appProfiles.rename(instanceId, appId, profileId, name),
  );
  if (!profile) return;
  return {
    data: profile,
    columns: PROFILE_COLUMNS,
    message: `Browser profile \`${profileId}\` renamed to \`${profile.name}\`.`,
  };
}

export async function appProfileSetDefault(context: CliContext, invocation: CliInvocation) {
  const { instanceId, appId } = profileTarget(invocation);
  const profileId = requireArgument(invocation, "profileId");
  const connection = await openConnection(context);
  const profile = await performWrite(
    context,
    "app-profile set-default",
    () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/${encodeURIComponent(appId)}/profiles/${encodeURIComponent(profileId)}/default`, body: {} }),
    () => connection.client.appProfiles.setDefault(instanceId, appId, profileId),
  );
  if (!profile) return;
  return {
    data: profile,
    columns: PROFILE_COLUMNS,
    message: `Browser profile \`${profile.name}\` is now the default for app \`${appId}\`.`,
  };
}

export async function appProfileRemove(context: CliContext, invocation: CliInvocation) {
  const { instanceId, appId } = profileTarget(invocation);
  const profileId = requireArgument(invocation, "profileId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "app-profile remove",
    () => ({ method: "DELETE", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/${encodeURIComponent(appId)}/profiles/${encodeURIComponent(profileId)}` }),
    () => connection.client.appProfiles.remove(instanceId, appId, profileId),
  );
  if (!result) return;
  return {
    data: result,
    columns: [{ key: "removed", header: "removed" }],
    message: `Browser profile \`${profileId}\` removed from app \`${appId}\`.`,
  };
}
