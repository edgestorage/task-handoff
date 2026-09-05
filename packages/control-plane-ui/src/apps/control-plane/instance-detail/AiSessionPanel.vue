<template>
  <div ref="panelEl" class="session-ai-panel" :class="{ 'creation-embedded': creationEmbedded }" :style="workspaceStyle">
    <Sheet v-model:open="sessionListOverlayOpen">
    <div class="session-ai-workspace" :class="{ 'creation-only': creationOnly, 'detail-only': detailOnly }">
      <component
        v-if="!creationOnly && !detailOnly"
        :is="compactAiSessionLayout ? SheetContent : 'div'"
        class="session-ai-sidebar-shell"
        :class="{ 'session-ai-sidebar-sheet': compactAiSessionLayout }"
        v-bind="compactAiSessionLayout ? {
          overlayClass: 'session-ai-sidebar-overlay',
          overlayStyle: sessionListOverlayBackdropStyle,
          showClose: false,
          side: 'left',
          style: sessionListOverlayStyle,
        } : {}"
      >
        <SheetTitle v-if="compactAiSessionLayout" class="sr-only">{{ t("sessions.panel.sessionList") }}</SheetTitle>
        <SheetDescription v-if="compactAiSessionLayout" class="sr-only">{{ t("sessions.panel.sessionListDescription") }}</SheetDescription>
        <aside ref="sidebarEl" class="session-ai-sidebar" :class="{ 'has-history-entry': !historyMode }">
        <div class="session-ai-sidebar-head">
          <div v-if="historyMode" class="session-ai-history-head">
            <Button
              variant="ghost"
              size="icon"
              class="session-ai-history-back"
              :aria-label="t('sessions.panel.backCurrent')"
              :title="t('sessions.panel.backCurrent')"
              @click="leaveHistoryMode"
            >
              <ArrowLeft :size="15" />
            </Button>
            <strong>{{ t("sessions.panel.history") }}</strong>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="outline" size="sm" class="session-ai-options-trigger" :aria-label="t('sessions.panel.historyOptions')" :title="t('sessions.panel.historyOptions')">
                  <SlidersHorizontal :size="16" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="session-ai-options-menu" align="end" :side-offset="6">
                <DropdownMenuLabel class="session-ai-options-label">{{ t("sessions.panel.view") }}</DropdownMenuLabel>
                <DropdownMenuRadioGroup v-model="groupMode">
                  <DropdownMenuRadioItem class="session-ai-options-item option-item" value="none">{{ t("sessions.panel.noGrouping") }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem class="session-ai-options-item option-item" value="path">{{ t("sessions.panel.groupByPath") }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem class="session-ai-options-item option-item" value="story">{{ t("sessions.panel.groupByStory") }}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div v-else class="session-ai-sidebar-actions">
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <button type="button" class="session-ai-filter-trigger">
                  <Filter :size="14" />
                  <span>{{ selectedStatusFilter.label }}</span>
                  <strong>{{ selectedStatusFilter.count }}</strong>
                  <ChevronDown :size="14" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="session-ai-filter-menu" align="end" :side-offset="6">
                <DropdownMenuLabel class="session-ai-filter-label">{{ t("sessions.panel.status") }}</DropdownMenuLabel>
                <DropdownMenuItem
                  v-for="option in statusFilterOptions"
                  :key="option.key"
                  class="session-ai-filter-item"
                  :data-selected="sessionStatusFilter === option.key ? 'true' : undefined"
                  @select="sessionStatusFilter = option.key"
                >
                  <Check v-if="sessionStatusFilter === option.key" :size="13" />
                  <span v-else class="session-ai-filter-check-spacer" />
                  <span>{{ option.label }}</span>
                  <strong>{{ option.count }}</strong>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="outline" size="sm" class="session-ai-options-trigger" :aria-label="t('sessions.panel.listOptions')" :title="t('sessions.panel.listOptions')">
                  <SlidersHorizontal :size="16" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="session-ai-options-menu" align="end" :side-offset="6">
                <DropdownMenuLabel class="session-ai-options-label">{{ t("sessions.panel.view") }}</DropdownMenuLabel>
                <DropdownMenuRadioGroup :model-value="sessionListLayout" @update:model-value="sessionListLayout = $event as AiSessionListLayout">
                  <DropdownMenuRadioItem class="session-ai-options-item option-item" value="cards">{{ t("sessions.panel.cardLayout") }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem class="session-ai-options-item option-item" value="list">{{ t("sessions.panel.listLayout") }}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup v-model="groupMode">
                  <DropdownMenuRadioItem class="session-ai-options-item option-item" value="none">{{ t("sessions.panel.noGrouping") }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem class="session-ai-options-item option-item" value="path">{{ t("sessions.panel.groupByPath") }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem class="session-ai-options-item option-item" value="story">{{ t("sessions.panel.groupByStory") }}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuCheckboxItem v-if="groupSessionsByPath" class="session-ai-options-item option-item" :model-value="showEmptyPathGroups" @update:model-value="(value) => showEmptyPathGroups = Boolean(value)">
                  {{ t("sessions.panel.showEmptyPathGroups") }}
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem class="session-ai-options-item option-item" :model-value="sortSessionsByStatus" @update:model-value="(value) => sortSessionsByStatus = Boolean(value)">
                  {{ t("sessions.panel.sortByStatus") }}
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button type="button" class="session-ai-new-button" :aria-label="t('sessions.panel.newSession')" :title="t('sessions.panel.newSession')" @click="openNewSession">
              <Plus :size="15" />
            </button>
          </div>
        </div>
        <ScrollArea class="session-ai-list" :class="{ 'has-history-entry': !historyMode }">
          <div v-if="!historyMode" class="session-ai-list-content">
            <section
              v-for="group in displayedSessionGroups"
              :key="group.key"
              class="session-ai-path-group"
              :class="{ 'is-compact-list': sessionListLayout === 'list' }"
              :data-collapsed="groupSessionsByPath && collapsedPathGroups[group.key] ? 'true' : undefined"
            >
              <AiSessionPathGroupContextMenu
                v-if="groupSessionsByPath"
                :can-open="canOpenPathGroupFolder"
                :can-rename="canRenamePathGroup(group)"
                @open="openPathGroupFolder(group)"
                @rename="openPathGroupRename(group)"
              >
                <div class="session-ai-path-group-head">
                  <button
                    type="button"
                    class="session-ai-path-group-toggle"
                    :aria-expanded="!collapsedPathGroups[group.key]"
                    @click="togglePathGroup(group.key)"
                  >
                    <Folder v-if="collapsedPathGroups[group.key]" class="session-ai-path-group-icon" :size="15" />
                    <FolderOpen v-else class="session-ai-path-group-icon" :size="15" />
                    <span class="session-ai-path-group-text">
                      <TooltipProvider :delay-duration="120">
                        <Tooltip>
                          <TooltipTrigger as-child>
                            <span class="session-ai-path-group-title">{{ group.label }}</span>
                          </TooltipTrigger>
                          <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ group.path }}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </span>
                  </button>
                  <button
                    type="button"
                    class="session-ai-path-group-add"
                    :aria-label="`${t('sessions.panel.newSession')} · ${group.label}`"
                    :title="t('sessions.panel.newSession')"
                    @click="openNewSessionForGroup(group)"
                  >
                    <Plus :size="15" />
                  </button>
                </div>
              </AiSessionPathGroupContextMenu>
              <Transition name="session-ai-path-group-collapse">
                <div
                  v-if="!groupSessionsByPath || !collapsedPathGroups[group.key]"
                  class="session-ai-path-group-collapse"
                  :class="{ 'is-grouped': groupSessionsByPath }"
                >
                  <div class="session-ai-path-group-collapse-content">
                    <ContextMenu
                  v-for="session in group.sessions"
                  :key="session.id"
                >
                  <ContextMenuTrigger as-child>
                <button
                  v-if="sessionListLayout === 'list'"
                  type="button"
                  class="session-ai-compact-row"
                  :class="{ 'is-grouped': groupSessionsByPath }"
                  :data-state="session.status"
                  :data-selected="selectedListSessionId === session.id"
                  :data-unread="session.unread ? 'true' : undefined"
                  @click="selectSession(session.id)"
                  @mouseenter="showSessionListPreview($event, session)"
                  @pointermove="showSessionListPreview($event, session)"
                  @mouseleave="scheduleSessionListPreviewClose"
                  @focusin="showSessionListPreview($event, session)"
                  @focusout="scheduleSessionListPreviewClose"
                >
                  <AiSessionStatusIndicator :status="session.status" size="compact" />
                  <span class="session-ai-compact-title">{{ displayAiSessionTitle(session, latestPromptIndex(session), t) }}</span>
                  <span v-if="session.unread" class="session-ai-compact-unread" :aria-label="t('sessions.actions.unread')" :title="t('sessions.actions.unread')" />
                </button>
                <article
                  v-else
                  v-ai-session-card-auto-scroll="{ target: '.session-ai-preview-field-assistant', revision: `${session.id}:${latestPromptIndex(session)}` }"
                  class="session-ai-row"
                  :data-state="session.status"
                  :data-selected="selectedListSessionId === session.id"
                  :data-unread="session.unread ? 'true' : undefined"
                  :data-app-session-origin="session.creationSource === 'app-session' ? 'true' : undefined"
                >
                <span v-if="session.unread" class="ai-session-unread-dot" :aria-label="t('sessions.actions.unread')" :title="t('sessions.actions.unread')" />
                <AiSessionCardMarks :agent="session.agent" :creation-source="session.creationSource" />
                <div
                  class="session-ai-select"
                  role="button"
                  tabindex="0"
                  @click="selectSession(session.id)"
                  @keydown.enter.prevent="selectSession(session.id)"
                  @keydown.space.prevent="selectSession(session.id)"
                >
                  <div class="session-ai-state">
                    <AiSessionStatusIndicator :status="session.status" />
                    <span class="session-ai-state-line">
                      <strong>{{ aiSessionAppDisplayName(aiSessionAppTab(instance, session), session.agent, t) }}</strong>
                      <span v-if="!groupSessionsByPath" class="session-ai-card-workspace">
                        <span aria-hidden="true">·</span>
                        <TooltipProvider :delay-duration="120">
                          <Tooltip>
                            <TooltipTrigger as-child>
                              <b>{{ aiSessionBasename(session.cwd) || t("sessions.board.unknownFolder") }}</b>
                            </TooltipTrigger>
                            <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ session.cwd || t("sessions.board.unknownPath") }}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </span>
                    </span>
                  </div>
                  <div class="session-ai-preview-field session-ai-preview-field-user">
                    <MarkdownContent class="session-ai-question" :content="displayAiSessionTitle(session, latestPromptIndex(session), t)" />
                  </div>
                  <div class="session-ai-preview-field session-ai-preview-field-assistant">
                    <AiSessionStreamingMarkdown
                      class="session-ai-message"
                      :code-tools="markdownCodeTools"
                      :content="displayAiSessionMessage(session, latestPromptIndex(session), t)"
                      :instance-id="instance.id"
                      file-links
                      :is-latest="true"
                      :provider-turn-id="session.activeTurnId"
                      :session-id="session.id"
                      :turn-id="session.latestTurnRef?.id"
                      @open-file="openMarkdownFile(session, $event)"
                    />
                  </div>
                </div>
                <AiSessionToolActivity
                  v-if="!canResolveApproval(session)"
                  class="session-ai-card-activity"
                  :current-tool="session.currentTool"
                  :phase="session.phase"
                  :status="session.status"
                  :summary="session.summary"
                  :tool-calls-since-last-message="session.toolCallsSinceLastMessage"
                />
                <div v-if="canResolveApproval(session)" class="session-ai-card-approval-actions">
                  <button v-if="approvalDecisions(session).includes('allow')" type="button" :disabled="aiSessionActionBusy" :title="t('sessions.actions.allow')" @click.stop="resolveApproval(session, 'allow')">
                    <Check :size="13" />
                    <span>{{ t("sessions.actions.allow") }}</span>
                  </button>
                  <button v-if="approvalDecisions(session).includes('skip')" type="button" :disabled="aiSessionActionBusy" :title="t('sessions.actions.skip')" @click.stop="resolveApproval(session, 'skip')">
                    <Ban :size="13" />
                    <span>{{ t("sessions.actions.skip") }}</span>
                  </button>
                  <button v-if="approvalDecisions(session).includes('deny')" type="button" :disabled="aiSessionActionBusy" :title="t('sessions.actions.deny')" @click.stop="resolveApproval(session, 'deny')">
                    <X :size="13" />
                    <span>{{ t("sessions.actions.deny") }}</span>
                  </button>
                </div>
                </article>
                  </ContextMenuTrigger>
                  <AiSessionCardContextMenu
                    :bound-trigger-count="boundTriggers(session).length"
                    :has-app-session="Boolean(aiSessionAppTab(instance, session))"
                    :can-open-app="Boolean(aiSessionAppTab(instance, session) || session.actions?.openApp)"
                    :can-open-terminal="Boolean(terminalLaunchAppId)"
                    :can-fork="session.actions?.fork === true"
                    :is-forking="forkingAiSessionId === session.id"
                    :is-opening-terminal="launchingApp"
                    :is-stopping-app-session="stoppingAppSessionId === session.id"
                    :is-trigger-bound="(configHash) => isTriggerBound(session, configHash)"
                    :is-trigger-busy="(configHash) => triggerBusyKey === triggerActionKey(session, configHash)"
                    :short-hash="shortHash"
                    :story-target="storyTargetFor(session)"
                    :trigger-templates="triggerTemplates"
                    @close-session="closeSession(session)"
                    @open-app="openSessionApp(session)"
                    @open-terminal="openSessionTerminal(session)"
                    @fork-session="forkSession(session, $event)"
                    @story-assigned="onStoryAssigned"
                    @story-assign-failed="onStoryAssignFailed"
                    @toggle-trigger="toggleTrigger(session, $event)"
                  />
                    </ContextMenu>
                  </div>
                </div>
              </Transition>
            </section>
            <div v-if="!sortedSessions.length" class="session-ai-empty session-ai-filter-empty" role="status">
              <span class="session-ai-empty-icon">
                <MessageSquare :size="17" />
              </span>
              <strong>{{ visibleAiSessions.length ? t("sessions.panel.noMatching") : t("sessions.panel.noConversations") }}</strong>
              <span>{{ visibleAiSessions.length ? t("sessions.panel.tryFilter") : t("sessions.panel.startHint") }}</span>
            </div>
          </div>
          <div v-else class="session-ai-history-list" aria-live="polite">
            <div v-if="historyLoading" class="session-ai-history-state">
              <LoaderCircle class="session-ai-spin" :size="16" />
              <span>{{ t("sessions.panel.loadingHistory") }}</span>
            </div>
            <div v-else-if="historyError" class="session-ai-history-state session-ai-history-error" role="alert">
              <span>{{ historyError }}</span>
              <Button variant="ghost" size="sm" @click="loadHistory">{{ t("sessions.panel.retry") }}</Button>
            </div>
            <p v-else-if="!historyItems.length" class="session-ai-history-state">{{ t("sessions.panel.noHistory") }}</p>
            <template v-else>
              <section v-for="group in displayedHistoryGroups" :key="group.key" class="session-ai-path-group session-ai-history-group">
                <AiSessionPathGroupContextMenu
                  v-if="groupSessionsByPath"
                  :can-open="canOpenPathGroupFolder"
                  :can-rename="canRenamePathGroup(group)"
                  @open="openPathGroupFolder(group)"
                  @rename="openPathGroupRename(group)"
                >
                  <div class="session-ai-path-group-head">
                    <button
                      type="button"
                      class="session-ai-path-group-toggle"
                      :aria-expanded="!collapsedHistoryPathGroups[group.key]"
                      @click="toggleHistoryPathGroup(group.key)"
                    >
                      <Folder v-if="collapsedHistoryPathGroups[group.key]" class="session-ai-path-group-icon" :size="15" />
                      <FolderOpen v-else class="session-ai-path-group-icon" :size="15" />
                      <span class="session-ai-path-group-text">
                        <TooltipProvider :delay-duration="120">
                          <Tooltip>
                            <TooltipTrigger as-child>
                              <span class="session-ai-path-group-title">{{ group.label }}</span>
                            </TooltipTrigger>
                            <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ group.path }}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </span>
                    </button>
                    <button
                      type="button"
                      class="session-ai-path-group-add"
                      :aria-label="`${t('sessions.panel.newSession')} · ${group.label}`"
                      :title="t('sessions.panel.newSession')"
                      @click="openNewSessionForGroup(group)"
                    >
                      <Plus :size="15" />
                    </button>
                  </div>
                </AiSessionPathGroupContextMenu>
                <Transition name="session-ai-path-group-collapse">
                  <div
                    v-if="!groupSessionsByPath || !collapsedHistoryPathGroups[group.key]"
                    class="session-ai-path-group-collapse"
                    :class="{ 'is-grouped': groupSessionsByPath }"
                  >
                    <div class="session-ai-path-group-collapse-content">
                      <article
                    v-for="item in group.items"
                    :key="item.id"
                    class="session-ai-history-row"
                    :data-selected="selectedHistoryId === item.id"
                  >
                    <div
                      class="session-ai-history-select"
                      role="button"
                      tabindex="0"
                      @click="selectHistoryItem(item)"
                      @keydown.enter.prevent="selectHistoryItem(item)"
                      @keydown.space.prevent="selectHistoryItem(item)"
                    >
                      <div class="session-ai-history-row-head">
                        <strong>{{ agentDisplayName(item.agent) }}</strong>
                        <time :datetime="item.lastActiveAt">{{ relativeHistoryTime(item.lastActiveAt) }}</time>
                      </div>
                      <p>{{ historyItemTitle(item) }}</p>
                      <small :title="item.cwd">{{ item.cwd }}</small>
                    </div>
                      </article>
                    </div>
                  </div>
                </Transition>
              </section>
            </template>
          </div>
        </ScrollArea>
        <Button v-if="!historyMode" variant="ghost" class="session-ai-history-entry" @click="enterHistoryMode">
          <History :size="15" />
          <span>{{ t("sessions.panel.viewHistory") }}</span>
          <ChevronRight :size="14" />
        </Button>
        </aside>
        <button
          v-if="compactAiSessionLayout"
          type="button"
          class="session-ai-drawer-resize-handle"
          :aria-label="t('sessions.panel.resizeList')"
          :title="t('sessions.panel.resizeList')"
          @pointerdown="startSidebarResize"
        />
      </component>
      <button
        v-if="!creationOnly && !detailOnly"
        type="button"
        class="session-ai-sidebar-resize-handle"
        :aria-label="t('sessions.panel.resizeList')"
        :title="t('sessions.panel.resizeList')"
        @pointerdown="startSidebarResize"
      />
      <TooltipProvider v-if="!creationOnly && !detailOnly" :delay-duration="120">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="outline"
              size="icon"
              class="session-ai-mobile-list-button"
              :data-open="sessionListOverlayOpen ? 'true' : undefined"
              :aria-label="t('sessions.panel.sessionList')"
              @click="sessionListOverlayOpen = true"
            >
              <PanelLeftOpen :size="16" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" :side-offset="6">{{ t("sessions.panel.sessionList") }}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <section v-if="historyMode" ref="detailEl" class="session-ai-detail session-ai-history-detail">
        <ScrollArea class="session-ai-detail-scroll">
          <div v-if="!selectedHistoryId" class="session-ai-history-detail-state">
            <History :size="20" />
            <strong>{{ t("sessions.panel.selectHistory") }}</strong>
          </div>
          <div v-else-if="historyDetailLoading" class="session-ai-history-detail-state">
            <LoaderCircle class="session-ai-spin" :size="18" />
            <span>{{ t("sessions.panel.loadingHistoryDetail") }}</span>
          </div>
          <div v-else-if="historyDetailError" class="session-ai-history-detail-state session-ai-history-error" role="alert">
            <span>{{ historyDetailError }}</span>
            <Button v-if="selectedHistoryItem" variant="ghost" size="sm" @click="selectHistoryItem(selectedHistoryItem)">{{ t("sessions.panel.retry") }}</Button>
          </div>
          <section v-else-if="historyDetail" class="session-ai-detail-content">
            <div v-if="!detailOnly" class="session-ai-detail-fixed-actions session-ai-detail-head-actions">
              <button
                type="button"
                class="session-ai-history-continue"
                :disabled="resumingHistoryId === historyDetail.item.id"
                :aria-busy="resumingHistoryId === historyDetail.item.id"
                @click="continueHistoryConversation"
              >
                <LoaderCircle
                  v-if="resumingHistoryId === historyDetail.item.id"
                  class="session-ai-spin"
                  :size="14"
                  aria-hidden="true"
                />
                <span>{{ resumingHistoryId === historyDetail.item.id ? t("sessions.actions.forking") : t("sessions.panel.continue") }}</span>
              </button>
            </div>
            <header>
              <div>
                <span>{{ agentDisplayName(historyDetail.item.agent) }}</span>
                <strong>{{ historyItemTitle(historyDetail.item) }}</strong>
              </div>
            </header>
            <div v-if="!historyDetail.turns.length" class="session-ai-history-detail-state">
              <span>{{ t("sessions.panel.noHistoryDetail") }}</span>
            </div>
            <AiSessionTimelineView
              v-else
              :instance-id="instance.id"
              :conversation-session-id="historyDetail.item.id"
              :stored-turns="historyDetail.turns"
              @sticky-user-message-change="timelineStickyUserMessage = $event"
            />
          </section>
        </ScrollArea>
        <article
          v-if="historyDetail && timelineStickyUserMessage"
          class="session-ai-timeline-sticky-prompt"
          aria-hidden="true"
        >
          <MarkdownContent :content="timelineStickyUserMessage.text" :code-tools="markdownCodeTools" />
        </article>
        <template v-if="historyDetail">
          <div class="session-ai-compose-gradient" aria-hidden="true" />
          <AiSessionComposer
            ref="composerEl"
            v-model="historyMessageDraft"
            v-model:attachments="historyMessageAttachments"
            class="session-ai-compose session-ai-history-composer"
            :busy="resumingHistoryId === historyDetail.item.id"
            :can-interrupt="false"
            :provider="historyDetail.item.agent"
            :permission-key="historyAiSessionPermissionKey(instance.id, historyDetail.item.id)"
            :default-permission-mode="instance.config.defaultCodexPermissionMode"
            :max-file-attachment-bytes="instance.config.aiSessionMaxFileAttachmentBytes"
            :placeholder="t('sessions.panel.continueConversation')"
            @run="sendHistoryMessage"
          />
        </template>
      </section>
      <section v-else-if="showNewSession" class="session-ai-detail session-ai-new-detail">
        <div class="session-ai-new-start">
          <h1 v-if="!creationEmbedded" class="session-ai-new-title">{{ t("sessions.panel.startIdea") }}</h1>
          <div class="session-ai-new-dialog" role="group" :aria-label="t('sessions.panel.newSession')">
            <div class="session-ai-new-pills">
              <DropdownMenu v-if="creationInstances && creationInstances.length > 1">
                <DropdownMenuTrigger as-child>
                  <button type="button" class="session-ai-project-pill session-ai-instance-pill" :disabled="newSessionComposerBusy" :title="instance.name">
                    <Server :size="14" />
                    <strong>{{ instance.name }}</strong>
                    <ChevronDown :size="13" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent class="session-ai-project-menu" align="start" :side-offset="8">
                  <DropdownMenuItem v-for="candidate in creationInstances" :key="candidate.id" class="session-ai-project-item" @select="emit('update:creationInstance', candidate.id)">
                    <Server :size="15" />
                    <span class="session-ai-project-folder-copy">
                      <strong>{{ candidate.name }}</strong>
                      <small>{{ instanceStatusLabel(candidate.status) }}</small>
                    </span>
                    <Check v-if="candidate.id === instance.id" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <span v-else-if="creationInstances && creationInstances.length === 1" class="session-ai-project-pill session-ai-instance-pill session-ai-instance-pill--static" :title="instance.name">
                <Server :size="14" />
                <strong>{{ instance.name }}</strong>
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <button type="button" class="session-ai-project-pill" :disabled="newSessionComposerBusy">
                    <Folder :size="14" />
                    <strong>{{ newSessionProjectLabel }}</strong>
                    <ChevronDown :size="13" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent class="session-ai-project-menu session-ai-project-picker-menu" align="start" :collision-padding="12" :side-offset="8">
                  <input v-model="newSessionFolderQuery" class="session-ai-project-search" :placeholder="t('sessions.panel.searchProjects')" :aria-label="t('sessions.panel.searchProjects')" />
                  <ScrollArea type="auto" :horizontal="false" class="session-ai-project-list">
                    <DropdownMenuItem v-for="folder in filteredNewSessionFolders" :key="folder.id" class="session-ai-project-item session-ai-project-folder-item" @select="newSessionFolderId = folder.id">
                      <Folder :size="15" />
                      <span class="session-ai-project-folder-copy">
                        <strong>{{ folder.name }}</strong>
                        <small>{{ folder.path }}</small>
                      </span>
                      <Check v-if="newSessionFolderId === folder.id" :size="15" />
                    </DropdownMenuItem>
                    <p v-if="!filteredNewSessionFolders.length" class="session-ai-project-empty">{{ t("sessions.panel.noProjects") }}</p>
                  </ScrollArea>
                  <template v-if="instance.source.type === 'local-folder'">
                    <DropdownMenuSeparator />
                    <DropdownMenuItem class="session-ai-project-item" @select="openNewProject"><Plus :size="15" /><span>{{ t("sessions.panel.newProject") }}</span></DropdownMenuItem>
                  </template>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu v-if="newSessionWorkspace?.availability === 'available' && newSessionWorkspace.branches.length">
                <DropdownMenuTrigger as-child>
                  <button type="button" class="session-ai-project-pill" :disabled="newSessionComposerBusy">
                    <GitBranch :size="14" />
                    <strong>{{ newSessionWorkspaceMode === "worktree"
                      ? t("sessions.panel.worktreeMode")
                      : t(creationMode === "preset" ? "sessions.panel.currentBranchMode" : "sessions.panel.currentFolderMode") }}</strong>
                    <ChevronDown :size="13" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent class="session-ai-project-menu" align="start" :side-offset="8">
                  <DropdownMenuItem class="session-ai-project-item" @select="selectNewSessionWorkspaceMode('current-folder')">
                    <Folder :size="14" /><span>{{ t(creationMode === "preset" ? "sessions.panel.currentBranchMode" : "sessions.panel.currentFolderMode") }}</span><Check v-if="newSessionWorkspaceMode === 'current-folder'" :size="15" />
                  </DropdownMenuItem>
                  <DropdownMenuItem class="session-ai-project-item" :disabled="!newSessionWorkspace.branches.some((branch) => branch.worktreeSelectable)" @select="selectNewSessionWorkspaceMode('worktree')">
                    <GitBranch :size="14" /><span>{{ t("sessions.panel.worktreeMode") }}</span><Check v-if="newSessionWorkspaceMode === 'worktree'" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu v-if="newSessionWorkspace?.availability === 'available' && newSessionWorkspace.branches.length && (creationMode !== 'preset' || newSessionWorkspaceMode === 'worktree')">
                <DropdownMenuTrigger as-child>
                  <button type="button" class="session-ai-project-pill" :disabled="newSessionComposerBusy">
                    <GitBranch :size="14" />
                    <strong>{{ newSessionSelectedBranchLabel }}</strong>
                    <ChevronDown :size="13" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent class="session-ai-project-menu session-ai-project-picker-menu" align="start" :collision-padding="12" :side-offset="8">
                  <input v-model="newSessionBranchQuery" class="session-ai-project-search" :placeholder="t('sessions.panel.searchBranches')" :aria-label="t('sessions.panel.searchBranches')" />
                  <ScrollArea type="auto" :horizontal="false" class="session-ai-project-list">
                    <DropdownMenuItem
                      v-for="node in visibleNewSessionBranches"
                      :key="node.id"
                      class="session-ai-project-item session-ai-branch-tree-item"
                      :class="{ 'is-folder': node.kind === 'folder' }"
                      :disabled="node.kind === 'branch' && !newSessionBranchSelectable(node.branch)"
                      :style="newSessionBranchTreeLayout(node.depth)"
                      @select="node.kind === 'folder' ? toggleNewSessionBranchFolder($event, node.id) : selectNewSessionBranch(node.branch)"
                    >
                      <template v-if="node.kind === 'folder'">
                        <i class="session-ai-branch-tree-toggle" aria-hidden="true">
                          <ChevronRight :class="{ expanded: node.expanded }" :size="9" />
                        </i>
                        <FolderOpen v-if="node.expanded" :size="14" />
                        <Folder v-else :size="14" />
                        <span>{{ node.label }}</span><small>{{ node.count }}</small>
                      </template>
                      <template v-else>
                        <i class="session-ai-branch-tree-toggle" aria-hidden="true" />
                        <GitBranch :size="14" /><span :title="node.branch.name">{{ node.label }}</span><small v-if="newSessionBranchDetached(node.branch)">{{ t("sessions.panel.detached") }}</small><Check v-if="newSessionBranch === node.branch.name" :size="15" />
                      </template>
                    </DropdownMenuItem>
                  </ScrollArea>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <button type="button" class="session-ai-app-pill" :disabled="launchingNewSession">
                    <AiAgentIcon :agent="agentIcon(newSessionApp)" :size="14" />
                    <strong>{{ agentDisplayName(newSessionApp) }}</strong>
                    <ChevronDown :size="13" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent class="session-ai-project-menu" align="start" :side-offset="8">
                  <DropdownMenuItem v-for="app in aiSessionLaunchableApps" :key="app.id" class="session-ai-project-item" @select="newSessionApp = app.id">
                    <AiAgentIcon :agent="agentIcon(app.id)" :size="14" />
                    <span>{{ app.label }}</span><Check v-if="newSessionApp === app.id" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <AiSessionComposer
              v-model="newSessionDraft"
              v-model:attachments="messageAttachments"
              v-model:mention-bindings="newSessionMentionBindings"
              class="session-ai-compose session-ai-new-composer"
              :class="{ 'is-loading': creationComposerBusy }"
              :aria-busy="creationComposerBusy"
              :busy="creationComposerBusy"
              :disabled="creationSubmitDisabled || !newSessionFolder || (newSessionWorkspaceLoading && !newSessionWorkspace)"
              :can-interrupt="false"
              :attachments-disabled="creationMode === 'preset'"
              :submit-hidden="creationMode === 'preset'"
              :provider="newSessionApp"
              :model-groups="newSessionModelGroups"
              :model-selection="newSessionModelSelection"
              :reasoning-effort="newSessionReasoningEffort"
              :reasoning-effort-enabled="newSessionReasoningEffortCapability.selectAtCreate"
              :permission-mode="newSessionPermissionMode"
              :default-permission-mode="instance.config.defaultCodexPermissionMode"
              :max-file-attachment-bytes="instance.config.aiSessionMaxFileAttachmentBytes"
              :placeholder="t('sessions.panel.promptPlaceholder')"
              @update:permission-mode="updateNewSessionPermissionMode"
              @select-model="newSessionModelSelection = $event"
              @select-reasoning-effort="newSessionReasoningEffort = $event"
              @run="createNewSession"
            />
          </div>
        </div>
      </section>
      <section v-else-if="selectedSession" ref="detailEl" class="session-ai-detail" :class="{ 'is-scrolled': detailScrolled }">
        <ScrollArea class="session-ai-detail-scroll">
          <section class="session-ai-detail-content" :class="{ 'is-following-latest': isFollowingLatest && !isSmoothFollowingLatest }">
          <div ref="detailActionsEl" class="session-ai-detail-fixed-actions session-ai-detail-head-actions">
            <AiSessionTurnNavigator
              v-if="effectiveTimelineViewMode === 'compact'"
              :count="promptCount(selectedSession)"
              :index="promptIndexFor(selectedSession)"
              :aria-label="t('sessions.composer.navigation')"
              :previous-label="t('sessions.actions.previousMessage', { agent: selectedSession.agent })"
              :next-label="t('sessions.actions.nextMessage', { agent: selectedSession.agent })"
              @previous="previousPrompt(selectedSession)"
              @next="nextPrompt(selectedSession)"
            />
            <template v-if="!compactAiSessionLayout">
              <RepositoryEnvironment
                :ai-agent="repositoryAiAgent"
                :connection-status="instance.connectionStatus"
                :instance-id="instance.id"
                :session-id="selectedSession.id"
                session-kind="ai-session"
                trigger-appearance="detail"
                @open-workspace="emit('openRepositoryWorkspace', $event)"
              />
              <TooltipProvider :delay-duration="120">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <button type="button" :title="t('sessions.detail.sessionDetails')" :aria-label="t('sessions.detail.sessionDetails')">
                      <CircleHelp :size="15" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent class="session-ai-info-tooltip" align="end" side="bottom" :side-offset="8">
                    <dl>
                      <div><dt>{{ t("sessions.detail.workspace") }}</dt><dd>{{ selectedSession.cwd || t("sessions.detail.unknown") }}</dd></div>
                      <div><dt>{{ t("sessions.detail.session") }}</dt><dd>{{ selectedSession.providerSessionId || selectedSession.id }}</dd></div>
                      <div><dt>{{ t("sessions.detail.appBinding") }}</dt><dd>{{ selectedSession.appSessionId || t("sessions.detail.notBound") }}</dd></div>
                      <div v-if="selectedSession.lineage?.kind === 'fork'"><dt>{{ t("sessions.detail.forkedFrom") }}</dt><dd>{{ parentSessionLabel(selectedSession) }}</dd></div>
                    </dl>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </template>
            <DropdownMenu :modal="false">
              <DropdownMenuTrigger as-child>
                <button type="button" :aria-label="t('sessions.actions.more')">
                  <MoreHorizontal :size="16" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="session-ai-detail-actions-menu" align="end" :side-offset="8" @interact-outside="keepCompactActionsMenuOpenForRepository">
                <template v-if="supportsAiSessionTimeline">
                  <ToggleGroup
                    class="session-ai-detail-actions-view-mode"
                    type="single"
                    :model-value="effectiveTimelineViewMode"
                    :aria-label="t('sessions.timeline.viewMode')"
                    @update:model-value="setTimelineViewMode"
                  >
                    <ToggleGroupItem value="compact" size="sm">{{ t("sessions.timeline.compact") }}</ToggleGroupItem>
                    <ToggleGroupItem value="full" size="sm">{{ t("sessions.timeline.full") }}</ToggleGroupItem>
                  </ToggleGroup>
                  <DropdownMenuSeparator />
                </template>
                <RepositoryEnvironment
                  v-if="compactAiSessionLayout"
                  :ai-agent="repositoryAiAgent"
                  :connection-status="instance.connectionStatus"
                  :instance-id="instance.id"
                  :session-id="selectedSession.id"
                  session-kind="ai-session"
                  trigger-appearance="menu"
                  @open-workspace="emit('openRepositoryWorkspace', $event)"
                />
                <DropdownMenuSub v-if="compactAiSessionLayout">
                  <DropdownMenuSubTrigger class="session-ai-detail-actions-menu-item">
                    <CircleHelp :size="14" />
                    <span>{{ t("sessions.detail.sessionDetails") }}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent class="session-ai-detail-info-menu">
                    <dl>
                      <div><dt>{{ t("sessions.detail.workspace") }}</dt><dd>{{ selectedSession.cwd || t("sessions.detail.unknown") }}</dd></div>
                      <div><dt>{{ t("sessions.detail.session") }}</dt><dd>{{ selectedSession.providerSessionId || selectedSession.id }}</dd></div>
                      <div><dt>{{ t("sessions.detail.appBinding") }}</dt><dd>{{ selectedSession.appSessionId || t("sessions.detail.notBound") }}</dd></div>
                      <div v-if="selectedSession.lineage?.kind === 'fork'"><dt>{{ t("sessions.detail.forkedFrom") }}</dt><dd>{{ parentSessionLabel(selectedSession) }}</dd></div>
                    </dl>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem
                  v-if="aiSessionAppTab(instance, selectedSession) || selectedSession.actions?.openApp"
                  class="session-ai-detail-actions-menu-item"
                  :disabled="openingAiSessionId === selectedSession.id"
                  @select="openSessionApp(selectedSession)"
                >
                  <ExternalLink :size="14" />
                  <span>{{ t("sessions.actions.openApp") }}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="terminalLaunchAppId"
                  class="session-ai-detail-actions-menu-item"
                  :disabled="launchingApp"
                  @select="openSessionTerminal(selectedSession)"
                >
                  <SquareTerminal :size="14" />
                  <span>{{ t("sessions.actions.openTerminal") }}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="selectedForkTurn"
                  class="session-ai-detail-actions-menu-item"
                  :disabled="forkingAiSessionId === selectedSession.id"
                  @select="forkSession(selectedSession, 'current', selectedForkTurn.id)"
                >
                  <Split :size="14" />
                  <span>{{ t("sessions.actions.continueFromTurn") }}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem class="session-ai-detail-actions-menu-item danger" :disabled="stoppingAppSessionId === selectedSession.id" @select="closeSession(selectedSession)">
                  <Square :size="14" />
                  <span>{{ t("sessions.actions.closeSession") }}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <header ref="detailHeaderEl">
            <TooltipProvider :delay-duration="120">
              <div class="session-ai-detail-context">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span class="session-ai-detail-context-item">
                      <Folder :size="14" aria-hidden="true" />
                      <span>{{ selectedSessionFolderName }}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ selectedSessionFolderPath }}</TooltipContent>
                </Tooltip>
                <span class="session-ai-detail-context-separator" aria-hidden="true">·</span>
                <span>{{ aiSessionStatusLabel(selectedSession, t) }}</span>
                <span class="session-ai-detail-context-separator" aria-hidden="true">·</span>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span class="session-ai-detail-context-item">
                      <Boxes :size="14" aria-hidden="true" />
                      <span>{{ selectedSessionInstanceName }}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ selectedSessionNodeName }}</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
            <div v-if="effectiveTimelineViewMode === 'compact'" class="session-ai-detail-prompt-stage">
              <Transition name="session-ai-prompt-fade" appear>
                <section :key="selectedSession.id" ref="detailPromptSectionEl" class="session-ai-detail-block session-ai-detail-block-user">
                  <AiSessionCompactPrompt
                    :code-tools="markdownCodeTools"
                    :content="selectedSessionContentState === 'ready' ? displayAiSessionTitle(selectedConversationSession || selectedSession, promptIndexFor(selectedSession), t) : ''"
                    :timestamp="selectedPromptTimestamp"
                  />
                </section>
              </Transition>
            </div>
          </header>
          <AiSessionConversationContent
            :class="{ 'session-ai-timeline-state': effectiveTimelineViewMode === 'full' }"
            :busy="aiSessionActionBusy"
            :can-interrupt="canInterrupt(selectedSession)"
            :can-resolve-approval="canResolveApproval(selectedSession)"
            :approval-decisions="approvalDecisions(selectedSession)"
            :instance-id="instance.id"
            :detail-state="selectedSessionContentState"
            file-links
            :mode="effectiveTimelineViewMode"
            :prompt-count="promptCount(selectedSession)"
            :prompt-index="promptIndexFor(selectedSession)"
            :session="selectedConversationSession || selectedSession"
            :selected-turn-state="selectedTurnTimelineState"
            :turn-bodies-ready="selectedSessionTurnsReady"
            :turn-timelines="conversationTurnTimelines"
            activity-interactive
            @layout-will-change="beginDetailLayoutAnchor"
            @layout-committed="commitDetailLayoutAnchor"
            @retry-detail="loadSelectedSessionDetail"
            @load-turn-timeline="loadTurnTimeline"
            @edit-queued-message="editQueuedMessage(selectedSession.id, $event)"
            @open-file="openMarkdownFile(selectedSession, $event)"
            @steer-queued-message="steerQueuedMessage(selectedSession.id, $event)"
            @retry-queued-message="retryQueuedMessage(selectedSession.id, $event)"
            @remove-queued-message="removeQueuedMessage(selectedSession.id, $event)"
            @reorder-queued-messages="reorderQueuedMessages(selectedSession.id, $event)"
            @resolve-approval="resolveSelectedApproval"
            @sticky-user-message-change="timelineStickyUserMessage = $event"
            @transitioning-change="setDetailConversationTransitioning"
            @continue-from-turn="forkSession(selectedSession, 'current', $event)"
            @save-as-preset="saveTurnAsPresetAction"
          />
          <span ref="detailBottomAnchorEl" class="session-ai-detail-bottom-anchor" aria-hidden="true" />
          </section>
        </ScrollArea>
        <article
          v-if="effectiveTimelineViewMode === 'full' && timelineStickyUserMessage"
          class="session-ai-timeline-sticky-prompt"
          aria-hidden="true"
        >
          <MarkdownContent :content="timelineStickyUserMessage.text" :code-tools="markdownCodeTools" />
        </article>
        <article
          v-else-if="effectiveTimelineViewMode === 'compact' && detailScrolled && !detailConversationTransitioning"
          class="session-ai-timeline-sticky-prompt"
          aria-hidden="true"
        >
          <MarkdownContent
            v-if="selectedSessionContentState === 'ready'"
            :content="displayAiSessionTitle(selectedConversationSession || selectedSession, promptIndexFor(selectedSession), t)"
            :code-tools="markdownCodeTools"
          />
        </article>
        <Button
          v-if="detailCanScroll && !isFollowingLatest"
          class="session-ai-follow-latest"
          size="icon-sm"
          variant="ghost"
          :aria-label="t('sessions.panel.backLatest')"
          :title="t('sessions.panel.backLatest')"
          @click="followLatest"
        >
          <ChevronDown :size="17" />
        </Button>
        <div class="session-ai-compose-gradient" aria-hidden="true" />
        <AiSessionComposer
          ref="composerEl"
          v-model="messageDraft"
          v-model:attachments="messageAttachments"
          v-model:mention-bindings="messageMentionBindings"
          class="session-ai-compose"
          :busy="aiSessionActionBusy"
          :can-interrupt="canInterrupt(selectedSession)"
          :provider="selectedSession.agent"
          :model-groups="selectedSessionModelGroups"
          :model-selection="selectedSessionModelDisplay"
          :model-selection-pending="modelSelectionPendingSessionId === selectedSession.id"
          :reasoning-effort="selectedSession.reasoningEffort || (selectedSession.agent === 'codex' ? AI_SESSION_DEFAULT_REASONING_EFFORT : undefined)"
          :reasoning-effort-enabled="selectedSessionReasoningEffortCapability.updateDuringSession"
          :reasoning-effort-pending="reasoningEffortPending?.sessionId === selectedSession.id"
          :permission-key="aiSessionPermissionKey(instance.id, selectedSession.id)"
          :default-permission-mode="instance.config.defaultCodexPermissionMode"
          :max-file-attachment-bytes="instance.config.aiSessionMaxFileAttachmentBytes"
          :mention-context="mentionContext"
          :mention-trigger="mentionTrigger"
          :command-trigger="commandTrigger"
          :editing-label="queueComposerEdit ? t('sessions.composer.editingQueuedMessage') : undefined"
          :session-busy="selectedSession?.status === 'running' || selectedSession?.status === 'waiting'"
          @cancel-edit="cancelQueueComposerEdit"
          @command="executeSelectedSessionCommand"
          @run="runSelectedSessionAction"
          @select-model="selectExistingSessionModel"
          @select-reasoning-effort="selectExistingSessionReasoningEffort"
          @steer="steerMessageDraft"
        />
      </section>
    </div>
    </Sheet>
    <Teleport to="body">
      <Transition name="session-ai-list-preview">
        <article
          v-if="sessionListPreviewVisible && sessionListPreviewSession"
          v-ai-session-card-auto-scroll="{ target: '.session-ai-preview-field-assistant', revision: `${sessionListPreviewSession.id}:${latestPromptIndex(sessionListPreviewSession)}` }"
          class="session-ai-row session-ai-list-hover-card"
          :data-state="sessionListPreviewSession.status"
          :data-unread="sessionListPreviewSession.unread ? 'true' : undefined"
          :data-app-session-origin="sessionListPreviewSession.creationSource === 'app-session' ? 'true' : undefined"
          :style="sessionListPreviewStyle"
          :aria-label="displayAiSessionTitle(sessionListPreviewSession, latestPromptIndex(sessionListPreviewSession), t)"
          role="dialog"
          @mouseenter="cancelSessionListPreviewClose"
          @mouseleave="scheduleSessionListPreviewClose"
        >
          <span v-if="sessionListPreviewSession.unread" class="ai-session-unread-dot" :aria-label="t('sessions.actions.unread')" :title="t('sessions.actions.unread')" />
          <AiSessionCardMarks :agent="sessionListPreviewSession.agent" :creation-source="sessionListPreviewSession.creationSource" />
          <div
            class="session-ai-select"
            role="button"
            tabindex="0"
            @click="selectSession(sessionListPreviewSession.id)"
            @keydown.enter.prevent="selectSession(sessionListPreviewSession.id)"
            @keydown.space.prevent="selectSession(sessionListPreviewSession.id)"
          >
            <div class="session-ai-state">
              <AiSessionStatusIndicator :status="sessionListPreviewSession.status" />
              <span class="session-ai-state-line">
                <strong>{{ aiSessionAppDisplayName(aiSessionAppTab(instance, sessionListPreviewSession), sessionListPreviewSession.agent, t) }}</strong>
                <span class="session-ai-card-workspace">
                  <span aria-hidden="true">·</span>
                  <b>{{ aiSessionBasename(sessionListPreviewSession.cwd) || t("sessions.board.unknownFolder") }}</b>
                </span>
              </span>
            </div>
            <div class="session-ai-preview-field session-ai-preview-field-user">
              <MarkdownContent class="session-ai-question" :content="displayAiSessionTitle(sessionListPreviewSession, latestPromptIndex(sessionListPreviewSession), t)" />
            </div>
            <div class="session-ai-preview-field session-ai-preview-field-assistant">
              <AiSessionStreamingMarkdown
                class="session-ai-message"
                :code-tools="markdownCodeTools"
                :content="displayAiSessionMessage(sessionListPreviewSession, latestPromptIndex(sessionListPreviewSession), t)"
                :instance-id="instance.id"
                file-links
                :is-latest="true"
                :provider-turn-id="sessionListPreviewSession.activeTurnId"
                :session-id="sessionListPreviewSession.id"
                :turn-id="sessionListPreviewSession.latestTurnRef?.id"
                @open-file="openMarkdownFile(sessionListPreviewSession, $event)"
              />
            </div>
          </div>
          <AiSessionToolActivity
            v-if="!canResolveApproval(sessionListPreviewSession)"
            class="session-ai-card-activity"
            :current-tool="sessionListPreviewSession.currentTool"
            :phase="sessionListPreviewSession.phase"
            :status="sessionListPreviewSession.status"
            :summary="sessionListPreviewSession.summary"
            :tool-calls-since-last-message="sessionListPreviewSession.toolCallsSinceLastMessage"
          />
          <div v-if="canResolveApproval(sessionListPreviewSession)" class="session-ai-card-approval-actions">
            <button v-if="approvalDecisions(sessionListPreviewSession).includes('allow')" type="button" :disabled="aiSessionActionBusy" :title="t('sessions.actions.allow')" @click.stop="resolveApproval(sessionListPreviewSession, 'allow')">
              <Check :size="13" />
              <span>{{ t("sessions.actions.allow") }}</span>
            </button>
            <button v-if="approvalDecisions(sessionListPreviewSession).includes('skip')" type="button" :disabled="aiSessionActionBusy" :title="t('sessions.actions.skip')" @click.stop="resolveApproval(sessionListPreviewSession, 'skip')">
              <Ban :size="13" />
              <span>{{ t("sessions.actions.skip") }}</span>
            </button>
            <button v-if="approvalDecisions(sessionListPreviewSession).includes('deny')" type="button" :disabled="aiSessionActionBusy" :title="t('sessions.actions.deny')" @click.stop="resolveApproval(sessionListPreviewSession, 'deny')">
              <X :size="13" />
              <span>{{ t("sessions.actions.deny") }}</span>
            </button>
          </div>
        </article>
      </Transition>
    </Teleport>
    <NodeStorageFolderPickerDialog
      :breadcrumbs="newProjectPicker.breadcrumbs.value"
      :can-confirm="newProjectPicker.canConfirm.value"
      :can-go-up="newProjectPicker.canGoUp.value"
      :current-path="newProjectPicker.currentPath.value"
      :error="newProjectPicker.error.value"
      :loading="newProjectPicker.loading.value"
      :node-name="newProjectPicker.targetNode.value?.name || instance.nodeId"
      :open="newProjectPicker.dialogOpen.value"
      :places="newProjectPicker.places.value"
      :rows="newProjectPicker.rows.value"
      :selected-path="newProjectPicker.selectedPath.value"
      :submit-error="newProjectPicker.submitError.value"
      :submitting="newProjectPicker.submitting.value"
      @confirm="confirmNewProject"
      @navigate="newProjectPicker.navigateTo"
      @refresh="newProjectPicker.refresh"
      @select="newProjectPicker.selectFolder"
      @up="newProjectPicker.goUp"
      @update:open="newProjectPicker.setOpen"
    />
    <Dialog :open="Boolean(pathGroupRenameTarget)" @update:open="setPathGroupRenameOpen">
      <DialogContent class="session-ai-path-rename-dialog">
        <DialogHeader>
          <DialogTitle>{{ t("sessions.panel.renameProject") }}</DialogTitle>
          <DialogDescription>{{ t("sessions.panel.renameProjectDescription") }}</DialogDescription>
        </DialogHeader>
        <form class="session-ai-path-rename-form" @submit.prevent="submitPathGroupRename">
          <label for="session-path-group-name">{{ t("sessions.panel.projectName") }}</label>
          <ControlPlaneInput
            id="session-path-group-name"
            v-model="pathGroupRenameDraft"
            :maxlength="160"
            :disabled="renamingPathGroup"
            autofocus
          />
          <code v-if="pathGroupRenameTarget">{{ pathGroupRenameTarget.path }}</code>
          <DialogFooter>
            <Button type="button" variant="outline" :disabled="renamingPathGroup" @click="setPathGroupRenameOpen(false)">{{ t("common.actions.cancel") }}</Button>
            <Button type="submit" :disabled="!canSubmitPathGroupRename">{{ t("common.actions.save") }}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog :open="Boolean(newSessionBranchSwitchTarget)" @update:open="(open) => !open && (newSessionBranchSwitchTarget = undefined)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t("sessions.panel.switchBranchTitle") }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t("sessions.panel.switchBranchDescription", { branch: newSessionBranchSwitchTarget?.name }) }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel>
          <AlertDialogAction @click="confirmNewSessionBranchSwitch">{{ t("sessions.panel.confirmBranchSwitch") }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog :open="Boolean(pendingBusyFork)" @update:open="(open) => !open && (pendingBusyFork = undefined)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t("sessions.actions.forkBusyTitle") }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t("sessions.actions.forkBusyDescription") }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel>
          <AlertDialogAction @click="confirmBusyFork">{{ t("sessions.actions.forkConfirm") }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <StoryPresetActionDialog
      :open="presetSaveOpen"
      :stories="presetSaveStories"
      :instances="presetSaveInstances"
      :local-folders-by-instance-id="presetSaveFoldersByInstanceId"
      :initial="presetSaveInitial"
      @update:open="presetSaveOpen = $event"
      @saved="handlePresetSaved"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type CSSProperties } from "vue";
import { useElementBounding, useMediaQuery } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { formatRelativeTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import { translateApiError } from "../../../i18n/apiError";
import { waitForAiSessionProjection } from "../ai-session-projection";
import { ArrowLeft, Ban, Boxes, Check, ChevronDown, ChevronRight, CircleHelp, ExternalLink, Filter, Folder, FolderOpen, GitBranch, History, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeftOpen, Plus, Server, SlidersHorizontal, Split, Square, SquareTerminal, X } from "@lucide/vue";
import { instanceStatusKeys, translateStatus } from "../../../i18n/status";
import { useQueryClient } from "@tanstack/vue-query";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import AiSessionCardContextMenu from "../../../components/ai-session/AiSessionCardContextMenu.vue";
import AiSessionCardMarks from "../../../components/ai-session/AiSessionCardMarks.vue";
import AiSessionStatusIndicator from "../../../components/ai-session/AiSessionStatusIndicator.vue";
import AiAgentIcon from "../../../components/AiAgentIcon.vue";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { bindAiSessionTrigger, closeAiSession, createAiSession, createNodeLocalFolder, editAiSessionQueuedMessage, forkAiSession, getAiSessionHistory, getAiSessionHistoryDetail, getAiSessionWorkspace, interruptAiSession, listNodeFolderPlaces, listNodeFolderTree, markAiSessionRead, openAiSessionApp, removeAiSessionQueuedMessage, reorderAiSessionQueuedMessages, resolveAiSessionApproval, resumeAiSession, retryAiSessionQueuedMessage, sendAiSessionMessage, steerAiSessionQueuedMessage, unbindAiSessionTrigger, updateAiSessionModelSelection, updateAiSessionReasoningEffort, updateControlledInstance, updateNodeLocalFolder, uploadAiSessionAttachment, useControlPlaneSettingsQuery, useControlPlaneTriggersQuery, useModelsQuery, useStoriesQuery } from "../../../api/queries";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { executeAiSessionCommand } from "../../../api/ai-session-commands";
import { AI_SESSION_DEFAULT_REASONING_EFFORT, type AiSessionCommandInput, type AiSessionHistoryDetail, type AiSessionHistoryItem, type AiSessionMessageAttachmentRef, type AiSessionModelSelection, type AiSessionPermissionMode, type AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";
import type { StorySessionPreset } from "@task-handoff/protocol/stories";
import { normalizeAiSessionModelSelectionCapabilities, normalizeAiSessionReasoningEffortCapabilities } from "@task-handoff/protocol/ai-session-provider-capabilities";
import type { RepositoryAiSessionWorkspace, RepositoryAiSessionWorkspaceBranch } from "@task-handoff/protocol/repository";
import { directoryAiSessionProviderCapability } from "@task-handoff/protocol/control-plane-directory";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { aiSessionStoryTarget, type AiSessionStoryTarget } from "../../../components/ai-session/storyTarget";
import type { LaunchableApp } from "../useInstanceSessions";
import { isAiSessionTriggerDeployment, removeInstanceTriggerBinding, upsertInstanceTriggerBinding } from "../instanceTriggerCache.ts";
import AiSessionComposer, { type AiSessionComposerAttachment } from "../../../components/ai-session/AiSessionComposer.vue";
import { uploadAiSessionComposerAttachment } from "../../../components/ai-session/attachmentUpload";
import AiSessionConversationContent from "../../../components/ai-session/AiSessionConversationContent.vue";
import AiSessionCompactPrompt from "../../../components/ai-session/AiSessionCompactPrompt.vue";
import AiSessionStreamingMarkdown from "../../../components/ai-session/AiSessionStreamingMarkdown.vue";
import { vAiSessionCardAutoScroll } from "../../../components/ai-session/aiSessionCardAutoScroll";
import AiSessionToolActivity from "../../../components/ai-session/AiSessionToolActivity.vue";
import { useAiSessionTimelinePresentation } from "../useAiSessionTimelinePresentation";
import { useAiSessionTimelineViewMode } from "../useAiSessionTimelineViewMode";
import { useAiSessionConversationProjection } from "../useAiSessionConversationProjection";
import { useAiSessionMessageDeltaDemand, useAiSessionTimelineDemand } from "../useAiSessionEventDemand";
import AiSessionTimelineView from "../../../components/ai-session/AiSessionTimelineView.vue";
import StoryPresetActionDialog from "../story/StoryPresetActionDialog.vue";
import { referencesForBindings, type AiSessionMentionBinding } from "../../../components/ai-session/mentions";
import { desktopRuntimePathAccess } from "../../../components/ai-session/useAiSessionMentions";
import AiSessionTurnNavigator from "../../../components/ai-session/AiSessionTurnNavigator.vue";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger } from "../../../components/ui/context-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../../../components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import { showControlPlaneToast, showDelayedControlPlaneLoadingToast } from "../useControlPlaneToasts";
import { nativeNodeFolderSelectionResult, nodeLocalFolderDisplayName, nodePathName, relativeNodePathSegments, type NativeNodeFolderPicker } from "../nodePath";
import { filterInstanceCwdFolders, selectableInstanceCwdFolders } from "../shared/instanceCwdFolders";
import NodeStorageFolderPickerDialog from "../settings/NodeStorageFolderPickerDialog.vue";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import { nodeSupportsLocalFolderNameUpdate } from "../../../api/nodeCapabilities";
import { canOpenDesktopLocalPath, openDesktopLocalPath } from "../../../lib/desktopBridge";
import RepositoryEnvironment from "./RepositoryEnvironment.vue";
import AiSessionPathGroupContextMenu from "./AiSessionPathGroupContextMenu.vue";
import { useNodeStorageFolderPicker } from "../settings/useNodeStorageFolderPicker";
import { groupAiSessionEntriesByPath } from "./aiSessionPathGrouping";
import { loadCollapsedAiSessionPathGroups, persistCollapsedAiSessionPathGroups } from "./aiSessionPathGroupCollapse";
import { aiSessionCreationDraftKey, aiSessionMessageText, clearAiSessionDraft, loadAiSessionDraftPayload, persistAiSessionDraftPayload } from "../useAiSessionDraft";
import {
  aiSessionPermissionKey,
  clearAiSessionPermissionMode,
  historyAiSessionPermissionKey,
  loadAiSessionPermissionMode,
  persistAiSessionPermissionMode,
} from "../useAiSessionPermissionMode";
import { createStreamingScrollFollow, distanceFromBottom, STREAMING_SCROLL_FOLLOW_THRESHOLD, type ScrollViewport } from "../../../lib/streaming-scroll-follow";
import { createLayoutScrollAnchor, createUserLayoutChangeGuard } from "../../../lib/layout-scroll-anchor";
import { createBrowserUuid } from "../../../lib/random-id";
import {
  aiSessionStatusGroup as sessionStatusGroup,
  canInterruptAiSession,
  defaultAiSessionModelSelection,
  deriveAiSessionModelGroups,
  isAiSessionApprovalPending,
} from "@task-handoff/control-plane-client";
import {
  aiSessionAppDisplayName,
  aiSessionAppTab,
  aiSessionAppNavigationTarget,
  aiSessionBasename,
  aiSessionLastUserMessageTime,
  aiSessionStatusLabel,
  aiSessionTurns,
  displayAiSessionMessage,
  displayAiSessionResponse,
  displayAiSessionTitle,
  sortedAiSessionsByLastUserMessage,
  type RepositoryWorkspaceTabTarget,
  type SessionTab,
} from "../useInstanceSessions";

export type AiSessionCreationPresetDraft = {
  instanceId: string;
  prompt: string;
  sessionPreset: StorySessionPreset;
};

type SessionStatusFilter = "all" | "active" | "waiting" | "idle" | "problem";
type AiSessionListLayout = "cards" | "list";
type AiSessionPathGroup = {
  key: string;
  path: string;
  cwdFolderId?: string;
  label: string;
  parentLabel: string;
  sessions: AiSessionSummary[];
};
type AiSessionHistoryPathGroup = {
  key: string;
  path: string;
  cwdFolderId?: string;
  label: string;
  parentLabel: string;
  items: AiSessionHistoryItem[];
};

const GROUP_BY_PATH_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-group-by-path";
const GROUP_MODE_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-group-mode";
const SHOW_EMPTY_PATH_GROUPS_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-show-empty-path-groups";
const SORT_BY_STATUS_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-sort-by-status";
const SESSION_LIST_LAYOUT_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-list-layout";
const SIDEBAR_WIDTH_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-sidebar-width";
const SIDEBAR_WIDTH_DEFAULT = 360;
const SIDEBAR_WIDTH_MIN = 260;
const SIDEBAR_WIDTH_MAX = 520;

function storedGroupByPath() {
  return window.localStorage?.getItem(GROUP_BY_PATH_STORAGE_KEY) !== "false";
}

function storedGroupMode(): "none" | "path" | "story" {
  const value = window.localStorage?.getItem(GROUP_MODE_STORAGE_KEY);
  if (value === "none" || value === "story" || value === "path") return value;
  return storedGroupByPath() ? "path" : "none";
}

function storedShowEmptyPathGroups() {
  return window.localStorage?.getItem(SHOW_EMPTY_PATH_GROUPS_STORAGE_KEY) === "true";
}

function storedSortByStatus() {
  return window.localStorage?.getItem(SORT_BY_STATUS_STORAGE_KEY) !== "false";
}

function storedSessionListLayout(): AiSessionListLayout {
  return window.localStorage?.getItem(SESSION_LIST_LAYOUT_STORAGE_KEY) === "list" ? "list" : "cards";
}

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

function storedSidebarWidth() {
  const stored = window.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  const value = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_WIDTH_DEFAULT;
}

const props = defineProps<{
  activeSession: SessionTab;
  chooseProjectFolder?: NativeNodeFolderPicker;
  creationInitialCwd?: string;
  creationInitialCwdFolderId?: string;
  creationInitialPreset?: StorySessionPreset;
  creationInitialPrompt?: string;
  creationEmbedded?: boolean;
  creationMode?: "session" | "preset";
  creationOnly?: boolean;
  creationSubmitDisabled?: boolean;
  creationSubmitting?: boolean;
  creationStoryId?: string;
  creationInstances?: InstanceWithAiSessions[];
  detailOnly?: boolean;
  historyStoryId?: string;
  initialHistoryId?: string;
  initialHistoryMode?: boolean;
  instance: InstanceWithAiSessions;
  launchableApps?: LaunchableApp[];
  launchingApp?: boolean;
  nodeLocalFolders?: NodeLocalFolder[];
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
}>();
const emit = defineEmits<{
  creationPresetSubmit: [draft: AiSessionCreationPresetDraft];
  launchApp: [instance: InstanceBoardItem, appId: string, cwdFolderId?: string, options?: Record<string, unknown>];
  openAiSessionApp: [instance: InstanceBoardItem, session?: AiSessionSummary];
  openRepositoryWorkspace: [target: RepositoryWorkspaceTabTarget];
  selectAiSession: [instanceId: string, sessionId: string];
  sessionCreated: [instanceId: string, sessionId: string];
  "update:creationInstance": [instanceId: string];
  "update:creationSubmitReady": [ready: boolean];
}>();
const { locale, t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));
const instanceStatusLabel = (status: string) => translateStatus(instanceStatusKeys, status, t);

const visibleAiSessions = computed(() => props.instance.aiSessions?.sessions || []);
const sessionListOverlayOpen = ref(false);
const panelEl = ref<HTMLElement | null>(null);
const panelBounds = useElementBounding(panelEl);
const sidebarWidth = ref(storedSidebarWidth());
const sessionListOverlayBackdropStyle = computed<CSSProperties>(() => ({
  top: `${panelBounds.top.value}px`,
  right: `calc(100vw - ${panelBounds.right.value}px)`,
  bottom: `calc(100vh - ${panelBounds.bottom.value}px)`,
  left: `${panelBounds.left.value}px`,
}));
const sessionListOverlayStyle = computed<CSSProperties>(() => ({
  top: `${panelBounds.top.value}px`,
  right: "auto",
  bottom: `calc(100vh - ${panelBounds.bottom.value}px)`,
  left: `${panelBounds.left.value}px`,
  width: `${Math.min(sidebarWidth.value, Math.max(0, panelBounds.width.value - 40))}px`,
  maxWidth: `calc(100vw - ${panelBounds.left.value + 40}px)`,
  height: "auto",
  padding: "0",
}));
const sessionStatusFilter = ref<SessionStatusFilter>("all");
const groupMode = ref<"none" | "path" | "story">(storedGroupMode());
const groupSessionsByPath = computed({
  get: () => groupMode.value !== "none",
  set: (value: boolean) => { groupMode.value = value ? "path" : "none"; },
});
const showEmptyPathGroups = ref(storedShowEmptyPathGroups());
const sortSessionsByStatus = ref(storedSortByStatus());
const sessionListLayout = ref<AiSessionListLayout>(storedSessionListLayout());
const sessionListPreviewSession = ref<AiSessionSummary>();
const sessionListPreviewVisible = ref(false);
const sessionListPreviewPosition = ref({ left: 12, top: 12 });
const sessionListPreviewStyle = computed(() => ({
  left: `${sessionListPreviewPosition.value.left}px`,
  top: `${sessionListPreviewPosition.value.top}px`,
}));
const SESSION_LIST_PREVIEW_DELAY_MS = 1_000;
const SESSION_LIST_PREVIEW_SKIP_DELAY_MS = 800;
const SESSION_LIST_PREVIEW_CLOSE_DELAY_MS = 120;
const SESSION_LIST_PREVIEW_WIDTH = 340;
const SESSION_LIST_PREVIEW_HEIGHT = 162;
let sessionListPreviewOpenTimer: ReturnType<typeof setTimeout> | undefined;
let sessionListPreviewCloseTimer: ReturnType<typeof setTimeout> | undefined;
let sessionListPreviewClosedAt = 0;
const statusFilterOptions = computed(() => {
  const sessions = visibleAiSessions.value;
  return [
    { key: "all", label: t("sessions.panel.allStatuses"), count: sessions.length },
    { key: "active", label: t("sessions.panel.active"), count: sessions.filter((session) => sessionStatusGroup(session) === "active").length },
    { key: "waiting", label: t("sessions.panel.waiting"), count: sessions.filter((session) => sessionStatusGroup(session) === "waiting").length },
    { key: "idle", label: t("sessions.status.idle"), count: sessions.filter((session) => sessionStatusGroup(session) === "idle").length },
    { key: "problem", label: t("sessions.panel.problem"), count: sessions.filter((session) => sessionStatusGroup(session) === "problem").length },
  ] satisfies Array<{ key: SessionStatusFilter; label: string; count: number }>;
});
const selectedStatusFilter = computed(() => statusFilterOptions.value.find((option) => option.key === sessionStatusFilter.value) || statusFilterOptions.value[0]);
const filteredSessions = computed(() => {
  if (sessionStatusFilter.value === "all") {
    return visibleAiSessions.value;
  }
  return visibleAiSessions.value.filter((session) => sessionStatusGroup(session) === sessionStatusFilter.value);
});
const sortedSessions = computed(() => sortedAiSessionsByLastUserMessage(filteredSessions.value, sortSessionsByStatus.value));
const storiesQuery = useStoriesQuery(() => props.instance.nodeId);
const storyTitlesById = computed(() => new Map((storiesQuery.data.value?.stories || []).map((story) => [story.id, story.title])));
const presetSaveOpen = ref(false);
const presetSaveInitial = ref<{
  storyId?: string;
  title?: string;
  promptTemplate?: string;
  targetInstanceId?: string;
  sessionPreset?: StorySessionPreset;
}>({});
const presetSaveStories = computed(() => (storiesQuery.data.value?.stories || []).filter((story) => !story.archivedAt));
const presetSaveInstances = computed(() => {
  const current = { id: props.instance.id, name: props.instance.name };
  const seen = new Set([current.id]);
  const entries = [{ ...current }];
  for (const instance of props.creationInstances || []) {
    if (seen.has(instance.id)) continue;
    seen.add(instance.id);
    entries.push({ id: instance.id, name: instance.name });
  }
  return entries;
});
const presetSaveFoldersByInstanceId = computed(() => ({
  [props.instance.id]: props.nodeLocalFolders || [],
}));

function derivePresetActionTitle(prompt: string) {
  const line = prompt.split(/\n/).find((entry) => entry.trim())?.trim() || "Preset action";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

function saveTurnAsPresetAction(payload: { turnId: string; prompt: string }) {
  const session = selectedConversationSession.value || selectedSession.value;
  if (!session) return;
  const turns = aiSessionTurns(session);
  const turn = turns.find((entry) => entry.id === payload.turnId);
  const prompt = payload.prompt.trim()
    || turn?.userPrompt?.trim()
    || (selectedSession.value && displayAiSessionTitle(session, promptIndexFor(selectedSession.value), t))
    || "";
  const preset: StorySessionPreset = {};
  if (session.agent) preset.agent = session.agent;
  const permission = loadAiSessionPermissionMode(aiSessionPermissionKey(props.instance.id, session.id));
  if (permission) preset.permissionMode = permission;
  if (session.modelSelection) preset.modelSelection = session.modelSelection;
  if (session.reasoningEffort) preset.reasoningEffort = session.reasoningEffort;
  if (session.cwdFolderId) preset.cwdFolderId = session.cwdFolderId;
  presetSaveInitial.value = {
    storyId: session.storyId || props.creationStoryId || "",
    title: derivePresetActionTitle(prompt),
    promptTemplate: prompt,
    targetInstanceId: props.instance.id,
    sessionPreset: Object.keys(preset).length ? preset : undefined,
  };
  presetSaveOpen.value = true;
}

async function handlePresetSaved() {
  showControlPlaneToast(t("sessions.panel.presetSaved"), "success");
  await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.stories(props.instance.nodeId) });
}
const displayedSessionGroups = computed<AiSessionPathGroup[]>(() => groupSessionsByPath.value ? (groupMode.value === "story" ? groupAiSessionsByStory(sortedSessions.value) : groupAiSessionsByPath(sortedSessions.value)) : [{
  key: "all",
  path: "",
  label: "",
  parentLabel: "",
  sessions: sortedSessions.value,
}]);
// Keep the detail selection anchored to the authoritative session set. A status
// transition (for example running -> idle) must not make the selected session
// disappear merely because the sidebar filter changed its membership.
const selectedSession = computed(() => props.selectedAiSession(props.instance, visibleAiSessions.value));
const promptIndexes = ref<Record<string, { index: number; count: number }>>({});
useAiSessionMessageDeltaDemand(computed(() => ({ instanceIds: [props.instance.id] })));
useAiSessionTimelineDemand(computed(() => selectedSession.value ? {
  instanceId: props.instance.id,
  sessionId: selectedSession.value.id,
} : undefined));
const {
  allTurnsReady: selectedSessionTurnsReady,
  conversation: selectedConversationSession,
  loadAllTurns: loadAllSelectedSessionTurns,
  hasCurrentTurn: hasCurrentSelectedSessionTurn,
  hasRenderableTurn: hasRenderableSelectedSessionTurn,
  loadTurn: loadSelectedSessionTurn,
  refresh: loadSelectedSessionDetail,
  state: selectedSessionDetailState,
  turnIndexKey: selectedSessionTurnIndexKey,
} = useAiSessionConversationProjection({ instanceId: () => props.instance.id, summary: selectedSession });
const { setViewMode: persistTimelineViewMode, viewMode: timelineViewMode } = useAiSessionTimelineViewMode();
const {
  conversationTurnTimelines,
  loadSelectedTurnTimeline,
  loadTurnTimeline,
  selectedTurn: selectedTimelineTurn,
  selectedTurnState: selectedTurnTimelineState,
  supportsTimeline: supportsAiSessionTimeline,
} = useAiSessionTimelinePresentation({
  instance: () => props.instance,
  promptIndex: () => selectedSession.value ? promptIndexFor(selectedSession.value) : 0,
  session: selectedConversationSession,
});
const effectiveTimelineViewMode = computed(() => (
  supportsAiSessionTimeline.value
    ? timelineViewMode.value
    : "compact"
));
const selectedSessionContentState = computed(() => {
  if (selectedSessionDetailState.value !== "ready" || effectiveTimelineViewMode.value === "full") {
    return selectedSessionDetailState.value;
  }
  const summary = selectedSession.value;
  const conversation = selectedConversationSession.value;
  if (!summary || !conversation) return "loading";
  const turn = aiSessionTurns(conversation)[promptIndexFor(summary)];
  return !turn || hasRenderableSelectedSessionTurn(turn.id) ? "ready" : "loading";
});
const selectedPromptTimestamp = computed(() => {
  const session = selectedConversationSession.value || selectedSession.value;
  if (!session) return "";
  return aiSessionTurns(session)[promptIndexFor(session)]?.startedAt || session.startedAt;
});
const selectedSessionFolderName = computed(() => {
  const session = selectedSession.value;
  if (!session) return t("sessions.board.unknownFolder");
  const folder = session.cwdFolderId
    ? (props.nodeLocalFolders || []).find((candidate) => candidate.id === session.cwdFolderId)
    : undefined;
  return folder
    ? nodeLocalFolderDisplayName(folder)
    : aiSessionBasename(session.cwd) || t("sessions.board.unknownFolder");
});
const selectedSessionFolderPath = computed(() => {
  const session = selectedSession.value;
  if (!session) return t("sessions.board.unknownPath");
  if (session.cwd) return session.cwd;
  return session.cwdFolderId
    ? (props.nodeLocalFolders || []).find((candidate) => candidate.id === session.cwdFolderId)?.path || t("sessions.board.unknownPath")
    : t("sessions.board.unknownPath");
});
const selectedSessionInstanceName = computed(() => props.instance.name || props.instance.id);
const selectedSessionNodeName = computed(() => props.instance.node?.name || props.instance.nodeId);

