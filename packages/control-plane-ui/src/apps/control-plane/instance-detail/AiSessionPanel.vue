<template>
  <div ref="panelEl" class="session-ai-panel" :style="workspaceStyle">
    <Sheet v-model:open="sessionListOverlayOpen">
    <div class="session-ai-workspace">
      <component
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
                <DropdownMenuCheckboxItem class="session-ai-options-item option-item" :model-value="groupSessionsByPath" @update:model-value="(value) => groupSessionsByPath = Boolean(value)">
                  {{ t("sessions.panel.groupByPath") }}
                </DropdownMenuCheckboxItem>
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
                <DropdownMenuCheckboxItem class="session-ai-options-item option-item" :model-value="groupSessionsByPath" @update:model-value="(value) => groupSessionsByPath = Boolean(value)">
                  {{ t("sessions.panel.groupByPath") }}
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
            >
              <div
                v-if="groupSessionsByPath"
                class="session-ai-path-group-head"
              >
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
              <template v-if="!groupSessionsByPath || !collapsedPathGroups[group.key]">
                <ContextMenu
                  v-for="session in group.sessions"
                  :key="session.id"
                >
                  <ContextMenuTrigger as-child>
                <article
                  v-ai-session-card-auto-scroll="{ target: '.session-ai-preview-field-assistant', revision: `${session.id}:${promptIndexFor(session)}` }"
                  class="session-ai-row"
                  :data-state="session.status"
                  :data-selected="selectedSession?.id === session.id"
                  :data-unread="session.unread ? 'true' : undefined"
                  :data-app-session-origin="session.creationSource === 'app-session' ? 'true' : undefined"
                >
                <span v-if="session.unread" class="ai-session-unread-dot" :aria-label="t('sessions.actions.unread')" :title="t('sessions.actions.unread')" />
                <AiSessionOriginMark :creation-source="session.creationSource" />
                <div
                  class="session-ai-select"
                  role="button"
                  tabindex="0"
                  @click="selectSession(session.id)"
                  @keydown.enter.prevent="selectSession(session.id)"
                  @keydown.space.prevent="selectSession(session.id)"
                >
                  <div class="session-ai-state">
                    <span class="session-ai-dot" />
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
                    <MarkdownContent class="session-ai-question" :content="displayAiSessionTitle(session, promptIndexFor(session), t)" />
                  </div>
                  <div class="session-ai-preview-field session-ai-preview-field-assistant">
                    <AiSessionStreamingMarkdown
                      class="session-ai-message"
                      :code-tools="markdownCodeTools"
                      :content="displayAiSessionMessage(session, promptIndexFor(session), t)"
                      :instance-id="instance.id"
                      file-links
                      :is-latest="promptIndexFor(session) >= promptCount(session) - 1"
                      :session-id="session.id"
                      @open-file="openMarkdownFile(session, $event)"
                    />
                  </div>
                  <span v-if="promptCount(session) > 1" class="session-ai-turn-nav">
                    <button type="button" :aria-label="t('sessions.actions.previousMessage', { agent: session.agent })" :disabled="promptIndexFor(session) <= 0" @click.stop="previousPrompt(session)">
                      <ChevronLeft :size="13" />
                    </button>
                    <small>{{ promptIndexFor(session) + 1 }} / {{ promptCount(session) }}</small>
                    <button type="button" :aria-label="t('sessions.actions.nextMessage', { agent: session.agent })" :disabled="promptIndexFor(session) >= promptCount(session) - 1" @click.stop="nextPrompt(session)">
                      <ChevronRight :size="13" />
                    </button>
                  </span>
                </div>
                <AiSessionToolActivity
                  v-if="promptIndexFor(session) >= promptCount(session) - 1 && !canResolveApproval(session)"
                  class="session-ai-card-activity"
                  :current-tool="session.currentTool"
                  :phase="session.phase"
                  :status="session.status"
                  :summary="session.summary"
                  :tool-calls-since-last-message="session.toolCallsSinceLastMessage"
                />
                <div v-if="canResolveApproval(session)" class="session-ai-card-approval-actions">
                  <button type="button" :disabled="aiSessionActionBusy" :title="t('sessions.actions.allow')" @click.stop="resolveApproval(session, 'allow')">
                    <Check :size="13" />
                    <span>{{ t("sessions.actions.allow") }}</span>
                  </button>
                  <button type="button" :disabled="aiSessionActionBusy" :title="t('sessions.actions.skip')" @click.stop="resolveApproval(session, 'skip')">
                    <Ban :size="13" />
                    <span>{{ t("sessions.actions.skip") }}</span>
                  </button>
                  <button type="button" :disabled="aiSessionActionBusy" :title="t('sessions.actions.deny')" @click.stop="resolveApproval(session, 'deny')">
                    <X :size="13" />
                    <span>{{ t("sessions.actions.deny") }}</span>
                  </button>
                </div>
                <div class="session-ai-card-tools" :aria-label="t('sessions.actions.controls')">
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <button type="button" class="session-ai-trigger-button ai-session-card-action" :data-bound="boundTriggers(session).length ? 'true' : undefined" :title="triggerButtonTitle(session)" @click.stop>
                        <Zap :size="13" />
                        <small v-if="boundTriggers(session).length">{{ boundTriggers(session).length }}</small>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent class="session-ai-trigger-menu" align="end" :side-offset="6" @click.stop>
                      <div class="session-ai-trigger-search" @click.stop @keydown.stop>
                        <input v-model="triggerSearch" type="search" :placeholder="t('sessions.actions.searchTriggers')" :aria-label="t('sessions.actions.searchTriggers')" />
                      </div>
                      <DropdownMenuItem v-if="!triggerTemplates.length" class="session-ai-trigger-menu-empty" disabled>{{ t("sessions.actions.noTriggers") }}</DropdownMenuItem>
                      <DropdownMenuItem v-else-if="!filteredTriggerTemplates.length" class="session-ai-trigger-menu-empty" disabled>{{ t("sessions.actions.noMatchingTriggers") }}</DropdownMenuItem>
                      <template v-else>
                        <DropdownMenuItem
                          v-for="trigger in filteredTriggerTemplates"
                          :key="`${session.id}:${trigger.configHash}`"
                          class="session-ai-trigger-menu-item"
                          :disabled="triggerBusyKey === triggerActionKey(session, trigger.configHash)"
                          @select="toggleTrigger(session, trigger.configHash)"
                        >
                          <Check v-if="isTriggerBound(session, trigger.configHash)" :size="13" />
                          <Zap v-else :size="13" />
                          <span>
                            <strong>{{ trigger.config.name }}</strong>
                            <small>{{ trigger.config.source.type }} · {{ shortHash(trigger.configHash) }}</small>
                          </span>
                          <small>{{ isTriggerBound(session, trigger.configHash) ? t("sessions.actions.remove") : t("sessions.actions.add") }}</small>
                        </DropdownMenuItem>
                      </template>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    v-if="aiSessionAppTab(instance, session) || session.actions?.openApp"
                    type="button"
                    class="session-ai-open ai-session-card-action"
                    :aria-label="t('sessions.actions.openAppFor', { agent: session.agent })"
                    :title="t('sessions.actions.openApp')"
                    :disabled="openingAiSessionId === session.id"
                    @click="openSessionApp(session)"
                  >
                    <ExternalLink :size="14" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <button type="button" class="session-ai-more ai-session-card-action" :aria-label="t('sessions.actions.moreFor', { agent: session.agent })" :title="t('sessions.actions.more')" @click.stop>
                        <MoreHorizontal :size="14" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent class="session-ai-card-menu" align="end" :side-offset="6" @click.stop>
                      <DropdownMenuSub v-if="session.actions?.fork">
                        <DropdownMenuSubTrigger class="session-ai-card-menu-item" :disabled="forkingAiSessionId === session.id">
                          <Split :size="13" />
                          <span>{{ forkingAiSessionId === session.id ? t("sessions.actions.forking") : t("sessions.actions.fork") }}</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent class="session-ai-card-menu">
                          <DropdownMenuItem class="session-ai-card-menu-item" @select="forkSession(session, 'current')">{{ t("sessions.actions.forkCurrent") }}</DropdownMenuItem>
                          <DropdownMenuItem class="session-ai-card-menu-item" @select="forkSession(session, 'managed-worktree')">{{ t("sessions.actions.forkWorktree") }}</DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuItem class="session-ai-card-menu-item danger" :disabled="stoppingAppSessionId === session.id" @select="closeSession(session)">
                        <Square :size="13" />
                        <span>{{ stoppingAppSessionId === session.id ? t("sessions.actions.closingSession") : t("sessions.actions.closeSession") }}</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                </article>
                  </ContextMenuTrigger>
                  <AiSessionCardContextMenu
                    :bound-trigger-count="boundTriggers(session).length"
                    :has-app-session="Boolean(aiSessionAppTab(instance, session))"
                    :can-open-app="Boolean(aiSessionAppTab(instance, session) || session.actions?.openApp)"
                    :can-fork="session.actions?.fork === true"
                    :is-forking="forkingAiSessionId === session.id"
                    :is-stopping-app-session="stoppingAppSessionId === session.id"
                    :is-trigger-bound="(configHash) => isTriggerBound(session, configHash)"
                    :is-trigger-busy="(configHash) => triggerBusyKey === triggerActionKey(session, configHash)"
                    :short-hash="shortHash"
                    :trigger-templates="triggerTemplates"
                    @close-session="closeSession(session)"
                    @open-app="openSessionApp(session)"
                    @fork-session="forkSession(session, $event)"
                    @toggle-trigger="toggleTrigger(session, $event)"
                  />
                </ContextMenu>
              </template>
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
                <div
                  v-if="groupSessionsByPath"
                  class="session-ai-path-group-head"
                >
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
                <template v-if="!groupSessionsByPath || !collapsedHistoryPathGroups[group.key]">
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
                        <strong>{{ item.agent === "claude" ? t("common.products.claude") : t("common.products.codex") }}</strong>
                        <time :datetime="item.lastActiveAt">{{ relativeHistoryTime(item.lastActiveAt) }}</time>
                      </div>
                      <p>{{ historyItemTitle(item) }}</p>
                      <small :title="item.cwd">{{ item.cwd }}</small>
                    </div>
                  </article>
                </template>
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
        type="button"
        class="session-ai-sidebar-resize-handle"
        :aria-label="t('sessions.panel.resizeList')"
        :title="t('sessions.panel.resizeList')"
        @pointerdown="startSidebarResize"
      />
      <TooltipProvider :delay-duration="120">
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
          <section v-else-if="historyDetail" class="session-ai-history-detail-content">
            <header class="session-ai-history-detail-head">
              <div>
                <span>{{ historyDetail.item.agent === "claude" ? t("common.products.claude") : t("common.products.codex") }}</span>
                <time :datetime="historyDetail.item.lastActiveAt">{{ relativeHistoryTime(historyDetail.item.lastActiveAt) }}</time>
              </div>
              <h2>{{ historyItemTitle(historyDetail.item) }}</h2>
              <small :title="historyDetail.item.cwd">{{ historyDetail.item.cwd }}</small>
            </header>
            <div v-if="!historyDetail.turns.length" class="session-ai-history-detail-state">
              <span>{{ t("sessions.panel.noHistoryDetail") }}</span>
            </div>
            <div v-else class="session-ai-history-turns">
              <article v-for="turn in historyDetail.turns" :key="turn.id" class="session-ai-history-turn">
                <section v-if="turn.userPrompt" class="session-ai-history-message session-ai-history-message-user">
                  <MarkdownContent :code-tools="markdownCodeTools" :content="turn.userPrompt" />
                </section>
                <section v-if="turn.lastMessage || turn.summary" class="session-ai-history-message session-ai-history-message-assistant">
                  <small>{{ historyDetail.item.agent === "claude" ? t("common.products.claude") : t("common.products.codex") }}</small>
                  <MarkdownContent :code-tools="markdownCodeTools" :content="turn.lastMessage || turn.summary || ''" />
                </section>
              </article>
            </div>
          </section>
        </ScrollArea>
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
            :placeholder="t('sessions.panel.continueConversation')"
            @run="sendHistoryMessage"
          />
        </template>
      </section>
      <section v-else-if="showNewSession" class="session-ai-detail session-ai-new-detail">
        <div class="session-ai-new-start">
          <h1 class="session-ai-new-title">{{ t("sessions.panel.startIdea") }}</h1>
          <div class="session-ai-new-dialog" role="group" :aria-label="t('sessions.panel.newSession')">
            <div class="session-ai-new-pills">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <button type="button" class="session-ai-project-pill" :disabled="launchingNewSession">
                    <Folder :size="14" />
                    <strong>{{ newSessionProjectLabel }}</strong>
                    <ChevronDown :size="13" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent class="session-ai-project-menu session-ai-project-picker-menu" align="start" :collision-padding="12" :side-offset="8">
                  <input v-model="newSessionFolderQuery" class="session-ai-project-search" :placeholder="t('sessions.panel.searchProjects')" :aria-label="t('sessions.panel.searchProjects')" />
                  <ScrollArea type="auto" :horizontal="false" class="session-ai-project-list">
                    <DropdownMenuItem v-for="folder in filteredNewSessionFolders" :key="folder.id" class="session-ai-project-item" @select="newSessionFolderId = folder.id">
                      <Folder :size="15" /><span>{{ folder.name }}</span><Check v-if="newSessionFolderId === folder.id" :size="15" />
                    </DropdownMenuItem>
                    <p v-if="!filteredNewSessionFolders.length" class="session-ai-project-empty">{{ t("sessions.panel.noProjects") }}</p>
                  </ScrollArea>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem class="session-ai-project-item" @select="openNewProject"><Plus :size="15" /><span>{{ t("sessions.panel.newProject") }}</span></DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu v-if="newSessionWorkspace?.availability === 'available' && newSessionWorkspace.branches.length">
                <DropdownMenuTrigger as-child>
                  <button type="button" class="session-ai-project-pill" :disabled="newSessionComposerBusy">
                    <GitBranch :size="14" />
                    <strong>{{ newSessionWorkspaceMode === "worktree" ? t("sessions.panel.worktreeMode") : t("sessions.panel.currentFolderMode") }}</strong>
                    <ChevronDown :size="13" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent class="session-ai-project-menu" align="start" :side-offset="8">
                  <DropdownMenuItem class="session-ai-project-item" @select="selectNewSessionWorkspaceMode('current-folder')">
                    <Folder :size="14" /><span>{{ t("sessions.panel.currentFolderMode") }}</span><Check v-if="newSessionWorkspaceMode === 'current-folder'" :size="15" />
                  </DropdownMenuItem>
                  <DropdownMenuItem class="session-ai-project-item" :disabled="!newSessionWorkspace.branches.some((branch) => branch.worktreeSelectable)" @select="selectNewSessionWorkspaceMode('worktree')">
                    <GitBranch :size="14" /><span>{{ t("sessions.panel.worktreeMode") }}</span><Check v-if="newSessionWorkspaceMode === 'worktree'" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu v-if="newSessionWorkspace?.availability === 'available' && newSessionWorkspace.branches.length">
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
                    <Bot v-if="newSessionApp === 'claude'" :size="14" />
                    <Code2 v-else :size="14" />
                    <strong>{{ newSessionApp === "claude" ? t("common.products.claude") : t("common.products.codex") }}</strong>
                    <ChevronDown :size="13" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent class="session-ai-project-menu" align="start" :side-offset="8">
                  <DropdownMenuItem v-for="app in aiSessionLaunchableApps" :key="app.id" class="session-ai-project-item" @select="newSessionApp = app.id">
                    <Bot v-if="app.id === 'claude'" :size="14" />
                    <Code2 v-else :size="14" />
                    <span>{{ app.label }}</span><Check v-if="newSessionApp === app.id" :size="15" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <AiSessionComposer
              v-model="newSessionDraft"
              v-model:attachments="messageAttachments"
              class="session-ai-compose session-ai-new-composer"
              :class="{ 'is-loading': newSessionComposerBusy }"
              :aria-busy="newSessionComposerBusy"
              :busy="newSessionComposerBusy"
              :can-interrupt="false"
              :provider="newSessionApp === 'claude' ? 'claude' : 'codex'"
              :permission-mode="newSessionPermissionMode"
              :default-permission-mode="instance.config.defaultCodexPermissionMode"
              :placeholder="t('sessions.panel.promptPlaceholder')"
              @update:permission-mode="updateNewSessionPermissionMode"
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
                <template v-if="supportsAiSessionTimeline && selectedSession.agent === 'codex'">
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
                    <CircleHelp :size="16" />
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
                  <ExternalLink :size="16" />
                  <span>{{ t("sessions.actions.openApp") }}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="selectedForkTurn"
                  class="session-ai-detail-actions-menu-item"
                  :disabled="forkingAiSessionId === selectedSession.id"
                  @select="forkSession(selectedSession, 'current', selectedForkTurn.id)"
                >
                  <Split :size="16" />
                  <span>{{ t("sessions.actions.continueFromTurn") }}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem class="session-ai-detail-actions-menu-item danger" :disabled="stoppingAppSessionId === selectedSession.id" @select="closeSession(selectedSession)">
                  <Square :size="16" />
                  <span>{{ t("sessions.actions.closeSession") }}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <header ref="detailHeaderEl">
            <div>
              <span>{{ aiSessionAppDisplayName(aiSessionAppTab(instance, selectedSession), selectedSession.agent, t) }}</span>
              <strong>{{ aiSessionStatusLabel(selectedSession, t) }}</strong>
            </div>
            <section v-if="effectiveTimelineViewMode === 'compact'" ref="detailPromptSectionEl" class="session-ai-detail-block session-ai-detail-block-user">
              <div
                ref="promptContentEl"
                class="session-ai-detail-prompt-content"
                :class="{ expanded: promptExpanded }"
              >
                <MarkdownContent :content="displayAiSessionTitle(selectedSession, promptIndexFor(selectedSession), t)" :code-tools="markdownCodeTools" />
              </div>
              <button
                v-if="promptHasOverflow"
                type="button"
                class="session-ai-detail-prompt-toggle"
                :aria-expanded="promptExpanded"
                @click="promptExpanded = !promptExpanded"
              >
                <span>{{ promptExpanded ? t("sessions.detail.collapsePrompt") : t("sessions.detail.expand") }}</span>
                <ChevronDown :size="13" :class="{ open: promptExpanded }" />
              </button>
            </section>
          </header>
          <div v-if="effectiveTimelineViewMode === 'full'" class="session-ai-timeline-state">
            <AiSessionTimelineView
              v-if="aiSessionTurns(selectedSession).length"
              :busy="aiSessionActionBusy"
              :can-interrupt="canInterrupt(selectedSession)"
              :can-resolve-approval="canResolveApproval(selectedSession)"
              :instance-id="instance.id"
              file-links
              :session="selectedSession"
              :turn-timelines="conversationTurnTimelines"
              @edit-queued-message="editQueuedMessage(selectedSession.id, $event)"
              @open-file="openMarkdownFile(selectedSession, $event)"
              @steer-queued-message="steerQueuedMessage(selectedSession.id, $event)"
              @retry-queued-message="retryQueuedMessage(selectedSession.id, $event)"
              @remove-queued-message="removeQueuedMessage(selectedSession.id, $event)"
              @reorder-queued-messages="reorderQueuedMessages(selectedSession.id, $event)"
              @resolve-approval="resolveSelectedApproval"
              @sticky-user-message-change="timelineStickyUserMessage = $event"
              @continue-from-turn="forkSession(selectedSession, 'current', $event)"
              @layout-will-change="beginDetailLayoutAnchor"
              @layout-committed="commitDetailLayoutAnchor"
              @load-turn-timeline="loadTurnTimeline"
            />
            <span v-else>{{ t("sessions.timeline.noHistory") }}</span>
          </div>
          <AiSessionResult
            v-else
            :busy="aiSessionActionBusy"
            :can-interrupt="canInterrupt(selectedSession)"
            :can-resolve-approval="canResolveApproval(selectedSession)"
            :instance-id="instance.id"
            file-links
            :is-latest="promptIndexFor(selectedSession) >= promptCount(selectedSession) - 1"
            :response-content="displayAiSessionResponse(selectedSession, promptIndexFor(selectedSession), t)"
            :session="selectedSession"
            :activities="selectedTurnTimeline.activities"
            :activity-history="selectedTurnTimeline.history"
            :activity-history-status="selectedTurnTimelineState.status"
            :activity-history-error="selectedTurnTimelineState.error"
            activity-interactive
            @layout-will-change="beginDetailLayoutAnchor"
            @layout-committed="commitDetailLayoutAnchor"
            @retry-activity-history="loadSelectedTurnTimeline(true)"
            @edit-queued-message="editQueuedMessage(selectedSession.id, $event)"
            @open-file="openMarkdownFile(selectedSession, $event)"
            @steer-queued-message="steerQueuedMessage(selectedSession.id, $event)"
            @retry-queued-message="retryQueuedMessage(selectedSession.id, $event)"
            @remove-queued-message="removeQueuedMessage(selectedSession.id, $event)"
            @reorder-queued-messages="reorderQueuedMessages(selectedSession.id, $event)"
            @resolve-approval="resolveSelectedApproval"
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
          v-else-if="effectiveTimelineViewMode === 'compact' && detailScrolled"
          class="session-ai-timeline-sticky-prompt"
          aria-hidden="true"
        >
          <MarkdownContent :content="displayAiSessionTitle(selectedSession, promptIndexFor(selectedSession), t)" :code-tools="markdownCodeTools" />
        </article>
        <Button
          v-if="!isFollowingLatest"
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
          :permission-key="aiSessionPermissionKey(instance.id, selectedSession.id)"
          :default-permission-mode="instance.config.defaultCodexPermissionMode"
          :mention-context="mentionContext"
          :mention-trigger="mentionTrigger"
          :command-trigger="commandTrigger"
          :editing-label="queueComposerEdit ? t('sessions.composer.editingQueuedMessage') : undefined"
          :session-busy="selectedSession?.status === 'running' || selectedSession?.status === 'waiting'"
          @cancel-edit="cancelQueueComposerEdit"
          @command="executeSelectedSessionCommand"
          @run="runSelectedSessionAction"
          @steer="steerMessageDraft"
        />
      </section>
    </div>
    </Sheet>
    <NodeStorageFolderPickerDialog
      :can-confirm="newProjectPicker.canConfirm.value"
      :error="newProjectPicker.error.value"
      :loading="newProjectPicker.loading.value"
      :node-name="newProjectPicker.targetNode.value?.name || instance.nodeId"
      :open="newProjectPicker.dialogOpen.value"
      :rows="newProjectPicker.rows.value"
      :selected-path="newProjectPicker.selectedPath.value"
      :submit-error="newProjectPicker.submitError.value"
      :submitting="newProjectPicker.submitting.value"
      @confirm="confirmNewProject"
      @refresh="newProjectPicker.loadRoots(instance.nodeId)"
      @select="newProjectPicker.selectFolder"
      @update:open="newProjectPicker.setOpen"
    />
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
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type CSSProperties } from "vue";
import { useElementBounding, useMediaQuery } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { formatRelativeTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import { translateApiError } from "../../../i18n/apiError";
import { ArrowLeft, Ban, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Code2, ExternalLink, Filter, Folder, FolderOpen, GitBranch, History, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeftOpen, Plus, SlidersHorizontal, Split, Square, X, Zap } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import AiSessionCardContextMenu from "../../../components/ai-session/AiSessionCardContextMenu.vue";
import AiSessionOriginMark from "../../../components/ai-session/AiSessionOriginMark.vue";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { bindAiSessionTrigger, closeAiSession, createAiSession, createNodeLocalFolder, editAiSessionQueuedMessage, forkAiSession, getAiSessionHistory, getAiSessionHistoryDetail, getAiSessionTimeline, getAiSessionTurnTimeline, getAiSessionWorkspace, interruptAiSession, listNodeFolderTree, markAiSessionRead, openAiSessionApp, removeAiSessionQueuedMessage, reorderAiSessionQueuedMessages, resolveAiSessionApproval, resumeAiSession, retryAiSessionQueuedMessage, sendAiSessionMessage, steerAiSessionQueuedMessage, unbindAiSessionTrigger, updateControlledInstance, uploadAiSessionAttachment, useControlPlaneSettingsQuery, useControlPlaneTriggersQuery } from "../../../api/queries";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { executeAiSessionCommand } from "../../../api/ai-session-commands";
import { type AiSessionCommandInput, type AiSessionHistoryDetail, type AiSessionHistoryItem, type AiSessionMessageAttachmentRef, type AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import type { RepositoryAiSessionWorkspace, RepositoryAiSessionWorkspaceBranch } from "@task-handoff/protocol/repository";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, NodeLocalFolder, TriggerConfig, TriggerDeployment, TriggerRuntimeState } from "../../../api/types";
import type { LaunchableApp } from "../useInstanceSessions";
import { updateInstanceBoardData } from "../instanceBoardCache.ts";
import AiSessionComposer, { type AiSessionComposerAttachment } from "../../../components/ai-session/AiSessionComposer.vue";
import AiSessionResult from "../../../components/ai-session/AiSessionResult.vue";
import AiSessionStreamingMarkdown from "../../../components/ai-session/AiSessionStreamingMarkdown.vue";
import { vAiSessionCardAutoScroll } from "../../../components/ai-session/aiSessionCardAutoScroll";
import AiSessionToolActivity from "../../../components/ai-session/AiSessionToolActivity.vue";
import { compactTimelineForTurn } from "../../../components/ai-session/timelineActivities";
import { useAiSessionTimelineStore } from "../useAiSessionTimelineStore";
import AiSessionTimelineView from "../../../components/ai-session/AiSessionTimelineView.vue";
import { referencesForBindings, type AiSessionMentionBinding } from "../../../components/ai-session/mentions";
import { desktopRuntimePathAccess } from "../../../components/ai-session/useAiSessionMentions";
import AiSessionTurnNavigator from "../../../components/ai-session/AiSessionTurnNavigator.vue";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger } from "../../../components/ui/context-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../../../components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { relativeNodePathSegments } from "../nodePath";
import NodeStorageFolderPickerDialog from "../settings/NodeStorageFolderPickerDialog.vue";
import RepositoryEnvironment from "./RepositoryEnvironment.vue";
import { useNodeStorageFolderPicker } from "../settings/useNodeStorageFolderPicker";
import { aiSessionMessageText, clearAiSessionDraft, loadAiSessionDraftPayload, persistAiSessionDraftPayload } from "../useAiSessionDraft";
import {
  aiSessionPermissionKey,
  clearAiSessionPermissionMode,
  historyAiSessionPermissionKey,
  persistAiSessionPermissionMode,
} from "../useAiSessionPermissionMode";
import { createStreamingScrollFollow, distanceFromBottom, STREAMING_SCROLL_FOLLOW_THRESHOLD, type ScrollViewport } from "../../../lib/streaming-scroll-follow";
import { createLayoutScrollAnchor, createUserLayoutChangeGuard } from "../../../lib/layout-scroll-anchor";
import {
  aiSessionStatusGroup as sessionStatusGroup,
  canInterruptAiSession,
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

type SessionStatusFilter = "all" | "active" | "waiting" | "idle" | "problem";
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
const SORT_BY_STATUS_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-sort-by-status";
const SIDEBAR_WIDTH_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-sidebar-width";
const TIMELINE_VIEW_MODE_STORAGE_KEY = "task-handoff.control-plane.ai-session-timeline-view-mode";
const SIDEBAR_WIDTH_DEFAULT = 360;
const SIDEBAR_WIDTH_MIN = 260;
const SIDEBAR_WIDTH_MAX = 520;

function storedGroupByPath() {
  return window.localStorage?.getItem(GROUP_BY_PATH_STORAGE_KEY) !== "false";
}

function storedSortByStatus() {
  return window.localStorage?.getItem(SORT_BY_STATUS_STORAGE_KEY) !== "false";
}

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

function storedSidebarWidth() {
  const stored = window.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  const value = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_WIDTH_DEFAULT;
}

function storedTimelineViewMode(): "compact" | "full" {
  return window.localStorage?.getItem(TIMELINE_VIEW_MODE_STORAGE_KEY) === "full" ? "full" : "compact";
}

const props = defineProps<{
  activeSession: SessionTab;
  instance: InstanceWithAiSessions;
  launchableApps?: LaunchableApp[];
  nodeLocalFolders?: NodeLocalFolder[];
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
}>();
const { locale, t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));

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
const groupSessionsByPath = ref(storedGroupByPath());
const sortSessionsByStatus = ref(storedSortByStatus());
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
const displayedSessionGroups = computed<AiSessionPathGroup[]>(() => groupSessionsByPath.value ? groupAiSessionsByPath(sortedSessions.value) : [{
  key: "all",
  path: "",
  label: "",
  parentLabel: "",
  sessions: sortedSessions.value,
}]);
const selectedSession = computed(() => props.selectedAiSession(props.instance, filteredSessions.value));
const timelineViewMode = ref<"compact" | "full">(storedTimelineViewMode());
const timelineItemStore = useAiSessionTimelineStore();
const activeTurnTimelineLoads = new Map<string, Promise<void>>();
const activeSessionTimelineLoads = new Map<string, Promise<void>>();
const supportsAiSessionTimeline = computed(() => {
  const capabilities = props.instance.capabilities;
  const features = capabilities && typeof capabilities === "object"
    ? (capabilities as Record<string, unknown>).features
    : undefined;
  return Boolean(features && typeof features === "object"
    && (features as Record<string, unknown>).aiSessionTimeline === true);
});
const supportsAiSessionTurnTimeline = computed(() => {
  const capabilities = props.instance.capabilities;
  const features = capabilities && typeof capabilities === "object"
    ? (capabilities as Record<string, unknown>).features
    : undefined;
  return Boolean(features && typeof features === "object"
    && (features as Record<string, unknown>).aiSessionTurnTimeline === true);
});
const effectiveTimelineViewMode = computed(() => (
  supportsAiSessionTimeline.value && selectedSession.value?.agent === "codex"
    ? timelineViewMode.value
    : "compact"
));
const selectedTimelineTurn = computed(() => {
  const session = selectedSession.value;
  return session ? aiSessionTurns(session)[promptIndexFor(session)] : undefined;
});
const selectedTurnTimelineState = computed(() => {
  const session = selectedSession.value;
  const turn = selectedTimelineTurn.value;
  return session && turn && supportsAiSessionTimeline.value && session.agent === "codex"
    ? timelineItemStore.turnState(props.instance.id, session.id, turn)
    : { status: "ready" as const, items: [] };
});
const selectedTurnTimeline = computed(() => {
  return compactTimelineForTurn(selectedTurnTimelineState.value.items, selectedTimelineTurn.value);
});
const conversationTurnTimelines = computed(() => {
  const session = selectedSession.value;
  if (!session) return {};
  return Object.fromEntries(aiSessionTurns(session).map((turn) => [
    turn.id,
    timelineItemStore.turnState(props.instance.id, session.id, turn),
  ]));
});

