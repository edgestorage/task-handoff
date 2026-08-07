<template>
  <ScrollArea class="settings-section-scroll" :horizontal="false">
    <div class="settings-section-scroll-content mobile-sessions-settings">
      <section class="modal-section settings-panel-surface mobile-sessions-panel">
        <header class="mobile-sessions-head">
          <div>
            <strong>{{ t("settings.mobileSessions.title") }}</strong>
            <p>{{ t("settings.mobileSessions.description") }}</p>
          </div>
          <Button variant="outline" size="sm" :disabled="!canLoadSessions || sessions.isFetching.value" @click="sessions.refetch()">
            <RefreshCw :class="{ spinning: sessions.isFetching.value }" :size="14" />
            <span>{{ sessions.isFetching.value ? t("settings.mobileSessions.refreshing") : t("settings.mobileSessions.refresh") }}</span>
          </Button>
        </header>

        <p v-if="authSession.isLoading.value" class="mobile-sessions-state" role="status">{{ t("settings.mobileSessions.loading") }}</p>
        <p v-else-if="!authSession.data.value?.enabled" class="mobile-sessions-state">{{ t("settings.mobileSessions.authenticationRequired") }}</p>
        <p v-else-if="sessions.isLoading.value" class="mobile-sessions-state" role="status">{{ t("settings.mobileSessions.loading") }}</p>
        <div v-else-if="sessions.error.value" class="mobile-sessions-error" role="alert">
          <span>{{ errorText(sessions.error.value) }}</span>
          <Button variant="outline" size="sm" @click="sessions.refetch()">{{ t("common.actions.retry") }}</Button>
        </div>
        <p v-else-if="!sessions.data.value?.length" class="mobile-sessions-state">{{ t("settings.mobileSessions.empty") }}</p>
        <div v-else class="mobile-session-list">
          <article v-for="session in sessions.data.value" :key="session.id" class="mobile-session-row">
            <div class="mobile-session-icon" aria-hidden="true"><Smartphone :size="19" /></div>
            <div class="mobile-session-copy">
              <div class="mobile-session-title">
                <strong>{{ session.device.name }}</strong>
                <Badge variant="secondary">{{ platformLabel(session.device.platform) }}</Badge>
                <Badge v-if="session.device.appVersion" variant="secondary">v{{ session.device.appVersion }}</Badge>
              </div>
              <dl>
                <div>
                  <dt>{{ t("settings.mobileSessions.lastSeen") }}</dt>
                  <dd>{{ formatSessionDate(session.lastSeenAt || session.createdAt) }}</dd>
                </div>
                <div>
                  <dt>{{ t("settings.mobileSessions.expires") }}</dt>
                  <dd>{{ formatSessionDate(session.expiresAt) }}</dd>
                </div>
                <div>
                  <dt>{{ t("settings.mobileSessions.signedInAs") }}</dt>
                  <dd>{{ session.user.username }}</dd>
                </div>
              </dl>
            </div>
            <Button
              variant="outline"
              size="sm"
              :disabled="Boolean(revokingId)"
              @click="pendingSession = session"
            >
              <Trash2 :size="14" />
              <span>{{ revokingId === session.id ? t("settings.mobileSessions.revoking") : t("settings.mobileSessions.revoke") }}</span>
            </Button>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>

  <Dialog :open="Boolean(pendingSession)" @update:open="(open) => { if (!open && !revokingId) pendingSession = undefined; }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t("settings.mobileSessions.revokeTitle", { name: pendingSession?.device.name || "" }) }}</DialogTitle>
        <DialogDescription>{{ t("settings.mobileSessions.revokeDescription") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" :disabled="Boolean(revokingId)" @click="pendingSession = undefined">{{ t("common.actions.cancel") }}</Button>
        <Button variant="destructive" :disabled="Boolean(revokingId)" @click="confirmRevoke">
          {{ revokingId ? t("settings.mobileSessions.revoking") : t("settings.mobileSessions.revoke") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, Smartphone, Trash2 } from "@lucide/vue";
import type { ControlPlaneMobileSession } from "@task-handoff/protocol/control-plane-access";
import { revokeMobileSession, useAuthSessionQuery, useMobileSessionsQuery } from "../../../api/queries";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { formatDateTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const { locale, t } = useI18n();
const authSession = useAuthSessionQuery();
const canLoadSessions = computed(() => Boolean(authSession.data.value?.enabled && authSession.data.value.authenticated));
const sessions = useMobileSessionsQuery(canLoadSessions);
const pendingSession = ref<ControlPlaneMobileSession>();
const revokingId = ref("");

const errorText = (error: unknown) => translateApiError(error, t, t("settings.mobileSessions.loadFailed"));
const platformLabel = (platform: ControlPlaneMobileSession["device"]["platform"]) => platform === "ios" ? "iOS" : "Android";
const formatSessionDate = (value: string) => formatDateTime(value, locale.value as SupportedLocale);

async function confirmRevoke() {
  const session = pendingSession.value;
  if (!session || revokingId.value) return;
  revokingId.value = session.id;
  try {
    const result = await revokeMobileSession(session.id);
    if (!result.revoked) throw new Error(t("settings.mobileSessions.notFound"));
    pendingSession.value = undefined;
    await sessions.refetch();
    showControlPlaneToast(t("settings.mobileSessions.revoked", { name: session.device.name }), "success");
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("settings.mobileSessions.revokeFailed")));
  } finally {
    revokingId.value = "";
  }
}
</script>

<style scoped>
.mobile-sessions-settings { max-width: 920px; }
.mobile-sessions-panel { align-content: start; }
.mobile-sessions-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.mobile-sessions-head > div { display: grid; gap: 4px; }
.mobile-sessions-head strong { color: var(--text-strong); font-size: 15px; }
.mobile-sessions-head p { color: var(--text-muted); font-size: 13px; line-height: 1.5; margin: 0; }
.mobile-sessions-state { color: var(--text-muted); font-size: 13px; margin: 0; padding: 28px 12px; text-align: center; }
.mobile-sessions-error { align-items: center; color: var(--status-danger); display: flex; font-size: 13px; gap: 12px; justify-content: space-between; padding: 12px; }
.mobile-session-list { display: grid; gap: 8px; }
.mobile-session-row { align-items: center; background: var(--surface-inset); border: 1px solid var(--line); border-radius: 8px; display: grid; gap: 12px; grid-template-columns: auto minmax(0, 1fr) auto; padding: 12px; }
.mobile-session-icon { align-items: center; background: var(--surface-active); border-radius: 10px; color: var(--text-muted); display: flex; height: 40px; justify-content: center; width: 40px; }
.mobile-session-copy { display: grid; gap: 8px; min-width: 0; }
.mobile-session-title { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }
.mobile-session-title strong { color: var(--text-strong); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobile-session-copy dl { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 0; }
.mobile-session-copy dl > div { display: flex; font-size: 12px; gap: 5px; }
.mobile-session-copy dt { color: var(--text-muted); }
.mobile-session-copy dd { color: var(--text); margin: 0; }
.spinning { animation: mobile-session-spin 0.8s linear infinite; }
@keyframes mobile-session-spin { to { transform: rotate(360deg); } }
@media (max-width: 720px) {
  .mobile-sessions-head { align-items: stretch; flex-direction: column; }
  .mobile-session-row { align-items: start; grid-template-columns: auto minmax(0, 1fr); }
  .mobile-session-row > button { grid-column: 1 / -1; justify-self: end; }
}
</style>