async function setTimelineViewMode(value: unknown) {
  if (value !== "compact" && value !== "full") return;
  const enteringFullTimeline = value === "full" && timelineViewMode.value !== "full";
  persistTimelineViewMode(value);
  if (value === "compact") {
    void loadSelectedTurnTimeline();
    return;
  }
  if (!enteringFullTimeline) return;
  await nextTick();
  scrollFollow?.jumpLatest();
  handleDetailScroll();
}

watch(() => ({
  id: selectedSession.value?.id,
  unread: selectedSession.value?.unread,
  updatedAt: selectedSession.value?.updatedAt,
}), (current) => {
  if (current.id && current.unread && current.updatedAt) {
    void markAiSessionRead(props.instance.id, current.id, current.updatedAt).catch(() => undefined);
  }
}, { immediate: true });
const repositoryAiAgent = computed<"codex" | "claude" | "opencode" | undefined>(() => {
  const agent = selectedSession.value?.agent;
  return agent === "codex" || agent === "claude" || agent === "opencode" ? agent : undefined;
});
const compactAiSessionLayout = useMediaQuery("(max-width: 920px)");
const supportsSessionListHoverPreview = useMediaQuery("(hover: hover) and (pointer: fine)");
watch(compactAiSessionLayout, (compact) => {
  if (!compact) sessionListOverlayOpen.value = false;
});
function keepCompactActionsMenuOpenForRepository(event: Event) {
  const originalEvent = (event as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent;
  const target = originalEvent?.target;
  if (target instanceof Element && target.closest(".repository-environment-popover")) event.preventDefault();
}
const newSessionOpen = ref(false);
const initialCreationInstanceId = props.instance.id;
const selectedForkTurn = computed(() => {
  const session = selectedSession.value;
  if (!session || session.actions?.fork !== true) return undefined;
  const turn = aiSessionTurns(session)[promptIndexFor(session)];
  return turn?.status === "completed" && turn.providerTurnId ? turn : undefined;
});
const showNewSession = computed(() => props.creationOnly || newSessionOpen.value || !selectedSession.value);
const selectedListSessionId = computed(() => showNewSession.value ? undefined : selectedSession.value?.id);
const newSessionApp = ref(props.creationMode === "preset" ? props.creationInitialPreset?.agent || "" : "");
const modelsQuery = useModelsQuery();
const newSessionModelSelection = ref<AiSessionModelSelection | undefined>(props.creationMode === "preset" ? props.creationInitialPreset?.modelSelection : undefined);
const modelSelectionPendingSessionId = ref("");
const newSessionReasoningEffort = ref<AiSessionReasoningEffort>(AI_SESSION_DEFAULT_REASONING_EFFORT);
if (props.creationMode === "preset" && props.creationInitialPreset?.reasoningEffort) {
  newSessionReasoningEffort.value = props.creationInitialPreset.reasoningEffort;
}
const reasoningEffortPending = ref<{ sessionId: string; target: AiSessionReasoningEffort }>();
const newSessionModelGroups = computed(() => deriveAiSessionModelGroups({
  entities: modelsQuery.data.value || [],
  assignment: props.instance.modelSelection,
  agent: newSessionApp.value,
  nodeId: props.instance.nodeId,
  mode: "create",
  capability: modelSelectionCapability(newSessionApp.value),
}));
const selectedSessionModelGroups = computed(() => {
  const session = selectedSession.value;
  if (!session) return [];
  return deriveAiSessionModelGroups({
    entities: modelsQuery.data.value || [],
    assignment: props.instance.modelSelection,
    agent: session.agent,
    nodeId: props.instance.nodeId,
    mode: "existing",
    currentSelection: session.modelSelection,
    capability: modelSelectionCapability(session.agent),
  });
});
const selectedSessionModelDisplay = computed(() => {
  const session = selectedSession.value;
  return session?.modelSelection;
});
const newSessionReasoningEffortCapability = computed(() => reasoningEffortCapability(newSessionApp.value));
const selectedSessionReasoningEffortCapability = computed(() => reasoningEffortCapability(selectedSession.value?.agent || ""));
const newSessionFolderId = ref("");
const activeNewSessionDraftKey = ref(aiSessionCreationDraftKey(props.instance.id));
const initialNewSessionDraft = props.creationMode === "preset"
  ? { value: props.creationInitialPrompt || "", bindings: [] }
  : loadAiSessionDraftPayload(activeNewSessionDraftKey.value);
const newSessionDraft = ref(initialNewSessionDraft.value);
const newSessionMentionBindings = ref(initialNewSessionDraft.bindings);
const newSessionFolderQuery = ref("");
const newSessionBranchQuery = ref("");
const collapsedNewSessionBranchFolders = ref(new Set<string>());
const newSessionWorkspace = ref<RepositoryAiSessionWorkspace>();
const newSessionWorkspaceMode = ref<"current-folder" | "worktree">(props.creationMode === "preset" ? props.creationInitialPreset?.gitSelection?.mode || "current-folder" : "current-folder");
const newSessionBranch = ref(props.creationMode === "preset" ? props.creationInitialPreset?.gitSelection?.branch || "" : "");
const newSessionWorkspaceLoading = ref(false);
let newSessionWorkspaceRevision = 0;
const launchingNewSession = ref(false);
const newSessionCreateAttempt = ref<{
  clientRequestId: string;
  fingerprint: string;
  uploadedAttachments?: AiSessionMessageAttachmentRef[];
}>();
const savingNewSessionPermission = ref(false);
const choosingNewSessionFolder = ref(false);
const newSessionPermissionMode = ref<AiSessionPermissionMode>(props.creationMode === "preset"
  ? props.creationInitialPreset?.permissionMode || props.instance.config.defaultCodexPermissionMode
  : props.instance.config.defaultCodexPermissionMode);
const newSessionComposerBusy = computed(() => launchingNewSession.value || savingNewSessionPermission.value || choosingNewSessionFolder.value);
const creationComposerBusy = computed(() => newSessionComposerBusy.value || Boolean(props.creationSubmitting));
const aiSessionLaunchableApps = computed(() => (props.launchableApps || []).filter((app) => app.id === "codex"));
const terminalLaunchAppId = computed(() => ["terminal-tty", "terminal", "gui-terminal"]
  .find((appId) => props.launchableApps?.some((app) => app.id === appId)));

function modelSelectionCapability(agent: string) {
  // Controlled-instance capabilities are wrapped in the public `features` document.
  // Passing the outer record makes the directory helper normalize to unsupported,
  // which silently hides the model picker even when the runtime advertises it.
  return normalizeAiSessionModelSelectionCapabilities(directoryAiSessionProviderCapability(props.instance.capabilities?.features, agent));
}

function reasoningEffortCapability(agent: string) {
  return normalizeAiSessionReasoningEffortCapabilities(directoryAiSessionProviderCapability(props.instance.capabilities?.features, agent));
}

watch(newSessionModelGroups, (groups) => {
  const current = newSessionModelSelection.value;
  if (current && groups.some((group) => group.models.some((model) => model.modelEntityId === current.modelEntityId && model.modelName === current.modelName))) return;
  if (props.creationMode === "preset" && props.instance.id === initialCreationInstanceId && current
    && current.modelEntityId === props.creationInitialPreset?.modelSelection?.modelEntityId
    && current.modelName === props.creationInitialPreset.modelSelection.modelName) return;
  newSessionModelSelection.value = defaultAiSessionModelSelection(groups);
}, { immediate: true });
watch(newSessionReasoningEffortCapability, (capability) => {
  if (!capability.selectAtCreate) newSessionReasoningEffort.value = undefined;
  else if (newSessionApp.value === "codex" && !newSessionReasoningEffort.value) newSessionReasoningEffort.value = AI_SESSION_DEFAULT_REASONING_EFFORT;
}, { immediate: true });
watch(visibleAiSessions, (sessions) => {
  const pending = reasoningEffortPending.value;
  if (pending && sessions.find((session) => session.id === pending.sessionId)?.reasoningEffort === pending.target) {
    reasoningEffortPending.value = undefined;
  }
});
const createdNewSessionFolders = ref<NodeLocalFolder[]>([]);
const pathGroupRenameTarget = ref<NodeLocalFolder>();
const pathGroupRenameDraft = ref("");
const renamingPathGroup = ref(false);
const canSubmitPathGroupRename = computed(() => Boolean(
  pathGroupRenameTarget.value
  && pathGroupRenameDraft.value.trim()
  && pathGroupRenameDraft.value.trim() !== pathGroupRenameTarget.value.name
  && !renamingPathGroup.value,
));
const INSTANCE_WORKSPACE_FOLDER_ID = "__instance_workspace__";
type NewSessionFolderOption = Pick<NodeLocalFolder, "id" | "name" | "path"> & { cwdFolderId?: string };
const newSessionFolders = computed<NewSessionFolderOption[]>(() => {
  const folders = [...(props.nodeLocalFolders || []), ...createdNewSessionFolders.value];
  if (props.instance.source.type !== "local-folder") {
    const workspacePath = props.instance.runtime?.workspacePath || props.instance.workspace.path || "/workspace";
    return [{
      id: INSTANCE_WORKSPACE_FOLDER_ID,
      name: nodePathName(workspacePath),
      path: workspacePath,
    }] satisfies NewSessionFolderOption[];
  }
  return selectableInstanceCwdFolders(props.instance, folders).map((folder) => ({
    id: folder.id,
    cwdFolderId: folder.id,
    name: nodeLocalFolderDisplayName(folder),
    path: folder.path,
  }));
});
async function registerNewSessionFolder(nodeId: string, input: { name: string; path: string }) {
  const folder = await createNodeLocalFolder(nodeId, input);
  createdNewSessionFolders.value = [...createdNewSessionFolders.value, folder];
  newSessionFolderId.value = folder.id;
  return folder;
}

function registeredPathGroupFolder(group: AiSessionPathGroup | AiSessionHistoryPathGroup) {
  if (!group.cwdFolderId) return undefined;
  return [...(props.nodeLocalFolders || []), ...createdNewSessionFolders.value]
    .find((folder) => folder.id === group.cwdFolderId);
}

const canOpenPathGroupFolder = computed(() => desktopRuntimePathAccess(props.instance) === "desktop-local" && canOpenDesktopLocalPath());

function canRenamePathGroup(group: AiSessionPathGroup | AiSessionHistoryPathGroup) {
  return Boolean(registeredPathGroupFolder(group) && nodeSupportsLocalFolderNameUpdate(props.instance.node));
}

async function openPathGroupFolder(group: AiSessionPathGroup | AiSessionHistoryPathGroup) {
  const result = await openDesktopLocalPath(group.path);
  if (!result.ok) showControlPlaneToast(t("sessions.panel.openInFileManagerFailed"));
}

function openPathGroupRename(group: AiSessionPathGroup | AiSessionHistoryPathGroup) {
  const folder = registeredPathGroupFolder(group);
  if (!folder || !nodeSupportsLocalFolderNameUpdate(props.instance.node)) return;
  pathGroupRenameTarget.value = folder;
  pathGroupRenameDraft.value = folder.name;
}

function setPathGroupRenameOpen(open: boolean) {
  if (open || renamingPathGroup.value) return;
  pathGroupRenameTarget.value = undefined;
  pathGroupRenameDraft.value = "";
}

async function submitPathGroupRename() {
  const folder = pathGroupRenameTarget.value;
  const name = pathGroupRenameDraft.value.trim();
  if (!folder || !name || !canSubmitPathGroupRename.value) return;
  renamingPathGroup.value = true;
  let succeeded = false;
  try {
    const updated = await updateNodeLocalFolder(folder.nodeId, folder.id, { name });
    createdNewSessionFolders.value = createdNewSessionFolders.value.map((candidate) => candidate.id === updated.id ? updated : candidate);
    await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodeLocalFolders(folder.nodeId) });
    succeeded = true;
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.renameProjectFailed")));
  } finally {
    renamingPathGroup.value = false;
    if (succeeded) setPathGroupRenameOpen(false);
  }
}
const newProjectPicker = useNodeStorageFolderPicker({
  createFolder: registerNewSessionFolder,
  errorText: (error) => translateApiError(error, t),
  loadFolders: listNodeFolderTree,
  loadPlaces: listNodeFolderPlaces,
  refresh: async () => {
    await queryClient.invalidateQueries({ queryKey: ["control-plane-node-local-folders", props.instance.nodeId] });
  },
});
const filteredNewSessionFolders = computed(() => {
  return filterInstanceCwdFolders(newSessionFolders.value, newSessionFolderQuery.value);
});
const filteredNewSessionBranches = computed(() => {
  const query = newSessionBranchQuery.value.trim().toLowerCase();
  return (newSessionWorkspace.value?.branches || []).filter((branch) => !query || branch.name.toLowerCase().includes(query));
});
type NewSessionBranchTreeFolder = { children: NewSessionBranchTreeNode[]; id: string; kind: "folder"; label: string };
type NewSessionBranchTreeLeaf = { branch: RepositoryAiSessionWorkspaceBranch; id: string; kind: "branch"; label: string };
type NewSessionBranchTreeNode = NewSessionBranchTreeFolder | NewSessionBranchTreeLeaf;
type VisibleNewSessionBranchTreeNode =
  | { count: number; depth: number; expanded: boolean; id: string; kind: "folder"; label: string }
  | { branch: RepositoryAiSessionWorkspaceBranch; depth: number; id: string; kind: "branch"; label: string };
