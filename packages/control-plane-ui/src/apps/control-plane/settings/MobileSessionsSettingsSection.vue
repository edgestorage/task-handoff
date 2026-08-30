<template>
  <ScrollArea class="mobile-sessions-scroll" :horizontal="false">
    <div class="mobile-sessions-page">
      <header class="mobile-sessions-page-head">
        <p>{{ t("settings.mobileSessions.description") }}</p>
        <Button variant="outline" size="sm" :disabled="!canLoadSessions || sessions.isFetching.value" @click="sessions.refetch()">
          <RefreshCw :class="{ spinning: sessions.isFetching.value }" :size="14" />
          <span>{{ sessions.isFetching.value ? t("settings.mobileSessions.refreshing") : t("settings.mobileSessions.refresh") }}</span>
        </Button>
      </header>

      <section class="mobile-sessions-directory">
        <header class="mobile-sessions-directory-head">
          <strong>{{ t("settings.mobileSessions.title") }}</strong>
          <span v-if="sessions.data.value?.length">{{ sessions.data.value.length }}</span>
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
                  <dd>{{ session.user.primaryUsername || session.user.displayName }}</dd>
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
.mobile-sessions-scroll { height: 100%; min-height: 0; width: 100%; }
.mobile-sessions-page { display: grid; gap: 12px; margin: 0 auto; padding: 0 10px 20px 0; width: min(100%, var(--settings-content-max-width, 1080px)); }
.mobile-sessions-page-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.mobile-sessions-page-head p { color: var(--text-muted); font-size: 12px; line-height: 1.45; margin: 0; }
.mobile-sessions-directory { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.mobile-sessions-directory-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; min-height: 38px; padding: 0 12px; }
.mobile-sessions-directory-head strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.mobile-sessions-directory-head span { color: var(--text-muted); font-size: 12px; }
.mobile-sessions-state { color: var(--text-muted); font-size: 12px; margin: 0; padding: 48px 20px; text-align: center; }
.mobile-sessions-error { align-items: center; color: var(--status-danger); display: flex; font-size: 12px; gap: 12px; justify-content: space-between; min-height: 80px; padding: 12px; }
.mobile-session-list { display: grid; }
.mobile-session-row + .mobile-session-row { border-top: 1px solid var(--line); }
.mobile-session-row { align-items: center; display: grid; gap: 12px; grid-template-columns: auto minmax(0, 1fr) auto; min-height: 76px; padding: 10px 12px; }
.mobile-session-icon { align-items: center; background: var(--surface-active); border-radius: 8px; color: var(--text-muted); display: flex; height: 36px; justify-content: center; width: 36px; }
.mobile-session-copy { display: grid; gap: 6px; min-width: 0; }
.mobile-session-title { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }
.mobile-session-title strong { color: var(--text-strong); font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobile-session-copy dl { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 0; }
.mobile-session-copy dl > div { display: flex; font-size: 12px; gap: 5px; }
.mobile-session-copy dt { color: var(--text-muted); }
.mobile-session-copy dd { color: var(--text); margin: 0; }
.spinning { animation: mobile-session-spin 0.8s linear infinite; }
@keyframes mobile-session-spin { to { transform: rotate(360deg); } }
@media (max-width: 720px) {
  .mobile-sessions-page { padding-right: 7px; }
  .mobile-sessions-page-head { align-items: stretch; flex-direction: column; }
  .mobile-sessions-page-head > button { align-self: flex-start; }
  .mobile-session-row { align-items: start; grid-template-columns: auto minmax(0, 1fr); }
  .mobile-session-row > button { grid-column: 1 / -1; justify-self: end; }
}
</style>