function setTimelineViewMode(value: unknown) {
  if (value !== "compact" && value !== "full") return;
  timelineViewMode.value = value;
  window.localStorage?.setItem(TIMELINE_VIEW_MODE_STORAGE_KEY, value);
  if (value === "compact") void loadSelectedTurnTimeline();
}

function timelineLoadKey(instanceId: string, sessionId: string, turnId?: string) {
  return JSON.stringify([instanceId, sessionId, turnId || ""]);
}

async function loadFullTimelineForSession(session: AiSessionSummary, force = false) {
  const instanceId = props.instance.id;
  const key = timelineLoadKey(instanceId, session.id);
  const existing = activeSessionTimelineLoads.get(key);
  if (existing) return existing;
  const sessionState = timelineItemStore.sessionState(instanceId, session.id);
  if (!force && sessionState.status === "ready") return;
  const turns = aiSessionTurns(session);
  timelineItemStore.beginSessionLoad(instanceId, session.id);
  for (const turn of turns) timelineItemStore.beginTurnLoad(instanceId, session.id, turn.id);
  const load = getAiSessionTimeline(instanceId, session.id)
    .then((result) => timelineItemStore.resolveSession(instanceId, session.id, turns, result))
    .catch((error) => {
      const message = translateApiError(error, t, t("sessions.timeline.loadFailed"));
      timelineItemStore.rejectSession(instanceId, session.id, message);
      for (const turn of turns) timelineItemStore.rejectTurn(instanceId, session.id, turn.id, message);
    })
    .finally(() => activeSessionTimelineLoads.delete(key));
  activeSessionTimelineLoads.set(key, load);
  return load;
}

