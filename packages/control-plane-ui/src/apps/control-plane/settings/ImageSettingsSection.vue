<template>
  <ScrollArea class="image-settings-scroll" :horizontal="false">
    <div class="image-settings-page">
      <header class="image-page-head">
        <p>{{ t("settings.imageRegistry.pageDescription") }}</p>
        <div class="image-head-actions">
          <ControlPlaneSelect v-model="nodeId" :placeholder="t('settings.imageRegistry.selectNode')">
            <ControlPlaneSelectItem v-for="node in nodes.data.value || []" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem>
          </ControlPlaneSelect>
          <Button size="sm" @click="openCreateDialog"><Plus :size="14" /><span>{{ t("settings.imageRegistry.add") }}</span></Button>
        </div>
      </header>

      <div class="image-toolbar">
        <div class="image-search">
          <Search :size="15" aria-hidden="true" />
          <ControlPlaneInput v-model="searchQuery" :aria-label="t('settings.imageRegistry.search')" :placeholder="t('settings.imageRegistry.searchPlaceholder')" />
        </div>
        <ControlPlaneSelect v-model="sourceFilter" :aria-label="t('settings.imageRegistry.sourceFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.imageRegistry.allSources") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="official">{{ t("settings.imageRegistry.official") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="custom">{{ t("settings.imageRegistry.custom") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect v-model="availabilityFilter" :aria-label="t('settings.imageRegistry.availabilityFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.imageRegistry.allAvailability") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="available">{{ t("settings.imageRegistry.availableOnNode") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="pull-required">{{ t("settings.imageRegistry.pullOnCreate") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="unknown">{{ t("settings.imageRegistry.availabilityUnknown") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </div>

      <section v-if="marketCatalog.data.value?.status.error" class="image-diagnostics" role="alert">
        <AlertTriangle :size="16" aria-hidden="true" />
        <div><strong>{{ t("settings.imageRegistry.marketUnavailable") }}</strong><span>{{ marketCatalog.data.value.status.error }}</span></div>
        <Button variant="ghost" size="sm" @click="marketCatalog.refetch()"><RefreshCw :size="14" /><span>{{ t("common.actions.retry") }}</span></Button>
      </section>

      <section class="image-directory" :aria-label="t('settings.imageRegistry.directoryCount', { count: filteredImages.length })">
        <header class="image-directory-head">
          <strong>{{ t("settings.imageRegistry.directoryCount", { count: filteredImages.length }) }}</strong>
          <span v-if="hasActiveFilters">{{ t("settings.imageRegistry.filteredFrom", { count: directoryImages.length }) }}</span>
        </header>

        <div v-if="images.isLoading.value || marketCatalog.isLoading.value" class="image-state" role="status">{{ t("settings.imageRegistry.loading") }}</div>
        <div v-else-if="images.error.value" class="image-state image-state-error" role="alert">
          <span>{{ errorText(images.error.value) }}</span>
          <Button variant="outline" size="sm" @click="images.refetch()">{{ t("common.actions.retry") }}</Button>
        </div>
        <div v-else-if="!filteredImages.length" class="image-state image-empty-state">
          <Boxes :size="28" aria-hidden="true" />
          <strong>{{ hasActiveFilters ? t("settings.imageRegistry.noMatches") : t("settings.imageRegistry.empty") }}</strong>
          <p>{{ hasActiveFilters ? t("settings.imageRegistry.noMatchesDescription") : t("settings.imageRegistry.emptyDescription") }}</p>
          <Button v-if="hasActiveFilters" variant="outline" size="sm" @click="clearFilters">{{ t("settings.imageRegistry.clearFilters") }}</Button>
          <Button v-else size="sm" @click="openCreateDialog"><Plus :size="14" />{{ t("settings.imageRegistry.add") }}</Button>
        </div>
        <div v-else class="image-list">
          <article v-for="image in filteredImages" :key="image.key" class="image-row" data-image-row>
            <div class="image-identity">
              <ImageArtwork compact class="image-artwork" :cover="image.cover" :icon-size="16" :name="image.name" />
              <div>
                <div class="image-title-line">
                  <strong>{{ image.name }}</strong>
                  <Badge variant="secondary">{{ image.source === "official" ? t("settings.imageRegistry.official") : t("settings.imageRegistry.custom") }}</Badge>
                </div>
                <code :title="image.reference">{{ image.reference }}</code>
                <span :title="image.description">{{ image.description }}</span>
              </div>
            </div>
            <div class="image-summary">
              <span><CircleDot :size="14" />{{ availabilityLabel(image.availability) }}</span>
              <span v-if="image.source === 'custom'"><Download :size="14" />{{ imagePullPolicyLabel(image.pullPolicy) }}</span>
              <span v-else><Boxes :size="14" />{{ capabilitySummary(image.capabilities) }}</span>
            </div>
            <div class="image-row-actions">
              <Badge v-if="image.source === 'official'" variant="secondary">{{ t("settings.imageRegistry.marketReadonly") }}</Badge>
              <DropdownMenu v-else>
                <DropdownMenuTrigger as-child><Button variant="ghost" size="icon" :aria-label="t('settings.imageRegistry.moreActions')" :disabled="deletingImageId === image.id"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" :side-offset="6">
                  <DropdownMenuItem class="text-destructive focus:text-destructive" @select="deleteTarget = image"><Trash2 :size="14" /><span>{{ t("common.actions.delete") }}</span></DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>

  <Dialog :open="createOpen" @update:open="handleCreateOpenChange">
    <DialogContent class="image-editor-dialog w-[min(580px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden p-0">
      <DialogHeader class="image-editor-head space-y-0">
        <div><DialogTitle>{{ t("settings.imageRegistry.addTitle") }}</DialogTitle><DialogDescription>{{ t("settings.imageRegistry.referenceDescription") }}</DialogDescription></div>
        <Button variant="ghost" size="icon" :aria-label="t('common.actions.close')" @click="requestCloseCreate"><X :size="16" /></Button>
      </DialogHeader>
      <form class="image-editor-form" @submit.prevent="submitRegistryImage">
        <section class="image-form-section">
          <header><h3>{{ t("settings.imageRegistry.imageInformation") }}</h3><p>{{ t("settings.imageRegistry.imageInformationDescription") }}</p></header>
          <label><span>{{ t("settings.fields.name") }}</span><ControlPlaneInput v-model="settingsImage.name" :placeholder="t('settings.imageRegistry.namePlaceholder')" /></label>
          <label>
            <span>{{ t("settings.imageRegistry.reference") }}</span>
            <!-- i18n-audit-allow-next-line code-token: example OCI image reference -->
            <ControlPlaneInput v-model="settingsImage.reference" placeholder="docker.io/org/image:v1" />
          </label>
        </section>
      </form>
      <DialogFooter class="image-editor-footer">
        <Button variant="outline" :disabled="savingImage" @click="requestCloseCreate">{{ t("common.actions.cancel") }}</Button>
        <Button :disabled="!canCreateImage || savingImage" @click="submitRegistryImage"><span>{{ savingImage ? t("settings.imageRegistry.adding") : t("settings.imageRegistry.add") }}</span></Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="Boolean(deleteTarget)" @update:open="(open) => { if (!open && !deletingImageId) deleteTarget = undefined; }">
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{{ t("settings.imageRegistry.deleteTitle", { name: deleteTarget?.name || '' }) }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.imageRegistry.deleteDescription") }}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel :disabled="Boolean(deletingImageId)">{{ t("common.actions.cancel") }}</AlertDialogCancel><Button variant="destructive" :disabled="Boolean(deletingImageId)" @click="confirmDelete">{{ deletingImageId ? t("settings.imageRegistry.deleting") : t("common.actions.delete") }}</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog :open="discardOpen" @update:open="discardOpen = $event">
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{{ t("settings.imageRegistry.discardTitle") }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.imageRegistry.discardDescription") }}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel><AlertDialogAction @click="discardCreate">{{ t("settings.imageRegistry.discard") }}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { AlertTriangle, Boxes, CircleDot, Download, MoreHorizontal, Plus, RefreshCw, Search, Trash2, X } from "@lucide/vue";
import type { ImageCover, ImageProfile } from "../../../api/types";
import { useImagesQuery, useMarketCatalogQuery, useNodeImageAvailabilityQuery, useNodesQuery } from "../../../api/queries";
import { invalidateControlPlaneDomains } from "../../../api/queryInvalidation";
import { translateApiError } from "../../../i18n/apiError";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import ImageArtwork from "../shared/ImageArtwork.vue";
import { resolveImageDescription } from "../shared/imageDescription";
import { useImageSettings } from "./useImageSettings";

type ImageAvailability = "available" | "pull-required" | "unknown";
type DirectoryImage = {
  key: string;
  id: string;
  source: "official" | "custom";
  name: string;
  reference: string;
  description: string;
  cover?: ImageCover;
  capabilities: string[];
  pullPolicy: string;
  availability: ImageAvailability;
  profile?: ImageProfile;
};

const { locale, t } = useI18n();
const queryClient = useQueryClient();
const images = useImagesQuery();
const marketCatalog = useMarketCatalogQuery();
const nodes = useNodesQuery();
const nodeId = ref("");
const imageAvailability = useNodeImageAvailabilityQuery(nodeId);
const searchQuery = ref("");
const sourceFilter = ref<"all" | DirectoryImage["source"]>("all");
const availabilityFilter = ref<"all" | ImageAvailability>("all");
const createOpen = ref(false);
const discardOpen = ref(false);
const createBaseline = ref("");
const deleteTarget = ref<DirectoryImage>();
const errorText = (error: unknown) => translateApiError(error, t, error instanceof Error ? error.message : String(error));
const refreshImages = () => invalidateControlPlaneDomains(queryClient, ["images"]);
const { canCreateImage, clearImageFeedback, createRegistryImage, deletingImageId, removeImageProfile, savingImage, settingsImage } = useImageSettings({ errorText, images: images.data, onImageDeleted() {}, refreshImages, translate: t });

watch(() => nodes.data.value, (items) => {
  if (nodeId.value && (items || []).some((node) => node.id === nodeId.value)) return;
  nodeId.value = items?.[0]?.id || "";
}, { immediate: true });

function availability(imageId: string): ImageAvailability {
  return imageAvailability.data.value?.find((item) => item.image.id === imageId)?.status || "unknown";
}

const directoryImages = computed<DirectoryImage[]>(() => [
  ...(marketCatalog.data.value?.catalog.items || []).map((image) => ({
    key: `official:${image.id}`, id: image.id, source: "official" as const, name: image.name,
    reference: `${image.repository}:${image.defaultTag}`, description: resolveImageDescription(image, locale.value), cover: image.cover,
    capabilities: image.capabilities, pullPolicy: "", availability: availability(image.id),
  })),
  ...(images.data.value || []).map((image) => ({
    key: `custom:${image.id}`, id: image.id, source: "custom" as const, name: image.name,
    reference: image.reference, description: image.description || t("settings.imageRegistry.customImageDescription"), cover: image.cover,
    capabilities: image.capabilities, pullPolicy: image.pullPolicy, availability: availability(image.id), profile: image,
  })),
]);
const hasActiveFilters = computed(() => Boolean(searchQuery.value.trim()) || sourceFilter.value !== "all" || availabilityFilter.value !== "all");
const filteredImages = computed(() => directoryImages.value.filter((image) => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  const matchesQuery = !query || `${image.name} ${image.reference} ${image.description} ${image.capabilities.join(" ")}`.toLocaleLowerCase().includes(query);
  return matchesQuery && (sourceFilter.value === "all" || image.source === sourceFilter.value) && (availabilityFilter.value === "all" || image.availability === availabilityFilter.value);
}));
const createDirty = computed(() => JSON.stringify(settingsImage) !== createBaseline.value);

function availabilityLabel(status: ImageAvailability) { return status === "available" ? t("settings.imageRegistry.availableOnNode") : status === "pull-required" ? t("settings.imageRegistry.pullOnCreate") : t("settings.imageRegistry.availabilityUnknown"); }
function capabilitySummary(capabilities: string[]) { return capabilities.length ? capabilities.slice(0, 3).map((capability) => t(`common.imageCapabilities.${capability}`, capability)).join(" · ") : t("settings.imageRegistry.noCapabilities"); }
function imagePullPolicyLabel(policy: string) { return policy === "if-not-present" ? t("settings.imageRegistry.pullIfMissing") : policy === "always" ? t("settings.imageRegistry.pullAlways") : policy === "never" ? t("settings.imageRegistry.pullNever") : t("common.status.unknownValue", { value: policy }); }
function clearFilters() { searchQuery.value = ""; sourceFilter.value = "all"; availabilityFilter.value = "all"; }
function openCreateDialog() { clearImageFeedback(); createBaseline.value = JSON.stringify(settingsImage); createOpen.value = true; }
function closeCreate() { createOpen.value = false; clearImageFeedback(); }
function requestCloseCreate() { if (savingImage.value) return; if (createDirty.value) discardOpen.value = true; else closeCreate(); }
function handleCreateOpenChange(open: boolean) { if (open) createOpen.value = true; else requestCloseCreate(); }
function discardCreate() { settingsImage.name = ""; settingsImage.reference = ""; discardOpen.value = false; closeCreate(); }
async function submitRegistryImage() { await createRegistryImage(); if (!settingsImage.name && !settingsImage.reference) closeCreate(); }
async function confirmDelete() { const target = deleteTarget.value?.profile; if (target && await removeImageProfile(target)) deleteTarget.value = undefined; }
</script>

<style scoped>
.image-settings-scroll { height: 100%; min-height: 0; width: 100%; }
.image-settings-page { display: grid; gap: 12px; margin: 0 auto; padding: 0 10px 20px 0; width: min(100%, var(--settings-content-max-width, 1080px)); }
.image-page-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.image-page-head p, .image-form-section h3, .image-form-section p { margin: 0; }
.image-page-head p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.image-head-actions { align-items: center; display: grid; gap: 8px; grid-template-columns: minmax(180px, 230px) auto; }
.image-toolbar { display: grid; gap: 8px; grid-template-columns: minmax(240px, 1fr) 170px 210px; }
.image-search { align-items: center; display: flex; min-width: 0; position: relative; }
.image-search > svg { color: var(--text-muted); left: 10px; pointer-events: none; position: absolute; z-index: 1; }
.image-search :deep(input) { padding-left: 32px; }
.image-diagnostics { align-items: center; background: var(--status-danger-bg); border: 1px solid var(--status-danger-border); border-radius: 8px; color: var(--status-danger); display: grid; gap: 10px; grid-template-columns: auto minmax(0, 1fr) auto; padding: 9px 12px; }
.image-diagnostics > div { display: grid; gap: 2px; }
.image-diagnostics strong { font-size: 13px; font-weight: 500; }
.image-diagnostics span { font-size: 12px; }
.image-directory { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.image-directory-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; min-height: 38px; padding: 0 12px; }
.image-directory-head strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.image-directory-head span { color: var(--text-muted); font-size: 12px; }
.image-state { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; justify-content: center; min-height: 160px; padding: 20px; }
.image-state-error { gap: 10px; }
.image-empty-state { align-content: center; display: grid; gap: 7px; justify-items: center; min-height: 220px; text-align: center; }
.image-empty-state strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.image-empty-state p { margin: 0 0 5px; }
.image-list { display: grid; }
.image-row + .image-row { border-top: 1px solid var(--line); }
.image-row { align-items: center; display: grid; gap: 16px; grid-template-columns: minmax(250px, 1.25fr) minmax(230px, .8fr) auto; min-height: 82px; padding: 10px 12px; }
.image-identity { align-items: flex-start; display: grid; gap: 10px; grid-template-columns: auto minmax(0, 1fr); min-width: 0; }
.image-artwork { border-radius: 7px; height: 36px; min-height: 36px; width: 36px; }
.image-identity > div { display: grid; gap: 3px; min-width: 0; }
.image-title-line { align-items: center; display: flex; gap: 7px; min-width: 0; }
.image-title-line strong { color: var(--text-strong); font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-identity code, .image-identity > div > span { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-summary { align-content: center; display: grid; gap: 6px; min-width: 0; }
.image-summary span { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-summary svg { flex: 0 0 auto; }
.image-row-actions { align-items: center; display: flex; justify-content: flex-end; }
:global(.image-editor-dialog) { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
.image-editor-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; flex-direction: row; justify-content: space-between; padding: 13px 16px; }
.image-editor-head > div { display: grid; gap: 4px; }
.image-editor-form { padding: 14px 16px 18px; }
.image-form-section { display: grid; gap: 10px; }
.image-form-section > header { display: grid; gap: 2px; }
.image-form-section h3 { color: var(--text-strong); font-size: 13px; font-weight: 600; }
.image-form-section header p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.image-form-section label { display: grid; gap: 5px; }
.image-form-section label > span { color: var(--text-muted); font-size: 12px; }
.image-editor-footer { border-top: 1px solid var(--line); display: flex; gap: 8px; justify-content: flex-end; padding: 8px 16px; }
@media(max-width: 800px) { .image-settings-page { padding-right: 7px; } .image-toolbar { grid-template-columns: 1fr 1fr; } .image-search { grid-column: 1 / -1; } .image-row { align-items: start; grid-template-columns: 1fr auto; } .image-summary { grid-column: 1 / -1; } }
@media(max-width: 620px) { .image-page-head { align-items: stretch; flex-direction: column; } .image-head-actions { grid-template-columns: 1fr auto; } }
</style>
