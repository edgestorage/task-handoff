import type { ChatSessionBinding } from "@task-handoff/protocol/control-plane";
import { compactChatLabel, createSingleColumnKeyboard } from "@task-handoff/core/core/chat-interactions";
import {
  appSessionAccessMode,
  appSessionButtonLabel,
  appSessionLink,
  instanceAppMenuCallbackData,
  isVisibleAppSession,
  launchAppCallbackData,
  launchableAppsForInstance,
  renderAppSessionsReply,
  renderInstancesReply,
  stringValue,
} from "../rendering.ts";
import type { ControlPlaneChatTargetResolver } from "../target-resolver.ts";
import type { ChatAppAccessDeps, ChatAppSessionSnapshotDeps, ChatBoardDeps } from "../types.ts";

export type ControlPlaneChatAppCommandDeps = ChatBoardDeps & ChatAppAccessDeps & ChatAppSessionSnapshotDeps;

export class ControlPlaneChatAppCommands {
  private readonly deps: ControlPlaneChatAppCommandDeps;
  private readonly targets: ControlPlaneChatTargetResolver;

  constructor(deps: ControlPlaneChatAppCommandDeps, targets: ControlPlaneChatTargetResolver) {
    this.deps = deps;
    this.targets = targets;
  }

  async handleInstancesCommand(binding: ChatSessionBinding) {
    const instances = await this.targets.instancesForBinding(binding);
    return {
      accepted: true,
      routed: false,
      binding,
      instances,
      reply: renderInstancesReply(instances.length),
      replyMarkup: instances.length
        ? createSingleColumnKeyboard(instances.map((instance) => ({
          text: compactChatLabel(instance.name || instance.id, 56),
          callbackData: instanceAppMenuCallbackData(this.deps.createChatActionToken({
            type: "instance-app-menu",
            instanceId: instance.id,
          }).token),
        })))
        : undefined,
    };
  }

  async handleInstanceAppMenuAction(binding: ChatSessionBinding, instanceId: string) {
    const instances = await this.targets.instancesForBinding(binding);
    const instance = instances.find((item) => item.id === instanceId);
    if (!instance) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: "Instance not found.",
      };
    }
    const apps = launchableAppsForInstance(instance);
    return {
      accepted: true,
      routed: false,
      binding,
      instance,
      message: `Select an app for ${instance.name}.`,
      reply: apps.length ? `New app for ${instance.name}` : `No launchable apps for ${instance.name}.`,
      replyMarkup: apps.length
        ? createSingleColumnKeyboard(apps.map((app) => ({
          text: compactChatLabel(app.label, 56),
          callbackData: launchAppCallbackData(this.deps.createChatActionToken({
            type: "launch-app",
            instanceId: instance.id,
            appId: app.id,
          }).token),
        })))
        : undefined,
    };
  }

  async handleLaunchAppAction(binding: ChatSessionBinding, instanceId: string, appId: string) {
    const instance = (await this.targets.instancesForBinding(binding)).find((item) => item.id === instanceId);
    if (!instance) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: "Instance not found.",
      };
    }
    const apps = launchableAppsForInstance(instance);
    const app = apps.find((item) => item.id === appId);
    if (!app) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: `App ${appId} is not launchable for ${instance.name}.`,
      };
    }
    const session = await this.deps.launchAppSession(instance.id, app.id);
    return {
      accepted: true,
      routed: false,
      binding,
      instance,
      session,
      message: `${app.label} launched`,
      reply: `Launched ${app.label} on ${instance.name}.`,
    };
  }

  async handleAppsCommand(binding: ChatSessionBinding) {
    const instances = await this.deps.boardAsync();
    const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
    const appSessions = await this.deps.listAppSessions();
    const rows = appSessions.instances.flatMap((entry) => {
      const instance = instancesById.get(entry.instanceId);
      if (!instance) {
        return [];
      }
      return entry.appSessions.sessions
        .filter(isVisibleAppSession)
        .filter((session) => Boolean(stringValue(session.id)))
        .map((session) => ({
          instance,
          session,
          link: appSessionLink(instance, session, this.deps.controlPlanePublicBaseUrl(), () =>
            this.deps.createAppAccessToken({
              instanceId: instance.id,
              sessionId: stringValue(session.id) || "",
              mode: appSessionAccessMode(session),
            }).token,
          ),
        }));
    });
    const buttons = rows
      .filter((row) => row.link.url)
      .map((row) => ({
        text: compactChatLabel(`${row.instance.name} · ${appSessionButtonLabel(row.instance, row.session)}`, 56),
        url: row.link.url,
      }));
    return {
      accepted: true,
      routed: false,
      binding,
      instances,
      reply: renderAppSessionsReply(rows.length, buttons.length),
      replyMarkup: buttons.length ? createSingleColumnKeyboard(buttons) : undefined,
    };
  }
}