async function loadTurnTimeline(turnId: string, force = false) {
  const session = selectedSession.value;
  if (!session || !supportsAiSessionTimeline.value || session.agent !== "codex") return;
  const instanceId = props.instance.id;
  const turn = aiSessionTurns(session).find((candidate) => candidate.id === turnId || candidate.providerTurnId === turnId);
  if (!turn) return;
  const state = timelineItemStore.turnState(instanceId, session.id, turn);
  // Compatibility for v0.0.21: older controlled instances expose only the full-session Timeline endpoint.
  if (!supportsAiSessionTurnTimeline.value) {
    if (!force && (state.status === "ready" || state.status === "loading")) return;
    return loadFullTimelineForSession(session, true);
  }
  if (!force && (state.status === "ready" || state.status === "loading")) return;
  const key = timelineLoadKey(instanceId, session.id, turn.id);
  const existing = activeTurnTimelineLoads.get(key);
  if (existing) return existing;
  timelineItemStore.beginTurnLoad(instanceId, session.id, turn.id);
  const load = getAiSessionTurnTimeline(instanceId, session.id, turn.id)
    .then((result) => timelineItemStore.resolveTurn(instanceId, session.id, turn.id, result.items))
    .catch((error) => timelineItemStore.rejectTurn(
      instanceId,
      session.id,
      turn.id,
      translateApiError(error, t, t("sessions.timeline.loadFailed")),
    ))
    .finally(() => activeTurnTimelineLoads.delete(key));
  activeTurnTimelineLoads.set(key, load);
  return load;
}

