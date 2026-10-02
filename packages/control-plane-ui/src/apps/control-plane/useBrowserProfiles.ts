import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { DEFAULT_APP_PROFILE_NAME, type AppProfile } from "@task-handoff/protocol/app-profiles";
import {
  createInstanceAppProfile,
  removeInstanceAppProfile,
  renameInstanceAppProfile,
  setDefaultInstanceAppProfile,
  useInstanceAppProfilesQuery,
} from "../../api/queries";
import { controlPlaneQueryKeys } from "../../api/queryKeys";
import type { InstanceAppInventory } from "../../api/types";

export const BROWSER_PROFILE_APP_ID = "chromium";

type InstanceWithAppInventory = { appInventory?: InstanceAppInventory };

/**
 * True while the profile still carries the placeholder name the instance
 * assigns when it creates the default profile. Display surfaces render that
 * case in the user's locale instead of the stable default-language value; a
 * renamed default profile keeps its user-given name.
 */
export function usesDefaultProfileName(profile: Pick<AppProfile, "name" | "isDefault">) {
  return profile.isDefault && profile.name === DEFAULT_APP_PROFILE_NAME;
}

/** Inventory item for the profile-capable app, or undefined when the instance does not report it. */
export function browserProfileApp(instance: InstanceWithAppInventory | undefined, appId = BROWSER_PROFILE_APP_ID) {
  return instance?.appInventory?.items.find((app) => app.id === appId);
}

/**
 * Profile support is gatekept by the instance capability: N-1 instances do not
 * report it and must never receive a `profileId`, so the UI hides the profile
 * surfaces instead of sending unsupported fields.
 */
export function supportsBrowserProfiles(instance: InstanceWithAppInventory | undefined, appId = BROWSER_PROFILE_APP_ID) {
  return browserProfileApp(instance, appId)?.capabilities.supportsProfiles === true;
}

/**
 * Shared browser profile source for the instance settings tab and the app
 * launcher. Queries stay lazy (the caller enables them when its surface opens)
 * and every mutation invalidates the authoritative list.
 */
export function useBrowserProfiles(options: {
  instanceId: MaybeRefOrGetter<string>;
  appId?: MaybeRefOrGetter<string>;
  enabled?: MaybeRefOrGetter<boolean>;
}) {
  const queryClient = useQueryClient();
  const appId = options.appId ?? BROWSER_PROFILE_APP_ID;
  const enabled = options.enabled ?? true;
  const query = useInstanceAppProfilesQuery(options.instanceId, appId, enabled);
  const profiles = computed(() => query.data.value?.profiles ?? []);
  const defaultProfile = computed(() => profiles.value.find((profile) => profile.isDefault));
  const runningProfiles = computed(() => profiles.value.filter((profile) => Boolean(profile.runningSessionId)));

  function requireInstanceId() {
    const instanceId = toValue(options.instanceId);
    if (!instanceId) throw new Error("An instance is required to manage browser profiles.");
    return instanceId;
  }

  function invalidate() {
    return queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceAppProfiles(toValue(options.instanceId), toValue(appId)) });
  }

  return {
    appId,
    query,
    profiles,
    defaultProfile,
    runningProfiles,
    refresh: () => query.refetch(),
    invalidate,
    async createProfile(name: string) {
      const created = await createInstanceAppProfile(requireInstanceId(), toValue(appId), name);
      await invalidate();
      return created;
    },
    async renameProfile(profileId: string, name: string) {
      const renamed = await renameInstanceAppProfile(requireInstanceId(), toValue(appId), profileId, name);
      await invalidate();
      return renamed;
    },
    async setDefaultProfile(profileId: string) {
      const updated = await setDefaultInstanceAppProfile(requireInstanceId(), toValue(appId), profileId);
      await invalidate();
      return updated;
    },
    async removeProfile(profileId: string) {
      await removeInstanceAppProfile(requireInstanceId(), toValue(appId), profileId);
      await invalidate();
    },
  };
}
