<template>
  <section class="trigger-board modal-section">
    <header class="trigger-board-head">
      <p>{{ t("triggers.description") }}</p>
      <div class="trigger-board-head-actions">
        <Dialog v-model:open="createDialogOpen">
          <DialogTrigger as-child>
            <Button size="sm" @click="beginCreate">
              <Plus :size="14" />
              <span>{{ t("triggers.create.action") }}</span>
            </Button>
          </DialogTrigger>
          <DialogContent class="trigger-create-dialog w-[min(760px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden p-0">
            <DialogHeader class="trigger-create-head flex-row items-center justify-between space-y-0">
              <div>
                <DialogTitle>{{ t(editingHash ? "triggers.edit.title" : "triggers.create.title") }}</DialogTitle>
                <DialogDescription>{{ t(editingHash ? "triggers.edit.description" : "triggers.create.description") }}</DialogDescription>
              </div>
              <DialogClose as-child>
                <Button variant="ghost" size="icon" class="trigger-create-close" :aria-label="t(editingHash ? 'triggers.edit.close' : 'triggers.create.close')">
                  <X :size="16" />
                </Button>
              </DialogClose>
            </DialogHeader>
            <ScrollArea class="trigger-create-dialog-scroll" :horizontal="false">
              <div class="trigger-create-dialog-body">
              <section class="trigger-create-group">
                <div class="trigger-board-create-main">
                  <label>
                    <span>{{ t("triggers.create.name") }}</span>
                    <Input v-model="createForm.name" :placeholder="t('triggers.create.namePlaceholder')" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.type") }}</span>
                    <ControlPlaneSelect v-model="createForm.sourceType" trigger-class="trigger-board-select" :placeholder="t('triggers.create.typePlaceholder')">
                      <ControlPlaneSelectItem value="schedule">{{ t("triggers.sourceType.schedule") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="file-change">{{ t("triggers.sourceType.fileChange") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="ai-session">{{ t("triggers.sourceType.aiSession") }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label class="trigger-create-full-width">
                    <span>{{ t("triggers.create.templateDescription") }}</span>
                    <Textarea v-model="createForm.description" rows="2" :placeholder="t('triggers.create.descriptionPlaceholder')" />
                  </label>
                </div>

                <div class="trigger-create-group-head">
                  <strong>{{ t("triggers.create.source") }}</strong>
                  <span>{{ sourceSectionHint }}</span>
                </div>
                <div v-if="createForm.sourceType === 'schedule'" class="trigger-board-source-grid">
                  <label>
                    <span>{{ t("triggers.create.mode") }}</span>
                    <ControlPlaneSelect v-model="createForm.scheduleKind" trigger-class="trigger-board-select" :placeholder="t('triggers.create.modePlaceholder')">
                      <ControlPlaneSelectItem value="interval">{{ t("triggers.scheduleMode.interval") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="daily">{{ t("triggers.scheduleMode.daily") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="weekly">{{ t("triggers.scheduleMode.weekly") }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label class="trigger-interval-field">
                    <span>{{ createForm.scheduleKind === "interval" ? t("triggers.create.every") : t("triggers.create.time") }}</span>
                    <div v-if="createForm.scheduleKind === 'interval'" class="trigger-interval-control">
                      <Input v-model="createForm.intervalValue" type="number" min="1" step="1" inputmode="numeric" placeholder="1" />
                      <ControlPlaneSelect v-model="createForm.intervalUnit" trigger-class="trigger-board-select trigger-interval-unit" :placeholder="t('triggers.create.unit')">
                        <ControlPlaneSelectItem value="minute">{{ t("triggers.intervalUnit.minute") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="hour">{{ t("triggers.intervalUnit.hour") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="day">{{ t("triggers.intervalUnit.day") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="week">{{ t("triggers.intervalUnit.week") }}</ControlPlaneSelectItem>
                      </ControlPlaneSelect>
                    </div>
                    <ControlPlaneTimePicker v-else v-model="createForm.timeOfDay" :hour-label="t('triggers.intervalUnit.hour')" :minute-label="t('triggers.intervalUnit.minute')" />
                  </label>
                  <label v-if="createForm.scheduleKind !== 'interval'">
                    <span>{{ t("triggers.create.timezone") }}</span>
                    <ControlPlaneSelect v-model="createForm.timezone" trigger-class="trigger-board-select" :placeholder="t('triggers.create.timezone')">
                      <ControlPlaneSelectItem v-for="timezone in timezoneOptions" :key="timezone" :value="timezone">{{ timezone }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <div v-if="createForm.scheduleKind === 'weekly'" class="trigger-weekday-field">
                    <span>{{ t("triggers.create.days") }}</span>
                    <div class="trigger-weekday-grid">
                      <label v-for="day in weekdayOptions" :key="day.value" class="trigger-weekday-option">
                        <Checkbox :model-value="createForm.weekdays.includes(day.value)" @update:model-value="toggleWeekday(day.value, Boolean($event))" />
                        <span>{{ day.label }}</span>
                      </label>
                    </div>
                  </div>
                </div>
                <div v-else-if="createForm.sourceType === 'file-change'" class="trigger-board-source-grid">
                  <label>
                    <span>{{ t("triggers.create.roots") }}</span>
                    <!-- i18n-audit-allow-next-line code-token: example watched runtime paths -->
                    <Input v-model="createForm.roots" placeholder="/workspace, /workspace/docs" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.globs") }}</span>
                    <!-- i18n-audit-allow-next-line code-token: example file glob patterns -->
                    <Input v-model="createForm.globs" placeholder="**/*, docs/**/*.md" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.ignore") }}</span>
                    <!-- i18n-audit-allow-next-line code-token: example ignored glob patterns -->
                    <Input v-model="createForm.ignore" placeholder="node_modules/**, .git/**" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.debounceMs") }}</span>
                    <Input v-model="createForm.debounceMs" placeholder="1500" />
                  </label>
                </div>
                <div v-else class="trigger-board-source-grid">
                  <label>
                    <span>{{ t("triggers.create.agent") }}</span>
                    <Input v-model="createForm.agent" :placeholder="t('triggers.create.anyAgent')" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.statuses") }}</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" class="trigger-multi-select" type="button">
                          <span>{{ selectedOptionText(createForm.statuses, aiStatusOptions, t("triggers.create.anyStatus")) }}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent class="trigger-multi-select-menu" align="start" :side-offset="6" @click.stop>
                        <DropdownMenuCheckboxItem
                          v-for="option in aiStatusOptions"
                          :key="option.value"
                          class="trigger-multi-select-item"
                          :model-value="createForm.statuses.includes(option.value)"
                          @update:model-value="toggleStringOption(createForm.statuses, option.value, Boolean($event))"
                          @select.prevent
                        >
                          {{ option.label }}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </label>
                  <label>
                    <span>{{ t("triggers.create.phases") }}</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" class="trigger-multi-select" type="button">
                          <span>{{ selectedOptionText(createForm.phases, aiPhaseOptions, t("triggers.create.anyPhase")) }}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent class="trigger-multi-select-menu" align="start" :side-offset="6" @click.stop>
                        <DropdownMenuCheckboxItem
                          v-for="option in aiPhaseOptions"
                          :key="option.value"
                          class="trigger-multi-select-item"
                          :model-value="createForm.phases.includes(option.value)"
                          @update:model-value="toggleStringOption(createForm.phases, option.value, Boolean($event))"
                          @select.prevent
                        >
                          {{ option.label }}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </label>
                </div>
              </section>

              <section class="trigger-create-group">
                <div class="trigger-create-group-head">
                  <strong>{{ t("triggers.create.runPolicy") }}</strong>
                  <span>{{ t("triggers.create.runPolicyHint") }}</span>
                </div>
                <div class="trigger-board-create-main">
                  <label>
                    <span>{{ t("triggers.create.cooldown") }}</span>
                    <ControlPlaneSelect v-model="createForm.cooldownPreset" trigger-class="trigger-board-select" :placeholder="t('triggers.create.cooldown')">
                      <ControlPlaneSelectItem v-for="option in cooldownPresetOptions" :key="option.value" :value="option.value">{{ option.label }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label>
                    <span>{{ t("triggers.create.busyPolicy") }}</span>
                    <ControlPlaneSelect v-model="createForm.whenBusy" trigger-class="trigger-board-select" :placeholder="t('triggers.create.busyPolicy')">
                      <ControlPlaneSelectItem value="skip">{{ t("triggers.busyPolicy.skip") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="queue">{{ t("triggers.busyPolicy.queue") }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label>
                    <span>{{ t("triggers.create.maxConcurrentRuns") }}</span>
                    <Input v-model="createForm.maxConcurrentRuns" type="number" min="1" max="20" step="1" inputmode="numeric" placeholder="1" />
                  </label>
                  <label v-if="createForm.cooldownPreset === 'custom'" class="trigger-interval-field">
                    <span>{{ t("triggers.create.customCooldown") }}</span>
                    <div class="trigger-interval-control">
                      <Input v-model="createForm.customCooldownValue" type="number" min="1" step="1" inputmode="numeric" placeholder="5" />
                      <ControlPlaneSelect v-model="createForm.customCooldownUnit" trigger-class="trigger-board-select trigger-interval-unit" :placeholder="t('triggers.create.unit')">
                        <ControlPlaneSelectItem value="second">{{ t("triggers.intervalUnit.second") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="minute">{{ t("triggers.intervalUnit.minute") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="hour">{{ t("triggers.intervalUnit.hour") }}</ControlPlaneSelectItem>
                      </ControlPlaneSelect>
                    </div>
                  </label>
                </div>

                <div class="trigger-create-group-head">
                  <strong>{{ t("triggers.create.prompt") }}</strong>
                  <span>{{ t("triggers.create.promptHint") }}</span>
                </div>
                <label class="trigger-board-prompt">
                  <span>{{ t("triggers.create.promptTemplate") }}</span>
                  <Textarea v-model="createForm.promptTemplate" rows="5" />
                </label>
              </section>
              </div>
            </ScrollArea>
            <DialogFooter class="trigger-create-footer">
              <DialogClose as-child>
                <Button variant="outline" size="sm">{{ t("triggers.create.cancel") }}</Button>
              </DialogClose>
              <Button size="sm" :disabled="saving" @click="saveTemplate">
                <Pencil v-if="editingHash" :size="14" />
                <Plus v-else :size="14" />
                <span>{{ saving ? t(editingHash ? "triggers.edit.saving" : "triggers.create.creating") : t(editingHash ? "triggers.edit.submit" : "triggers.create.submit") }}</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </header>
    <div class="trigger-board-toolbar">
      <div class="trigger-board-search">
        <Search :size="15" aria-hidden="true" />
        <ControlPlaneInput v-model="filter" :aria-label="t('triggers.filter')" :placeholder="t('triggers.filter')" />
      </div>
      <ControlPlaneSelect v-model="sourceFilter" :aria-label="t('triggers.filters.source')">
        <ControlPlaneSelectItem value="all">{{ t("triggers.filters.allSources") }}</ControlPlaneSelectItem>
        <ControlPlaneSelectItem value="schedule">{{ t("triggers.sourceType.schedule") }}</ControlPlaneSelectItem>
        <ControlPlaneSelectItem value="file-change">{{ t("triggers.sourceType.fileChange") }}</ControlPlaneSelectItem>
        <ControlPlaneSelectItem value="ai-session">{{ t("triggers.sourceType.aiSession") }}</ControlPlaneSelectItem>
      </ControlPlaneSelect>
      <ControlPlaneSelect v-model="statusFilter" :aria-label="t('triggers.filters.status')">
        <ControlPlaneSelectItem value="all">{{ t("triggers.filters.allStatuses") }}</ControlPlaneSelectItem>
        <ControlPlaneSelectItem value="active">{{ t("triggers.status.active") }}</ControlPlaneSelectItem>
        <ControlPlaneSelectItem value="running">{{ t("triggers.status.running") }}</ControlPlaneSelectItem>
        <ControlPlaneSelectItem value="error">{{ t("triggers.status.error") }}</ControlPlaneSelectItem>
        <ControlPlaneSelectItem value="disabled">{{ t("triggers.status.disabled") }}</ControlPlaneSelectItem>
        <ControlPlaneSelectItem value="not-deployed">{{ t("triggers.status.notDeployed") }}</ControlPlaneSelectItem>
      </ControlPlaneSelect>
    </div>

    <div class="trigger-board-overview" :aria-label="t('triggers.overview.label')">
      <div class="trigger-board-stat"><Zap :size="15" /><span>{{ t("triggers.overview.templates") }}</span><strong>{{ triggers.data.value?.triggers.length || 0 }}</strong></div>
      <div class="trigger-board-stat"><MapPin :size="15" /><span>{{ t("triggers.overview.deployments") }}</span><strong>{{ overview.deploymentCount }}</strong></div>
      <div class="trigger-board-stat"><Activity :size="15" /><span>{{ t("triggers.overview.running") }}</span><strong>{{ overview.runningCount }}</strong></div>
      <div class="trigger-board-stat" :class="{ 'is-danger': overview.errorCount > 0 }"><CircleAlert :size="15" /><span>{{ t("triggers.overview.errors") }}</span><strong>{{ overview.errorCount }}</strong></div>
    </div>

    <section class="trigger-directory" :aria-label="t('triggers.libraryTitle', { count: filteredTriggers.length })">
      <header class="trigger-directory-head">
        <strong>{{ t("triggers.libraryTitle", { count: filteredTriggers.length }) }}</strong>
        <span v-if="hasActiveFilters">{{ t("triggers.filters.filteredFrom", { count: triggers.data.value?.triggers.length || 0 }) }}</span>
      </header>
      <div v-if="triggers.error.value" class="trigger-state trigger-state-error"><span>{{ errorText }}</span><Button variant="outline" size="sm" @click="triggers.refetch()">{{ t("common.actions.retry") }}</Button></div>
      <div v-else-if="filteredTriggers.length" class="trigger-list">
        <article v-for="trigger in filteredTriggers" :key="trigger.configHash" class="trigger-row">
          <div class="trigger-row-main">
            <div class="trigger-identity">
              <div class="trigger-title-line">
                <strong>{{ trigger.config.name }}</strong>
                <Badge variant="secondary">{{ sourceTypeLabel(trigger.config.source.type) }}</Badge>
                <Badge :variant="trigger.errorCount ? 'destructive' : 'secondary'">{{ triggerStatusLabel(trigger) }}</Badge>
                <Badge v-if="!trigger.ownedByControlPlane" variant="secondary">{{ t("triggers.ownership.instanceLocal") }}</Badge>
              </div>
              <span class="trigger-source-line">
                <Clock3 v-if="trigger.config.source.type === 'schedule'" :size="14" />
                <FolderSync v-else-if="trigger.config.source.type === 'file-change'" :size="14" />
                <Bot v-else :size="14" />
                <span :title="sourceText(trigger.config.source)">{{ sourceText(trigger.config.source) }}</span>
              </span>
              <span class="trigger-description" :title="trigger.config.description || trigger.configHash">{{ trigger.config.description || shortHash(trigger.configHash) }}</span>
            </div>

            <div class="trigger-summary">
              <Popover>
                <PopoverTrigger as-child>
                  <button type="button" class="trigger-summary-item trigger-summary-trigger">
                    <MapPin :size="14" aria-hidden="true" />
                    <span>{{ t(trigger.deploymentCount === 1 ? "triggers.counts.bindingOne" : "triggers.counts.bindings", { count: trigger.deploymentCount }) }}</span>
                    <ChevronDown :size="14" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent class="trigger-summary-popover w-[min(360px,var(--reka-popover-content-available-width))] overflow-hidden p-0" align="start" :collision-padding="10" :side-offset="4">
                  <header class="trigger-summary-popover-head"><strong>{{ t("triggers.deployments.title") }}</strong><span>{{ t(trigger.deploymentCount === 1 ? "triggers.counts.bindingOne" : "triggers.counts.bindings", { count: trigger.deploymentCount }) }}</span></header>
                  <ScrollArea v-if="trigger.deployments.length" class="trigger-summary-popover-scroll" :horizontal="false">
                    <div class="trigger-popover-list">
                      <div v-for="entry in trigger.deployments" :key="`${entry.instanceId}:${entry.deployment.deploymentId || entry.deployment.configHash}`" class="trigger-deployment-row">
                        <MapPin :size="14" aria-hidden="true" />
                        <div class="trigger-deployment-copy"><strong>{{ entry.instanceName }}</strong><span :title="targetText(entry.deployment.target)">{{ sessionTitle(entry.instanceId, entry.deployment.target.aiSessionId) }}</span></div>
                        <div class="trigger-deployment-status"><span class="trigger-runtime-dot" :data-status="entry.runtime?.status || (entry.deployment.enabled ? 'idle' : 'disabled')" /><span :title="entry.runtime?.lastError">{{ runtimeStatusLabel(entry.runtime?.status || (entry.deployment.enabled ? "idle" : "disabled")) }}</span></div>
                        <div class="trigger-deployment-actions">
                          <Button variant="ghost" size="icon" :aria-label="t('triggers.actions.run')" :title="t('triggers.actions.run')" @click="run(entry.instanceId, trigger.configHash, entry.deployment.deploymentId || entry.deployment.configHash)"><Play :size="14" /></Button>
                          <Button v-if="trigger.ownedByControlPlane && entry.deployment.origin === 'control-plane'" variant="ghost" size="icon" :disabled="bindingBusyKey === deploymentKey(entry.instanceId, entry.deployment.target.aiSessionId, trigger.configHash)" :aria-label="t('triggers.actions.unbind')" :title="t('triggers.actions.unbind')" @click="unbind(trigger.configHash, entry.instanceId, entry.deployment.target.aiSessionId)"><Unlink :size="14" /></Button>
                        </div>
                      </div>
                    </div>
                  </ScrollArea>
                  <p v-else class="trigger-popover-empty">{{ t("triggers.deployments.empty") }}</p>
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger as-child>
                  <button type="button" class="trigger-summary-item trigger-summary-trigger">
                    <History :size="14" aria-hidden="true" />
                    <span>{{ t("triggers.activity.count", { count: trigger.recentRuns.length }) }}</span>
                    <ChevronDown :size="14" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent class="trigger-summary-popover w-[min(420px,var(--reka-popover-content-available-width))] overflow-hidden p-0" align="start" :collision-padding="10" :side-offset="4">
                  <header class="trigger-summary-popover-head"><strong>{{ t("triggers.activity.title") }}</strong><span v-if="trigger.recentRuns.length">{{ t("triggers.activity.latest", { time: formatDate(trigger.recentRuns[0].startedAt) }) }}</span></header>
                  <ScrollArea v-if="trigger.recentRuns.length" class="trigger-summary-popover-scroll" :horizontal="false">
                    <div class="trigger-popover-list">
                      <div v-for="run in trigger.recentRuns.slice(0, 5)" :key="run.id" class="trigger-run-row">
                        <Badge :variant="run.status === 'failed' ? 'destructive' : 'secondary'" :title="run.error">{{ runStatusLabel(run.status) }}</Badge>
                        <span>{{ run.instanceName || run.instanceId }}</span><span>{{ eventTypeLabel(run.eventType) }}</span><time>{{ formatDate(run.startedAt) }}</time>
                      </div>
                    </div>
                  </ScrollArea>
                  <p v-else class="trigger-popover-empty">{{ t("triggers.activity.empty") }}</p>
                </PopoverContent>
              </Popover>

              <span class="trigger-summary-item"><Zap :size="14" aria-hidden="true" />{{ t("triggers.counts.enabled", { count: trigger.enabledCount }) }}</span>
            </div>

            <div class="trigger-row-actions">
              <Button variant="outline" size="sm" :disabled="!trigger.ownedByControlPlane" :title="trigger.ownedByControlPlane ? t('triggers.actions.editTitle') : t('triggers.ownership.editOwnedElsewhere')" @click="beginEdit(trigger)"><Pencil :size="14" /><span>{{ t("triggers.actions.configure") }}</span></Button>
              <DropdownMenu>
                <DropdownMenuTrigger as-child><Button variant="ghost" size="icon" :aria-label="t('triggers.actions.more')" :disabled="deletingHash === trigger.configHash"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" :side-offset="6">
                  <DropdownMenuItem :disabled="!trigger.ownedByControlPlane || !availableSessions(trigger).length" @select="openDeployDialog(trigger.configHash)"><MapPinPlus :size="14" /><span>{{ t("triggers.actions.deploy") }}</span></DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem class="trigger-delete-item" :disabled="!trigger.ownedByControlPlane" @select="requestDelete(trigger)"><Trash2 :size="14" /><span>{{ t("triggers.actions.delete") }}</span></DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="trigger-state trigger-empty-state">
        <Zap :size="28" aria-hidden="true" />
        <strong>{{ hasActiveFilters ? t("triggers.filters.noMatches") : t("triggers.empty") }}</strong>
        <p>{{ hasActiveFilters ? t("triggers.filters.noMatchesDescription") : t("triggers.emptyDescription") }}</p>
        <Button v-if="hasActiveFilters" variant="outline" size="sm" @click="clearFilters">{{ t("triggers.filters.clear") }}</Button>
        <Button v-else size="sm" @click="openCreateDialog"><Plus :size="14" />{{ t("triggers.create.action") }}</Button>
      </div>
    </section>

    <Dialog v-model:open="deployDialogOpen">
      <DialogContent class="trigger-deploy-dialog w-[min(520px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden p-0">
        <DialogHeader class="trigger-create-head flex-row items-center justify-between space-y-0"><div><DialogTitle>{{ t("triggers.deployments.dialogTitle") }}</DialogTitle><DialogDescription>{{ t("triggers.deployments.dialogDescription") }}</DialogDescription></div><DialogClose as-child><Button variant="ghost" size="icon" class="trigger-create-close" :aria-label="t('triggers.deployments.close')"><X :size="16" /></Button></DialogClose></DialogHeader>
        <ScrollArea class="trigger-deploy-session-scroll" :horizontal="false">
          <div class="trigger-deploy-session-list">
            <button v-for="session in selectedTriggerSessions" :key="`${session.instanceId}:${session.id}`" type="button" :disabled="Boolean(bindingBusyKey)" @click="bindSelectedTrigger(session.instanceId, session.id)">
              <Bot :size="15" /><span><strong>{{ session.title || session.userPrompt || session.id }}</strong><small>{{ session.instanceName }} · {{ session.cwd || session.agent }}</small></span><Plus :size="14" />
            </button>
            <p v-if="!selectedTriggerSessions.length" class="settings-empty">{{ t("triggers.deployments.noSessions") }}</p>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="Boolean(pendingDelete)" @update:open="(open) => { if (!open) pendingDelete = undefined; }">
      <AlertDialogContent class="w-[min(440px,calc(100vw-32px))] max-w-none">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t("triggers.actions.deleteConfirmTitle") }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t("triggers.actions.deleteConfirmDescription", { name: pendingDelete?.config.name || '' }) }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel>
          <AlertDialogAction :disabled="Boolean(deletingHash)" @click="confirmDelete">{{ t("triggers.actions.delete") }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useI18n } from "vue-i18n";
import type { ControlPlaneTriggerMutationFailure } from "@task-handoff/protocol/triggers";
import { Activity, Bot, ChevronDown, CircleAlert, Clock3, FolderSync, History, MapPin, MapPinPlus, MoreHorizontal, Pencil, Play, Plus, Search, Trash2, Unlink, X, Zap } from "@lucide/vue";
import { bindAiSessionTrigger, createControlPlaneTrigger, deleteControlPlaneTrigger, runControlledInstanceTrigger, unbindAiSessionTrigger, updateControlPlaneTrigger, useControlPlaneAiSessionsQuery, useControlPlaneTriggersQuery } from "../../../api/queries";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import type { ControlPlaneTrigger, InstanceBoardItem, TriggerRun, TriggerSource, TriggerTarget } from "../../../api/types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Input } from "../../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Textarea } from "../../../components/ui/textarea";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import ControlPlaneTimePicker from "../shared/ControlPlaneTimePicker.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { formatDateTime } from "../../../i18n/presentation";
import { translateApiError } from "../../../i18n/apiError";
import type { SupportedLocale } from "../../../i18n";

type AiSessionTriggerSource = Extract<TriggerSource, { type: "ai-session" }>;

const queryClient = useQueryClient();
const { locale, t } = useI18n();
const props = defineProps<{ instances: InstanceBoardItem[] }>();
const triggers = useControlPlaneTriggersQuery();
const aiSessions = useControlPlaneAiSessionsQuery();
const filter = ref("");
const sourceFilter = ref<"all" | TriggerSource["type"]>("all");
const statusFilter = ref<"all" | TriggerStatus>("all");
const saving = ref(false);
const editingHash = ref("");
const deletingHash = ref("");
const bindingBusyKey = ref("");
const createDialogOpen = ref(false);
const deployDialogOpen = ref(false);
const deployTriggerHash = ref("");
const pendingDelete = ref<ControlPlaneTrigger>();
const createForm = reactive({
  name: "",
  description: "",
  sourceType: "schedule" as TriggerSource["type"],
  scheduleKind: "interval" as ScheduleKind,
  intervalValue: "1",
  intervalUnit: "hour" as IntervalUnit,
  timeOfDay: "09:00",
  timezone: defaultTimezone(),
  weekdays: [1, 2, 3, 4, 5],
  roots: "/workspace",
  globs: "**/*",
  ignore: "node_modules/**, .git/**",
  debounceMs: "1500",
  statuses: ["idle", "failed"] as AiSessionTriggerSource["statuses"],
  phases: [] as AiSessionTriggerSource["phases"],
  agent: "",
  cooldownPreset: "none" as CooldownPreset,
  customCooldownValue: "5",
  customCooldownUnit: "minute" as CooldownUnit,
  whenBusy: "skip" as "skip" | "queue",
  maxConcurrentRuns: "1",
  promptTemplate: "Please review the current context and continue with the next useful step.",
});

type ScheduleKind = "interval" | "daily" | "weekly";
type IntervalUnit = "minute" | "hour" | "day" | "week";
type CooldownPreset = "none" | "30s" | "1m" | "5m" | "15m" | "1h" | "custom";
type CooldownUnit = "second" | "minute" | "hour";
type TriggerStatus = "active" | "running" | "error" | "disabled" | "not-deployed";

const intervalUnitMs: Record<IntervalUnit, number> = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

const timezoneOptions = Array.from(new Set([
  defaultTimezone(),
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
])).filter(Boolean);

const weekdayOptions = computed(() => [
  { value: 1, label: t("triggers.weekday.monday") },
  { value: 2, label: t("triggers.weekday.tuesday") },
  { value: 3, label: t("triggers.weekday.wednesday") },
  { value: 4, label: t("triggers.weekday.thursday") },
  { value: 5, label: t("triggers.weekday.friday") },
  { value: 6, label: t("triggers.weekday.saturday") },
  { value: 0, label: t("triggers.weekday.sunday") },
]);

const aiStatusOptions = computed<Array<{ value: NonNullable<AiSessionTriggerSource["statuses"]>[number]; label: string }>>(() => [
  { value: "running", label: t("triggers.sessionStatus.running") },
  { value: "waiting", label: t("triggers.sessionStatus.waiting") },
  { value: "idle", label: t("triggers.sessionStatus.idle") },
  { value: "failed", label: t("triggers.sessionStatus.failed") },
]);

const aiPhaseOptions = computed<Array<{ value: NonNullable<AiSessionTriggerSource["phases"]>[number]; label: string }>>(() => [
  { value: "thinking", label: t("triggers.sessionPhase.thinking") },
  { value: "tool", label: t("triggers.sessionPhase.tool") },
  { value: "editing", label: t("triggers.sessionPhase.editing") },
  { value: "approval", label: t("triggers.sessionPhase.approval") },
  { value: "responding", label: t("triggers.sessionPhase.responding") },
  { value: "unknown", label: t("triggers.sessionPhase.unknown") },
]);

const cooldownPresetOptions = computed<Array<{ value: CooldownPreset; label: string; ms: number | null }>>(() => [
  { value: "none", label: t("triggers.cooldownPreset.none"), ms: 0 },
  { value: "30s", label: t("triggers.cooldownPreset.seconds30"), ms: 30_000 },
  { value: "1m", label: t("triggers.cooldownPreset.minute1"), ms: 60_000 },
  { value: "5m", label: t("triggers.cooldownPreset.minutes5"), ms: 5 * 60_000 },
  { value: "15m", label: t("triggers.cooldownPreset.minutes15"), ms: 15 * 60_000 },
  { value: "1h", label: t("triggers.cooldownPreset.hour1"), ms: 60 * 60_000 },
  { value: "custom", label: t("triggers.cooldownPreset.custom"), ms: null },
]);

const cooldownUnitMs: Record<CooldownUnit, number> = {
  second: 1000,
  minute: 60_000,
  hour: 60 * 60_000,
};

const errorText = computed(() => (triggers.error.value instanceof Error ? triggers.error.value.message : String(triggers.error.value || "")));
const sourceSectionHint = computed(() => {
  if (createForm.sourceType === "file-change") {
    return t("triggers.sourceHint.fileChange");
  }
  if (createForm.sourceType === "ai-session") {
    return t("triggers.sourceHint.aiSession");
  }
  if (createForm.scheduleKind === "interval") {
    return t("triggers.sourceHint.interval");
  }
  return t("triggers.sourceHint.wallClock");
});
const filteredTriggers = computed(() => {
  const value = filter.value.trim().toLowerCase();
  const items = triggers.data.value?.triggers || [];
  return items.filter((trigger) => {
    const matchesText = !value || `${trigger.config.name} ${trigger.config.description || ""} ${trigger.configHash} ${trigger.config.source.type} ${sourceText(trigger.config.source)}`.toLowerCase().includes(value);
    const matchesSource = sourceFilter.value === "all" || trigger.config.source.type === sourceFilter.value;
    const matchesStatus = statusFilter.value === "all" || triggerStatus(trigger) === statusFilter.value;
    return matchesText && matchesSource && matchesStatus;
  });
});
const hasActiveFilters = computed(() => Boolean(filter.value.trim()) || sourceFilter.value !== "all" || statusFilter.value !== "all");
const overview = computed(() => (triggers.data.value?.triggers || []).reduce((result, trigger) => ({
  deploymentCount: result.deploymentCount + trigger.deploymentCount,
  runningCount: result.runningCount + trigger.runningCount,
  errorCount: result.errorCount + trigger.errorCount,
}), { deploymentCount: 0, runningCount: 0, errorCount: 0 }));
const allSessions = computed(() => (aiSessions.data.value?.instances || []).flatMap((entry) => {
  const instance = props.instances.find((candidate) => candidate.id === entry.instanceId);
  return entry.aiSessions.sessions.map((session) => ({ ...session, instanceId: entry.instanceId, instanceName: instance?.name || entry.instanceId }));
}));
const selectedTrigger = computed(() => (triggers.data.value?.triggers || []).find((trigger) => trigger.configHash === deployTriggerHash.value));
const selectedTriggerSessions = computed(() => selectedTrigger.value ? availableSessions(selectedTrigger.value) : []);

function triggerStatusLabel(trigger: ControlPlaneTrigger) {
  return t(`triggers.status.${triggerStatus(trigger) === "not-deployed" ? "notDeployed" : triggerStatus(trigger)}`);
}

function triggerStatus(trigger: ControlPlaneTrigger): TriggerStatus {
  if (trigger.errorCount) return "error";
  if (trigger.runningCount) return "running";
  if (!trigger.deploymentCount) return "not-deployed";
  if (!trigger.enabledCount) return "disabled";
  return "active";
}

function clearFilters() {
  filter.value = "";
  sourceFilter.value = "all";
  statusFilter.value = "all";
}

function availableSessions(trigger: ControlPlaneTrigger) {
  const deployed = new Set(trigger.deployments.map((entry) => `${entry.instanceId}:${entry.deployment.target.aiSessionId}`));
  return allSessions.value.filter((session) => !deployed.has(`${session.instanceId}:${session.id}`));
}

function sessionTitle(instanceId: string, sessionId: string) {
  const session = allSessions.value.find((candidate) => candidate.instanceId === instanceId && candidate.id === sessionId);
  return session?.title || session?.userPrompt || sessionId;
}

function deploymentKey(instanceId: string, sessionId: string, configHash: string) {
  return `${instanceId}:${sessionId}:${configHash}`;
}

function openDeployDialog(configHash: string) {
  deployTriggerHash.value = configHash;
  deployDialogOpen.value = true;
}

async function bindSelectedTrigger(instanceId: string, sessionId: string) {
  if (!deployTriggerHash.value || bindingBusyKey.value) return;
  bindingBusyKey.value = deploymentKey(instanceId, sessionId, deployTriggerHash.value);
  try {
    await bindAiSessionTrigger(instanceId, sessionId, deployTriggerHash.value);
    deployDialogOpen.value = false;
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    bindingBusyKey.value = "";
  }
}

async function unbind(configHash: string, instanceId: string, sessionId: string) {
  if (bindingBusyKey.value) return;
  bindingBusyKey.value = deploymentKey(instanceId, sessionId, configHash);
  try {
    await unbindAiSessionTrigger(instanceId, sessionId, configHash);
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    bindingBusyKey.value = "";
  }
}

async function run(instanceId: string, configHash: string, deploymentId?: string) {
  try {
    await runControlledInstanceTrigger(instanceId, configHash, { deploymentId });
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  }
}

function beginCreate() {
  editingHash.value = "";
  resetCreateForm();
}

function openCreateDialog() {
  beginCreate();
  createDialogOpen.value = true;
}

function resetCreateForm() {
  Object.assign(createForm, {
    name: "",
    description: "",
    sourceType: "schedule",
    scheduleKind: "interval",
    intervalValue: "1",
    intervalUnit: "hour",
    timeOfDay: "09:00",
    timezone: defaultTimezone(),
    weekdays: [1, 2, 3, 4, 5],
    roots: "/workspace",
    globs: "**/*",
    ignore: "node_modules/**, .git/**",
    debounceMs: "1500",
    statuses: ["idle", "failed"],
    phases: [],
    agent: "",
    cooldownPreset: "none",
    customCooldownValue: "5",
    customCooldownUnit: "minute",
    whenBusy: "skip",
    maxConcurrentRuns: "1",
    promptTemplate: "Please review the current context and continue with the next useful step.",
  });
}

function beginEdit(trigger: ControlPlaneTrigger) {
  if (!trigger.ownedByControlPlane) return;
  editingHash.value = trigger.configHash;
  resetCreateForm();
  populateForm(trigger.config);
  createDialogOpen.value = true;
}

async function saveTemplate() {
  saving.value = true;
  try {
    const input = {
      name: createForm.name.trim() || "Untitled trigger",
      description: createForm.description.trim() || undefined,
      source: sourceFromForm(),
      action: { promptTemplate: createForm.promptTemplate },
      policy: {
        cooldownMs: cooldownMsFromForm(),
        maxConcurrentRuns: boundedInteger(createForm.maxConcurrentRuns, 1, 1, 20),
        whenBusy: createForm.whenBusy,
      },
    };
    if (editingHash.value) {
      const result = await updateControlPlaneTrigger(editingHash.value, input);
      showMutationFailures(result.partialFailures);
    } else {
      await createControlPlaneTrigger(input);
    }
    createForm.name = "";
    createDialogOpen.value = false;
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    saving.value = false;
  }
}

function populateForm(config: ControlPlaneTrigger["config"]) {
  createForm.name = config.name;
  createForm.description = config.description || "";
  createForm.sourceType = config.source.type;
  createForm.promptTemplate = config.action.promptTemplate;
  createForm.whenBusy = config.policy.whenBusy;
  createForm.maxConcurrentRuns = String(config.policy.maxConcurrentRuns);
  setCooldown(config.policy.cooldownMs || 0);
  if (config.source.type === "file-change") {
    createForm.roots = config.source.roots.join(", ");
    createForm.globs = config.source.globs.join(", ");
    createForm.ignore = (config.source.ignore || []).join(", ");
    createForm.debounceMs = String(config.source.debounceMs);
  } else if (config.source.type === "ai-session") {
    createForm.agent = config.source.agent || "";
    createForm.statuses = [...(config.source.statuses || [])];
    createForm.phases = [...(config.source.phases || [])];
  } else if ("intervalMs" in config.source) {
    createForm.scheduleKind = "interval";
    const intervalMs = config.source.intervalMs;
    const unit = (["week", "day", "hour", "minute"] as IntervalUnit[]).find((candidate) => intervalMs % intervalUnitMs[candidate] === 0) || "minute";
    createForm.intervalUnit = unit;
    createForm.intervalValue = String(intervalMs / intervalUnitMs[unit]);
  } else {
    createForm.scheduleKind = config.source.scheduleKind;
    createForm.timeOfDay = config.source.timeOfDay;
    createForm.timezone = config.source.timezone;
    if (config.source.scheduleKind === "weekly") createForm.weekdays = [...config.source.weekdays];
  }
}

function setCooldown(cooldownMs: number) {
  const preset = cooldownPresetOptions.value.find((option) => option.ms === cooldownMs);
  if (preset) {
    createForm.cooldownPreset = preset.value;
    return;
  }
  createForm.cooldownPreset = "custom";
  const unit = (["hour", "minute", "second"] as CooldownUnit[]).find((candidate) => cooldownMs % cooldownUnitMs[candidate] === 0) || "second";
  createForm.customCooldownUnit = unit;
  createForm.customCooldownValue = String(cooldownMs / cooldownUnitMs[unit]);
}

function requestDelete(trigger: ControlPlaneTrigger) {
  if (!trigger.ownedByControlPlane) return;
  pendingDelete.value = trigger;
}

async function confirmDelete() {
  const target = pendingDelete.value;
  if (!target) return;
  if (await deleteTemplate(target.configHash)) {
    pendingDelete.value = undefined;
  }
}

async function deleteTemplate(configHash: string) {
  if (deletingHash.value) {
    return false;
  }
  deletingHash.value = configHash;
  try {
    const result = await deleteControlPlaneTrigger(configHash);
    showMutationFailures(result.partialFailures);
    await refresh();
    return true;
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
    return false;
  } finally {
    deletingHash.value = "";
  }
}

function showMutationFailures(failures: ControlPlaneTriggerMutationFailure[] | undefined) {
  if (!failures?.length) return;
  const failedTargets = [...new Set(failures.map((failure) => failure.instanceId || failure.nodeId).filter(Boolean))];
  showControlPlaneToast(t("triggers.feedback.partialFailure", {
    count: failedTargets.length || failures.length,
    targets: failedTargets.join(", ") || t("triggers.feedback.unknownTarget"),
  }), "info");
}

async function refresh() {
  await queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] });
  await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard });
  await queryClient.invalidateQueries({ queryKey: ["control-plane-ai-sessions"] });
}

function sourceFromForm(): TriggerSource {
  if (createForm.sourceType === "file-change") {
    return {
      type: "file-change",
      roots: listFromCsv(createForm.roots, ["/workspace"]),
      globs: listFromCsv(createForm.globs, ["**/*"]),
      ignore: listFromCsv(createForm.ignore),
      debounceMs: positiveNumber(createForm.debounceMs, 1500),
    };
  }
  if (createForm.sourceType === "ai-session") {
    return {
      type: "ai-session",
      agent: createForm.agent.trim() || undefined,
      statuses: createForm.statuses.length ? createForm.statuses : undefined,
      phases: createForm.phases.length ? createForm.phases : undefined,
    };
  }
  return {
    ...scheduleSourceFromForm(),
    type: "schedule",
  } as TriggerSource;
}

function scheduleSourceFromForm() {
  if (createForm.scheduleKind === "daily") {
    return {
      scheduleKind: "daily" as const,
      timeOfDay: createForm.timeOfDay,
      timezone: createForm.timezone || defaultTimezone(),
    };
  }
  if (createForm.scheduleKind === "weekly") {
    return {
      scheduleKind: "weekly" as const,
      weekdays: createForm.weekdays.length ? [...createForm.weekdays].sort((a, b) => a - b) : [1],
      timeOfDay: createForm.timeOfDay,
      timezone: createForm.timezone || defaultTimezone(),
    };
  }
  return {
    scheduleKind: "interval" as const,
    intervalMs: intervalMsFromForm(),
  };
}

function intervalMsFromForm() {
  const value = positiveNumber(createForm.intervalValue, 1);
  return Math.round(value * intervalUnitMs[createForm.intervalUnit]);
}

function cooldownMsFromForm() {
  if (createForm.cooldownPreset === "custom") {
    const value = positiveNumber(createForm.customCooldownValue, 5);
    return Math.round(value * cooldownUnitMs[createForm.customCooldownUnit]);
  }
  return cooldownPresetOptions.value.find((option) => option.value === createForm.cooldownPreset)?.ms || 0;
}

function listFromCsv(value: string, fallback: string[] = []) {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function positiveNumber(value: string, fallback: number) {
  return Math.max(1, Number(value) || fallback);
}

function boundedInteger(value: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  return Math.min(maximum, Math.max(minimum, normalized));
}

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}...` : value;
}

function sourceText(source: TriggerSource) {
  if (source.type === "schedule") {
    if ("intervalMs" in source) {
      return t("triggers.sourceSummary.interval", { interval: formatInterval(source.intervalMs) });
    }
    if (source.scheduleKind === "daily") {
      return t("triggers.sourceSummary.daily", { time: source.timeOfDay, timezone: source.timezone });
    }
    return t("triggers.sourceSummary.weekly", { weekdays: formatWeekdays(source.weekdays), time: source.timeOfDay, timezone: source.timezone });
  }
  if (source.type === "file-change") {
    return `${source.roots.join(", ")} · ${source.globs.join(", ")}`;
  }
  const filters = [
    source.agent ? t("triggers.sourceSummary.agent", { value: source.agent }) : undefined,
    source.statuses?.length ? t("triggers.sourceSummary.statuses", { value: source.statuses.map(sessionStatusLabel).join(", ") }) : undefined,
    source.phases?.length ? t("triggers.sourceSummary.phases", { value: source.phases.map(sessionPhaseLabel).join(", ") }) : undefined,
  ].filter(Boolean);
  return filters.join(" · ") || t("triggers.sourceSummary.anyAiSessionUpdate");
}

function sourceTypeLabel(value: TriggerSource["type"]) {
  if (value === "schedule") return t("triggers.sourceType.schedule");
  if (value === "file-change") return t("triggers.sourceType.fileChange");
  if (value === "ai-session") return t("triggers.sourceType.aiSession");
  return value;
}

function sessionStatusLabel(value: string) {
  if (value === "running") return t("triggers.sessionStatus.running");
  if (value === "waiting") return t("triggers.sessionStatus.waiting");
  if (value === "idle") return t("triggers.sessionStatus.idle");
  if (value === "failed") return t("triggers.sessionStatus.failed");
  return value;
}

function sessionPhaseLabel(value: string) {
  if (value === "thinking") return t("triggers.sessionPhase.thinking");
  if (value === "tool") return t("triggers.sessionPhase.tool");
  if (value === "editing") return t("triggers.sessionPhase.editing");
  if (value === "approval") return t("triggers.sessionPhase.approval");
  if (value === "responding") return t("triggers.sessionPhase.responding");
  if (value === "unknown") return t("triggers.sessionPhase.unknown");
  return value;
}

function runtimeStatusLabel(value: string) {
  if (value === "idle") return t("triggers.status.idle");
  if (value === "running") return t("triggers.status.running");
  if (value === "disabled") return t("triggers.status.disabled");
  if (value === "error") return t("triggers.status.error");
  return t("triggers.status.unknown", { value });
}

function runStatusLabel(value: string) {
  if (value === "started") return t("triggers.status.started");
  if (value === "completed") return t("triggers.status.completed");
  if (value === "failed") return t("triggers.status.failed");
  if (value === "skipped") return t("triggers.status.skipped");
  return t("triggers.status.unknown", { value });
}

function eventTypeLabel(value: TriggerRun["eventType"]) {
  if (value === "manual") return t("triggers.eventType.manual");
  if (value === "schedule") return t("triggers.eventType.schedule");
  if (value === "file-change") return t("triggers.eventType.fileChange");
  return t("triggers.eventType.aiSession");
}

function originLabel(value: string) {
  if (value === "control-plane") return t("triggers.origin.controlPlane");
  if (value === "controlled-instance") return t("triggers.origin.controlledInstance");
  return t("triggers.origin.unknown", { value });
}

function toggleWeekday(value: number, checked: boolean) {
  const next = new Set(createForm.weekdays);
  if (checked) {
    next.add(value);
  } else {
    next.delete(value);
  }
  createForm.weekdays = [...next].sort((a, b) => a - b);
}

function toggleStringOption<T extends string>(values: T[], value: T, checked: boolean) {
  const next = new Set(values);
  if (checked) {
    next.add(value);
  } else {
    next.delete(value);
  }
  values.splice(0, values.length, ...next);
}

function selectedOptionText<T extends string>(values: T[] | undefined, options: Array<{ value: T; label: string }>, emptyText: string) {
  if (!values?.length) {
    return emptyText;
  }
  const labels = new Map(options.map((option) => [option.value, option.label]));
  return values.map((value) => labels.get(value) || value).join(", ");
}

function formatWeekdays(values: number[]) {
  const labels = new Map(weekdayOptions.value.map((day) => [day.value, day.label]));
  return values.map((value) => labels.get(value) || String(value)).join(", ");
}

function defaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatInterval(value: number) {
  const units: IntervalUnit[] = ["week", "day", "hour", "minute"];
  for (const unit of units) {
    const unitMs = intervalUnitMs[unit];
    if (value >= unitMs && value % unitMs === 0) {
      const count = value / unitMs;
      const suffix = count === 1 ? "One" : "Many";
      return t(`triggers.interval.${unit}${suffix}`, { count });
    }
  }
  return t("triggers.interval.milliseconds", { count: value });
}

function targetText(target: TriggerTarget) {
  return t("triggers.target.aiSession", { id: target.aiSessionId });
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date, locale.value as SupportedLocale);
}
</script>

<style src="./ControlPlaneTriggersView.css"></style>