function loadSelectedTurnTimeline(force = false) {
  const turn = selectedTimelineTurn.value;
  return turn ? loadTurnTimeline(turn.id, force) : undefined;
}

watch(timelineItemStore.recoveryRevision, () => void loadSelectedTurnTimeline(true));
watch(() => ({
  id: selectedSession.value?.id,
  unread: selectedSession.value?.unread,
  updatedAt: selectedSession.value?.updatedAt,
}), (current) => {
  if (current.id && current.unread && current.updatedAt) {
    void markAiSessionRead(props.instance.id, current.id, current.updatedAt).catch(() => undefined);
  }
}, { immediate: true });
const repositoryAiAgent = computed<"codex" | "claude" | undefined>(() => {
  const agent = selectedSession.value?.agent;
  return agent === "codex" || agent === "claude" ? agent : undefined;
});
const compactAiSessionLayout = useMediaQuery("(max-width: 920px)");
watch(compactAiSessionLayout, (compact) => {
  if (!compact) sessionListOverlayOpen.value = false;
});
function keepCompactActionsMenuOpenForRepository(event: Event) {
  const originalEvent = (event as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent;
  const target = originalEvent?.target;
  if (target instanceof Element && target.closest(".repository-environment-popover")) event.preventDefault();
}
const newSessionOpen = ref(false);
const selectedForkTurn = computed(() => {
  const session = selectedSession.value;
  if (!session || session.actions?.fork !== true) return undefined;
  const turn = aiSessionTurns(session)[promptIndexFor(session)];
  return turn?.status === "completed" && turn.providerTurnId ? turn : undefined;
});
const showNewSession = computed(() => newSessionOpen.value || !selectedSession.value);
const newSessionApp = ref("");
const newSessionFolderId = ref("");
const newSessionDraft = ref("");
const newSessionFolderQuery = ref("");
const newSessionBranchQuery = ref("");
const collapsedNewSessionBranchFolders = ref(new Set<string>());
const newSessionWorkspace = ref<RepositoryAiSessionWorkspace>();
const newSessionWorkspaceMode = ref<"current-folder" | "worktree">("current-folder");
const newSessionBranch = ref("");
const newSessionWorkspaceLoading = ref(false);
let newSessionWorkspaceRevision = 0;
const launchingNewSession = ref(false);
const newSessionCreateAttempt = ref<{
  clientRequestId: string;
  fingerprint: string;
  uploadedAttachments?: AiSessionMessageAttachmentRef[];
}>();
const savingNewSessionPermission = ref(false);
const newSessionPermissionMode = ref<AiSessionPermissionMode>(props.instance.config.defaultCodexPermissionMode);
const newSessionComposerBusy = computed(() => launchingNewSession.value || savingNewSessionPermission.value || newSessionWorkspaceLoading.value);
const aiSessionLaunchableApps = computed(() => (props.launchableApps || []).filter((app) => app.id === "codex"));
const createdNewSessionFolders = ref<NodeLocalFolder[]>([]);
const newSessionFolders = computed(() => {
  const folders = [...(props.nodeLocalFolders || []), ...createdNewSessionFolders.value];
  return [...new Map(folders.map((folder) => [folder.id, folder])).values()];
});
const newProjectPicker = useNodeStorageFolderPicker({
  createFolder: async (nodeId, input) => {
    const folder = await createNodeLocalFolder(nodeId, input);
    createdNewSessionFolders.value = [...createdNewSessionFolders.value, folder];
    newSessionFolderId.value = folder.id;
    return folder;
  },
  errorText: (error) => translateApiError(error, t),
  loadFolders: listNodeFolderTree,
  refresh: async () => {
    await queryClient.invalidateQueries({ queryKey: ["control-plane-node-local-folders", props.instance.nodeId] });
  },
});
const filteredNewSessionFolders = computed(() => {
  const query = newSessionFolderQuery.value.trim().toLowerCase();
  return newSessionFolders.value.filter((folder) => !query || `${folder.name} ${folder.path}`.toLowerCase().includes(query));
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
const newSessionProjectLabel = computed(() => {
  if (newSessionFolder.value?.name) return newSessionFolder.value.name;
  const sourcePath = props.instance.source.type === "local-folder" ? props.instance.source.path : "";
  return sourcePath?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || t("sessions.panel.chooseProject");
});
const newSessionSelectedBranchLabel = computed(() => {
  const selected = newSessionWorkspace.value?.branches.find((branch) => branch.name === newSessionBranch.value);
  if (!selected) return t("sessions.panel.chooseBranch");
  return newSessionBranchDetached(selected)
    ? `${selected.name} (${t("sessions.panel.detached")})`
    : selected.name;
});
const queryClient = useQueryClient();
const sidebarEl = ref<HTMLElement>();
const historyMode = ref(false);
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
const promptIndexes = ref<Record<string, { index: number; count: number }>>({});
const collapsedPathGroups = reactive<Record<string, boolean>>({});
const collapsedHistoryPathGroups = reactive<Record<string, boolean>>({});
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
const detailHeaderEl = ref<HTMLElement>();
const detailPromptSectionEl = ref<HTMLElement>();
const detailActionsEl = ref<HTMLElement>();
const detailBottomAnchorEl = ref<HTMLElement>();
const promptContentEl = ref<HTMLElement>();
const promptHasOverflow = ref(false);
const promptExpanded = ref(false);
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
let sidebarResizeCleanup: (() => void) | undefined;
const aiSessionActionBusy = ref(false);
const stoppingAppSessionId = ref("");
const openingAiSessionId = ref("");
const forkingAiSessionId = ref("");
const forkRequestIds = new Map<string, string>();
const pendingBusyFork = ref<{ session: AiSessionSummary; mode: "current" | "managed-worktree"; throughTurnId?: string }>();
const triggerBusyKey = ref("");
const triggerSearch = ref("");
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
const filteredTriggerTemplates = computed(() => {
  const query = triggerSearch.value.trim().toLowerCase();
  if (!query) {
    return triggerTemplates.value;
  }
  return triggerTemplates.value.filter((trigger) => {
    const searchable = [
      trigger.config.name,
      trigger.config.source.type,
      trigger.configHash,
    ].join(" ").toLowerCase();
    return searchable.includes(query);
  });
});
const workspaceStyle = computed(
  () =>
    ({
      "--session-ai-sidebar-width": `${sidebarWidth.value}px`,
    }) as CSSProperties,
);

function groupAiSessionsByPath(sessions: AiSessionSummary[]) {
  const groups = new Map<string, { cwdFolderId?: string; path: string; sessions: AiSessionSummary[] }>();
  for (const session of sessions) {
    const path = aiSessionPath(session);
    const key = session.cwdFolderId ? `folder:${session.cwdFolderId}` : `cwd:${path}`;
    const current = groups.get(key);
    groups.set(key, { cwdFolderId: session.cwdFolderId, path: current?.path || path, sessions: [...(current?.sessions || []), session] });
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      path: aiSessionGroupPath(group.cwdFolderId, group.path),
      cwdFolderId: group.cwdFolderId,
      ...aiSessionGroupLabel(group.cwdFolderId, group.path),
      sessions: group.sessions,
    }))
    .sort((a, b) => {
      const messageTimeDelta = groupLastUserMessageTime(b.sessions) - groupLastUserMessageTime(a.sessions);
      return messageTimeDelta || a.key.localeCompare(b.key);
    });
}

function groupAiSessionHistoryByPath(items: AiSessionHistoryItem[]) {
  const groups = new Map<string, { cwdFolderId?: string; path: string; items: AiSessionHistoryItem[] }>();
  for (const item of items) {
    const path = item.cwd?.trim() || "";
    const key = item.cwdFolderId ? `folder:${item.cwdFolderId}` : `cwd:${path}`;
    const current = groups.get(key);
    groups.set(key, { cwdFolderId: item.cwdFolderId, path: current?.path || path, items: [...(current?.items || []), item] });
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      path: aiSessionGroupPath(group.cwdFolderId, group.path),
      cwdFolderId: group.cwdFolderId,
      ...aiSessionGroupLabel(group.cwdFolderId, group.path),
      items: group.items,
    }))
    .sort((a, b) => {
      const latestA = Math.max(0, ...a.items.map((item) => Date.parse(item.lastActiveAt) || 0));
      const latestB = Math.max(0, ...b.items.map((item) => Date.parse(item.lastActiveAt) || 0));
      return latestB - latestA || a.key.localeCompare(b.key);
    });
}