const newSessionBranchTree = computed(() => buildNewSessionBranchTree(filteredNewSessionBranches.value));
const visibleNewSessionBranches = computed(() => flattenNewSessionBranchTree(newSessionBranchTree.value));
const newSessionFolder = computed(() => newSessionFolders.value.find((folder) => folder.id === newSessionFolderId.value));
const creationSubmitReady = computed(() => Boolean(
  !props.creationSubmitDisabled
  && !creationComposerBusy.value
  && newSessionApp.value
  && newSessionFolder.value
  && newSessionDraft.value.trim()
  && (!newSessionWorkspaceLoading.value || newSessionWorkspace.value),
));
watch(creationSubmitReady, (ready) => emit("update:creationSubmitReady", ready), { immediate: true });
const newSessionProjectLabel = computed(() => newSessionFolder.value?.name || t("sessions.panel.chooseProject"));
const newSessionSelectedBranchLabel = computed(() => {
  const selected = newSessionWorkspace.value?.branches.find((branch) => branch.name === newSessionBranch.value);
  if (!selected) return t("sessions.panel.chooseBranch");
  return newSessionBranchDetached(selected)
    ? `${selected.name} (${t("sessions.panel.detached")})`
    : selected.name;
});
const queryClient = useQueryClient();
const sidebarEl = ref<HTMLElement>();
const historyMode = ref(Boolean(props.initialHistoryMode));
const historyItems = ref<AiSessionHistoryItem[]>([]);
const historyLoading = ref(false);
const historyError = ref("");
const selectedHistoryId = ref("");
const historyDetail = ref<AiSessionHistoryDetail>();
const historyDetailLoading = ref(false);
const historyDetailError = ref("");
const resumingHistoryId = ref("");
const historyMessageDraft = ref("");
const historyMessageAttachments = ref<AiSessionComposerAttachment[]>([]);
let currentListScrollTop = 0;
let historyDetailRevision = 0;
let promptSelectionRevision = 0;
const collapsedPathGroups = reactive<Record<string, boolean>>(
  loadCollapsedAiSessionPathGroups(props.instance.id, "current"),
);
const collapsedHistoryPathGroups = reactive<Record<string, boolean>>(
  loadCollapsedAiSessionPathGroups(props.instance.id, "history"),
);
const messageDraft = ref("");
const messageAttachments = ref<AiSessionComposerAttachment[]>([]);
const messageMentionBindings = ref<AiSessionMentionBinding[]>([]);
const queueComposerEdit = ref<{
  queueId: string;
  originalMessage: string;
  previousDraft: string;
  previousAttachments: AiSessionComposerAttachment[];
  previousMentionBindings: AiSessionMentionBinding[];
}>();
const controlPlaneSettings = useControlPlaneSettingsQuery();
const mentionTrigger = computed(() => controlPlaneSettings.data.value?.mentionTrigger || "@");
const commandTrigger = computed(() => controlPlaneSettings.data.value?.commandTrigger || "/");
const mentionContext = computed(() => {
  const session = selectedSession.value;
  if (!session?.cwd) return undefined;
  return {
    instanceId: props.instance.id,
    sessionId: session.id,
    provider: session.agent,
    cwd: session.cwd,
    runtimeType: props.instance.runtime?.type,
    runtimePathAccess: desktopRuntimePathAccess(props.instance),
  };
});
const detailEl = ref<HTMLElement>();
const composerEl = ref<InstanceType<typeof AiSessionComposer>>();
const detailScrolled = ref(false);
const detailConversationTransitioning = ref(false);
const detailHeaderEl = ref<HTMLElement>();
const detailPromptSectionEl = ref<HTMLElement>();
const detailActionsEl = ref<HTMLElement>();
const detailBottomAnchorEl = ref<HTMLElement>();
const timelineStickyUserMessage = ref<{ id: string; text: string }>();
let composerResizeObserver: ResizeObserver | undefined;
let detailActionsResizeObserver: ResizeObserver | undefined;
let detailScrollViewport: HTMLElement | undefined;
let detailScrollLayoutRevision = 0;
let detailScrollLayoutPending = false;
let detailStickyThreshold = 0;
let promptResizeObserver: ResizeObserver | undefined;
let streamingResizeObserver: ResizeObserver | undefined;
let scrollFollow: ReturnType<typeof createStreamingScrollFollow> | undefined;
const userDetailLayoutGuard = createUserLayoutChangeGuard({
  onActiveChange: (active) => {
    detailEl.value?.classList.toggle("is-user-layout-changing", active);
    if (!active) scrollFollow?.handleScroll();
  },
});
const detailLayoutAnchor = createLayoutScrollAnchor(
  () => detailScrollViewport,
  () => detailBottomAnchorEl.value,
  () => !userDetailLayoutGuard.isActive() && scrollFollow?.isFollowing() === true && !scrollFollow.isAutoScrolling(),
);
const isFollowingLatest = ref(true);
const isSmoothFollowingLatest = ref(false);
const detailCanScroll = ref(false);
let sidebarResizeCleanup: (() => void) | undefined;
const aiSessionActionBusy = ref(false);
const stoppingAppSessionId = ref("");
const openingAiSessionId = ref("");
const forkingAiSessionId = ref("");
const forkRequestIds = new Map<string, string>();
const pendingBusyFork = ref<{ session: AiSessionSummary; mode: "current" | "managed-worktree"; throughTurnId?: string }>();
const triggerBusyKey = ref("");
const triggers = useControlPlaneTriggersQuery();
const triggerTemplates = computed(() => triggers.data.value?.triggers || []);

