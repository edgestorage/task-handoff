<template>
  <ScrollArea class="trusted-devices-scroll settings-page-scroll" :horizontal="false">
    <div class="trusted-devices-page settings-content-page">
      <header class="trusted-devices-head">
        <p>{{ t("settings.deviceTrust.description") }}</p>
        <Button variant="outline" size="sm" :disabled="store.loading.value" @click="store.recover().catch(() => undefined)">
          <RefreshCw :class="{ spinning: store.loading.value }" :size="14" />
          <span>{{ store.loading.value ? t("settings.deviceTrust.refreshing") : t("settings.deviceTrust.refresh") }}</span>
        </Button>
      </header>

      <section class="trusted-devices-directory">
        <header class="trusted-devices-directory-head">
          <strong>{{ t("settings.deviceTrust.title") }}</strong>
          <span>{{ t("settings.deviceTrust.count", { count: store.snapshot.value.trustedDevices.length }) }}</span>
        </header>
        <p v-if="!authSession.data.value?.authenticated" class="trusted-devices-state">{{ t("settings.deviceTrust.authenticationRequired") }}</p>
        <p v-else-if="store.loading.value && !store.snapshot.value.trustedDevices.length" class="trusted-devices-state" role="status">{{ t("settings.deviceTrust.loading") }}</p>
        <div v-else-if="store.error.value" class="trusted-devices-error" role="alert">
          <span>{{ t("settings.deviceTrust.loadFailed") }}</span>
          <Button variant="outline" size="sm" @click="store.recover().catch(() => undefined)">{{ t("common.actions.retry") }}</Button>
        </div>
        <p v-else-if="!devices.length" class="trusted-devices-state">{{ t("settings.deviceTrust.empty") }}</p>
        <div v-else class="trusted-device-list">
          <article v-for="device in devices" :key="device.pinId" class="trusted-device-row">
            <div class="trusted-device-icon" aria-hidden="true"><Smartphone :size="19" /></div>
            <div class="trusted-device-copy">
              <div class="trusted-device-title">
                <strong>{{ device.device.name }}</strong>
                <span class="trusted-device-reported">{{ t("settings.deviceTrust.reported") }}</span>
                <Badge :variant="device.status === 'active' ? 'secondary' : 'outline'">
                  {{ t(`settings.deviceTrust.status.${device.status}`) }}
                </Badge>
                <Badge variant="secondary">{{ device.device.platform }}</Badge>
                <Badge v-if="device.device.version" variant="secondary">v{{ device.device.version }}</Badge>
              </div>
              <dl>
                <div><dt>{{ t("settings.deviceTrust.kind") }}</dt><dd>{{ device.device.kind }}</dd></div>
                <div><dt>{{ t("settings.deviceTrust.role") }}</dt><dd>{{ device.roleName || device.roleId }}</dd></div>
                <div><dt>{{ t("settings.deviceTrust.access") }}</dt><dd>{{ accessLabel(device) }}</dd></div>
                <div><dt>{{ t("settings.deviceTrust.binding") }}</dt><dd>{{ device.bindingId }}</dd></div>
                <div><dt>{{ t("settings.deviceTrust.account") }}</dt><dd>{{ device.accountId }}</dd></div>
                <div><dt>{{ t("settings.deviceTrust.cloudRole") }}</dt><dd>{{ device.cloudAccessRoleId }}<template v-if="device.shareGrantId"> · {{ device.shareGrantId }}</template></dd></div>
                <div><dt>{{ t("settings.deviceTrust.lastSeen") }}</dt><dd>{{ formatDate(device.lastSeenAt) }}</dd></div>
                <div><dt>{{ t("settings.deviceTrust.approved") }}</dt><dd>{{ formatDate(device.approvedAt) }} · {{ device.approvedByActorId }}</dd></div>
                <div v-if="device.revokedAt"><dt>{{ t("settings.deviceTrust.revoked") }}</dt><dd>{{ formatDate(device.revokedAt) }}</dd></div>
              </dl>
              <div class="trusted-device-fingerprint">
                <span>{{ t("settings.deviceTrust.fingerprint") }}</span>
                <code>{{ device.fingerprint }}</code>
                <span>{{ t("settings.deviceTrust.comparisonCode") }}</span>
                <code>{{ device.comparisonCode }}</code>
              </div>
            </div>
            <Button
              v-if="device.status === 'active'"
              variant="outline"
              size="sm"
              :disabled="Boolean(pendingRevoke)"
              @click="pendingRevoke = device"
            >
              <Trash2 :size="14" />
              <span>{{ t("settings.deviceTrust.revoke") }}</span>
            </Button>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>

  <Dialog :open="Boolean(pendingRevoke)" @update:open="(open) => { if (!open && !revokingId) pendingRevoke = undefined; }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t("settings.deviceTrust.revokeTitle", { name: pendingRevoke?.device.name || "" }) }}</DialogTitle>
        <DialogDescription>{{ t("settings.deviceTrust.revokeDescription") }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" :disabled="Boolean(revokingId)" @click="pendingRevoke = undefined">{{ t("common.actions.cancel") }}</Button>
        <Button variant="destructive" :disabled="Boolean(revokingId)" @click="revokeDevice">{{ revokingId ? t("settings.deviceTrust.revoking") : t("settings.deviceTrust.revoke") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, Smartphone, Trash2 } from "@lucide/vue";
import type { CloudDeviceTrustedDevice } from "@task-handoff/protocol/device-trust";
import { useAuthSessionQuery } from "../../../api/queries";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { formatDateTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import { translateApiError } from "../../../i18n/apiError";
import { useDeviceTrustStore } from "../action-inbox/useDeviceTrustStore";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const { locale, t } = useI18n();
const authSession = useAuthSessionQuery();
const store = useDeviceTrustStore();
const pendingRevoke = ref<CloudDeviceTrustedDevice>();
const revokingId = ref("");
const devices = computed(() => [...store.snapshot.value.trustedDevices].sort((left, right) => {
  if (left.status !== right.status) return left.status === "active" ? -1 : 1;
  return right.lastSeenAt.localeCompare(left.lastSeenAt) || left.pinId.localeCompare(right.pinId);
}));
const formatDate = (value: string) => formatDateTime(value, locale.value as SupportedLocale);
const accessLabel = (device: CloudDeviceTrustedDevice) => device.accessMode === "shared"
  ? t("settings.deviceTrust.sharedAccess", { owner: device.ownerAccountId })
  : t("settings.deviceTrust.ownerAccess");

onMounted(() => {
  if (store.snapshot.value.revision < 0) void store.recover().catch(() => undefined);
});

async function revokeDevice() {
  const device = pendingRevoke.value;
  if (!device || revokingId.value) return;
  revokingId.value = device.pinId;
  try {
    await store.revoke(device.pinId, { expectedRevision: device.revision });
    pendingRevoke.value = undefined;
    showControlPlaneToast(t("settings.deviceTrust.revokedToast", { name: device.device.name }), "success");
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("settings.deviceTrust.revokeFailed")), "error");
    await store.recover().catch(() => undefined);
  } finally {
    revokingId.value = "";
  }
}
</script>

<style scoped>
.trusted-devices-scroll { height: 100%; min-height: 0; width: 100%; }
.trusted-devices-page { display: grid; gap: 12px; }
.trusted-devices-head { align-items: center; display: flex; gap: 16px; justify-content: space-between; }
.trusted-devices-head p { color: var(--text-muted); font-size: 12px; line-height: 1.45; margin: 0; }
.trusted-devices-directory { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.trusted-devices-directory-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; min-height: 38px; padding: 0 12px; }
.trusted-devices-directory-head strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.trusted-devices-directory-head span { color: var(--text-muted); font-size: 12px; }
.trusted-devices-state { color: var(--text-muted); font-size: 12px; margin: 0; padding: 48px 20px; text-align: center; }
.trusted-devices-error { align-items: center; color: var(--status-danger); display: flex; font-size: 12px; gap: 12px; justify-content: space-between; min-height: 80px; padding: 12px; }
.trusted-device-list { display: grid; }
.trusted-device-row + .trusted-device-row { border-top: 1px solid var(--line); }
.trusted-device-row { align-items: start; display: grid; gap: 12px; grid-template-columns: auto minmax(0, 1fr) auto; padding: 12px; }
.trusted-device-icon { align-items: center; background: var(--surface-active); border-radius: 8px; color: var(--text-muted); display: flex; height: 36px; justify-content: center; width: 36px; }
.trusted-device-copy { display: grid; gap: 7px; min-width: 0; }
.trusted-device-title { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }
.trusted-device-title strong { color: var(--text-strong); font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trusted-device-reported { color: var(--text-muted); font-size: 12px; }
.trusted-device-copy dl { display: flex; flex-wrap: wrap; gap: 7px 20px; margin: 0; }
.trusted-device-copy dl > div { display: flex; font-size: 12px; gap: 5px; }
.trusted-device-copy dt { color: var(--text-muted); }
.trusted-device-copy dd { color: var(--text); margin: 0; overflow-wrap: anywhere; }
.trusted-device-fingerprint { color: var(--text-muted); display: grid; font-size: 12px; gap: 3px; }
.trusted-device-fingerprint code { color: var(--text); font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace); font-size: 12px; overflow-wrap: anywhere; }
.spinning { animation: trusted-device-spin 0.8s linear infinite; }
@keyframes trusted-device-spin { to { transform: rotate(360deg); } }
@media (max-width: 720px) {
  .trusted-devices-head { align-items: stretch; flex-direction: column; }
  .trusted-devices-head > button { align-self: flex-start; }
  .trusted-device-row { grid-template-columns: auto minmax(0, 1fr); }
  .trusted-device-row > button { grid-column: 1 / -1; justify-self: end; }
}
</style>
