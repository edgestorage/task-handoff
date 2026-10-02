import fs from "node:fs";
import path from "node:path";
import { ChromiumProfileStore, type ChromiumProfileRecord } from "./profiles";
import type { ManagedAppGuiLaunchInput, ManagedAppProfileRecord, ManagedAppProfilesRuntime, ManagedAppRuntimeExtension, ManagedAppRuntimeHost } from "../types";
import type { AppSession } from "../../types";

const DEFAULT_EXTENSION_DIR = "/opt/task-handoff/chromium-extensions";

function isExtensionDir(extensionDir: string) {
  return fs.existsSync(path.join(extensionDir, "manifest.json"));
}

function extensionDirs() {
  const configured = process.env.TASK_HANDOFF_CHROMIUM_EXTENSION_DIRS;
  if (configured) {
    return configured.split(/[,;]/).map((entry) => entry.trim()).filter((entry) => isExtensionDir(entry));
  }
  const root = process.env.TASK_HANDOFF_CHROMIUM_EXTENSION_DIR || DEFAULT_EXTENSION_DIR;
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((entry) => isExtensionDir(entry))
    .sort();
}

function profileView(profile: ChromiumProfileRecord, defaultProfileId: string): ManagedAppProfileRecord {
  return {
    id: profile.id,
    name: profile.name,
    directory: profile.directory,
    isDefault: profile.id === defaultProfileId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function runningProfileSessionId(sessions: AppSession[], appId: string, profileId: string) {
  const session = sessions.find((candidate) => (
    candidate.appId === appId
    && candidate.status === "running"
    && candidate.launch?.profileId === profileId
  ));
  return session?.id;
}

export function createChromiumRuntime(host: ManagedAppRuntimeHost): ManagedAppRuntimeExtension {
  const store = new ChromiumProfileStore(host.paths.dataDir, {
    onWarning: (message, details) => console.warn(JSON.stringify({ code: "BROWSER_PROFILE_WARNING", message, ...details })),
  });
  store.ensureDefault();

  const profiles: ManagedAppProfilesRuntime = {
    list: () => {
      const defaultProfileId = store.defaultProfileId();
      return store.list().map((profile) => profileView(profile, defaultProfileId));
    },
    defaultProfileId: () => store.defaultProfileId(),
    create: (name) => profileView(store.create(name), store.defaultProfileId()),
    rename: (profileId, name) => profileView(store.rename(profileId, name), store.defaultProfileId()),
    remove: (profileId) => store.remove(profileId),
    setDefault: (profileId) => profileView(store.setDefault(profileId), profileId),
    usageBytes: (profileId) => store.usageBytes(profileId),
    resolveLaunchProfile: (profileId) => profileView(store.resolveLaunchProfile(profileId), store.defaultProfileId()),
  };

  function chromiumArgs(input: ManagedAppGuiLaunchInput) {
    const sandboxArgs = ["1", "true", "yes", "on"].includes(String(process.env.TASK_HANDOFF_CHROMIUM_NO_SANDBOX || "").toLowerCase()) ? ["--no-sandbox"] : [];
    const requestedProfileId = typeof input.launch.profileId === "string" ? input.launch.profileId.trim() : "";
    let userDataDir: string;
    if (requestedProfileId) {
      const busySessionId = runningProfileSessionId(host.activeAppSessions(), input.app.id, requestedProfileId);
      if (busySessionId) {
        throw Object.assign(
          new Error(`Browser profile ${requestedProfileId} is already running in session ${busySessionId}.`),
          { code: "BROWSER_PROFILE_BUSY", details: { profileId: requestedProfileId, sessionId: busySessionId } },
        );
      }
      userDataDir = profiles.resolveLaunchProfile(requestedProfileId).directory;
    } else {
      // Missing profileId keeps the historical ephemeral profile so released
      // clients and parallel browser sessions behave exactly as before.
      userDataDir = path.join(input.sessionDir, "profile");
    }
    const extensions = extensionDirs();
    return [
      ...sandboxArgs,
      "--disable-dev-shm-usage",
      "--no-first-run",
      ...(extensions.length ? [`--load-extension=${extensions.join(",")}`] : []),
      "--remote-debugging-address=127.0.0.1",
      ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
      ...(input.app.automation?.portArg
        ? [input.app.automation.portArg.replaceAll("{port}", String(input.automationPort))]
        : [`--remote-debugging-port=${input.automationPort}`]),
      ...input.defaultArgs,
    ];
  }

  return { prepareGuiArgs: chromiumArgs, profiles };
}