function updateDetailStickyThreshold() {
  if (detailScrolled.value) return;
  const header = detailHeaderEl.value;
  const detail = detailEl.value;
  const viewport = detailScrollViewport;
  if (!header || !detail || !viewport) {
    detailStickyThreshold = 0;
    return;
  }
  const style = window.getComputedStyle(detail);
  const stickyHeaderHeight = [
    "--session-ai-sticky-prompt-height",
    "--session-ai-sticky-padding-top",
    "--session-ai-sticky-padding-bottom",
    "--session-ai-sticky-border-width",
  ].reduce((height, property) => height + (Number.parseFloat(style.getPropertyValue(property)) || 0), 0);
  const expandedDividerOffset = header.getBoundingClientRect().bottom
    - viewport.getBoundingClientRect().top
    + viewport.scrollTop;
  detailStickyThreshold = Math.max(0, Math.ceil(expandedDividerOffset - stickyHeaderHeight));
}

function setDetailConversationTransitioning(transitioning: boolean) {
  detailConversationTransitioning.value = transitioning;
  if (transitioning) {
    detailScrolled.value = false;
    return;
  }
  void nextTick(() => {
    if (detailConversationTransitioning.value || detailScrollLayoutPending) return;
    detailStickyThreshold = 0;
    updateDetailStickyThreshold();
    handleDetailScroll();
  });
}
const workspaceStyle = computed(
  () =>
    ({
      "--session-ai-sidebar-width": `${sidebarWidth.value}px`,
    }) as CSSProperties,
);