const displayedHistoryGroups = computed<AiSessionHistoryPathGroup[]>(() => groupSessionsByPath.value ? groupAiSessionHistoryByPath(historyItems.value) : [{
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

watch(
  displayedSessionGroups,
  (groups) => {
    const activeKeys = new Set(groups.map((group) => group.key));
    for (const key of Object.keys(collapsedPathGroups)) {
      if (!activeKeys.has(key)) {
        delete collapsedPathGroups[key];
      }
    }
  },
  { immediate: true },
);

watch(
  displayedHistoryGroups,
  (groups) => {
    const activeKeys = new Set(groups.map((group) => group.key));
    for (const key of Object.keys(collapsedHistoryPathGroups)) {
      if (!activeKeys.has(key)) delete collapsedHistoryPathGroups[key];
    }
  },
  { immediate: true },
);

watch(groupSessionsByPath, (value) => {
  window.localStorage?.setItem(GROUP_BY_PATH_STORAGE_KEY, String(value));
});

watch(sortSessionsByStatus, (value) => {
  window.localStorage?.setItem(SORT_BY_STATUS_STORAGE_KEY, String(value));
});

watch(() => props.instance.id, () => {
  historyDetailRevision += 1;
  historyItems.value = [];
  historyError.value = "";
  selectedHistoryId.value = "";
  historyDetail.value = undefined;
  historyDetailError.value = "";
  historyMessageDraft.value = "";
  historyMessageAttachments.value = [];
  for (const key of Object.keys(collapsedHistoryPathGroups)) delete collapsedHistoryPathGroups[key];
  if (historyMode.value) void loadHistory();
});

watch(
  [() => props.instance.id, () => props.instance.config.defaultCodexPermissionMode],
  ([, permissionMode]) => {
    newSessionPermissionMode.value = permissionMode;
  },
  { immediate: true },
);

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
    newSessionWorkspace.value = undefined;
    newSessionWorkspaceMode.value = "current-folder";
    newSessionBranch.value = "";
    newSessionBranchQuery.value = "";
    if (!show || !folderId) {
      newSessionWorkspaceLoading.value = false;
      return;
    }
    const abort = new AbortController();
    onCleanup(() => abort.abort());
    newSessionWorkspaceLoading.value = true;
    void getAiSessionWorkspace(instanceId, folderId, abort.signal)
      .then((workspace) => {
        if (revision !== newSessionWorkspaceRevision) return;
        newSessionWorkspace.value = workspace;
        newSessionBranch.value = workspace.currentBranch
          || workspace.branches.find((branch) => branch.current)?.name
          || workspace.branches.find((branch) => branch.currentFolderSelectable)?.name
          || "";
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        // Compatibility for v0.0.21: instances without pre-session repository inspection keep the original cwd-only flow.
        if (revision === newSessionWorkspaceRevision) newSessionWorkspace.value = undefined;
      })
      .finally(() => {
        if (revision === newSessionWorkspaceRevision) newSessionWorkspaceLoading.value = false;
      });
  },
  { immediate: true },
);

function togglePathGroup(key: string) {
  collapsedPathGroups[key] = !collapsedPathGroups[key];
}

function toggleHistoryPathGroup(key: string) {
  collapsedHistoryPathGroups[key] = !collapsedHistoryPathGroups[key];
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
  return aiSessionTurns(session).length;
}

function updatePromptOverflow() {
  const element = promptContentEl.value;
  if (promptExpanded.value) return;
  promptHasOverflow.value = Boolean(element && element.scrollHeight > element.clientHeight + 1);
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

function setPromptIndex(session: AiSessionSummary, index: number) {
  const count = promptCount(session);
  if (!count) {
    return;
  }
  promptIndexes.value = {
    ...promptIndexes.value,
    [session.id]: { index: Math.min(Math.max(index, 0), count - 1), count },
  };
  promptExpanded.value = false;
  promptHasOverflow.value = false;
  void nextTick(updatePromptOverflow);
}

function previousPrompt(session: AiSessionSummary) {
  setPromptIndex(session, promptIndexFor(session) - 1);
}

function nextPrompt(session: AiSessionSummary) {
  setPromptIndex(session, promptIndexFor(session) + 1);
}

function selectSession(sessionId: string) {
  newSessionOpen.value = false;
  sessionListOverlayOpen.value = false;
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
    historyItems.value = (await getAiSessionHistory(props.instance.id)).items;
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

async function selectHistoryItem(item: AiSessionHistoryItem) {
  if (resumingHistoryId.value) return;
  sessionListOverlayOpen.value = false;
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
  let session = findAuthoritativeSession();
  for (let attempt = 0; attempt < 12 && !session; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    session = findAuthoritativeSession();
  }
  if (!session) {
    await queryClient.refetchQueries({ queryKey: ["control-plane-ai-sessions"] });
    await nextTick();
    session = findAuthoritativeSession();
  }
  if (!session) throw new Error(t("sessions.panel.resumePending"));
  return session;
}

async function sendHistoryMessage(permissionMode?: AiSessionPermissionMode) {
  const item = historyDetail.value?.item;
  const message = historyMessageDraft.value.trim();
  if (!item || resumingHistoryId.value || (!message && !historyMessageAttachments.value.length)) return;
  resumingHistoryId.value = item.id;
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
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.continueFailed")));
  } finally {
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
  newSessionDraft.value = "";
  messageAttachments.value = [];
  messageMentionBindings.value = [];
  newSessionCreateAttempt.value = undefined;
  initializeNewSessionDefaults();
}

function newSessionFolderIdForPath(sessionPath: string) {
  const runtimeIsLocal = props.instance.runtime?.type === "local" || props.instance.runtime?.kind === "local";
  const sourcePath = props.instance.source.type === "local-folder" ? props.instance.source.path : "";
  const workspacePath = props.instance.runtime?.workspacePath || props.instance.workspace.path || "/workspace";
  return newSessionFolders.value.find((folder) => {
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

function initializeNewSessionDefaults() {
  if (!aiSessionLaunchableApps.value.some((app) => app.id === newSessionApp.value)) {
    newSessionApp.value = aiSessionLaunchableApps.value[0]?.id || "";
  }
  if (!newSessionFolders.value.some((folder) => folder.id === newSessionFolderId.value)) {
    const sourcePath = props.instance.source.type === "local-folder" ? props.instance.source.path : "";
    newSessionFolderId.value = newSessionFolders.value.find((folder) => folder.path === sourcePath)?.id || "";
  }
}

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
  const previousPermissionMode = newSessionPermissionMode.value;
  newSessionPermissionMode.value = permissionMode;
  savingNewSessionPermission.value = true;
  try {
    await updateControlledInstance(props.instance.id, { config: { defaultCodexPermissionMode: permissionMode } });
    await refreshBoard();
  } catch (error) {
    newSessionPermissionMode.value = previousPermissionMode;
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.defaultPermissionFailed")));
  } finally {
    savingNewSessionPermission.value = false;
  }
}

function openNewProject() {
  void newProjectPicker.openForNode({ id: props.instance.nodeId, name: props.instance.nodeId });
}

async function confirmNewProject() {
  await newProjectPicker.confirm();
}

async function createNewSession(permissionMode?: AiSessionPermissionMode) {
  const message = newSessionDraft.value.trim();
  const cwdFolderId = newSessionFolder.value?.id;
  if (!newSessionApp.value || !message || newSessionComposerBusy.value) return;
  const gitSelection = newSessionWorkspace.value?.availability === "available" && newSessionBranch.value
    ? { mode: newSessionWorkspaceMode.value, branch: newSessionBranch.value }
    : undefined;
  const references = referencesForBindings(newSessionDraft.value, messageMentionBindings.value);
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
  });
  if (newSessionCreateAttempt.value?.fingerprint !== fingerprint) {
    newSessionCreateAttempt.value = { clientRequestId: crypto.randomUUID(), fingerprint };
  }
  const attempt = newSessionCreateAttempt.value;
  launchingNewSession.value = true;
  try {
    const attachments = attempt.uploadedAttachments
      || await uploadMessageAttachments(props.instance.id, attempt.clientRequestId);
    attempt.uploadedAttachments = attachments;
    const result = await createAiSession(props.instance.id, {
      agent: newSessionApp.value,
      ...(cwdFolderId ? { cwdFolderId } : {}),
      ...(gitSelection ? { gitSelection } : {}),
      message: aiSessionMessageText(message),
      attachments,
      references,
      permissionMode,
      clientRequestId: attempt.clientRequestId,
    });
    if (permissionMode) {
      persistAiSessionPermissionMode(aiSessionPermissionKey(props.instance.id, result.aiSessionId), permissionMode);
    }
    emit("selectAiSession", props.instance.id, result.aiSessionId);
    newSessionDraft.value = "";
    messageMentionBindings.value = [];
    messageAttachments.value = [];
    newSessionCreateAttempt.value = undefined;
    newSessionOpen.value = false;
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.startFailed")));
  } finally {
    launchingNewSession.value = false;
  }
}

function canInterrupt(session: AiSessionSummary) {
  return canInterruptAiSession(session);
}

function canResolveApproval(session: AiSessionSummary) {
  return isAiSessionApprovalPending(session);
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

async function uploadAttachments(instanceId: string, sessionId: string, attachments: AiSessionComposerAttachment[]) {
  return Promise.all(attachments.map(async (attachment) => {
    if (attachment.source.type === "runtime-path") {
      return { id: attachment.id, kind: attachment.kind, name: attachment.name, mime: attachment.mime, size: attachment.size, source: attachment.source };
    }
    if (!attachment.dataUrl) throw new Error(t("sessions.panel.attachmentUnavailable", { name: attachment.name }));
    const uploaded = await uploadAiSessionAttachment({ instanceId, sessionId, kind: attachment.kind, name: attachment.name, mime: attachment.mime, data: attachment.dataUrl });
    return { id: uploaded.id, kind: uploaded.kind, source: { type: "upload-ref" as const } };
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
    await refreshBoard();
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
    await refreshBoard();
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
    await editAiSessionQueuedMessage(props.instance.id, session.id, edit.queueId, session.queue.revision, message);
    cancelQueueComposerEdit();
    await refreshBoard();
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
    await refreshBoard();
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
    await refreshBoard();
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
    await refreshBoard();
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
    const result = await openAiSessionApp(props.instance.id, session.id, crypto.randomUUID());
    emit("openAiSessionApp", props.instance, aiSessionAppNavigationTarget(session, result));
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.openAppFailed")));
    await refreshBoard();
  } finally {
    openingAiSessionId.value = "";
  }
}

async function closeSession(session: AiSessionSummary) {
  if (stoppingAppSessionId.value) return;
  stoppingAppSessionId.value = session.id;
  try {
    await closeAiSession(props.instance.id, session.id, crypto.randomUUID());
    await refreshBoard();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.closeSessionFailed")));
    await refreshBoard();
  } finally {
    stoppingAppSessionId.value = "";
  }
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
  const clientRequestId = forkRequestIds.get(requestKey) || crypto.randomUUID();
  forkRequestIds.set(requestKey, clientRequestId);
  try {
    const result = await forkAiSession(props.instance.id, session.id, { clientRequestId, ...(throughTurnId ? { throughTurnId } : {}), workspace: { mode } });
    let forked = props.instance.aiSessions?.sessions.find((candidate) => candidate.id === result.aiSessionId && candidate.providerSessionId === result.providerSessionId);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      forked = props.instance.aiSessions?.sessions.find((candidate) => candidate.id === result.aiSessionId && candidate.providerSessionId === result.providerSessionId);
      if (forked) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!forked) {
      await refreshBoard();
      forked = props.instance.aiSessions?.sessions.find((candidate) => candidate.id === result.aiSessionId && candidate.providerSessionId === result.providerSessionId);
    }
    if (!forked) throw new Error(t("sessions.panel.forkProjectionPending"));
    selectSession(forked.id);
    forkRequestIds.delete(requestKey);
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.forkFailed")));
  } finally {
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

function isAiSessionTriggerDeployment(deployment: TriggerDeployment, sessionId: string) {
  return deployment.target.type === "ai-session" && deployment.target.aiSessionId === sessionId;
}

function isTriggerBound(session: AiSessionSummary, configHash: string) {
  return boundTriggers(session).some((deployment) => deployment.configHash === configHash);
}

function triggerActionKey(session: AiSessionSummary, configHash: string) {
  return `${props.instance.id}:${session.id}:${configHash}`;
}

function triggerButtonTitle(session: AiSessionSummary) {
  const count = boundTriggers(session).length;
  return count ? t("sessions.actions.triggersBound", { count }) : t("sessions.actions.addTrigger");
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
      removeLocalTriggerBinding(session, configHash);
    } else {
      const created = await bindAiSessionTrigger(props.instance.id, session.id, configHash) as TriggerMutationResult;
      upsertLocalTriggerBinding(created);
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }),
      queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] }),
    ]);
  } finally {
    triggerBusyKey.value = "";
  }
}

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}...` : value;
}

type TriggerMutationResult = {
  config?: TriggerConfig;
  deployment?: TriggerDeployment;
  runtime?: TriggerRuntimeState;
};

type InstanceTriggerSnapshot = NonNullable<InstanceBoardItem["triggers"]>;

function emptyTriggerSnapshot(): InstanceTriggerSnapshot {
  return {
    configs: [],
    recentRuns: [],
    updatedAt: new Date().toISOString(),
  };
}

function upsertLocalTriggerBinding(result: TriggerMutationResult) {
  if (!result.config || !result.deployment) {
    return;
  }
  updateInstanceBoardData(queryClient, (instances) => instances.map((instance) => {
    if (instance.id !== props.instance.id) {
      return instance;
    }
    const snapshot = instance.triggers || emptyTriggerSnapshot();
    const currentConfig = snapshot.configs.find((entry) => entry.configHash === result.config?.configHash);
    const nextEntry = {
      configHash: result.config.configHash,
      config: result.config,
      deployments: [
        ...(currentConfig?.deployments || []).filter((deployment) => deployment.deploymentId !== result.deployment?.deploymentId),
        result.deployment,
      ],
      runtime: result.runtime
        ? [...(currentConfig?.runtime || []).filter((runtime) => runtime.deploymentId !== result.runtime?.deploymentId), result.runtime]
        : currentConfig?.runtime || [],
    };
    return {
      ...instance,
      triggers: {
        ...snapshot,
        configs: [
          ...snapshot.configs.filter((entry) => entry.configHash !== result.config?.configHash),
          nextEntry,
        ],
        updatedAt: new Date().toISOString(),
      },
    };
  }));
}

function removeLocalTriggerBinding(session: AiSessionSummary, configHash: string) {
  updateInstanceBoardData(queryClient, (instances) => instances.map((instance) => {
    if (instance.id !== props.instance.id || !instance.triggers) {
      return instance;
    }
    const configs = instance.triggers.configs.flatMap((entry) => {
      if (entry.configHash !== configHash) {
        return [entry];
      }
      const deployments = entry.deployments.filter((deployment) => !isAiSessionTriggerDeployment(deployment, session.id));
      if (!deployments.length) {
        return [];
      }
      const deploymentIds = new Set(deployments.map((deployment) => deployment.deploymentId || deployment.configHash));
      return [{
        ...entry,
        deployments,
        runtime: entry.runtime.filter((runtime) => deploymentIds.has(runtime.deploymentId || runtime.configHash)),
      }];
    });
    return {
      ...instance,
      triggers: {
        ...instance.triggers,
        configs,
        updatedAt: new Date().toISOString(),
      },
    };
  }));
}

function syncComposerOffset() {
  const detail = detailEl.value;
  const composer = (composerEl.value?.$el instanceof HTMLElement ? composerEl.value.$el : undefined);
  if (!detail || !composer) {
    return;
  }
  detail.style.setProperty("--session-ai-compose-offset", `${Math.ceil(composer.getBoundingClientRect().height)}px`);
  scrollFollow?.notifyContentResize();
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
    scrollFollow?.jumpLatest();
    handleDetailScroll();
  });
}

function pauseDetailScrollFollow(event: WheelEvent | TouchEvent) {
  userDetailLayoutGuard.cancel();
  detailLayoutAnchor.cancel();
  if (event instanceof TouchEvent || event.deltaY < 0) {
    scrollFollow?.stopFollowing();
    return;
  }
  scrollFollow?.pauseFollowing();
}

function handleDetailScroll() {
  scrollFollow?.handleScroll();
  if (detailScrollLayoutPending) {
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
  void loadSelectedTurnTimeline();
  queueComposerEdit.value = undefined;
  const draft = selectedSession.value ? loadAiSessionDraftPayload(selectedSession.value.id) : { value: "", bindings: [] };
  messageDraft.value = draft.value;
  messageMentionBindings.value = draft.bindings;
  promptExpanded.value = false;
  timelineStickyUserMessage.value = undefined;
  promptHasOverflow.value = false;
  void nextTick(() => {
    updatePromptOverflow();
    promptResizeObserver?.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      promptResizeObserver = new ResizeObserver(() => {
        updatePromptOverflow();
        if (!detailScrolled.value) {
          updateDetailStickyThreshold();
        }
      });
      if (promptContentEl.value) promptResizeObserver.observe(promptContentEl.value);
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
  });
});

watch(() => selectedTimelineTurn.value?.id, () => void loadSelectedTurnTimeline());
watch(() => props.instance.id, () => {
  sessionListOverlayOpen.value = false;
});
onBeforeUnmount(() => {
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

const emit = defineEmits<{
  openAiSessionApp: [instance: InstanceBoardItem, session?: AiSessionSummary];
  openRepositoryWorkspace: [target: RepositoryWorkspaceTabTarget];
  selectAiSession: [instanceId: string, sessionId: string];
}>();

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
<style scoped src="../../../components/ai-session/AiSessionCardAction.css"></style>
