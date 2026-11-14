<template>
  <ScrollArea class="desktop-turn-scroll settings-page-scroll" :horizontal="false">
    <div class="settings-content-page">
      <section class="settings-group" aria-labelledby="desktop-turn-heading">
        <header class="group-heading">
          <h3 id="desktop-turn-heading">{{ t("settings.desktopTurn.title") }}</h3>
          <p>{{ t("settings.desktopTurn.description") }}</p>
        </header>
        <p v-if="query.isPending.value" role="status">{{ t("common.states.loading") }}</p>
        <div v-else-if="query.error.value" class="load-error" role="alert"><p class="settings-error">{{ t("settings.desktopTurn.loadFailed") }}</p><Button variant="outline" size="sm" @click="query.refetch()">{{ t("common.actions.retry") }}</Button></div>
        <form v-else class="group-surface" @submit.prevent="save">
          <fieldset :disabled="saving" class="turn-fields">
            <label class="enable-row"><Checkbox v-model="enabled" /><span>{{ t("settings.desktopTurn.enabled") }}</span></label>
            <label class="field"><span>{{ t("settings.desktopTurn.urls") }}</span>
              <!-- i18n-audit-allow-next-line code-token: example TURN URLs -->
              <Textarea v-model="urls" rows="3" placeholder="turn:turn.example.com:3478?transport=udp" spellcheck="false" />
              <small>{{ t("settings.desktopTurn.urlsHint") }}</small>
            </label>
            <div class="field"><label id="turn-auth-label">{{ t("settings.desktopTurn.authentication") }}</label>
              <ControlPlaneSelect v-model="authentication" :aria-label="t('settings.desktopTurn.authentication')" :disabled="saving">
                <ControlPlaneSelectItem value="password">{{ t("settings.desktopTurn.passwordAuth") }}</ControlPlaneSelectItem>
                <ControlPlaneSelectItem value="shared-secret">{{ t("settings.desktopTurn.sharedSecretAuth") }}</ControlPlaneSelectItem>
              </ControlPlaneSelect>
            </div>
            <label v-if="authentication === 'password'" class="field"><span>{{ t("settings.desktopTurn.username") }}</span><ControlPlaneInput v-model="username" autocomplete="off" /></label>
            <label class="field"><span>{{ authentication === 'password' ? t("settings.desktopTurn.password") : t("settings.desktopTurn.sharedSecret") }}</span>
              <ControlPlaneInput v-model="secret" type="password" autocomplete="new-password" :placeholder="canKeepSecret ? t('settings.desktopTurn.keepSecret') : ''" />
              <small>{{ authentication === 'shared-secret' ? t("settings.desktopTurn.sharedSecretHint") : t("settings.desktopTurn.secretHint") }}</small>
            </label>
            <div class="row-actions"><Button type="submit" size="sm" :disabled="!dirty">{{ t("common.actions.save") }}</Button><Button type="button" variant="outline" size="sm" :disabled="!dirty" @click="reset">{{ t("common.actions.cancel") }}</Button></div>
          </fieldset>
          <p v-if="message" :class="failed ? 'settings-error' : 'settings-success'" :role="failed ? 'alert' : 'status'">{{ message }}</p>
        </form>
      </section>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { CustomTurnUpdateSchema } from "@task-handoff/protocol/control-plane-desktop";
import { getCustomTurnSettings, updateCustomTurnSettings } from "../../../api/remoteDesktop";
import { ApiError } from "../../../api/client";
import { controlPlaneQueryKeys } from "../../../api/queryKeys";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Textarea } from "../../../components/ui/textarea";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";

const { t } = useI18n();
const client = useQueryClient();
const query = useQuery({ queryKey: controlPlaneQueryKeys.desktopTurn, queryFn: getCustomTurnSettings });
const enabled = ref(false), urls = ref(""), username = ref(""), secret = ref("");
const authentication = ref<"password" | "shared-secret">("password");
const revision = ref(0), original = ref(""), originalAuth = ref("password"), secretConfigured = ref(false);
const saving = ref(false), message = ref(""), failed = ref(false);
const fields = () => ({ enabled: enabled.value, urls: urls.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean), authentication: authentication.value, username: authentication.value === "password" ? username.value.trim() : "" });
const dirty = computed(() => !!secret.value || JSON.stringify(fields()) !== original.value);
const canKeepSecret = computed(() => secretConfigured.value && authentication.value === originalAuth.value);
function reset() {
  const data = query.data.value;
  if (!data) return;
  enabled.value = data.enabled; urls.value = data.urls.join("\n"); username.value = data.username;
  authentication.value = data.authentication; originalAuth.value = data.authentication; secretConfigured.value = data.secretConfigured;
  revision.value = data.revision; secret.value = ""; message.value = "";
  original.value = JSON.stringify(fields());
}
watch(query.data, () => { if (!original.value || !dirty.value) reset(); }, { immediate: true });
async function save() {
  const parsed = CustomTurnUpdateSchema.safeParse({ ...fields(), expectedRevision: revision.value, ...(secret.value ? { secret: secret.value } : {}) });
  if (!parsed.success || (enabled.value && !secret.value && !canKeepSecret.value)) {
    failed.value = true; message.value = t("settings.desktopTurn.invalid"); return;
  }
  saving.value = true; message.value = "";
  try {
    const saved = await updateCustomTurnSettings(parsed.data);
    client.setQueryData(controlPlaneQueryKeys.desktopTurn, saved);
    reset(); failed.value = false; message.value = t("settings.desktopTurn.saved");
    await client.invalidateQueries({ queryKey: controlPlaneQueryKeys.desktopConnectionOptions() });
  } catch (error) {
    failed.value = true;
    message.value = t(error instanceof ApiError && error.code === "REMOTE_DESKTOP_TURN_REVISION_CONFLICT" ? "settings.desktopTurn.conflict" : "settings.desktopTurn.saveFailed");
  } finally { saving.value = false; }
}
</script>

<style scoped>
.desktop-turn-scroll { height: 100%; min-height: 0; width: 100%; }
.settings-group, .group-heading, .turn-fields, .field { display: grid; gap: 8px; }
.group-heading { gap: 3px; padding: 0 2px; }
.group-heading h3 { margin: 0; font-size: 14px; font-weight: 500; }
.group-heading p, .field small { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.5; }
.group-surface { padding: 16px; background: var(--surface-raised); border: 1px solid var(--line); border-radius: 9px; }
.turn-fields { border: 0; margin: 0; padding: 0; gap: 16px; max-width: 640px; min-width: 0; font-size: 13px; }
.field { gap: 6px; min-width: 0; }
.load-error { display: grid; justify-items: start; gap: 8px; }
.enable-row, .row-actions { display: flex; align-items: center; gap: 8px; }
.settings-error, .settings-success { margin: 12px 0 0; font-size: 13px; line-height: 1.5; }
.settings-error { color: var(--status-danger); }
.settings-success { color: var(--text-muted); }
</style>