function groupAiSessionsByPath(sessions: AiSessionSummary[]) {
  return groupAiSessionEntriesByPath(sessions, showEmptyPathGroups.value ? newSessionFolders.value : [])
    .map((group) => ({
      key: group.key,
      path: aiSessionGroupPath(group.cwdFolderId, group.path),
      cwdFolderId: group.cwdFolderId,
      ...aiSessionGroupLabel(group.cwdFolderId, group.path),
      sessions: group.entries,
    }))
    .sort((a, b) => {
      const messageTimeDelta = groupLastUserMessageTime(b.sessions) - groupLastUserMessageTime(a.sessions);
      return messageTimeDelta || a.key.localeCompare(b.key);
    });
}

function storyGroupLabel(storyId: string | undefined) {
  if (!storyId) return t("sessions.panel.unassignedStory");
  return storyTitlesById.value.get(storyId) || `Story ${storyId}`;
}

function groupAiSessionsByStory(sessions: AiSessionSummary[]) {
  const groups = new Map<string, AiSessionPathGroup>();
  for (const session of sessions) {
    const key = `story:${session.storyId || "unassigned"}`;
    const current = groups.get(key);
    groups.set(key, { key, path: session.storyId || "", label: storyGroupLabel(session.storyId), parentLabel: session.storyId || "", sessions: [...(current?.sessions || []), session] });
  }
  return [...groups.values()];
}

function groupAiSessionHistoryByPath(items: AiSessionHistoryItem[]) {
  return groupAiSessionEntriesByPath(items)
    .map((group) => ({
      key: group.key,
      path: aiSessionGroupPath(group.cwdFolderId, group.path),
      cwdFolderId: group.cwdFolderId,
      ...aiSessionGroupLabel(group.cwdFolderId, group.path),
      items: group.entries,
    }))
    .sort((a, b) => {
      const latestA = Math.max(0, ...a.items.map((item) => Date.parse(item.lastActiveAt) || 0));
      const latestB = Math.max(0, ...b.items.map((item) => Date.parse(item.lastActiveAt) || 0));
      return latestB - latestA || a.key.localeCompare(b.key);
    });
}

function groupAiSessionHistoryByStory(items: AiSessionHistoryItem[]) {
  const groups = new Map<string, AiSessionHistoryPathGroup>();
  for (const item of items) {
    const key = `story:${item.storyId || "unassigned"}`;
    const current = groups.get(key);
    groups.set(key, { key, path: item.storyId || "", label: storyGroupLabel(item.storyId), parentLabel: item.storyId || "", items: [...(current?.items || []), item] });
  }
  return [...groups.values()];
}

const displayedHistoryGroups = computed<AiSessionHistoryPathGroup[]>(() => groupSessionsByPath.value ? (groupMode.value === "story" ? groupAiSessionHistoryByStory(historyItems.value) : groupAiSessionHistoryByPath(historyItems.value)) : [{
  key: "all",
  path: "",
  label: "",
  parentLabel: "",
  items: historyItems.value,
}]);
const selectedHistoryItem = computed(() => historyItems.value.find((item) => item.id === selectedHistoryId.value));

function aiSessionPath(session: AiSessionSummary) {
  return session.cwd?.trim() || "";
}

function aiSessionGroupLabel(cwdFolderId: string | undefined, fallbackPath: string) {
  const folder = cwdFolderId ? newSessionFolders.value.find((candidate) => candidate.id === cwdFolderId) : undefined;
  return folder
    ? { label: folder.name, parentLabel: folder.path }
    : aiSessionPathLabel(fallbackPath);
}

function aiSessionGroupPath(cwdFolderId: string | undefined, fallbackPath: string) {
  return (cwdFolderId ? newSessionFolders.value.find((candidate) => candidate.id === cwdFolderId)?.path : undefined)
    || fallbackPath;
}

function aiSessionPathLabel(path: string) {
  if (!path) {
    return { label: t("sessions.board.unknownPath"), parentLabel: "" };
  }
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index <= 0) {
    return { label: normalized || path, parentLabel: "" };
  }
  return {
    label: normalized.slice(index + 1) || normalized,
    parentLabel: normalized.slice(0, index),
  };
}

function groupLastUserMessageTime(sessions: AiSessionSummary[]) {
  return Math.max(0, ...sessions.map(aiSessionLastUserMessageTime));
}

watch(groupMode, (value) => {
  window.localStorage?.setItem(GROUP_MODE_STORAGE_KEY, value);
  window.localStorage?.setItem(GROUP_BY_PATH_STORAGE_KEY, String(value !== "none"));
});

watch(showEmptyPathGroups, (value) => {
  window.localStorage?.setItem(SHOW_EMPTY_PATH_GROUPS_STORAGE_KEY, String(value));
});

watch(sortSessionsByStatus, (value) => {
  window.localStorage?.setItem(SORT_BY_STATUS_STORAGE_KEY, String(value));
});

watch(sessionListLayout, (value) => {
  window.localStorage?.setItem(SESSION_LIST_LAYOUT_STORAGE_KEY, value);
  closeSessionListPreview();
});

watch([historyMode, supportsSessionListHoverPreview], closeSessionListPreview);

watch(() => props.instance.id, () => {
  historyDetailRevision += 1;
  historyItems.value = [];
  historyError.value = "";
  selectedHistoryId.value = "";
  historyDetail.value = undefined;
  historyDetailError.value = "";
  historyMessageDraft.value = "";
  historyMessageAttachments.value = [];
  replaceCollapsedPathGroups(collapsedPathGroups, loadCollapsedAiSessionPathGroups(props.instance.id, "current"));
  replaceCollapsedPathGroups(collapsedHistoryPathGroups, loadCollapsedAiSessionPathGroups(props.instance.id, "history"));
  if (historyMode.value) void loadHistory();
});

watch(
  [() => props.instance.id, () => props.instance.config.defaultCodexPermissionMode],
  ([, permissionMode]) => {
    if (props.creationMode === "preset" && props.creationInitialPreset?.permissionMode) return;
    newSessionPermissionMode.value = permissionMode;
  },
  { immediate: true },
);

watch(() => props.instance.id, (instanceId) => {
  if (props.creationMode === "preset") return;
  activeNewSessionDraftKey.value = aiSessionCreationDraftKey(instanceId);
  const draft = loadAiSessionDraftPayload(activeNewSessionDraftKey.value);
  newSessionDraft.value = draft.value;
  newSessionMentionBindings.value = draft.bindings;
  messageAttachments.value = [];
  newSessionCreateAttempt.value = undefined;
});

watch([newSessionDraft, newSessionMentionBindings], ([draft, bindings]) => {
  if (props.creationMode === "preset") return;
  persistAiSessionDraftPayload(activeNewSessionDraftKey.value, draft, bindings);
}, { deep: true });

watch(
  [showNewSession, aiSessionLaunchableApps, newSessionFolders],
  ([show]) => {
    if (show) initializeNewSessionDefaults();
  },
  { immediate: true },
);

watch(
  [() => props.instance.id, newSessionFolderId, showNewSession],
  ([instanceId, folderId, show], _previous, onCleanup) => {
    const revision = ++newSessionWorkspaceRevision;
    const initialGitSelection = props.creationMode === "preset" ? props.creationInitialPreset?.gitSelection : undefined;
    newSessionWorkspaceMode.value = initialGitSelection?.mode || "current-folder";
    newSessionBranch.value = initialGitSelection?.branch || "";
    newSessionBranchQuery.value = "";
    if (!show || !folderId) {
      newSessionWorkspace.value = undefined;
      newSessionWorkspaceLoading.value = false;
      return;
    }
    const abort = new AbortController();
    onCleanup(() => abort.abort());
    const cwdFolderId = newSessionFolders.value.find((folder) => folder.id === folderId)?.cwdFolderId;
    const queryKey = controlPlaneQueryKeys.aiSessionWorkspace(instanceId, cwdFolderId);
    const cachedWorkspace = queryClient.getQueryData<RepositoryAiSessionWorkspace>(queryKey);
    newSessionWorkspace.value = cachedWorkspace;
    if (cachedWorkspace) selectDefaultNewSessionBranch(cachedWorkspace);
    newSessionWorkspaceLoading.value = true;
    void getAiSessionWorkspace(instanceId, cwdFolderId, abort.signal)
      .then((workspace) => {
        if (revision !== newSessionWorkspaceRevision) return;
        queryClient.setQueryData(queryKey, workspace);
        newSessionWorkspace.value = workspace;
        const selected = workspace.branches.find((branch) => branch.name === newSessionBranch.value);
        if (!selected || !newSessionBranchSelectable(selected)) selectDefaultNewSessionBranch(workspace);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        // Compatibility for v0.0.21: instances without pre-session repository inspection keep the original cwd-only flow.
        // Keep a cached workspace visible when only the background refresh failed.
      })
      .finally(() => {
        if (revision === newSessionWorkspaceRevision) newSessionWorkspaceLoading.value = false;
      });
  },
  { immediate: true },
);

function selectDefaultNewSessionBranch(workspace: RepositoryAiSessionWorkspace) {
  const selected = workspace.branches.find((branch) => branch.name === newSessionBranch.value);
  if (selected && newSessionBranchSelectable(selected)) return;
  newSessionBranch.value = workspace.currentBranch
    || workspace.branches.find((branch) => branch.current)?.name
    || workspace.branches.find((branch) => branch.currentFolderSelectable)?.name
    || "";
}

function togglePathGroup(key: string) {
  collapsedPathGroups[key] = !collapsedPathGroups[key];
  persistCollapsedAiSessionPathGroups(props.instance.id, "current", collapsedPathGroups);
}

function toggleHistoryPathGroup(key: string) {
  collapsedHistoryPathGroups[key] = !collapsedHistoryPathGroups[key];
  persistCollapsedAiSessionPathGroups(props.instance.id, "history", collapsedHistoryPathGroups);
}

function replaceCollapsedPathGroups(target: Record<string, boolean>, source: Record<string, boolean>) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function stopSidebarResize() {
  sidebarResizeCleanup?.();
  sidebarResizeCleanup = undefined;
  document.body.classList.remove("session-ai-sidebar-resizing");
}

function startSidebarResize(event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  stopSidebarResize();
  const startX = event.clientX;
  const startWidth = sidebarWidth.value;
  const maximumWidth = compactAiSessionLayout.value
    ? Math.min(SIDEBAR_WIDTH_MAX, Math.max(0, panelBounds.width.value - 40))
    : SIDEBAR_WIDTH_MAX;
  const minimumWidth = Math.min(SIDEBAR_WIDTH_MIN, maximumWidth);
  document.body.classList.add("session-ai-sidebar-resizing");
  const handlePointerMove = (moveEvent: PointerEvent) => {
    sidebarWidth.value = Math.min(maximumWidth, Math.max(minimumWidth, Math.round(startWidth + moveEvent.clientX - startX)));
  };
  const handlePointerUp = () => {
    window.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth.value));
    stopSidebarResize();
  };
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp, { once: true });
  window.addEventListener("pointercancel", handlePointerUp, { once: true });
  sidebarResizeCleanup = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  };
}

function promptCount(session: AiSessionSummary) {
  const conversation = selectedConversationSession.value?.id === session.id
    ? selectedConversationSession.value
    : session;
  return conversation.turns ? aiSessionTurns(conversation).length : conversation.turnCount ?? 0;
}

function latestPromptIndex(session: AiSessionSummary) {
  return Math.max(0, promptCount(session) - 1);
}

function promptIndexFor(session: AiSessionSummary) {
  const count = promptCount(session);
  if (!count) {
    return 0;
  }
  const saved = promptIndexes.value[session.id];
  if (!saved) {
    return count - 1;
  }
  const wasFollowingLatest = saved.index >= saved.count - 1;
  if (wasFollowingLatest && count !== saved.count) {
    return count - 1;
  }
  return Math.min(Math.max(saved.index, 0), count - 1);
}

async function setPromptIndex(session: AiSessionSummary, index: number) {
  const count = promptCount(session);
  if (!count) {
    return;
  }
  const targetIndex = Math.min(Math.max(index, 0), count - 1);
  const conversation = selectedConversationSession.value?.id === session.id
    ? selectedConversationSession.value
    : undefined;
  const targetTurn = conversation ? aiSessionTurns(conversation)[targetIndex] : undefined;
  if (targetTurn && !hasCurrentSelectedSessionTurn(targetTurn.id)) {
    const requestRevision = ++promptSelectionRevision;
    const loaded = await loadSelectedSessionTurn(targetTurn.id);
    if (!loaded || requestRevision !== promptSelectionRevision || selectedSession.value?.id !== session.id) return;
  } else {
    promptSelectionRevision += 1;
  }
  promptIndexes.value = {
    ...promptIndexes.value,
    [session.id]: { index: targetIndex, count },
  };
}

function previousPrompt(session: AiSessionSummary) {
  void setPromptIndex(session, promptIndexFor(session) - 1);
}

function nextPrompt(session: AiSessionSummary) {
  void setPromptIndex(session, promptIndexFor(session) + 1);
}

function cancelSessionListPreviewClose() {
  if (!sessionListPreviewCloseTimer) return;
  clearTimeout(sessionListPreviewCloseTimer);
  sessionListPreviewCloseTimer = undefined;
}

function closeSessionListPreview() {
  if (sessionListPreviewOpenTimer) clearTimeout(sessionListPreviewOpenTimer);
  if (sessionListPreviewCloseTimer) clearTimeout(sessionListPreviewCloseTimer);
  sessionListPreviewOpenTimer = undefined;
  sessionListPreviewCloseTimer = undefined;
  if (sessionListPreviewVisible.value) sessionListPreviewClosedAt = Date.now();
  sessionListPreviewVisible.value = false;
}

function scheduleSessionListPreviewClose() {
  if (sessionListPreviewOpenTimer) clearTimeout(sessionListPreviewOpenTimer);
  sessionListPreviewOpenTimer = undefined;
  cancelSessionListPreviewClose();
  sessionListPreviewCloseTimer = setTimeout(closeSessionListPreview, SESSION_LIST_PREVIEW_CLOSE_DELAY_MS);
}

function showSessionListPreview(event: Event, session: AiSessionSummary) {
  if (sessionListLayout.value !== "list" || !supportsSessionListHoverPreview.value || historyMode.value) return;
  if (!(event.currentTarget instanceof HTMLElement)) return;
  cancelSessionListPreviewClose();
  if (sessionListPreviewOpenTimer) clearTimeout(sessionListPreviewOpenTimer);
  const bounds = event.currentTarget.getBoundingClientRect();
  const cardWidth = Math.min(SESSION_LIST_PREVIEW_WIDTH, window.innerWidth - 24);
  const preferredLeft = bounds.right + 8;
  const left = preferredLeft + cardWidth <= window.innerWidth - 12
    ? preferredLeft
    : bounds.left - cardWidth - 8;
  sessionListPreviewPosition.value = {
    left: Math.max(12, Math.min(left, window.innerWidth - cardWidth - 12)),
    top: Math.max(12, Math.min(bounds.top, window.innerHeight - SESSION_LIST_PREVIEW_HEIGHT - 12)),
  };
  sessionListPreviewSession.value = session;
  if (sessionListPreviewVisible.value || Date.now() - sessionListPreviewClosedAt <= SESSION_LIST_PREVIEW_SKIP_DELAY_MS) {
    sessionListPreviewVisible.value = true;
    return;
  }
  sessionListPreviewOpenTimer = setTimeout(() => {
    sessionListPreviewVisible.value = true;
    sessionListPreviewOpenTimer = undefined;
  }, SESSION_LIST_PREVIEW_DELAY_MS);
}

function selectSession(sessionId: string) {
  newSessionOpen.value = false;
  sessionListOverlayOpen.value = false;
  closeSessionListPreview();
  emit("selectAiSession", props.instance.id, sessionId);
}

function sidebarViewport() {
  return sidebarEl.value?.querySelector<HTMLElement>("[data-reka-scroll-area-viewport]");
}

async function enterHistoryMode() {
  currentListScrollTop = sidebarViewport()?.scrollTop || 0;
  historyMode.value = true;
  await loadHistory();
}

async function leaveHistoryMode() {
  historyDetailRevision += 1;
  historyMode.value = false;
  timelineStickyUserMessage.value = undefined;
  historyMessageDraft.value = "";
  historyMessageAttachments.value = [];
  await nextTick();
  const viewport = sidebarViewport();
  if (viewport) viewport.scrollTop = currentListScrollTop;
}

async function loadHistory() {
  if (historyLoading.value) return;
  historyLoading.value = true;
  historyError.value = "";
  try {
    const items = (await getAiSessionHistory(props.instance.id)).items;
    historyItems.value = props.historyStoryId ? items.filter((item) => item.storyId === props.historyStoryId) : items;
    if (selectedHistoryId.value && !historyItems.value.some((item) => item.id === selectedHistoryId.value)) {
      selectedHistoryId.value = "";
      historyDetail.value = undefined;
      historyDetailError.value = "";
    }
  } catch (error) {
    historyError.value = translateApiError(error, t, t("sessions.panel.historyLoadFailed"));
  } finally {
    historyLoading.value = false;
  }
}

async function enterInitialHistoryMode() {
  await enterHistoryMode();
  const initialId = props.initialHistoryId;
  if (!initialId) return;
  const item = historyItems.value.find((candidate) => candidate.id === initialId);
  if (item) await selectHistoryItem(item);
}

async function selectHistoryItem(item: AiSessionHistoryItem) {
  if (resumingHistoryId.value) return;
  sessionListOverlayOpen.value = false;
  timelineStickyUserMessage.value = undefined;
  if (selectedHistoryId.value !== item.id) {
    historyMessageDraft.value = "";
    historyMessageAttachments.value = [];
  }
  const revision = ++historyDetailRevision;
  selectedHistoryId.value = item.id;
  historyDetail.value = undefined;
  historyDetailError.value = "";
  historyDetailLoading.value = true;
  try {
    const detail = await getAiSessionHistoryDetail(props.instance.id, item.id);
    if (revision === historyDetailRevision && historyMode.value && selectedHistoryId.value === item.id) {
      historyDetail.value = detail;
    }
  } catch (error) {
    if (revision === historyDetailRevision && historyMode.value && selectedHistoryId.value === item.id) {
      historyDetailError.value = translateApiError(error, t, t("sessions.panel.historyDetailFailed"));
    }
  } finally {
    if (revision === historyDetailRevision) historyDetailLoading.value = false;
  }
}

function historyItemTitle(item: AiSessionHistoryItem) {
  return item.title?.trim() || item.userPrompt?.trim() || item.lastMessage?.trim() || t("sessions.panel.unnamedConversation");
}

function relativeHistoryTime(value: string) {
  return formatRelativeTime(value, Date.now(), locale.value as SupportedLocale);
}

async function resumeHistorySession(item: AiSessionHistoryItem) {
  const result = await resumeAiSession(props.instance.id, item.id);
  const findAuthoritativeSession = () => visibleAiSessions.value.find((session) => (
    session.id === result.aiSessionId
    && session.providerSessionId === result.providerSessionId
    && session.creationSource === result.creationSource
    && (result.appSessionId ? session.appSessionId === result.appSessionId : !session.appSessionId)
  ));
  const session = await waitForAiSessionProjection(findAuthoritativeSession);
  if (!session) throw new Error(t("sessions.panel.resumePending"));
  return session;
}

async function continueHistoryConversation() {
  const item = historyDetail.value?.item;
  if (!item || resumingHistoryId.value) return;
  resumingHistoryId.value = item.id;
  const loadingToast = showDelayedControlPlaneLoadingToast(t("sessions.actions.forking"));
  try {
    const session = await resumeHistorySession(item);
    emit("selectAiSession", props.instance.id, session.id);
    await leaveHistoryMode();
  } catch (error) {
    loadingToast.dismiss();
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.continueFailed")));
  } finally {
    loadingToast.dismiss();
    resumingHistoryId.value = "";
  }
}

async function sendHistoryMessage(permissionMode?: AiSessionPermissionMode) {
  const item = historyDetail.value?.item;
  const message = historyMessageDraft.value.trim();
  if (!item || resumingHistoryId.value || (!message && !historyMessageAttachments.value.length)) return;
  resumingHistoryId.value = item.id;
  const loadingToast = showDelayedControlPlaneLoadingToast(t("sessions.actions.forking"));
  try {
    const session = await resumeHistorySession(item);
    const attachments = await uploadAttachments(props.instance.id, session.id, historyMessageAttachments.value);
    await sendAiSessionMessage(
      props.instance.id,
      session.id,
      aiSessionMessageText(message),
      undefined,
      attachments,
      [],
      permissionMode,
    );
    if (permissionMode) {
      persistAiSessionPermissionMode(aiSessionPermissionKey(props.instance.id, session.id), permissionMode);
      clearAiSessionPermissionMode(historyAiSessionPermissionKey(props.instance.id, item.id));
    }
    historyMessageDraft.value = "";
    historyMessageAttachments.value = [];
    emit("selectAiSession", props.instance.id, session.id);
    await leaveHistoryMode();
  } catch (error) {
    loadingToast.dismiss();
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.continueFailed")));
  } finally {
    loadingToast.dismiss();
    resumingHistoryId.value = "";
  }
}

function openNewSession() {
  const wasVisible = showNewSession.value;
  newSessionOpen.value = true;
  sessionListOverlayOpen.value = false;
  if (wasVisible) {
    return;
  }
  messageAttachments.value = [];
  newSessionCreateAttempt.value = undefined;
  initializeNewSessionDefaults();
}

function newSessionFolderIdForPath(sessionPath: string) {
  const runtimeIsLocal = props.instance.runtime?.type === "local" || props.instance.runtime?.kind === "local";
  const sourcePath = props.instance.source.type === "local-folder" ? props.instance.source.path : "";
  const workspacePath = props.instance.runtime?.workspacePath || props.instance.workspace.path || "/workspace";
  return newSessionFolders.value.find((folder) => {
    if (!folder.cwdFolderId) {
      return relativeNodePathSegments(folder.path, sessionPath)?.length === 0;
    }
    if (runtimeIsLocal) {
      return relativeNodePathSegments(folder.path, sessionPath)?.length === 0;
    }
    if (!sourcePath) {
      return false;
    }
    const relativeSegments = relativeNodePathSegments(sourcePath, folder.path);
    if (!relativeSegments) {
      return false;
    }
    const workspaceRoot = workspacePath.replace(/\/+$/, "") || "/";
    const mappedPath = relativeSegments.length
      ? `${workspaceRoot === "/" ? "" : workspaceRoot}/${relativeSegments.join("/")}`
      : workspaceRoot;
    return relativeNodePathSegments(mappedPath, sessionPath)?.length === 0;
  })?.id;
}

async function openNewSessionForPath(sessionPath: string) {
  const folderId = newSessionFolderIdForPath(sessionPath);
  if (!folderId) {
    showControlPlaneToast(t("sessions.panel.projectUnavailable"));
    return;
  }
  if (historyMode.value) {
    await leaveHistoryMode();
  }
  openNewSession();
  newSessionFolderId.value = folderId;
}

async function openNewSessionForGroup(group: AiSessionPathGroup | AiSessionHistoryPathGroup) {
  if (group.cwdFolderId && newSessionFolders.value.some((folder) => folder.id === group.cwdFolderId)) {
    if (historyMode.value) await leaveHistoryMode();
    openNewSession();
    newSessionFolderId.value = group.cwdFolderId;
    return;
  }
  await openNewSessionForPath(group.path);
}

function creationInitialFolderId() {
  if (props.creationInitialCwdFolderId && newSessionFolders.value.some((folder) => folder.id === props.creationInitialCwdFolderId)) {
    return props.creationInitialCwdFolderId;
  }
  return props.creationInitialCwd ? newSessionFolderIdForPath(props.creationInitialCwd) : undefined;
}

function initializeNewSessionDefaults() {
  if (!aiSessionLaunchableApps.value.some((app) => app.id === newSessionApp.value)) {
    if (props.creationMode === "preset" && props.instance.id === initialCreationInstanceId && newSessionApp.value === props.creationInitialPreset?.agent) return;
    newSessionApp.value = aiSessionLaunchableApps.value[0]?.id || "";
  }
  if (!newSessionFolders.value.some((folder) => folder.id === newSessionFolderId.value)) {
    const initialFolderId = creationInitialFolderId();
    if (initialFolderId) {
      newSessionFolderId.value = initialFolderId;
      return;
    }
    if (props.instance.source.type !== "local-folder") {
      newSessionFolderId.value = INSTANCE_WORKSPACE_FOLDER_ID;
      return;
    }
    const sourcePath = props.instance.source.type === "local-folder" ? props.instance.source.path : "";
    const sourceFolderId = props.instance.source.type === "local-folder" ? props.instance.source.localFolderId : undefined;
    newSessionFolderId.value = newSessionFolders.value.find((folder) => folder.id === sourceFolderId)?.id
      || newSessionFolders.value.find((folder) => relativeNodePathSegments(folder.path, sourcePath)?.length === 0)?.id
      || "";
  }
}

watch(
  [() => props.instance.id, () => props.creationInitialCwd, () => props.creationInitialCwdFolderId],
  () => {
    if (!props.creationOnly) return;
    newSessionFolderId.value = "";
    initializeNewSessionDefaults();
  },
  { immediate: true },
);

function newSessionBranchSelectable(branch: RepositoryAiSessionWorkspaceBranch) {
  return newSessionWorkspaceMode.value === "worktree" ? branch.worktreeSelectable : branch.currentFolderSelectable;
}

function newSessionBranchDetached(branch: RepositoryAiSessionWorkspaceBranch) {
  return newSessionWorkspaceMode.value === "worktree" && branch.worktreeCheckout === "detached";
}

function buildNewSessionBranchTree(branches: RepositoryAiSessionWorkspaceBranch[]): NewSessionBranchTreeNode[] {
  // i18n-audit-allow-next-line code-token: internal Git branch tree root identifier
  const root: NewSessionBranchTreeFolder = { children: [], id: "branch", kind: "folder", label: "branch" };
  for (const branch of branches) {
    const parts = branch.name.split("/").filter(Boolean);
    let parent = root;
    for (const [index, part] of parts.entries()) {
      const id = `branch:${parts.slice(0, index + 1).join("/")}`;
      if (index === parts.length - 1) {
        parent.children.push({ branch, id: `${id}:leaf`, kind: "branch", label: part });
        continue;
      }
      let folder = parent.children.find((node): node is NewSessionBranchTreeFolder => node.kind === "folder" && node.label === part);
      if (!folder) {
        folder = { children: [], id, kind: "folder", label: part };
        parent.children.push(folder);
      }
      parent = folder;
    }
  }
  return root.children;
}

function flattenNewSessionBranchTree(nodes: NewSessionBranchTreeNode[], depth = 0): VisibleNewSessionBranchTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === "branch") return [{ ...node, depth }];
    const expanded = Boolean(newSessionBranchQuery.value.trim()) || !collapsedNewSessionBranchFolders.value.has(node.id);
    return [
      { count: countNewSessionBranchLeaves(node), depth, expanded, id: node.id, kind: "folder" as const, label: node.label },
      ...(expanded ? flattenNewSessionBranchTree(node.children, depth + 1) : []),
    ];
  });
}

function countNewSessionBranchLeaves(folder: NewSessionBranchTreeFolder): number {
  return folder.children.reduce((count, node) => count + (node.kind === "branch" ? 1 : countNewSessionBranchLeaves(node)), 0);
}

function toggleNewSessionBranchFolder(event: Event, id: string) {
  event.preventDefault();
  const next = new Set(collapsedNewSessionBranchFolders.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedNewSessionBranchFolders.value = next;
}

function newSessionBranchTreeLayout(depth: number) {
  return { paddingInlineStart: `${8 + depth * 16}px` };
}

const newSessionBranchSwitchTarget = ref<RepositoryAiSessionWorkspaceBranch>();

function selectNewSessionBranch(branch: RepositoryAiSessionWorkspaceBranch) {
  if (!newSessionBranchSelectable(branch)) return;
  if (newSessionWorkspaceMode.value === "worktree" || branch.current) {
    newSessionBranch.value = branch.name;
    return;
  }
  newSessionBranchSwitchTarget.value = branch;
}

function confirmNewSessionBranchSwitch() {
  if (newSessionBranchSwitchTarget.value) newSessionBranch.value = newSessionBranchSwitchTarget.value.name;
  newSessionBranchSwitchTarget.value = undefined;
}

function selectNewSessionWorkspaceMode(mode: "current-folder" | "worktree") {
  newSessionWorkspaceMode.value = mode;
  const selected = newSessionWorkspace.value?.branches.find((branch) => branch.name === newSessionBranch.value);
  if (selected && newSessionBranchSelectable(selected)) return;
  newSessionBranch.value = newSessionWorkspace.value?.branches.find(newSessionBranchSelectable)?.name || "";
}

function closeNewSession() {
  if (!newSessionComposerBusy.value) newSessionOpen.value = false;
}

async function updateNewSessionPermissionMode(permissionMode: AiSessionPermissionMode) {
  if (savingNewSessionPermission.value || permissionMode === newSessionPermissionMode.value) return;
  if (props.creationMode === "preset") {
    newSessionPermissionMode.value = permissionMode;
    return;
  }
  const previousPermissionMode = newSessionPermissionMode.value;
  newSessionPermissionMode.value = permissionMode;
  savingNewSessionPermission.value = true;
  try {
    await updateControlledInstance(props.instance.id, { config: { defaultCodexPermissionMode: permissionMode } });
  } catch (error) {
    newSessionPermissionMode.value = previousPermissionMode;
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.defaultPermissionFailed")));
  } finally {
    savingNewSessionPermission.value = false;
  }
}

async function openNewProject() {
  if (!props.chooseProjectFolder) {
    await newProjectPicker.openForNode({ id: props.instance.nodeId, name: props.instance.nodeId });
    return;
  }
  if (choosingNewSessionFolder.value) return;
  choosingNewSessionFolder.value = true;
  try {
    const result = nativeNodeFolderSelectionResult(await props.chooseProjectFolder(), props.instance.nodeId);
    if (result.status === "cancelled") return;
    if (result.status === "invalid-owner") {
      showControlPlaneToast(t("settings.nodeDetail.invalidLocalFolderOwner"));
      return;
    }
    await registerNewSessionFolder(props.instance.nodeId, {
      name: nodePathName(result.path),
      path: result.path,
    });
    await queryClient.invalidateQueries({ queryKey: ["control-plane-node-local-folders", props.instance.nodeId] });
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    choosingNewSessionFolder.value = false;
  }
}

async function confirmNewProject() {
  await newProjectPicker.confirm();
}

async function createNewSession(permissionMode?: AiSessionPermissionMode) {
  const message = newSessionDraft.value.trim();
  const cwdFolderId = newSessionFolder.value?.cwdFolderId;
  if (!newSessionApp.value || !newSessionFolder.value || !message || creationComposerBusy.value || (newSessionWorkspaceLoading.value && !newSessionWorkspace.value)) return;
  const gitSelection = newSessionWorkspace.value?.availability === "available"
    && newSessionBranch.value
    && (props.creationMode !== "preset" || newSessionWorkspaceMode.value === "worktree")
    ? { mode: newSessionWorkspaceMode.value, branch: newSessionBranch.value }
    : undefined;
  if (props.creationMode === "preset") {
    emit("creationPresetSubmit", {
      instanceId: props.instance.id,
      prompt: message,
      sessionPreset: {
        agent: newSessionApp.value,
        ...(cwdFolderId ? { cwdFolderId } : {}),
        ...(gitSelection ? { gitSelection } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(newSessionModelSelection.value ? { modelSelection: newSessionModelSelection.value } : {}),
        ...(newSessionReasoningEffortCapability.value.selectAtCreate && newSessionReasoningEffort.value
          ? { reasoningEffort: newSessionReasoningEffort.value }
          : {}),
      },
    });
    return;
  }
  const references = referencesForBindings(newSessionDraft.value, newSessionMentionBindings.value);
  const fingerprint = JSON.stringify({
    instanceId: props.instance.id,
    agent: newSessionApp.value,
    cwdFolderId,
    gitSelection,
    message: aiSessionMessageText(message),
    attachments: messageAttachments.value.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      source: attachment.source,
    })),
    references,
    permissionMode,
    storyId: props.creationStoryId,
    modelSelection: newSessionModelSelection.value,
    reasoningEffort: newSessionReasoningEffort.value,
  });
  if (newSessionCreateAttempt.value?.fingerprint !== fingerprint) {
    newSessionCreateAttempt.value = { clientRequestId: createBrowserUuid(), fingerprint };
  }
  const attempt = newSessionCreateAttempt.value;
  launchingNewSession.value = true;
  try {
    const attachments = attempt.uploadedAttachments
      || await uploadAttachments(props.instance.id, attempt.clientRequestId, messageAttachments.value, "create-request");
    attempt.uploadedAttachments = attachments;
    const result = await createAiSession(props.instance.id, {
      agent: newSessionApp.value,
      ...(cwdFolderId ? { cwdFolderId } : {}),
      ...(gitSelection ? { gitSelection } : {}),
      message: aiSessionMessageText(message),
      attachments,
      references,
      permissionMode,
      ...(props.creationStoryId ? { storyId: props.creationStoryId } : {}),
      ...(newSessionModelSelection.value ? { modelSelection: newSessionModelSelection.value } : {}),
      ...(newSessionReasoningEffortCapability.value.selectAtCreate && newSessionReasoningEffort.value
        ? { reasoningEffort: newSessionReasoningEffort.value }
        : {}),
      clientRequestId: attempt.clientRequestId,
    });
    if (permissionMode) {
      persistAiSessionPermissionMode(aiSessionPermissionKey(props.instance.id, result.aiSessionId), permissionMode);
    }
    emit("selectAiSession", props.instance.id, result.aiSessionId);
    emit("sessionCreated", props.instance.id, result.aiSessionId);
    clearAiSessionDraft(activeNewSessionDraftKey.value);
    newSessionDraft.value = "";
    newSessionMentionBindings.value = [];
    messageAttachments.value = [];
    newSessionCreateAttempt.value = undefined;
    newSessionOpen.value = false;
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.startFailed")));
  } finally {
    launchingNewSession.value = false;
  }
}

function submitCreation() {
  if (!creationSubmitReady.value) return;
  void createNewSession(newSessionPermissionMode.value);
}

defineExpose({ submitCreation });

async function selectExistingSessionModel(modelSelection: AiSessionModelSelection) {
  const session = selectedSession.value;
  if (!session || modelSelectionPendingSessionId.value || (
    session.modelSelection?.modelEntityId === modelSelection.modelEntityId
    && session.modelSelection.modelName === modelSelection.modelName
  )) return;
  modelSelectionPendingSessionId.value = session.id;
  try {
    await updateAiSessionModelSelection(props.instance.id, session.id, createBrowserUuid(), modelSelection);
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.modelSwitchFailed")));
  } finally {
    if (modelSelectionPendingSessionId.value === session.id) modelSelectionPendingSessionId.value = "";
  }
}

async function selectExistingSessionReasoningEffort(reasoningEffort: AiSessionReasoningEffort) {
  const session = selectedSession.value;
  if (!session || reasoningEffortPending.value || session.reasoningEffort === reasoningEffort) return;
  reasoningEffortPending.value = { sessionId: session.id, target: reasoningEffort };
  try {
    await updateAiSessionReasoningEffort(props.instance.id, session.id, createBrowserUuid(), reasoningEffort);
  } catch (error) {
    if (reasoningEffortPending.value?.sessionId === session.id) reasoningEffortPending.value = undefined;
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.reasoningEffortFailed")));
  }
}

function canInterrupt(session: AiSessionSummary) {
  return canInterruptAiSession(session);
}

function canResolveApproval(session: AiSessionSummary) {
  return isAiSessionApprovalPending(session) && approvalDecisions(session).length > 0;
}

function approvalDecisions(session: AiSessionSummary): Array<"allow" | "deny" | "skip"> {
  const capability = directoryAiSessionProviderCapability(props.instance.capabilities?.features, session.agent);
  if (capability) return capability.actions.approvalDecisions;
  // Compatibility for v0.0.21: provider capabilities were absent and the UI exposed all legacy decisions.
  return session.agent === "codex" || session.agent === "claude" ? ["allow", "deny", "skip"] : [];
}

function agentIcon(agent: string): "codex" | "claude" | "opencode" {
  return agent === "claude" || agent === "opencode" ? agent : "codex";
}

function agentDisplayName(agent: string) {
  return agent === "codex" || agent === "claude" || agent === "opencode" ? t(`common.products.${agent}`) : agent;
}

async function refreshBoard() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-ai-sessions"] }),
  ]);
}

async function runSelectedSessionAction(permissionMode?: AiSessionPermissionMode) {
  const session = selectedSession.value;
  if (!session || aiSessionActionBusy.value || (!messageDraft.value.trim() && !messageAttachments.value.length && !canInterrupt(session))) {
    return;
  }
  if (queueComposerEdit.value) {
    await saveQueuedMessageEdit();
    return;
  }
  if (messageDraft.value.trim() || messageAttachments.value.length) {
    await sendSelectedSessionMessage(permissionMode);
    return;
  }
  await interruptSelectedSession();
}

async function uploadAttachments(instanceId: string, sessionId: string, attachments: AiSessionComposerAttachment[], scopeType: "session" | "create-request" = "session") {
  return Promise.all(attachments.map(async (attachment) => {
    return uploadAiSessionComposerAttachment(attachment, (onProgress) => {
      if (!attachment.dataUrl) throw new Error(t("sessions.panel.attachmentUnavailable", { name: attachment.name }));
      return uploadAiSessionAttachment({
        instanceId,
        sessionId,
        scopeType,
        kind: attachment.kind,
        name: attachment.name,
        mime: attachment.mime,
        data: attachment.dataUrl,
      }, onProgress);
    });
  }));
}

async function uploadMessageAttachments(instanceId: string, sessionId: string) {
  return uploadAttachments(instanceId, sessionId, messageAttachments.value);
}

async function sendSelectedSessionMessage(permissionMode?: AiSessionPermissionMode) {
  const session = selectedSession.value;
  const message = messageDraft.value.trim();
  if (!session || (!message && !messageAttachments.value.length) || aiSessionActionBusy.value) {
    return;
  }
  const keepFollowingAfterSend = detailScrollViewport
    ? distanceFromBottom(detailScrollViewport) <= STREAMING_SCROLL_FOLLOW_THRESHOLD
    : scrollFollow?.isFollowing() !== false;
  if (keepFollowingAfterSend) scrollFollow?.followLatest();
  aiSessionActionBusy.value = true;
  try {
    const attachments = await uploadMessageAttachments(props.instance.id, session.id);
    await sendAiSessionMessage(props.instance.id, session.id, aiSessionMessageText(message), undefined, attachments, referencesForBindings(messageDraft.value, messageMentionBindings.value), permissionMode);
    clearAiSessionDraft(session.id);
    messageDraft.value = "";
    messageMentionBindings.value = [];
    messageAttachments.value = [];
    if (keepFollowingAfterSend && scrollFollow?.isFollowing()) {
      await nextTick();
      scrollFollow?.followLatest();
      scrollFollow?.notifyContentResize();
    }
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.sendFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function executeSelectedSessionCommand(input: AiSessionCommandInput) {
  const session = selectedSession.value;
  if (!session || aiSessionActionBusy.value) return;
  aiSessionActionBusy.value = true;
  try {
    const result = await executeAiSessionCommand(props.instance.id, session.id, input);
    clearAiSessionDraft(session.id);
    messageDraft.value = "";
    messageMentionBindings.value = [];
    if (input.command === "goal" && !input.argument) showControlPlaneToast(result.value || t("sessions.panel.noGoal"));
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.commandFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function steerMessageDraft() {
  const session = selectedSession.value;
  const message = messageDraft.value.trim();
  if (!session || (!message && !messageAttachments.value.length) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    const attachments = await uploadMessageAttachments(props.instance.id, session.id);
    await sendAiSessionMessage(props.instance.id, session.id, aiSessionMessageText(message), "steer", attachments, referencesForBindings(messageDraft.value, messageMentionBindings.value));
    clearAiSessionDraft(session.id);
    messageDraft.value = "";
    messageMentionBindings.value = [];
    messageAttachments.value = [];
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.steerFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function steerQueuedMessage(sessionId: string, queueId: string) {
  await runQueueAction(() => steerAiSessionQueuedMessage(props.instance.id, sessionId, queueId), t("sessions.panel.steerQueuedFailed"));
}

async function retryQueuedMessage(sessionId: string, queueId: string) {
  await runQueueAction(() => retryAiSessionQueuedMessage(props.instance.id, sessionId, queueId), t("sessions.panel.retryQueuedFailed"));
}

async function removeQueuedMessage(sessionId: string, queueId: string) {
  await runQueueAction(() => removeAiSessionQueuedMessage(props.instance.id, sessionId, queueId), t("sessions.panel.removeQueuedFailed"));
}

function editQueuedMessage(sessionId: string, payload: { queueId: string; message: string }) {
  if (selectedSession.value?.id !== sessionId) return;
  const previous = queueComposerEdit.value;
  queueComposerEdit.value = {
    queueId: payload.queueId,
    originalMessage: payload.message,
    previousDraft: previous?.previousDraft ?? messageDraft.value,
    previousAttachments: previous?.previousAttachments ?? messageAttachments.value,
    previousMentionBindings: previous?.previousMentionBindings ?? messageMentionBindings.value,
  };
  messageDraft.value = payload.message;
  messageAttachments.value = [];
  messageMentionBindings.value = [];
  void nextTick(() => composerEl.value?.focus());
}

function cancelQueueComposerEdit() {
  const edit = queueComposerEdit.value;
  if (!edit) return;
  queueComposerEdit.value = undefined;
  messageDraft.value = edit.previousDraft;
  messageAttachments.value = edit.previousAttachments;
  messageMentionBindings.value = edit.previousMentionBindings;
}

async function saveQueuedMessageEdit() {
  const session = selectedSession.value;
  const edit = queueComposerEdit.value;
  const message = messageDraft.value.trim();
  if (!session || !edit || !message || aiSessionActionBusy.value) return;
  if (message === edit.originalMessage.trim()) {
    cancelQueueComposerEdit();
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    const queueRevision = selectedConversationSession.value?.queue.revision ?? session.queue.revision;
    await editAiSessionQueuedMessage(props.instance.id, session.id, edit.queueId, queueRevision, message);
    cancelQueueComposerEdit();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.editQueuedFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function reorderQueuedMessages(sessionId: string, payload: { expectedRevision: number; queueIds: string[] }) {
  await runQueueAction(() => reorderAiSessionQueuedMessages(props.instance.id, sessionId, payload.expectedRevision, payload.queueIds), t("sessions.panel.reorderQueuedFailed"));
}

async function runQueueAction(action: () => Promise<unknown>, message: string) {
  if (aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await action();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, message));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function interruptSelectedSession() {
  const session = selectedSession.value;
  if (!session || !canInterrupt(session) || aiSessionActionBusy.value || messageDraft.value.trim() || messageAttachments.value.length) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await interruptAiSession(props.instance.id, session.id);
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.stopFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function resolveSelectedApproval(decision: "allow" | "deny" | "skip") {
  const session = selectedSession.value;
  if (session) {
    await resolveApproval(session, decision);
  }
}

async function resolveApproval(session: AiSessionSummary, decision: "allow" | "deny" | "skip") {
  if (!session || !canResolveApproval(session) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await resolveAiSessionApproval(props.instance.id, session.id, decision);
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.approvalFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function openSessionApp(session: AiSessionSummary) {
  const existing = aiSessionAppTab(props.instance, session);
  if (existing) {
    emit("openAiSessionApp", props.instance, session);
    return;
  }
  if (openingAiSessionId.value || !session.actions?.openApp) return;
  openingAiSessionId.value = session.id;
  try {
    emit("openAiSessionApp", props.instance, session);
    const result = await openAiSessionApp(props.instance.id, session.id, createBrowserUuid());
    emit("openAiSessionApp", props.instance, aiSessionAppNavigationTarget(session, result));
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.openAppFailed")));
    await refreshBoard();
  } finally {
    openingAiSessionId.value = "";
  }
}

function openSessionTerminal(session: AiSessionSummary) {
  const appId = terminalLaunchAppId.value;
  if (!appId || props.launchingApp || !session.cwd) return;
  emit("launchApp", props.instance, appId, undefined, { cwd: session.cwd });
}

async function closeSession(session: AiSessionSummary) {
  if (stoppingAppSessionId.value) return;
  stoppingAppSessionId.value = session.id;
  const loadingToast = showDelayedControlPlaneLoadingToast(t("sessions.actions.closingSession"));
  try {
    await closeAiSession(props.instance.id, session.id, createBrowserUuid());
  } catch (error) {
    loadingToast.dismiss();
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.closeSessionFailed")));
    await refreshBoard();
  } finally {
    loadingToast.dismiss();
    stoppingAppSessionId.value = "";
  }
}

function storyTargetFor(session: AiSessionSummary): AiSessionStoryTarget | undefined {
  return aiSessionStoryTarget(props.instance, session);
}

function onStoryAssigned(_target: AiSessionStoryTarget) {
  showControlPlaneToast(t("sessions.actions.storyAssigned"), "success");
  void refreshBoard();
}

function onStoryAssignFailed(_target: AiSessionStoryTarget, error: unknown) {
  showControlPlaneToast(translateApiError(error, t, t("sessions.actions.storyAssignFailed")));
}

async function forkSession(session: AiSessionSummary, mode: "current" | "managed-worktree" = "current", throughTurnId?: string) {
  if (!throughTurnId && (session.status === "running" || session.status === "waiting")) {
    pendingBusyFork.value = { session, mode };
    return;
  }
  await performFork(session, mode, throughTurnId);
}

function confirmBusyFork() {
  const pending = pendingBusyFork.value;
  pendingBusyFork.value = undefined;
  if (pending) void performFork(pending.session, pending.mode, pending.throughTurnId);
}

async function performFork(session: AiSessionSummary, mode: "current" | "managed-worktree", throughTurnId?: string) {
  if (forkingAiSessionId.value || session.actions?.fork !== true) return;
  forkingAiSessionId.value = session.id;
  const requestKey = `${session.id}:${mode}:${throughTurnId || "latest"}`;
  const clientRequestId = forkRequestIds.get(requestKey) || createBrowserUuid();
  forkRequestIds.set(requestKey, clientRequestId);
  const loadingToast = showDelayedControlPlaneLoadingToast(t("sessions.actions.forking"));
  try {
    const result = await forkAiSession(props.instance.id, session.id, { clientRequestId, ...(throughTurnId ? { throughTurnId } : {}), workspace: { mode } });
    const forked = await waitForAiSessionProjection(() => props.instance.aiSessions?.sessions.find(
      (candidate) => candidate.id === result.aiSessionId && candidate.providerSessionId === result.providerSessionId,
    ));
    if (!forked) throw new Error(t("sessions.panel.forkProjectionPending"));
    selectSession(forked.id);
    forkRequestIds.delete(requestKey);
  } catch (error) {
    loadingToast.dismiss();
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.forkFailed")));
  } finally {
    loadingToast.dismiss();
    forkingAiSessionId.value = "";
  }
}

function boundTriggers(session: AiSessionSummary) {
  return (props.instance.triggers?.configs || []).flatMap((entry) => entry.deployments.filter((deployment) => isAiSessionTriggerDeployment(deployment, session.id)));
}

function parentSessionLabel(session: AiSessionSummary) {
  const parentProviderSessionId = session.lineage?.parentProviderSessionId;
  if (!parentProviderSessionId) return t("sessions.detail.unknown");
  const parent = props.instance.aiSessions?.sessions.find((candidate) => candidate.providerSessionId === parentProviderSessionId);
  return parent ? displayAiSessionTitle(parent, 0, t) : parentProviderSessionId;
}

function isTriggerBound(session: AiSessionSummary, configHash: string) {
  return boundTriggers(session).some((deployment) => deployment.configHash === configHash);
}

function triggerActionKey(session: AiSessionSummary, configHash: string) {
  return `${props.instance.id}:${session.id}:${configHash}`;
}

async function toggleTrigger(session: AiSessionSummary, configHash: string) {
  const key = triggerActionKey(session, configHash);
  if (triggerBusyKey.value) {
    return;
  }
  triggerBusyKey.value = key;
  try {
    if (isTriggerBound(session, configHash)) {
      await unbindAiSessionTrigger(props.instance.id, session.id, configHash);
      removeInstanceTriggerBinding(queryClient, props.instance.id, session.id, configHash);
    } else {
      const created = await bindAiSessionTrigger(props.instance.id, session.id, configHash);
      upsertInstanceTriggerBinding(queryClient, props.instance.id, created);
    }
    await queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] });
  } finally {
    triggerBusyKey.value = "";
  }
}

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}...` : value;
}

function syncComposerOffset() {
  const detail = detailEl.value;
  const composer = (composerEl.value?.$el instanceof HTMLElement ? composerEl.value.$el : undefined);
  if (!detail || !composer) {
    return;
  }
  detail.style.setProperty("--session-ai-compose-offset", `${Math.ceil(composer.getBoundingClientRect().height)}px`);
  // Session replacement is a layout transaction. The old viewport may still
  // report a resize while Vue swaps its content; treating that resize as live
  // streaming growth can snap compact mode to the old/new bottom.
  if (!detailScrollLayoutPending && !detailConversationTransitioning.value) {
    scrollFollow?.notifyContentResize();
  }
}

function followLatest() {
  scrollFollow?.followLatest();
}

function beginDetailLayoutAnchor() {
  detailLayoutAnchor.begin();
}

function commitDetailLayoutAnchor() {
  detailLayoutAnchor.commit();
  if (!userDetailLayoutGuard.isActive()) scrollFollow?.notifyContentResize();
}

function handleDetailExpansionClick(event: MouseEvent) {
  if (event.button !== 0 || event.defaultPrevented) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const trigger = target.closest<HTMLElement>("summary, button[aria-expanded]");
  const content = detailEl.value?.querySelector<HTMLElement>(".session-ai-detail-content");
  if (!trigger || !content?.contains(trigger) || trigger.matches(":disabled")) return;
  userDetailLayoutGuard.cancel();
  scrollFollow?.stopFollowing();
  detailLayoutAnchor.cancel();
  userDetailLayoutGuard.begin();
}

function observeComposerOffset() {
  composerResizeObserver?.disconnect();
  composerResizeObserver = undefined;
  const composer = (composerEl.value?.$el instanceof HTMLElement ? composerEl.value.$el : undefined);
  if (!composer) {
    syncComposerOffset();
    return;
  }
  composerResizeObserver = new ResizeObserver(syncComposerOffset);
  composerResizeObserver.observe(composer);
  syncComposerOffset();
}

function syncDetailActionsWidth() {
  const detail = detailEl.value;
  const actions = detailActionsEl.value;
  if (!detail || !actions) {
    return;
  }
  detail.style.setProperty("--session-ai-fixed-actions-width", `${Math.ceil(actions.getBoundingClientRect().width)}px`);
}

function observeDetailActionsWidth() {
  detailActionsResizeObserver?.disconnect();
  detailActionsResizeObserver = undefined;
  const actions = detailActionsEl.value;
  if (!actions) {
    syncDetailActionsWidth();
    return;
  }
  detailActionsResizeObserver = new ResizeObserver(syncDetailActionsWidth);
  detailActionsResizeObserver.observe(actions);
  syncDetailActionsWidth();
}

function observeDetailScroll() {
  detailScrollViewport?.removeEventListener("scroll", handleDetailScroll);
  detailScrollViewport?.removeEventListener("wheel", pauseDetailScrollFollow);
  detailScrollViewport?.removeEventListener("touchstart", pauseDetailScrollFollow);
  detailScrollViewport?.removeEventListener("click", handleDetailExpansionClick, true);
  streamingResizeObserver?.disconnect();
  streamingResizeObserver = undefined;
  scrollFollow?.dispose();
  scrollFollow = undefined;
  detailScrollViewport = undefined;
  userDetailLayoutGuard.cancel();
  detailLayoutAnchor.cancel();
  const layoutRevision = ++detailScrollLayoutRevision;
  detailScrollLayoutPending = true;
  detailScrolled.value = false;
  detailCanScroll.value = false;
  detailStickyThreshold = 0;
  const viewport = detailEl.value?.querySelector<HTMLElement>(".session-ai-detail-scroll [data-task-handoff-scroll-viewport]");
  if (!viewport) {
    detailScrollLayoutPending = false;
    isFollowingLatest.value = true;
    return;
  }
  detailScrollViewport = viewport;
  isFollowingLatest.value = true;
  isSmoothFollowingLatest.value = false;
  scrollFollow = createStreamingScrollFollow(
    () => detailScrollViewport as (HTMLElement & ScrollViewport) | undefined,
    {
      onAutoScrollingChange: (value) => { isSmoothFollowingLatest.value = value; },
      onFollowingChange: (value) => { isFollowingLatest.value = value; },
    },
  );
  const content = detailEl.value?.querySelector<HTMLElement>(".session-ai-detail-content");
  if (content && typeof ResizeObserver !== "undefined") {
    streamingResizeObserver = new ResizeObserver(() => {
      updateDetailCanScroll();
      if (!userDetailLayoutGuard.isActive()) scrollFollow?.notifyContentResize();
    });
    streamingResizeObserver.observe(content);
  }
  viewport.addEventListener("scroll", handleDetailScroll, { passive: true });
  viewport.addEventListener("wheel", pauseDetailScrollFollow, { passive: true });
  viewport.addEventListener("touchstart", pauseDetailScrollFollow, { passive: true });
  viewport.addEventListener("click", handleDetailExpansionClick, true);
  void nextTick(() => {
    if (layoutRevision !== detailScrollLayoutRevision || detailScrollViewport !== viewport) return;
    updateDetailStickyThreshold();
    detailScrollLayoutPending = false;
    if (effectiveTimelineViewMode.value === "full") {
      scrollFollow?.jumpLatest();
    } else {
      scrollFollow?.stopFollowing();
      viewport.scrollTop = 0;
    }
    updateDetailCanScroll();
    handleDetailScroll();
  });
}

function updateDetailCanScroll() {
  const viewport = detailScrollViewport;
  detailCanScroll.value = Boolean(viewport && viewport.scrollHeight > viewport.clientHeight + 1);
}

function pauseDetailScrollFollow(event: WheelEvent | TouchEvent) {
  userDetailLayoutGuard.cancel();
  detailLayoutAnchor.cancel();
  // Wheel events fire before the resulting scroll event. Lock following until
  // the user actually reaches the bottom, so a downward scroll near the bottom
  // cannot be mistaken for passive following and snapped to the end.
  scrollFollow?.pauseFollowing(true);
}

function handleDetailScroll() {
  scrollFollow?.handleScroll();
  updateDetailCanScroll();
  if (detailScrollLayoutPending || detailConversationTransitioning.value) {
    return;
  }
  const scrollTop = detailScrollViewport?.scrollTop || 0;
  if (!detailScrolled.value && detailStickyThreshold <= 0) {
    updateDetailStickyThreshold();
  }
  if (!detailScrolled.value && detailStickyThreshold > 0 && scrollTop > detailStickyThreshold) {
    detailScrolled.value = true;
  } else if (detailScrolled.value && scrollTop <= detailStickyThreshold) {
    detailScrolled.value = false;
  }
}

watch([selectedSession, messageAttachments, messageDraft, historyMessageAttachments, historyMessageDraft, historyDetail], () => {
  void nextTick(observeComposerOffset);
}, { immediate: true });

watch(() => `${props.instance.id}\u0000${selectedSession.value?.id || ""}`, () => {
  // Freeze the previous viewport before the new session is rendered. This is
  // especially important in compact mode, where switching sessions must start
  // at the top instead of inheriting the previous follow state.
  detailScrollLayoutPending = true;
  scrollFollow?.stopFollowing();
  detailLayoutAnchor.cancel();
  void loadSelectedTurnTimeline();
  queueComposerEdit.value = undefined;
  const draft = selectedSession.value ? loadAiSessionDraftPayload(selectedSession.value.id) : { value: "", bindings: [] };
  messageDraft.value = draft.value;
  messageMentionBindings.value = draft.bindings;
  timelineStickyUserMessage.value = undefined;
  void nextTick(() => {
    promptResizeObserver?.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      promptResizeObserver = new ResizeObserver(() => {
        if (!detailScrolled.value) {
          updateDetailStickyThreshold();
        }
      });
      if (detailPromptSectionEl.value) promptResizeObserver.observe(detailPromptSectionEl.value);
      if (detailHeaderEl.value) promptResizeObserver.observe(detailHeaderEl.value);
    }
    observeDetailActionsWidth();
    observeDetailScroll();
  });
}, { immediate: true });

watch([() => selectedSession.value?.id, messageDraft, messageMentionBindings], ([sessionId, draft, bindings]) => {
  if (sessionId && !queueComposerEdit.value) {
    persistAiSessionDraftPayload(sessionId, draft, bindings);
  }
}, { deep: true });

onMounted(() => {
  void nextTick(() => {
    observeComposerOffset();
    observeDetailActionsWidth();
    if (!detailScrollViewport) observeDetailScroll();
    if (props.initialHistoryMode) void enterInitialHistoryMode();
  });
});

watch(
  () => selectedTimelineTurn.value ? `${selectedTimelineTurn.value.id}:${selectedTimelineTurn.value.status}:${selectedSessionTurnIndexKey.value}` : "",
  () => {
    if (selectedTimelineTurn.value) void loadSelectedSessionTurn(selectedTimelineTurn.value.id);
    void loadSelectedTurnTimeline();
  },
);
watch(
  [effectiveTimelineViewMode, selectedSessionTurnIndexKey],
  ([mode]) => { if (mode === "full") void loadAllSelectedSessionTurns(); },
  { immediate: true },
);
watch(() => props.instance.id, () => {
  sessionListOverlayOpen.value = false;
});
onBeforeUnmount(() => {
  closeSessionListPreview();
  composerResizeObserver?.disconnect();
  detailActionsResizeObserver?.disconnect();
  promptResizeObserver?.disconnect();
  detailScrollViewport?.removeEventListener("scroll", handleDetailScroll);
  detailScrollViewport?.removeEventListener("wheel", pauseDetailScrollFollow);
  detailScrollViewport?.removeEventListener("touchstart", pauseDetailScrollFollow);
  detailScrollViewport?.removeEventListener("click", handleDetailExpansionClick, true);
  userDetailLayoutGuard.cancel();
  streamingResizeObserver?.disconnect();
  scrollFollow?.dispose();
  stopSidebarResize();
});

function openMarkdownFile(session: AiSessionSummary, filePath: string) {
  emit("openRepositoryWorkspace", {
    initialView: "files",
    filePath,
    sessionId: session.id,
    sessionKind: "ai-session",
  });
}
</script>

<style scoped src="./AiSessionPanel.css"></style>
