<template>
  <section class="story-view">
    <div v-if="error" class="story-error" role="alert">{{ error }}</div>

    <div ref="workspaceEl" class="story-workspace" :data-resizing="resizingSidebar ? 'true' : undefined" :style="{ '--story-sidebar-width': `${sidebarWidth}px` }">
      <aside ref="storySidebarEl" class="story-sidebar" :aria-busy="storiesFetching ? 'true' : undefined" :aria-label="t('stories.region')">
        <div class="story-sidebar-actions">
          <button type="button" class="story-tree-item story-new-button" @click="openCreate"><Plus :size="15" /><span class="story-tree-item-copy"><strong>{{ t("stories.newStory") }}</strong></span></button>
          <div class="story-sidebar-section">
            <span class="story-sidebar-section-label">{{ t("stories.section") }}</span>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-sm" class="story-view-mode-button" :aria-label="t('stories.listOptions')" :title="t('stories.listOptions')"><MoreHorizontal :size="16" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="story-list-options-menu" align="end" :side-offset="6">
                <DropdownMenuLabel class="story-list-options-label">{{ t("stories.viewMode") }}</DropdownMenuLabel>
                <DropdownMenuRadioGroup :model-value="treeViewMode" @update:model-value="setTreeViewMode($event as TreeViewMode)">
                  <DropdownMenuRadioItem class="story-list-options-item option-item" value="compact">{{ t("stories.compactMode") }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem class="story-list-options-item option-item" value="detailed">{{ t("stories.detailedMode") }}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator class="story-list-options-separator" />
                <DropdownMenuLabel class="story-list-options-label">{{ t("stories.sort.title") }}</DropdownMenuLabel>
                <DropdownMenuRadioGroup :model-value="storySortMode" @update:model-value="setStorySortMode($event as StorySortMode)">
                  <DropdownMenuRadioItem class="story-list-options-item option-item" value="name">{{ t("stories.sort.name") }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem class="story-list-options-item option-item" value="last-user-message">{{ t("stories.sort.lastAiSession") }}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem class="story-list-options-item option-item" value="manual">{{ t("stories.sort.manual") }}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <ScrollArea type="hover" :horizontal="false" class="story-sidebar-scroll">
          <div class="story-sidebar-scroll-inner">
            <div v-if="!stories.length && !storiesPending" class="story-empty">{{ t("stories.empty") }}</div>
            <div
              v-for="story in stories"
              :key="storySortKey(story)"
              class="story-tree"
              :class="{ 'story-tree-manual': storySortMode === 'manual', 'story-tree-dragging': draggingStoryKey === storySortKey(story) }"
              :data-story-key="storySortKey(story)"
              :data-drop-position="dropTargetKey === storySortKey(story) ? dropPosition : undefined"
              @click.capture="suppressStoryClickAfterDrag"
              @pointerdown="startStoryPointer($event, story)"
            >
              <div class="story-tree-story-row">
                <button type="button" class="story-tree-disclosure-button" :aria-label="t(isStoryOpen(story) ? 'stories.collapse' : 'stories.expand')" :aria-expanded="isStoryOpen(story)" @click.stop="toggleStoryExpanded(story)">
                  <ChevronRight :size="15" class="story-tree-disclosure" :class="{ expanded: isStoryOpen(story) }" />
                </button>
                <ContextMenu>
                  <ContextMenuTrigger as-child>
                    <button type="button" class="story-tree-item story-tree-story" :class="{ active: isStorySelected(story) }" :aria-keyshortcuts="storySortMode === 'manual' ? 'Alt+ArrowUp Alt+ArrowDown' : undefined" @click="selectStory(story)" @keydown="handleStorySortKeydown($event, story)">
                      <BookOpen :size="15" />
                      <span class="story-tree-item-copy"><strong>{{ story.title }}</strong></span>
                    </button>
                  </ContextMenuTrigger>
                  <StoryTreeContextMenu
                    :story="story"
                    :can-new-session="!Boolean(story.archivedAt) && instancesForStory(story).length > 0"
                    :can-add-existing="!Boolean(story.archivedAt) && unassignedSessionsFor(story).length > 0"
                    @new-session="openNewSession(story)"
                    @add-existing="openAssignSessionFor(story)"
                    @add-action="openCreateActionForStory(story)"
                    @add-automation="openCreateAutomationForStory(story)"
                    @edit="editStoryFromTree(story)"
                    @toggle-archive="toggleArchive(story)"
                    @delete="deleteStory(story)"
                  />
                </ContextMenu>
                <button type="button" class="story-tree-add story-tree-story-add" :aria-label="t('stories.newSession')" :title="t('stories.newSession')" :disabled="Boolean(story.archivedAt) || !instancesForStory(story).length" @click.stop="openNewSession(story)"><MessageSquarePlus :size="14" /></button>
              </div>
              <Transition name="story-tree-collapse">
                <div v-if="isStoryOpen(story)" class="story-tree-collapse">
                  <div class="story-tree-collapse-inner">
                    <div class="story-tree-children">
                <ContextMenu v-for="document in treeDocumentsFor(story)" :key="document.storyPath">
                  <ContextMenuTrigger as-child>
                    <button type="button" class="story-tree-item" :class="{ active: isDocumentSelected(story, document.storyPath), 'story-tree-item-detailed': treeViewMode === 'detailed' }" @click="selectDocument(story, document.storyPath)">
                      <FileText :size="14" /><span class="story-tree-item-copy" :class="{ 'story-tree-item-detail': treeViewMode === 'detailed' }"><strong>{{ document.title }}</strong><small v-if="treeViewMode === 'detailed'">{{ document.storyPath }}</small></span><small v-if="treeViewMode === 'compact'" class="story-tree-item-hint" aria-hidden="true">{{ document.storyPath }}</small>
                    </button>
                  </ContextMenuTrigger>
                  <DocumentTreeContextMenu :disabled="Boolean(story.archivedAt)" @open="selectDocument(story, document.storyPath)" @download="downloadDocument(story, document.storyPath)" @rename="renameDocument(story, document.storyPath, document.title)" @delete="deleteDocument(story, document.storyPath)" />
                </ContextMenu>
                <button v-if="hasMoreTreeDocuments(story)" type="button" class="story-tree-more-documents" @click="showAllTreeDocuments(story)">{{ t("stories.moreDocuments") }}</button>
                <ContextMenu v-for="entry in sessionsFor(story)" :key="entry.session.id">
                  <ContextMenuTrigger as-child>
                    <button type="button" class="story-tree-item" :class="{ active: isSessionSelected(story, entry.session.id), 'story-tree-item-detailed': treeViewMode === 'detailed', 'story-tree-item-unread': entry.session.unread }" :data-state="entry.session.status" :data-unread="entry.session.unread ? 'true' : undefined" @click="selectSession(story, entry)">
                      <span v-if="entry.session.status === 'running'" class="story-session-status"><AiSessionStatusIndicator :status="entry.session.status" /></span><span v-else class="story-session-icon"><MessageSquare :size="14" /><AiSessionStatusIndicator class="story-session-icon-status" :status="entry.session.status" size="compact" /></span><span class="story-tree-item-copy" :class="{ 'story-tree-item-detail': treeViewMode === 'detailed' }"><strong>{{ entry.session.title || entry.session.userPrompt || entry.session.id }}</strong><small v-if="treeViewMode === 'detailed'">{{ entry.instance.name }} · {{ sessionStatusLabel(entry.session.status, t) }}</small></span><small v-if="treeViewMode === 'compact'" class="story-tree-item-hint" aria-hidden="true">{{ entry.instance.name }}</small><span v-if="entry.session.unread" class="story-session-unread" :aria-label="t('sessions.actions.unread')" :title="t('sessions.actions.unread')" />
                    </button>
                  </ContextMenuTrigger>
                  <AiSessionCardContextMenu
                    :bound-trigger-count="0"
                    :has-app-session="Boolean(entry.session.appSessionId)"
                    :can-open-app="Boolean(entry.session.appSessionId || entry.session.actions?.openApp)"
                    :can-open-terminal="false"
                    :can-fork="false"
                    :is-forking="false"
                    :is-opening-terminal="false"
                    :is-stopping-app-session="closingSessionKey === entry.session.id"
                    :show-trigger-actions="false"
                    :story-target="storyTargetFor(entry)"
                    :is-trigger-bound="() => false"
                    :is-trigger-busy="() => false"
                    :short-hash="shortHash"
                    :trigger-templates="[]"
                    @close-session="closeSession(entry)"
                    @open-app="openStoryAiSessionApp(entry.instance, entry.session)"
                    @story-assigned="onStoryAssigned"
                    @story-assign-failed="onStoryAssignFailed"
                  />
                </ContextMenu>
                      <div v-if="!sessionsFor(story).length" class="story-tree-empty">{{ t("stories.noLinkedSessions") }}</div>
                    </div>
                  </div>
                </div>
              </Transition>
            </div>
            <div v-if="storiesPending" class="story-loading-overlay" role="status" aria-live="polite">
              <LoaderCircle class="story-loading-spin" :size="18" />
            </div>
          </div>
        </ScrollArea>
        <span class="sr-only" aria-live="polite">{{ storyReorderAnnouncement }}</span>
      </aside>
      <button type="button" class="story-sidebar-resize-handle" :aria-label="t('stories.resizeList')" :title="t('stories.resizeList')" @pointerdown.stop.prevent="startSidebarResize" @click.stop @dragstart.prevent />

      <main class="story-content" :class="{ 'story-session-pane': (selectedResource?.kind === 'session' || selectedResource?.kind === 'new-session') }">
        <template v-if="selectedResource?.kind === 'new-session'">
          <AiSessionPanel v-if="newSessionInstance" class="story-session-creator" :active-session="creationActiveSession" creation-only :creation-story-id="selectedResource.story.id" :creation-initial-cwd="newSessionInitialCwd" :creation-initial-cwd-folder-id="newSessionInitialCwdFolderId" :creation-instances="storyInstances" :instance="newSessionInstance" :launchable-apps="launchableAppsForInstance(newSessionInstance, t)" :node-local-folders="nodeLocalFoldersByNodeId[newSessionInstance.nodeId] || []" :selected-ai-session="noSelectedAiSession" @update:creation-instance="selectCreationInstance" @session-created="finishStorySessionCreation" />
          <div v-else class="story-content-state">{{ t("stories.noAvailableInstance") }}</div>
        </template>
        <template v-else-if="selectedResource?.kind === 'session'">
          <AiSessionPanel
            class="story-session-creator"
            :active-session="storySessionTab"
            detail-only
            :instance="selectedSessionInstance"
            :launchable-apps="launchableAppsForInstance(selectedSessionInstance, t)"
            :node-local-folders="nodeLocalFoldersByNodeId[selectedSessionInstance?.nodeId || ''] || []"
            :selected-ai-session="selectedStorySession"
            @select-ai-session="handleSelectAiSession"
            @launch-app="(target, appId, cwdFolderId, options) => emit('launch-app', target, appId, cwdFolderId, options)"
            @open-ai-session-app="(target, session) => openStoryAiSessionApp(target, session)"
            @open-repository-workspace="$emit('open-repository-workspace', $event)"
            @session-created="finishStorySessionCreation"
          />
        </template>
        <template v-else-if="selectedResource?.kind === 'document'">
          <header class="story-content-header">
            <div class="story-content-title"><h2>{{ selectedResource.document.title }}</h2><small>{{ selectedResource.document.storyPath }}</small></div>
            <div class="story-content-actions"><a class="story-content-download" :href="downloadUrl(selectedResource.story, selectedResource.document.storyPath)" :download="selectedResource.document.storyPath.split('/').pop()"><Download :size="14" /> {{ t("common.actions.download") }}</a><Button variant="outline" size="sm" :disabled="Boolean(selectedResource.story.archivedAt)" @click="renameDocument(selectedResource.story, selectedResource.document.storyPath, selectedResource.document.title)">{{ t("common.actions.rename") }}</Button><Button variant="outline" size="sm" :disabled="Boolean(selectedResource.story.archivedAt)" @click="deleteDocument(selectedResource.story, selectedResource.document.storyPath)">{{ t("common.actions.delete") }}</Button></div>
          </header>
          <div v-if="previewLoading" class="story-content-state">{{ t("stories.loadingDocument") }}</div>
          <div v-else-if="previewError" class="story-content-state story-error">{{ previewError }}</div>
          <ScrollArea v-else type="auto" :horizontal="false" class="story-document-markdown">
            <div class="story-document-markdown-content">
              <AiSessionStreamingMarkdown
                :instance-id="documentInstanceId"
                :session-id="documentMarkdownSessionId"
                :html-policy="documentHtmlPolicy"
                :code-tools="markdownCodeTools"
                :content="previewText"
                :file-links="true"
                @open-file="onOpenDocumentLink"
              />
            </div>
          </ScrollArea>
        </template>
        <template v-else-if="selectedResource?.kind === 'story'">
          <ScrollArea type="auto" :horizontal="false" class="story-detail-scroll">
            <div ref="storyDetailScrollInnerEl" class="story-detail-scroll-inner">
              <div ref="storyDetailHeadEl" class="story-detail-head">
                <header class="story-content-header">
                  <div class="story-content-title"><h2>{{ selectedResource.story.title }}</h2><small>{{ storyOwnerNodeName(selectedResource.story.ownerNodeId) }}</small></div>
                  <Tabs class="story-detail-header-tabs" :model-value="storyDetailSection" @update:model-value="scrollToStorySection($event as StoryDetailSection)">
                    <TabsList class="story-detail-tabs" :aria-label="t('stories.detailSections')">
                      <TabsTrigger value="actions"><span class="story-detail-tab-count">{{ selectedResource.story.actions.length }}</span>{{ t("stories.presetActions") }}</TabsTrigger>
                      <TabsTrigger value="documents"><span class="story-detail-tab-count">{{ selectedResource.story.documents.length }}</span>{{ t("stories.documents") }}</TabsTrigger>
                      <TabsTrigger value="sessions"><span class="story-detail-tab-count">{{ sessionCount(selectedResource.story) }}</span>{{ t("stories.aiSessions") }}</TabsTrigger>
                      <TabsTrigger value="automations"><span class="story-detail-tab-count">{{ storyAutomationEntries.length }}</span>{{ t("stories.automation.title") }}</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <div class="story-content-actions">
                    <Button variant="outline" size="sm" @click="openEdit"><Pencil :size="14" /> {{ t("common.actions.edit") }}</Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" size="icon-sm" :aria-label="t('stories.moreActions')" :title="t('stories.moreActions')"><MoreHorizontal :size="16" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt)" @select="openNewSession(selectedResource.story)"><MessageSquarePlus :size="14" /> {{ t("stories.newSession") }}</DropdownMenuItem>
                        <DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt) || !availableSessions.length" @select="openAssignSession"><Link :size="14" /> {{ t("stories.addExisting") }}</DropdownMenuItem>
                        <DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt)" @select="openCreateAction()"><Play :size="14" /> {{ t("stories.addAction") }}</DropdownMenuItem>
                        <DropdownMenuItem :disabled="Boolean(selectedResource.story.archivedAt)" @select="openCreateAutomation()"><CalendarClock :size="14" /> {{ t("stories.automation.add") }}</DropdownMenuItem>
                        <DropdownMenuItem @select="toggleArchive(selectedResource.story)"><Archive v-if="!selectedResource.story.archivedAt" :size="14" /><RotateCcw v-else :size="14" /> {{ t(selectedResource.story.archivedAt ? "common.actions.restore" : "common.actions.archive") }}</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </header>
                <p v-if="selectedResource.story.description" class="story-description">{{ selectedResource.story.description }}</p>
              </div>
              <section ref="storyActionsSectionEl" class="story-directory story-actions-section">
                <div class="story-directory-header story-actions-header"><div class="story-directory-heading"><h3>{{ t("stories.presetActions") }}</h3><span>{{ selectedResource.story.actions.length }}</span></div><Button variant="ghost" size="icon-sm" :disabled="Boolean(selectedResource.story.archivedAt)" :aria-label="t('stories.addAction')" :title="t('stories.addAction')" @click="openCreateAction"><Plus :size="16" /></Button></div>
                <div v-if="!selectedResource.story.actions.length" class="story-empty story-empty-with-action"><span>{{ t("stories.noPresetActions") }}</span><Button variant="link" size="sm" :disabled="Boolean(selectedResource.story.archivedAt)" @click="openCreateAction">{{ t("stories.addAction") }}</Button></div>
                <div v-for="action in selectedResource.story.actions" :key="action.id" class="story-action-item">
                  <button type="button" class="story-action-run" :disabled="Boolean(selectedResource.story.archivedAt)" @click="$emit('run-action', selectedResource.story, action, storyActionCreationFinished(selectedResource.story))">
                    <span class="story-action-icon"><Play :size="14" /></span>
                    <span class="story-action-copy">
                      <strong>{{ action.title }}</strong>
                      <small>{{ action.promptTemplate }}</small>
                      <span class="story-action-meta">{{ actionTargetName(selectedResource.story, action) }}<template v-if="actionSessionPresetSummary(action)"> · {{ actionSessionPresetSummary(action) }}</template></span>
                    </span>
                  </button>
                  <div class="story-action-controls">
                    <Popover>
                      <PopoverTrigger as-child>
                        <button type="button" class="story-action-automation-count" :aria-label="t('stories.automation.linkedCount', { count: actionAutomations(action.id).length })">
                          <CalendarClock :size="13" />{{ actionAutomations(action.id).length }}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent class="story-action-automation-popover p-0" align="end" :collision-padding="12" :side-offset="6">
                        <header class="story-action-automation-popover-head"><strong>{{ action.title }}</strong><span>{{ t("stories.automation.linkedCount", { count: actionAutomations(action.id).length }) }}</span></header>
                        <ScrollArea v-if="actionAutomations(action.id).length" class="story-action-automation-popover-scroll" :horizontal="false">
                          <div class="story-action-automation-popover-list">
                            <button v-for="entry in actionAutomations(action.id)" :key="entry.automation.id" type="button" class="story-action-automation-link" @click="scrollToAutomation(entry.automation.id)">
                              <span>{{ automationScheduleLabel(entry.automation.schedule) }}</span>
                              <small>{{ t(`stories.automation.status.${entry.effectiveStatus}`) }}</small>
                            </button>
                          </div>
                        </ScrollArea>
                        <p v-else class="story-action-automation-empty">{{ t("stories.automation.empty") }}</p>
                      </PopoverContent>
                    </Popover>
                    <button type="button" class="story-action-edit" :disabled="Boolean(selectedResource.story.archivedAt)" :aria-label="t('stories.editNamed', { name: action.title })" :title="t('stories.editNamed', { name: action.title })" @click.stop="openEditAction(action)"><Pencil :size="13" /></button>
                  </div>
                </div>
              </section>
              <section ref="storyDocumentsSectionEl" class="story-directory story-resource-section">
                <div class="story-directory-header story-resource-header"><div class="story-directory-heading"><h3>{{ t("stories.documents") }}</h3><span>{{ selectedResource.story.documents.length }}</span></div></div>
                <div v-if="!selectedResource.story.documents.length" class="story-empty">{{ t("stories.noDocuments") }}</div>
                <button v-for="document in pagedStoryDocuments" :key="document.storyPath" type="button" class="story-resource-item" :class="{ active: isDocumentSelected(selectedResource.story, document.storyPath) }" @click="selectDocument(selectedResource.story, document.storyPath)">
                  <span class="story-resource-icon"><FileText :size="15" /></span>
                  <span class="story-resource-copy"><strong>{{ document.title }}</strong><small>{{ document.storyPath }}</small></span>
                </button>
                <div v-if="storyDocumentPageCount > 1" class="story-pagination">
                  <span>{{ t("stories.pagination", { page: storyDocumentPage, total: storyDocumentPageCount }) }}</span>
                  <div><Button variant="ghost" size="icon-sm" :disabled="storyDocumentPage <= 1" :aria-label="t('stories.previousPage')" :title="t('stories.previousPage')" @click="storyDocumentPage -= 1"><ChevronLeft :size="14" /></Button><Button variant="ghost" size="icon-sm" :disabled="storyDocumentPage >= storyDocumentPageCount" :aria-label="t('stories.nextPage')" :title="t('stories.nextPage')" @click="storyDocumentPage += 1"><ChevronRight :size="14" /></Button></div>
                </div>
              </section>
              <section ref="storySessionsSectionEl" class="story-directory story-resource-section">
                <div class="story-directory-header story-resource-header">
                  <div class="story-directory-heading"><h3>{{ t("stories.aiSessions") }}</h3><span>{{ storySessionView === "history" ? storyHistoryEntries.length : sessionCount(selectedResource.story) }}</span></div>
                  <Tabs :model-value="storySessionView" @update:model-value="setStorySessionView($event as StorySessionView)">
                    <TabsList class="story-session-tabs" :aria-label="t('stories.aiSessions')">
                      <TabsTrigger value="current">{{ t("stories.currentSessions") }}</TabsTrigger>
                      <TabsTrigger value="history">{{ t("stories.historySessions") }}</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                <template v-if="storySessionView === 'history'">
                  <div v-if="storyHistoryLoading" class="story-resource-state" role="status">
                    <LoaderCircle class="story-loading-spin" :size="16" />
                    <span>{{ t("stories.loadingHistorySessions") }}</span>
                  </div>
                  <div v-else-if="storyHistoryError" class="story-resource-state story-error" role="alert">
                    <span>{{ storyHistoryError }}</span>
                    <Button variant="ghost" size="sm" @click="loadStoryHistory">{{ t("sessions.panel.retry") }}</Button>
                  </div>
                  <div v-else-if="!storyHistoryEntries.length" class="story-empty">{{ t("stories.noHistorySessions") }}</div>
                  <button v-for="entry in pagedStoryHistoryEntries" :key="`${entry.instance.id}:${entry.item.id}`" type="button" class="story-resource-item" @click="openStoryHistoryEntry(entry)">
                    <span class="story-resource-icon"><History :size="15" /></span>
                    <span class="story-resource-copy"><strong>{{ storyHistoryItemTitle(entry.item) }}</strong><small>{{ entry.instance.name }} · {{ actionAgentLabel(entry.item.agent) }} · {{ formatStoryHistoryTime(entry.item.lastActiveAt) }}</small></span>
                  </button>
                  <div v-if="storyHistoryPageCount > 1" class="story-pagination">
                    <span>{{ t("stories.pagination", { page: storyHistoryPage, total: storyHistoryPageCount }) }}</span>
                    <div><Button variant="ghost" size="icon-sm" :disabled="storyHistoryPage <= 1" :aria-label="t('stories.previousPage')" :title="t('stories.previousPage')" @click="storyHistoryPage -= 1"><ChevronLeft :size="14" /></Button><Button variant="ghost" size="icon-sm" :disabled="storyHistoryPage >= storyHistoryPageCount" :aria-label="t('stories.nextPage')" :title="t('stories.nextPage')" @click="storyHistoryPage += 1"><ChevronRight :size="14" /></Button></div>
                  </div>
                </template>
                <template v-else>
                  <div v-if="!sessionsFor(selectedResource.story).length" class="story-empty">{{ t("stories.noLinkedSessions") }}</div>
                  <button v-for="entry in pagedStoryCurrentSessions" :key="entry.session.id" type="button" class="story-resource-item" :class="{ active: isSessionSelected(selectedResource.story, entry.session.id) }" @click="selectSession(selectedResource.story, entry)">
                    <span v-if="entry.session.status === 'running'" class="story-resource-icon"><AiSessionStatusIndicator :status="entry.session.status" /></span>
                    <span v-else class="story-resource-icon story-resource-session-icon"><MessageSquare :size="15" /><AiSessionStatusIndicator class="story-resource-session-status" :status="entry.session.status" size="compact" /></span>
                    <span class="story-resource-copy"><strong>{{ entry.session.title || entry.session.userPrompt || entry.session.id }}</strong><small>{{ entry.instance.name }} · {{ sessionStatusLabel(entry.session.status, t) }}</small></span>
                    <span v-if="entry.session.unread" class="story-resource-unread" :aria-label="t('sessions.actions.unread')" :title="t('sessions.actions.unread')" />
                  </button>
                  <div v-if="storyCurrentSessionPageCount > 1" class="story-pagination">
                    <span>{{ t("stories.pagination", { page: storyCurrentSessionPage, total: storyCurrentSessionPageCount }) }}</span>
                    <div><Button variant="ghost" size="icon-sm" :disabled="storyCurrentSessionPage <= 1" :aria-label="t('stories.previousPage')" :title="t('stories.previousPage')" @click="storyCurrentSessionPage -= 1"><ChevronLeft :size="14" /></Button><Button variant="ghost" size="icon-sm" :disabled="storyCurrentSessionPage >= storyCurrentSessionPageCount" :aria-label="t('stories.nextPage')" :title="t('stories.nextPage')" @click="storyCurrentSessionPage += 1"><ChevronRight :size="14" /></Button></div>
                  </div>
                </template>
              </section>
              <section ref="storyAutomationsSectionEl" class="story-directory story-automations-section">
                <StoryActionAutomations
                  ref="storyAutomationsPanel"
                  :story="selectedResource.story"
                  :actions="selectedResource.story.actions"
                  :create-with-action="createAutomationWithAction"
                  :disabled="Boolean(selectedResource.story.archivedAt)"
                  :instances="storyInstances"
                  :node-local-folders-by-node-id="nodeLocalFoldersByNodeId"
                  @loaded="setStoryAutomationEntries"
                  @open-session="(instanceId, sessionId) => openAutomationSession(selectedResource.story, instanceId, sessionId)"
                />
              </section>
            </div>
          </ScrollArea>
        </template>
        <div v-else class="story-content-state">{{ t("stories.selectResource") }}</div>
      </main>
    </div>
  </section>

  <Teleport to="body">
    <div v-if="storyPointerDrag" class="story-pointer-overlay" :style="storyPointerOverlayStyle" aria-hidden="true">
      <BookOpen :size="15" />
      <span>{{ storyPointerDrag.title }}</span>
    </div>
  </Teleport>

  <Dialog v-model:open="editorOpen">
    <DialogContent class="story-editor-dialog"><DialogHeader class="story-dialog-header"><div><DialogTitle>{{ t(editing ? "stories.editor.editTitle" : "stories.editor.newTitle") }}</DialogTitle><DialogDescription>{{ t("stories.editor.description") }}</DialogDescription></div><DialogClose as-child><button type="button" class="story-dialog-close" :aria-label="t('stories.close')"><X :size="16" /></button></DialogClose></DialogHeader><div class="story-editor-fields"><label>{{ t("stories.editor.title") }}<Input v-model="draftTitle" :placeholder="t('stories.editor.titlePlaceholder')" /></label><label>{{ t("stories.editor.descriptionLabel") }}<Textarea v-model="draftDescription" :placeholder="t('stories.editor.descriptionPlaceholder')" /></label><label>{{ t("stories.editor.ownerNode") }}<ControlPlaneSelect v-model="draftNodeId" :disabled="editing"><ControlPlaneSelectItem v-for="node in nodes.filter((candidate) => candidate.status === 'online')" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label><label>{{ t("stories.editor.maxIdleAiSessions") }}<Input v-model.number="draftMaxIdleAiSessions" type="number" :min="STORY_MIN_IDLE_AI_SESSIONS" :max="STORY_MAX_IDLE_AI_SESSIONS" /></label></div><DialogFooter><Button variant="outline" @click="editorOpen = false">{{ t("common.actions.cancel") }}</Button><Button :disabled="!draftTitle.trim() || !draftNodeId || saving" @click="saveStory">{{ saving ? t("stories.editor.saving") : t("common.actions.save") }}</Button></DialogFooter></DialogContent>
  </Dialog>
  <Dialog v-model:open="assignSessionOpen"><DialogContent class="story-editor-dialog"><DialogHeader class="story-dialog-header"><div><DialogTitle>{{ t("stories.assign.title") }}</DialogTitle><DialogDescription>{{ t("stories.assign.description") }}</DialogDescription></div><DialogClose as-child><button type="button" class="story-dialog-close" :aria-label="t('stories.close')"><X :size="16" /></button></DialogClose></DialogHeader><div class="story-editor-fields"><label>{{ t("stories.assign.session") }}<ControlPlaneSelect v-model="assignSessionId"><ControlPlaneSelectItem v-for="entry in availableSessions" :key="`${entry.instance.id}:${entry.session.id}`" :value="`${entry.instance.id}:${entry.session.id}`">{{ entry.session.title || entry.session.userPrompt || entry.session.id }} · {{ entry.instance.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label></div><DialogFooter><Button variant="outline" @click="assignSessionOpen = false">{{ t("common.actions.cancel") }}</Button><Button :disabled="!assignSessionId || assigningSession" @click="assignExistingSession">{{ assigningSession ? t("stories.assign.adding") : t("stories.assign.submit") }}</Button></DialogFooter></DialogContent></Dialog>
  <Dialog :open="actionEditorOpen" @update:open="handleActionEditorOpenChange">
    <DialogContent class="story-editor-dialog story-action-editor-dialog">
      <DialogHeader class="story-dialog-header"><div><DialogTitle>{{ t(editingActionId ? "stories.actionEditor.editTitle" : "stories.actionEditor.newTitle") }}</DialogTitle><DialogDescription>{{ t("stories.actionEditor.description") }}</DialogDescription></div><DialogClose as-child><button type="button" class="story-dialog-close" :aria-label="t('stories.close')"><X :size="16" /></button></DialogClose></DialogHeader>
      <ScrollArea class="story-action-editor-scroll" :horizontal="false">
        <StoryActionEditorContent
          ref="actionCreationPanel"
          v-model:mode="actionDraftMode"
          v-model:target-instance-id="actionDraftTargetInstanceId"
          v-model:title="actionDraftTitle"
          :initial-preset="actionDraftInitialPreset"
          :initial-prompt="actionDraftInitialPrompt"
          :instances="storyInstances"
          :node-local-folders-by-node-id="nodeLocalFoldersByNodeId"
          :revision="actionEditorRevision"
          :submitting="actionSaving"
          @submit="saveAction"
          @update:submit-ready="actionCreationSubmitReady = $event"
        />
      </ScrollArea>
      <DialogFooter><Button variant="outline" :disabled="actionSaving" @click="actionEditorOpen = false">{{ t("common.actions.cancel") }}</Button><Button :disabled="!actionCreationSubmitReady || actionSaving" @click="submitActionCreation">{{ actionSaving ? t("stories.actionEditor.saving") : t("common.actions.save") }}</Button></DialogFooter>
    </DialogContent>
  </Dialog>

  <Sheet v-model:open="storyHistoryDetailOpen">
    <SheetContent side="right" :show-close="false" class="story-history-drawer">
      <SheetTitle class="sr-only">{{ storyHistoryDetailEntry ? storyHistoryItemTitle(storyHistoryDetailEntry.item) : t("stories.historySessions") }}</SheetTitle>
      <SheetDescription class="sr-only">{{ storyHistoryDetailEntry?.instance.name }}</SheetDescription>
      <div class="story-history-drawer-drag-region" aria-hidden="true" />
      <SheetClose as-child><button type="button" class="story-history-drawer-close" :aria-label="t('stories.close')"><X :size="16" /></button></SheetClose>
      <div class="story-history-panel">
        <AiSessionPanel
          v-if="storyHistoryPanelInstance"
          class="story-history-ai-session-panel"
          :active-session="storyHistoryPanelSession"
          detail-only
          :history-story-id="selectedResource?.story?.id"
          :initial-history-id="storyHistoryDetailEntry?.item.id"
          initial-history-mode
          :instance="storyHistoryPanelInstance"
          :selected-ai-session="storyHistoryPanelSelectedSession"
          @select-ai-session="handleStoryHistorySessionSelected"
        />
      </div>
    </SheetContent>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { Archive, BookOpen, CalendarClock, ChevronLeft, ChevronRight, Download, FileText, History, Link, LoaderCircle, MessageSquare, MessageSquarePlus, MoreHorizontal, Pencil, Play, Plus, RotateCcw, X } from "@lucide/vue";
import AiSessionStatusIndicator from "../../../components/ai-session/AiSessionStatusIndicator.vue";
import AiSessionStreamingMarkdown from "../../../components/ai-session/AiSessionStreamingMarkdown.vue";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "../../../components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import Input from "../../../components/ui/input/Input.vue";
import Textarea from "../../../components/ui/textarea/Textarea.vue";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { ContextMenu, ContextMenuTrigger } from "../../../components/ui/context-menu";
import AiSessionCardContextMenu from "../../../components/ai-session/AiSessionCardContextMenu.vue";
import { aiSessionStoryTarget, type AiSessionStoryTarget } from "../../../components/ai-session/storyTarget";
import StoryTreeContextMenu from "./StoryTreeContextMenu.vue";
import DocumentTreeContextMenu from "./DocumentTreeContextMenu.vue";
import StoryActionEditorContent from "./StoryActionEditorContent.vue";
import StoryActionAutomations from "./StoryActionAutomations.vue";
import { closeAiSession, getAiSessionHistory, getStoryRetentionSettings, useStoriesQuery } from "../../../api/queries";
import { sharedControlPlaneClient } from "../../../api/sharedClient.ts";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { showControlPlaneToast, showDelayedControlPlaneLoadingToast } from "../useControlPlaneToasts";
import { translateApiError } from "../../../i18n/apiError";
import { createBrowserUuid } from "../../../lib/random-id";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, Node, NodeLocalFolder } from "../../../api/types";
import { STORY_DEFAULT_MAX_IDLE_AI_SESSIONS, STORY_MAX_IDLE_AI_SESSIONS, STORY_MIN_IDLE_AI_SESSIONS, type Story, type StoryAction, type StoryAutomationRun, type StoryAutomationSchedule, type StoryAutomationStatus, type StorySessionPreset } from "@task-handoff/protocol/stories";
import type { AiSessionHistoryItem } from "@task-handoff/protocol/ai-sessions";
import AiSessionPanel, { type AiSessionCreationPresetDraft } from "../instance-detail/AiSessionPanel.vue";
import { aiSessionLastUserMessageTime, launchableAppsForInstance, sessionStatusLabel, sortedAiSessionInboxEntries, type RepositoryWorkspaceTabTarget, type SessionTab } from "../useInstanceSessions";
import { latestStoryDocuments, STORY_TREE_DOCUMENT_LIMIT } from "./storyDocuments";
import { normalizeManualStoryOrder, reorderStoryKeys, sortStories, storyDropTargetAt, storySortKey, type StorySortMode } from "./storySort";

const props = withDefaults(defineProps<{ instances: InstanceWithAiSessions[]; nodes: Node[]; nodeLocalFoldersByNodeId?: Record<string, NodeLocalFolder[]>; filterNodeId?: string }>(), { nodeLocalFoldersByNodeId: () => ({}), filterNodeId: "" });
const { locale, t } = useI18n();
const emit = defineEmits<{
  "launch-app": [instance: InstanceBoardItem, appId: string, cwdFolderId?: string, options?: Record<string, unknown>];
  "open-session": [instance: InstanceWithAiSessions, session: AiSessionSummary | undefined];
  "open-repository-workspace": [target: RepositoryWorkspaceTabTarget];
  "run-action": [story: Story, action: StoryAction, onCreated: (instanceId: string, sessionId: string) => void];
}>();
type SessionEntry = { instance: InstanceWithAiSessions; session: AiSessionSummary };
type StoryHistoryEntry = { instance: InstanceWithAiSessions; item: AiSessionHistoryItem };
type Resource = { kind: "story"; story: Story } | { kind: "new-session"; story: Story } | { kind: "document"; story: Story; document: Story["documents"][number] } | { kind: "session"; story: Story; entry: SessionEntry };
const EXPANDED_STORY_KEYS_STORAGE_KEY = "task-handoff.control-plane.stories.expanded";
function storedExpandedStoryKeys() { try { const value = JSON.parse(window.localStorage?.getItem(EXPANDED_STORY_KEYS_STORAGE_KEY) || "[]"); return new Set<string>(Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []); } catch { return new Set<string>(); } }
function persistExpandedStoryKeys(keys: Set<string>) { try { window.localStorage?.setItem(EXPANDED_STORY_KEYS_STORAGE_KEY, JSON.stringify([...keys])); } catch { /* Local storage may be unavailable in restricted browser contexts. */ } }
const STORY_SORT_MODE_STORAGE_KEY = "task-handoff.control-plane.stories.sort-mode";
const STORY_MANUAL_ORDER_STORAGE_KEY = "task-handoff.control-plane.stories.manual-order";
function storedStorySortMode(): StorySortMode {
  try {
    const value = window.localStorage?.getItem(STORY_SORT_MODE_STORAGE_KEY);
    return value === "last-user-message" || value === "manual" ? value : "name";
  } catch { return "name"; }
}
function storedManualStoryOrder() {
  try {
    const value = JSON.parse(window.localStorage?.getItem(STORY_MANUAL_ORDER_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
  } catch { return []; }
}
function persistManualStoryOrder() {
  try { window.localStorage?.setItem(STORY_MANUAL_ORDER_STORAGE_KEY, JSON.stringify(manualStoryKeys.value)); } catch { /* Local storage may be unavailable in restricted browser contexts. */ }
}
const storySortMode = ref<StorySortMode>(storedStorySortMode());
const manualStoryKeys = ref(storedManualStoryOrder());
const draggingStoryKey = ref("");
const dropTargetKey = ref("");
const dropPosition = ref<"before" | "after">("before");
const storyReorderAnnouncement = ref("");
const storySidebarEl = ref<HTMLElement>();
type PendingStoryPointer = {
  pointerId: number;
  pointerType: string;
  story: Story;
  element: HTMLElement;
  startX: number;
  startY: number;
  rowLeft: number;
  rowWidth: number;
  rowHeight: number;
};
type StoryPointerDrag = { title: string; x: number; y: number; width: number; height: number };
const storyPointerDrag = ref<StoryPointerDrag>();
const storyPointerOverlayStyle = computed(() => storyPointerDrag.value ? {
  width: `${storyPointerDrag.value.width}px`,
  height: `${storyPointerDrag.value.height}px`,
  transform: `translate3d(${storyPointerDrag.value.x}px, ${storyPointerDrag.value.y}px, 0)`,
} : undefined);
const STORY_POINTER_DRAG_THRESHOLD = 5;
const STORY_TOUCH_DRAG_HOLD_MS = 420;
const STORY_TOUCH_MOVE_TOLERANCE = 8;
let pendingStoryPointer: PendingStoryPointer | undefined;
let storyTouchDragTimer: number | undefined;
let storyDragMoved = false;
let suppressStoryClickUntil = 0;
let storyAutoScrollFrame = 0;
let storyPointerClientY = 0;
let dragStartOrder: string[] = [];
const storiesQuery = useStoriesQuery();
const allStories = computed(() => storiesQuery.data.value?.stories ?? []);
const filteredStories = computed(() => {
  const nodeId = props.filterNodeId?.trim();
  return nodeId ? allStories.value.filter((story) => story.ownerNodeId === nodeId) : allStories.value;
});
const storyLastUserMessageTimes = computed(() => {
  const times = new Map<string, number>();
  const availableStoryKeys = new Set(allStories.value.map(storySortKey));
  for (const instance of props.instances) {
    const ownerNodeId = instance.node?.id;
    if (!ownerNodeId) continue;
    for (const session of instance.aiSessions.sessions || []) {
      if (!session.storyId) continue;
      const key = `${ownerNodeId}:${session.storyId}`;
      if (!availableStoryKeys.has(key)) continue;
      times.set(key, Math.max(times.get(key) || 0, aiSessionLastUserMessageTime(session)));
    }
  }
  return times;
});
const storySortOptions = computed(() => ({ locale: locale.value, lastUserMessageTimes: storyLastUserMessageTimes.value, manualKeys: manualStoryKeys.value }));
const stories = computed(() => sortStories(filteredStories.value, storySortMode.value, storySortOptions.value));
const storiesPending = computed(() => storiesQuery.isPending.value);
const storiesFetching = computed(() => storiesQuery.isFetching.value);
const selectedResource = ref<Resource>(); const expandedStoryKeys = ref(storedExpandedStoryKeys()); const expandedDocumentStoryKeys = ref(new Set<string>()); const error = ref("");
type StoryDetailSection = "actions" | "documents" | "sessions" | "automations";
type StoryAutomationView = StoryAutomationStatus & { recentRuns: StoryAutomationRun[] };
const storyDetailSection = ref<StoryDetailSection>("actions");
const storyDetailScrollInnerEl = ref<HTMLElement>();
const storyDetailHeadEl = ref<HTMLElement>();
const storyActionsSectionEl = ref<HTMLElement>();
const storyDocumentsSectionEl = ref<HTMLElement>();
const storySessionsSectionEl = ref<HTMLElement>();
const storyAutomationsSectionEl = ref<HTMLElement>();
const storyAutomationsPanel = ref<InstanceType<typeof StoryActionAutomations>>();
const storyAutomationEntries = ref<StoryAutomationView[]>([]);
let storyDetailHeadResizeObserver: ResizeObserver | undefined;
const pendingCreatedStorySession = ref<{ story: Story; instanceId: string; sessionId: string; sourceResourceKey: string }>();
type TreeViewMode = "compact" | "detailed";
const TREE_VIEW_MODE_STORAGE_KEY = "task-handoff.control-plane.stories.tree-view-mode";
function storedTreeViewMode(): TreeViewMode {
  try {
    const value = window.localStorage?.getItem(TREE_VIEW_MODE_STORAGE_KEY);
    return value === "detailed" ? "detailed" : "compact";
  } catch { return "compact"; }
}
const treeViewMode = ref<TreeViewMode>(storedTreeViewMode());
function setTreeViewMode(mode: TreeViewMode) {
  treeViewMode.value = mode;
  try { window.localStorage?.setItem(TREE_VIEW_MODE_STORAGE_KEY, mode); } catch { /* Local storage may be unavailable in restricted browser contexts. */ }
}
function setStorySortMode(mode: StorySortMode) {
  if (mode === "manual" && storySortMode.value !== "manual") {
    const currentOrder = sortStories(allStories.value, storySortMode.value, storySortOptions.value).map(storySortKey);
    manualStoryKeys.value = normalizeManualStoryOrder(allStories.value, currentOrder);
    persistManualStoryOrder();
  }
  storySortMode.value = mode;
  try { window.localStorage?.setItem(STORY_SORT_MODE_STORAGE_KEY, mode); } catch { /* Local storage may be unavailable in restricted browser contexts. */ }
}
function beginStoryReorder(story: Story) {
  manualStoryKeys.value = normalizeManualStoryOrder(allStories.value, manualStoryKeys.value);
  dragStartOrder = [...manualStoryKeys.value];
  draggingStoryKey.value = storySortKey(story);
}

function startStoryPointer(event: PointerEvent, story: Story) {
  if (storySortMode.value !== "manual" || event.button !== 0) return;
  const element = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  const row = element?.querySelector<HTMLElement>(".story-tree-story-row");
  if (!element || !row) return;
  cancelStoryPointerDrag();
  const bounds = row.getBoundingClientRect();
  pendingStoryPointer = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    story,
    element,
    startX: event.clientX,
    startY: event.clientY,
    rowLeft: bounds.left,
    rowWidth: bounds.width,
    rowHeight: bounds.height,
  };
  window.addEventListener("pointermove", moveStoryPointer, true);
  window.addEventListener("pointerup", finishStoryPointer, true);
  window.addEventListener("pointercancel", cancelStoryPointerDrag, true);
  window.addEventListener("keydown", cancelStoryPointerDragOnEscape, true);
  window.addEventListener("blur", cancelStoryPointerDrag);
  if (event.pointerType === "touch") {
    storyTouchDragTimer = window.setTimeout(() => {
      const pending = pendingStoryPointer;
      if (!pending || pending.pointerId !== event.pointerId) return;
      activateStoryPointerDrag(pending.startX, pending.startY);
    }, STORY_TOUCH_DRAG_HOLD_MS);
  }
}

function moveStoryPointer(event: PointerEvent) {
  const pending = pendingStoryPointer;
  if (!pending || event.pointerId !== pending.pointerId) return;
  const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
  if (!storyPointerDrag.value && pending.pointerType === "touch") {
    if (distance > STORY_TOUCH_MOVE_TOLERANCE) cleanupStoryPointerDrag(false, false);
    return;
  }
  if (!storyPointerDrag.value && distance < STORY_POINTER_DRAG_THRESHOLD) return;
  event.preventDefault();
  if (!storyPointerDrag.value) activateStoryPointerDrag(event.clientX, event.clientY);
  const drag = storyPointerDrag.value;
  if (!drag) return;
  drag.x = pending.rowLeft + event.clientX - pending.startX;
  drag.y = event.clientY - drag.height / 2;
  storyDragMoved = true;
  storyPointerClientY = event.clientY;
  updateStoryPointerTarget(event.clientY);
  startStoryEdgeScroll();
}

function activateStoryPointerDrag(clientX: number, clientY: number) {
  const pending = pendingStoryPointer;
  if (!pending || storyPointerDrag.value) return;
  clearStoryTouchDragTimer();
  try { pending.element.setPointerCapture?.(pending.pointerId); } catch { /* Window listeners retain pointer ownership. */ }
  beginStoryReorder(pending.story);
  const height = Math.min(40, Math.max(32, pending.rowHeight));
  storyPointerDrag.value = { title: pending.story.title, x: pending.rowLeft + clientX - pending.startX, y: clientY - height / 2, width: pending.rowWidth, height };
  document.body.classList.add("story-pointer-dragging");
}

function storyScrollViewport() {
  return storySidebarEl.value?.querySelector<HTMLElement>(".story-sidebar-scroll [data-task-handoff-scroll-viewport]");
}

function updateStoryPointerTarget(clientY: number) {
  const viewport = storyScrollViewport();
  if (!viewport || !draggingStoryKey.value) return;
  const rows = [...viewport.querySelectorAll<HTMLElement>(".story-tree")].flatMap((element) => {
    const key = element.dataset.storyKey;
    const row = element.querySelector<HTMLElement>(".story-tree-story-row");
    if (!key || !row) return [];
    const bounds = row.getBoundingClientRect();
    return [{ key, top: bounds.top, height: bounds.height }];
  });
  const target = storyDropTargetAt(rows, draggingStoryKey.value, clientY);
  if (!target) { dropTargetKey.value = ""; return; }
  if (dropTargetKey.value === target.targetKey && dropPosition.value === target.placement) return;
  dropTargetKey.value = target.targetKey;
  dropPosition.value = target.placement;
  manualStoryKeys.value = reorderStoryKeys(manualStoryKeys.value, draggingStoryKey.value, target.targetKey, target.placement);
}

function startStoryEdgeScroll() {
  if (storyAutoScrollFrame) return;
  storyAutoScrollFrame = requestAnimationFrame(scrollStoryDragFrame);
}

function scrollStoryDragFrame() {
  storyAutoScrollFrame = 0;
  if (!storyPointerDrag.value) return;
  const viewport = storyScrollViewport();
  if (!viewport || viewport.scrollHeight <= viewport.clientHeight) return;
  const bounds = viewport.getBoundingClientRect();
  const edge = Math.min(48, bounds.height / 4);
  const topRatio = Math.max(0, Math.min(1, (bounds.top + edge - storyPointerClientY) / edge));
  const bottomRatio = Math.max(0, Math.min(1, (storyPointerClientY - (bounds.bottom - edge)) / edge));
  const delta = Math.round((bottomRatio - topRatio) * 14);
  if (!delta) return;
  const before = viewport.scrollTop;
  viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, before + delta));
  if (viewport.scrollTop === before) return;
  updateStoryPointerTarget(storyPointerClientY);
  storyAutoScrollFrame = requestAnimationFrame(scrollStoryDragFrame);
}

function finishStoryPointer(event: PointerEvent) {
  if (!pendingStoryPointer || event.pointerId !== pendingStoryPointer.pointerId) return;
  const wasDragging = Boolean(storyPointerDrag.value);
  if (wasDragging && storyDragMoved) {
    updateStoryPointerTarget(event.clientY);
    persistManualStoryOrder();
  }
  cleanupStoryPointerDrag(wasDragging, true);
}

function cancelStoryPointerDragOnEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  cancelStoryPointerDrag();
}

function cancelStoryPointerDrag() {
  cleanupStoryPointerDrag(Boolean(storyPointerDrag.value), false);
}

function cleanupStoryPointerDrag(suppressClick: boolean, committed: boolean) {
  clearStoryTouchDragTimer();
  if (storyAutoScrollFrame) cancelAnimationFrame(storyAutoScrollFrame);
  storyAutoScrollFrame = 0;
  window.removeEventListener("pointermove", moveStoryPointer, true);
  window.removeEventListener("pointerup", finishStoryPointer, true);
  window.removeEventListener("pointercancel", cancelStoryPointerDrag, true);
  window.removeEventListener("keydown", cancelStoryPointerDragOnEscape, true);
  window.removeEventListener("blur", cancelStoryPointerDrag);
  const pending = pendingStoryPointer;
  if (pending?.element.hasPointerCapture?.(pending.pointerId)) pending.element.releasePointerCapture(pending.pointerId);
  if (draggingStoryKey.value && !committed) manualStoryKeys.value = dragStartOrder;
  pendingStoryPointer = undefined;
  storyPointerDrag.value = undefined;
  draggingStoryKey.value = "";
  dropTargetKey.value = "";
  dragStartOrder = [];
  storyDragMoved = false;
  document.body.classList.remove("story-pointer-dragging");
  if (suppressClick) suppressStoryClickUntil = Date.now() + 250;
}

function clearStoryTouchDragTimer() {
  if (storyTouchDragTimer === undefined) return;
  window.clearTimeout(storyTouchDragTimer);
  storyTouchDragTimer = undefined;
}

function suppressStoryClickAfterDrag(event: MouseEvent) {
  if (Date.now() >= suppressStoryClickUntil) return;
  event.preventDefault();
  event.stopPropagation();
}

function handleStorySortKeydown(event: KeyboardEvent, story: Story) {
  if (storySortMode.value !== "manual" || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  const index = stories.value.findIndex((candidate) => storySortKey(candidate) === storySortKey(story));
  const target = stories.value[index + (event.key === "ArrowUp" ? -1 : 1)];
  if (!target) return;
  event.preventDefault();
  manualStoryKeys.value = normalizeManualStoryOrder(allStories.value, manualStoryKeys.value);
  manualStoryKeys.value = reorderStoryKeys(manualStoryKeys.value, storySortKey(story), storySortKey(target), event.key === "ArrowUp" ? "before" : "after");
  persistManualStoryOrder();
  storyReorderAnnouncement.value = t("stories.sort.reordered", { title: story.title });
}
const SIDEBAR_WIDTH_STORAGE_KEY = "task-handoff.control-plane.stories.sidebar-width";
function storedSidebarWidth() {
  try {
    const value = Number(window.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) ? Math.min(520, Math.max(240, value)) : 320;
  } catch { return 320; }
}
const sidebarWidth = ref(storedSidebarWidth()); const workspaceEl = ref<HTMLElement>(); const resizingSidebar = ref(false); let resizingPointerId: number | undefined;
const previewText = ref(""); const previewLoading = ref(false); const previewError = ref("");
const editorOpen = ref(false); const editing = ref(false); const draftTitle = ref(""); const draftDescription = ref(""); const draftNodeId = ref(""); const draftMaxIdleAiSessions = ref(STORY_DEFAULT_MAX_IDLE_AI_SESSIONS); const saving = ref(false);
const newSessionInstanceId = ref(""); const newSessionInitialCwd = ref(""); const newSessionInitialCwdFolderId = ref(""); const assignSessionOpen = ref(false); const assignSessionId = ref(""); const assigningSession = ref(false);
const actionEditorOpen = ref(false); const actionEditorRevision = ref(0); const actionCreationPanel = ref<InstanceType<typeof StoryActionEditorContent>>(); const actionCreationSubmitReady = ref(false); const editingActionId = ref<string | null>(null); const actionSaving = ref(false); const actionDraftTitle = ref(""); const actionDraftMode = ref<StorySessionPreset["mode"] | "">(""); const actionDraftTargetInstanceId = ref(""); const actionDraftInitialPrompt = ref(""); const actionDraftInitialPreset = ref<StorySessionPreset>();
const targetInstance = (instanceId: string) => props.instances.find((instance) => instance.id === instanceId);
const foldersForInstance = (instanceId: string) => {
  const nodeId = targetInstance(instanceId)?.nodeId;
  return nodeId ? props.nodeLocalFoldersByNodeId[nodeId] || [] : [];
};
const sessionsFor = (story: Story): SessionEntry[] => {
  const instancesById = new Map(props.instances.map((instance) => [instance.id, instance]));
  const entries = props.instances.flatMap((instance) => (instance.aiSessions.sessions || [])
    .filter((session) => session.storyId === story.id && instance.node?.id === story.ownerNodeId)
    .map((session) => ({ instanceId: instance.id, session })));
  return sortedAiSessionInboxEntries(entries).map((entry) => ({
    instance: instancesById.get(entry.instanceId)!,
    session: entry.session,
  }));
};
const unassignedSessionsFor = (story: Story) => props.instances.flatMap((instance) => (instance.aiSessions.sessions || []).filter((session) => !session.storyId && instance.node?.id === story.ownerNodeId).map((session) => ({ instance, session })));
const STORY_DETAIL_PAGE_SIZE = 10;
const storyDocumentPage = ref(1);
const storyCurrentSessionPage = ref(1);
const storyHistoryPage = ref(1);
const storyHistoryEntries = ref<StoryHistoryEntry[]>([]);
const storyDetail = computed(() => selectedResource.value?.kind === "story" ? selectedResource.value.story : undefined);
const storyDetailDocuments = computed(() => storyDetail.value?.documents || []);
const storyCurrentSessions = computed(() => storyDetail.value ? sessionsFor(storyDetail.value) : []);
const pageCount = (length: number) => Math.max(1, Math.ceil(length / STORY_DETAIL_PAGE_SIZE));
const pageItems = <T,>(items: T[], page: number) => items.slice((page - 1) * STORY_DETAIL_PAGE_SIZE, page * STORY_DETAIL_PAGE_SIZE);
const storyDocumentPageCount = computed(() => pageCount(storyDetailDocuments.value.length));
const storyCurrentSessionPageCount = computed(() => pageCount(storyCurrentSessions.value.length));
const storyHistoryPageCount = computed(() => pageCount(storyHistoryEntries.value.length));
const pagedStoryDocuments = computed(() => pageItems(storyDetailDocuments.value, storyDocumentPage.value));
const pagedStoryCurrentSessions = computed(() => pageItems(storyCurrentSessions.value, storyCurrentSessionPage.value));
const pagedStoryHistoryEntries = computed(() => pageItems(storyHistoryEntries.value, storyHistoryPage.value));
type StorySessionView = "current" | "history";
const storySessionView = ref<StorySessionView>("current");
const storyHistoryLoading = ref(false);
const storyHistoryError = ref("");
const storyHistoryDetailOpen = ref(false);
const storyHistoryDetailEntry = ref<StoryHistoryEntry>();
let storyHistoryRequestRevision = 0;
function storyHistoryItemTitle(item: AiSessionHistoryItem) {
  return item.title?.trim() || item.userPrompt?.trim() || item.lastMessage?.trim() || t("sessions.panel.unnamedConversation");
}
function formatStoryHistoryTime(value: string) {
  return new Date(value).toLocaleString(locale.value);
}
async function loadStoryHistory() {
  const story = selectedResource.value?.story;
  if (!story) return;
  const instances = instancesForStory(story);
  const revision = ++storyHistoryRequestRevision;
  storyHistoryLoading.value = true;
  storyHistoryError.value = "";
  try {
    const settled = await Promise.allSettled(instances.map((instance) => getAiSessionHistory(instance.id)));
    const entries: StoryHistoryEntry[] = [];
    const failedInstances: string[] = [];
    settled.forEach((result, index) => {
      const instance = instances[index];
      if (!instance) return;
      if (result.status === "fulfilled") {
        for (const item of result.value.items) {
          if (item.storyId === story.id) entries.push({ instance, item });
        }
      } else {
        failedInstances.push(instance.name);
      }
    });
    if (revision !== storyHistoryRequestRevision) return;
    entries.sort((left, right) => Date.parse(right.item.lastActiveAt) - Date.parse(left.item.lastActiveAt));
    storyHistoryEntries.value = entries;
    if (!entries.length && failedInstances.length) storyHistoryError.value = t("stories.historySessionsFailed");
  } catch (cause) {
    if (revision !== storyHistoryRequestRevision) return;
    storyHistoryError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (revision === storyHistoryRequestRevision) storyHistoryLoading.value = false;
  }
}
function setStorySessionView(view: StorySessionView) {
  storySessionView.value = view;
  if (view === "history" && !storyHistoryEntries.value.length && !storyHistoryLoading.value) void loadStoryHistory();
}
function openStoryHistoryEntry(entry: StoryHistoryEntry) {
  storyHistoryDetailEntry.value = entry;
  storyHistoryDetailOpen.value = true;
}
function handleStoryHistorySessionSelected(instanceId: string, sessionId: string) {
  const story = selectedResource.value?.story;
  const instance = props.instances.find((candidate) => candidate.id === instanceId);
  const session = instance?.aiSessions.sessions.find((candidate) => candidate.id === sessionId);
  if (!story || !instance || !session) return;
  storyHistoryDetailOpen.value = false;
  selectedResource.value = { kind: "session", story, entry: { instance, session } };
}
const storyHistoryPanelInstance = computed(() => storyHistoryDetailEntry.value?.instance);
const storyHistoryPanelSession = computed<SessionTab>(() => ({
  key: "ai",
  label: t("navigation.ai"),
  status: "running",
  kind: "ai",
  aiSessions: storyHistoryPanelInstance.value?.aiSessions.sessions || [],
}));
const storyHistoryPanelSelectedSession = () => undefined as AiSessionSummary | undefined;
const queryClient = useQueryClient();
const closingSessionKey = ref("");
function storyTargetFor(entry: SessionEntry): AiSessionStoryTarget | undefined {
  return aiSessionStoryTarget(entry.instance, entry.session, props.nodes.find((node) => node.id === entry.instance.nodeId)?.name);
}
function shortHash(value: string) { return value.length > 14 ? `${value.slice(0, 10)}...` : value; }
function storyOwnerNodeName(nodeId: string) { return props.nodes.find((node) => node.id === nodeId)?.name || nodeId; }
function actionTargetName(story: Story, action: StoryAction) { const id = action.targetInstanceId; const instance = id && instancesForStory(story).find((item) => item.id === id); return instance?.name || id || t("stories.defaultTarget"); }
function actionAgentLabel(agent: string) {
  return ["codex", "claude", "opencode"].includes(agent) ? t(`common.products.${agent}`) : agent;
}
function actionSessionPresetSummary(action: StoryAction) {
  const preset = action.sessionPreset;
  if (!preset) return "";
  const parts: string[] = [];
  if (preset.agent) parts.push(actionAgentLabel(preset.agent));
  if (preset.modelSelection?.modelName) parts.push(preset.modelSelection.modelName);
  if (preset.reasoningEffort) parts.push(t(`stories.actionEditor.reasoning.${preset.reasoningEffort}`));
  if (preset.mode) parts.push(t(`stories.actionEditor.${preset.mode === "auto" ? "auto" : preset.mode}`));
  if (preset.permissionMode) parts.push(t(`stories.actionEditor.${preset.permissionMode === "auto-review" ? "autoReview" : preset.permissionMode === "full-access" ? "fullAccess" : "ask"}`));
  if (preset.cwdFolderId) {
    const folder = foldersForInstance(action.targetInstanceId || "").find((item) => item.id === preset.cwdFolderId);
    parts.push(folder?.name || t("stories.folderFallback"));
  }
  if (preset.gitSelection) parts.push(t(preset.gitSelection.mode === "worktree" ? "stories.actionEditor.worktree" : "stories.actionEditor.currentFolder"));
  return parts.join(" · ");
}
async function refreshStorySessions() { await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }); }
async function closeSession(entry: SessionEntry) {
  if (closingSessionKey.value) return;
  closingSessionKey.value = entry.session.id;
  const loadingToast = showDelayedControlPlaneLoadingToast(t("sessions.actions.closingSession"));
  try {
    await closeAiSession(entry.instance.id, entry.session.id, createBrowserUuid());
    showControlPlaneToast(t("sessions.actions.closeSession"), "success");
    await refreshStorySessions();
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t, t("sessions.panel.closeSessionFailed")));
  } finally {
    loadingToast.dismiss();
    closingSessionKey.value = "";
  }
}
async function onStoryAssigned(_target: AiSessionStoryTarget) {
  showControlPlaneToast(t("sessions.actions.storyAssigned"), "success");
  await refreshStorySessions();
}
function onStoryAssignFailed(_target: AiSessionStoryTarget, error: unknown) {
  showControlPlaneToast(translateApiError(error, t, t("sessions.actions.storyAssignFailed")));
}
const latestSessionFor = (story: Story) => sessionsFor(story).reduce<SessionEntry | undefined>((latest, entry) => !latest || Date.parse(entry.session.updatedAt) > Date.parse(latest.session.updatedAt) ? entry : latest, undefined);
const instancesForStory = (story: Story) => props.instances.filter((instance) => instance.node?.id === story.ownerNodeId);
const documentResource = computed(() => selectedResource.value?.kind === "document" ? selectedResource.value : undefined);
const documentInstanceId = computed(() => { const resource = documentResource.value; return resource ? instancesForStory(resource.story)[0]?.id ?? "" : ""; });
const documentMarkdownSessionId = computed(() => { const resource = documentResource.value; return resource ? `${resource.story.ownerNodeId}:${resource.story.id}:${resource.document.storyPath}` : ""; });
const documentHtmlPolicy = computed<"escape" | "safe">(() => {
  const resource = documentResource.value;
  return resource && /\.html?$/i.test(resource.document.storyPath) ? "safe" : "escape";
});
const markdownCodeTools = computed(() => ({ copiedLabel: t("sessions.markdown.copied"), copyLabel: t("sessions.markdown.copy"), plainTextLabel: t("sessions.markdown.plainText") }));
function onOpenDocumentLink(href: string) {
  const resource = selectedResource.value;
  if (resource?.kind !== "document") return;
  const clean = href.split("#")[0]?.split("?")[0]?.replace(/^\.?\//, "").trim();
  if (!clean) return;
  const target = resource.story.documents.find((candidate) => candidate.storyPath === clean || candidate.storyPath.endsWith(`/${clean}`));
  if (target) selectDocument(resource.story, target.storyPath);
}
const storyInstances = computed(() => { const story = selectedResource.value?.story; return story ? instancesForStory(story) : []; });
const newSessionInstance = computed(() => storyInstances.value.find((instance) => instance.id === newSessionInstanceId.value));
const creationActiveSession = computed<SessionTab>(() => ({ key: "ai", label: t("navigation.ai"), status: "running", kind: "ai", aiSessions: newSessionInstance.value?.aiSessions.sessions || [] }));
const selectedSessionInstance = computed<InstanceWithAiSessions | undefined>(() => {
  const resource = selectedResource.value;
  if (resource?.kind !== "session") return undefined;
  return props.instances.find((instance) => instance.id === resource.entry.instance.id) || resource.entry.instance;
});
const storySessionTab = computed<SessionTab>(() => {
  return { key: "ai", label: t("navigation.ai"), status: "running", kind: "ai", aiSessions: selectedSessionInstance.value?.aiSessions.sessions || [] };
});
const noSelectedAiSession = () => undefined as AiSessionSummary | undefined;
const selectedStorySession = (_instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => {
  const resource = selectedResource.value;
  if (resource?.kind !== "session") return undefined;
  const entryId = resource.entry.session.id;
  return sessions?.find((session) => session.id === entryId) || resource.entry.session;
};
const availableSessions = computed(() => { const story = selectedResource.value?.story; return story ? unassignedSessionsFor(story) : []; });
const sessionCount = (story: Story) => sessionsFor(story).length;
const storyKey = (story: Story) => `${story.ownerNodeId}:${story.id}`;
const isSelectedStory = (story: Story) => selectedResource.value?.story.id === story.id && selectedResource.value?.story.ownerNodeId === story.ownerNodeId;
const isStoryOpen = (story: Story) => expandedStoryKeys.value.has(storyKey(story));
const isStorySelected = (story: Story) => (selectedResource.value?.kind === "story" || selectedResource.value?.kind === "new-session") && isSelectedStory(story);
const isDocumentSelected = (story: Story, path: string) => selectedResource.value?.kind === "document" && isSelectedStory(story) && selectedResource.value.document.storyPath === path;
const isSessionSelected = (story: Story, id: string) => selectedResource.value?.kind === "session" && isSelectedStory(story) && selectedResource.value.entry.session.id === id;
const treeDocumentsFor = (story: Story) => latestStoryDocuments(story.documents, expandedDocumentStoryKeys.value.has(storyKey(story)));
const hasMoreTreeDocuments = (story: Story) => story.documents.length > STORY_TREE_DOCUMENT_LIMIT && !expandedDocumentStoryKeys.value.has(storyKey(story));
function showAllTreeDocuments(story: Story) { expandedDocumentStoryKeys.value = new Set(expandedDocumentStoryKeys.value).add(storyKey(story)); }
function setStoryExpanded(story: Story, expanded: boolean) { const next = new Set(expandedStoryKeys.value); const key = storyKey(story); if (expanded) next.add(key); else next.delete(key); expandedStoryKeys.value = next; persistExpandedStoryKeys(next); }
function toggleStoryExpanded(story: Story) { setStoryExpanded(story, !isStoryOpen(story)); }
function selectStory(story: Story) { selectedResource.value = { kind: "story", story }; }
function selectDocument(story: Story, path: string) { const document = story.documents.find((item) => item.storyPath === path); if (document) { setStoryExpanded(story, true); if (!treeDocumentsFor(story).includes(document)) showAllTreeDocuments(story); selectedResource.value = { kind: "document", story, document }; } }
function selectSession(story: Story, entry: SessionEntry) { setStoryExpanded(story, true); selectedResource.value = { kind: "session", story, entry }; }
function openAutomationSession(story: Story, instanceId: string, sessionId: string) { const instance = props.instances.find((candidate) => candidate.id === instanceId); const session = instance?.aiSessions.sessions.find((candidate) => candidate.id === sessionId); if (instance && session) selectSession(story, { instance, session }); }
function setStoryAutomationEntries(entries: StoryAutomationView[]) { storyAutomationEntries.value = entries; }
function actionAutomations(actionId: string) { return storyAutomationEntries.value.filter((entry) => entry.automation.actionId === actionId); }
function automationScheduleLabel(schedule: StoryAutomationSchedule) {
  if (schedule.scheduleKind === "interval") return t("stories.automation.everyMinutes", { count: schedule.intervalMs / 60_000 });
  if (schedule.scheduleKind === "daily") return t("stories.automation.dailyAt", { time: schedule.timeOfDay, timezone: schedule.timezone });
  if (schedule.scheduleKind === "weekly") {
    const days = schedule.weekdays.map((day) => new Intl.DateTimeFormat(locale.value, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 7, 2 + day)))).join(", ");
    return t("stories.automation.weeklyAt", { days, time: schedule.timeOfDay, timezone: schedule.timezone });
  }
  return t("stories.automation.monthlyAt", { day: schedule.dayOfMonth, time: schedule.timeOfDay, timezone: schedule.timezone });
}
function syncStoryDetailHeadOffset() {
  if (!storyDetailScrollInnerEl.value || !storyDetailHeadEl.value) return;
  storyDetailScrollInnerEl.value.style.setProperty("--story-detail-head-height", `${storyDetailHeadEl.value.offsetHeight}px`);
}
watch(storyDetailHeadEl, (head) => {
  storyDetailHeadResizeObserver?.disconnect();
  if (!head || typeof ResizeObserver === "undefined") return;
  const update = () => syncStoryDetailHeadOffset();
  storyDetailHeadResizeObserver = new ResizeObserver(update);
  storyDetailHeadResizeObserver.observe(head);
  update();
}, { immediate: true });
function storySectionElement(section: StoryDetailSection) {
  return { actions: storyActionsSectionEl.value, documents: storyDocumentsSectionEl.value, sessions: storySessionsSectionEl.value, automations: storyAutomationsSectionEl.value }[section];
}
async function scrollToStorySection(section: StoryDetailSection) {
  storyDetailSection.value = section;
  await nextTick();
  storySectionElement(section)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}
async function scrollToAutomation(automationId: string) {
  await scrollToStorySection("automations");
  await nextTick();
  const row = storyAutomationsSectionEl.value?.querySelector<HTMLElement>(`[data-automation-id="${automationId}"]`);
  row?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  row?.focus({ preventScroll: true });
}
function resourceKey(resource: Resource | undefined) {
  if (!resource) return "";
  const parentKey = storyKey(resource.story);
  if (resource.kind === "document") return `${resource.kind}:${parentKey}:${resource.document.storyPath}`;
  if (resource.kind === "session") return `${resource.kind}:${parentKey}:${resource.entry.instance.id}:${resource.entry.session.id}`;
  return `${resource.kind}:${parentKey}`;
}
function selectPendingCreatedStorySession() {
  const pending = pendingCreatedStorySession.value;
  if (!pending) return;
  if (resourceKey(selectedResource.value) !== pending.sourceResourceKey) {
    pendingCreatedStorySession.value = undefined;
    return;
  }
  const instance = props.instances.find((candidate) => candidate.id === pending.instanceId);
  const session = instance?.aiSessions.sessions.find((candidate) => candidate.id === pending.sessionId && candidate.storyId === pending.story.id);
  if (!instance || !session) return;
  pendingCreatedStorySession.value = undefined;
  selectSession(pending.story, { instance, session });
}
watch(() => props.instances, selectPendingCreatedStorySession);
function handleSelectAiSession(instanceId: string, sessionId: string) {
  const resource = selectedResource.value;
  if (resource?.kind !== "session") return;
  const instance = props.instances.find((candidate) => candidate.id === instanceId);
  const session = instance?.aiSessions.sessions.find((candidate) => candidate.id === sessionId);
  if (instance && session) selectedResource.value = { kind: "session", story: resource.story, entry: { instance, session } };
}
function openStoryAiSessionApp(instance: InstanceBoardItem, session?: AiSessionSummary) {
  emit("open-session", instance as InstanceWithAiSessions, session);
}
function startSidebarResize(event: PointerEvent) { if (window.matchMedia("(max-width: 800px)").matches || !workspaceEl.value) return; resizingSidebar.value = true; resizingPointerId = event.pointerId; (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId); window.addEventListener("pointermove", resizeSidebar); window.addEventListener("pointerup", stopSidebarResize); window.addEventListener("pointercancel", stopSidebarResize); }
function resizeSidebar(event: PointerEvent) { if (!resizingSidebar.value || event.pointerId !== resizingPointerId || !workspaceEl.value) return; sidebarWidth.value = Math.min(520, Math.max(240, event.clientX - workspaceEl.value.getBoundingClientRect().left)); }
function stopSidebarResize(event?: PointerEvent) { if (event && resizingPointerId !== undefined && event.pointerId !== resizingPointerId) return; resizingSidebar.value = false; resizingPointerId = undefined; window.removeEventListener("pointermove", resizeSidebar); window.removeEventListener("pointerup", stopSidebarResize); window.removeEventListener("pointercancel", stopSidebarResize); }
watch(sidebarWidth, (width) => { try { window.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width)); } catch { /* Local storage may be unavailable in restricted browser contexts. */ } });
async function load() {
  error.value = "";
  try {
    const result = await storiesQuery.refetch();
    if (result.error) error.value = result.error instanceof Error ? result.error.message : String(result.error);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
watch(selectedResource, async (resource) => { previewText.value = ""; previewError.value = ""; if (resource?.kind === "document") { previewLoading.value = true; try { const response = await fetch(`/api/stories/${encodeURIComponent(resource.story.id)}/content/file?nodeId=${encodeURIComponent(resource.story.ownerNodeId)}&storyPath=${encodeURIComponent(resource.document.storyPath)}`); if (!response.ok) throw new Error((await response.json()).error?.message || "Could not read document."); previewText.value = await response.text(); } catch (cause) { previewError.value = cause instanceof Error ? cause.message : String(cause); } finally { previewLoading.value = false; } } }, { immediate: true });
watch(() => selectedResource.value?.kind === "story" ? `${selectedResource.value.story.ownerNodeId}:${selectedResource.value.story.id}` : "", () => {
  storyDetailSection.value = "actions";
  storyAutomationEntries.value = [];
  storySessionView.value = "current";
  storyDocumentPage.value = 1;
  storyCurrentSessionPage.value = 1;
  storyHistoryPage.value = 1;
  storyHistoryEntries.value = [];
  storyHistoryLoading.value = false;
  storyHistoryError.value = "";
  storyHistoryRequestRevision += 1;
});
watch(storyDocumentPageCount, (total) => { storyDocumentPage.value = Math.min(storyDocumentPage.value, total); });
watch(storyCurrentSessionPageCount, (total) => { storyCurrentSessionPage.value = Math.min(storyCurrentSessionPage.value, total); });
watch(storyHistoryPageCount, (total) => { storyHistoryPage.value = Math.min(storyHistoryPage.value, total); });
watch(stories, (value) => {
  const resource = selectedResource.value;
  if (!resource) {
    if (value[0]) selectStory(value[0]);
    return;
  }
  const present = value.some((story) => story.id === resource.story.id && story.ownerNodeId === resource.story.ownerNodeId);
  if (!present) selectedResource.value = value[0] ? { kind: "story", story: value[0] } : undefined;
}, { immediate: true });
function openCreate() {
  editing.value = false;
  draftTitle.value = "";
  draftDescription.value = "";
  draftMaxIdleAiSessions.value = STORY_DEFAULT_MAX_IDLE_AI_SESSIONS;
  const filterNodeId = props.filterNodeId?.trim();
  draftNodeId.value = filterNodeId && props.nodes.some((node) => node.id === filterNodeId && node.status === "online")
    ? filterNodeId
    : props.nodes.find((node) => node.status === "online")?.id || "";
  editorOpen.value = true;
}
async function openEdit() {
  const story = selectedResource.value?.story;
  if (!story) return;
  editing.value = true;
  draftTitle.value = story.title;
  draftDescription.value = story.description || "";
  draftNodeId.value = story.ownerNodeId;
  draftMaxIdleAiSessions.value = STORY_DEFAULT_MAX_IDLE_AI_SESSIONS;
  try {
    const settings = await getStoryRetentionSettings(story.id, story.ownerNodeId);
    draftMaxIdleAiSessions.value = settings.maxIdleAiSessions;
    editorOpen.value = true;
  } catch (cause) {
    error.value = translateApiError(cause, t, t("stories.errors.retentionLoadFailed"));
  }
}
function openNewSession(story: Story) { if (!story) return; const latest = latestSessionFor(story); setStoryExpanded(story, true); newSessionInstanceId.value = latest?.instance.id || instancesForStory(story)[0]?.id || ""; newSessionInitialCwd.value = latest?.session.cwd || ""; newSessionInitialCwdFolderId.value = latest?.session.cwdFolderId || ""; selectedResource.value = { kind: "new-session", story }; }
function selectCreationInstance(instanceId: string) { newSessionInstanceId.value = instanceId; newSessionInitialCwd.value = ""; newSessionInitialCwdFolderId.value = ""; }
function openAssignSession() { assignSessionId.value = availableSessions.value[0] ? `${availableSessions.value[0].instance.id}:${availableSessions.value[0].session.id}` : ""; assignSessionOpen.value = true; }
function openAssignSessionFor(story: Story) { if (!story || story.archivedAt) return; selectStory(story); openAssignSession(); }
function editStoryFromTree(story: Story) { if (!story) return; selectStory(story); void openEdit(); }
function openCreateAction(story?: Story) {
  const target = story || selectedResource.value?.story;
  if (!target || target.archivedAt) return;
  editingActionId.value = null;
  actionDraftTitle.value = "";
  actionDraftMode.value = "";
  actionDraftInitialPrompt.value = "";
  actionDraftInitialPreset.value = undefined;
  actionDraftTargetInstanceId.value = storyInstances.value[0]?.id || "";
  actionCreationSubmitReady.value = false;
  actionEditorRevision.value += 1;
  actionEditorOpen.value = true;
}
function openCreateActionForStory(story: Story) {
  if (!story || story.archivedAt) return;
  selectStory(story);
  openCreateAction(story);
}
async function openCreateAutomation(story?: Story) {
  const target = story || selectedResource.value?.story;
  if (!target || target.archivedAt) return;
  if (story) selectStory(story);
  await nextTick();
  storyAutomationsPanel.value?.openCreate();
}
function openCreateAutomationForStory(story: Story) {
  void openCreateAutomation(story);
}
function handleActionEditorOpenChange(open: boolean) {
  actionEditorOpen.value = open;
}
function openEditAction(action: StoryAction) {
  const story = selectedResource.value?.story;
  if (!story || story.archivedAt) return;
  editingActionId.value = action.id;
  actionDraftTitle.value = action.title;
  actionDraftMode.value = action.sessionPreset?.mode || "";
  actionDraftInitialPrompt.value = action.promptTemplate;
  actionDraftInitialPreset.value = action.sessionPreset;
  actionDraftTargetInstanceId.value = action.targetInstanceId || storyInstances.value[0]?.id || "";
  actionCreationSubmitReady.value = false;
  actionEditorRevision.value += 1;
  actionEditorOpen.value = true;
}
function submitActionCreation() { actionCreationPanel.value?.submitCreation(); }
async function saveAction(draft: AiSessionCreationPresetDraft) {
  const story = selectedResource.value?.story;
  if (!story || story.archivedAt || actionSaving.value) return;
  const title = actionDraftTitle.value.trim();
  const promptTemplate = draft.prompt.trim();
  if (!title || !promptTemplate) { error.value = t("stories.actionEditor.validationRequired"); return; }
  const actions = [...story.actions];
  const targetInstanceId = draft.instanceId;
  if (!targetInstanceId) { error.value = t("stories.actionEditor.validationTarget"); return; }
  const sessionPreset: StorySessionPreset = {
    ...draft.sessionPreset,
    ...(actionDraftMode.value ? { mode: actionDraftMode.value } : {}),
  } satisfies StorySessionPreset;
  if (editingActionId.value) {
    const index = actions.findIndex((action) => action.id === editingActionId.value);
    if (index < 0) { error.value = t("stories.actionEditor.notFound"); return; }
    actions[index] = { ...actions[index], title, promptTemplate, targetInstanceId, sessionPreset };
  } else {
    actions.push({ id: createBrowserUuid(), title, promptTemplate, targetInstanceId, sessionPreset });
  }
  actionSaving.value = true;
  try {
    const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId, input: { actions } }) });
    if (!response.ok) throw new Error((await response.json()).error?.message || t("stories.actionEditor.saveFailed"));
    actionEditorOpen.value = false;
    await load();
    const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId);
    if (refreshed) selectStory(refreshed);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { actionSaving.value = false; }
}
async function createAutomationWithAction(payload: { action: StoryAction; config: { schedule: StoryAutomationSchedule; enabled: boolean; policy: { maxConcurrentRuns: number; whenBusy: "skip" | "queue"; cooldownMs?: number } } }) {
  const story = selectedResource.value?.story;
  if (!story || actionSaving.value) return;
  actionSaving.value = true;
  error.value = "";
  try {
    await sharedControlPlaneClient.stories.createAutomationWithAction(story.id, story.ownerNodeId, { action: payload.action, automation: payload.config });
    await load();
    const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId);
    if (refreshed) selectStory(refreshed);
  } catch (cause) {
    throw cause;
  } finally {
    actionSaving.value = false;
  }
}
function queueCreatedStorySession(story: Story, instanceId: string, sessionId: string, sourceResourceKey: string) {
  pendingCreatedStorySession.value = { story, instanceId, sessionId, sourceResourceKey };
  selectPendingCreatedStorySession();
}
function finishStorySessionCreation(instanceId: string, sessionId: string) {
  const story = selectedResource.value?.story;
  if (story) queueCreatedStorySession(story, instanceId, sessionId, resourceKey(selectedResource.value));
}
function storyActionCreationFinished(story: Story) {
  const sourceResourceKey = resourceKey(selectedResource.value);
  return (instanceId: string, sessionId: string) => queueCreatedStorySession(story, instanceId, sessionId, sourceResourceKey);
}
async function assignExistingSession() { const story = selectedResource.value?.story; const [instanceId, sessionId] = assignSessionId.value.split(":"); if (!story || !instanceId || !sessionId || assigningSession.value) return; assigningSession.value = true; try { const response = await fetch(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/story`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ storyId: story.id }) }); if (!response.ok) throw new Error(t("stories.errors.assignFailed")); assignSessionOpen.value = false; await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { assigningSession.value = false; } }
async function saveStory() {
  if (!draftTitle.value.trim() || !draftNodeId.value || saving.value) return;
  const maxIdleAiSessions = Number(draftMaxIdleAiSessions.value);
  saving.value = true;
  try {
    const story = selectedResource.value?.story;
    const response = await fetch(editing.value && story ? `/api/stories/${encodeURIComponent(story.id)}` : "/api/stories", {
      method: editing.value ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editing.value
        ? { nodeId: draftNodeId.value, input: { title: draftTitle.value.trim(), description: draftDescription.value.trim() || null, maxIdleAiSessions } }
        : { nodeId: draftNodeId.value, input: { title: draftTitle.value.trim(), description: draftDescription.value.trim() || undefined, maxIdleAiSessions } }),
    });
    if (!response.ok) throw new Error((await response.json()).error?.message || t("stories.errors.saveFailed"));
    editorOpen.value = false;
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}
async function toggleArchive(story: Story = selectedResource.value?.story) { if (!story) return; const action = story.archivedAt ? "restore" : "archive"; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId }) }); if (!response.ok) { error.value = t("stories.errors.updateFailed"); return; } await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); }
function downloadUrl(story: Story, storyPath: string) { return `/api/stories/${encodeURIComponent(story.id)}/content/file?nodeId=${encodeURIComponent(story.ownerNodeId)}&storyPath=${encodeURIComponent(storyPath)}`; }
function downloadDocument(story: Story, storyPath: string) { const anchor = document.createElement("a"); anchor.href = downloadUrl(story, storyPath); anchor.download = storyPath.split("/").pop() || storyPath; anchor.click(); }
async function deleteStory(story: Story) { if (!story) return; if (!window.confirm(t("stories.confirm.deleteStory", { title: story.title }))) return; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}?nodeId=${encodeURIComponent(story.ownerNodeId)}`, { method: "DELETE" }); if (!response.ok) { error.value = t("stories.errors.deleteFailed"); return; } await load(); const resource = selectedResource.value; if (resource && resource.story.id === story.id && resource.story.ownerNodeId === story.ownerNodeId) selectedResource.value = undefined; }
async function renameDocument(story: Story, storyPath: string, title: string) { const next = window.prompt(t("stories.confirm.documentTitle"), title)?.trim(); if (!next || next === title) return; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}/documents/${encodeURIComponent(storyPath)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId, input: { title: next } }) }); if (!response.ok) { error.value = t("stories.errors.renameDocumentFailed"); return; } await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectDocument(refreshed, storyPath); }
async function deleteDocument(story: Story, storyPath: string) { if (!window.confirm(t("stories.confirm.deleteDocument"))) return; const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}/documents/${encodeURIComponent(storyPath)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: story.ownerNodeId }) }); if (!response.ok) { error.value = t("stories.errors.deleteDocumentFailed"); return; } await load(); const refreshed = stories.value.find((item) => item.id === story.id && item.ownerNodeId === story.ownerNodeId); if (refreshed) selectStory(refreshed); }
onBeforeUnmount(() => {
  stopSidebarResize();
  cancelStoryPointerDrag();
  storyDetailHeadResizeObserver?.disconnect();
  storyDetailHeadResizeObserver = undefined;
});
</script>

<style scoped>
.story-view { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; background:var(--workspace-bg); padding:12px 0; color:var(--text); }
.story-content-header h2 { margin:0; color:var(--text-strong); font-size:18px; font-weight:500; }
.story-description,.story-content-header small { color:var(--text-muted); font-size:12px; }
.story-description { max-width:720px; margin:8px 0 0; line-height:1.5; }
.story-workspace { display:grid; grid-template-columns:minmax(240px,var(--story-sidebar-width,320px)) 2px minmax(0,1fr); gap:0; flex:1 1 auto; min-height:0; margin-top:0; overflow:hidden; }
.story-sidebar { display:grid; min-width:0; min-height:0; grid-template-rows:auto minmax(0,1fr); }
.story-sidebar-actions { padding:0 10px; }
.story-new-button { width:100%; padding-block:11px; }
.story-sidebar-section { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0 4px 8px; }
.story-sidebar-section-label { color:var(--text-muted); font-size:12px; font-weight:500; line-height:1; }
.story-view-mode-button { width:26px; height:26px; color:var(--text-muted); }
.story-view-mode-button:hover { color:var(--text-strong); }
:global(.story-list-options-menu) { display:grid; width:176px; gap:2px; border:1px solid var(--line-strong); border-radius:8px; background:var(--surface-inset); box-shadow:var(--shadow-popover); padding:5px; }
:global(.story-list-options-label) { color:var(--text-muted); font-size:11px; font-weight:500; line-height:1; padding:7px 8px 5px; }
:global(.story-list-options-separator) { margin:4px -5px; background:var(--surface-active); }
:global(.story-list-options-item) { display:flex; align-items:center; gap:7px; width:100%; min-height:30px; border:0; border-radius:6px; background:transparent; color:var(--control-plane-menu-text); cursor:pointer; font-size:12px; font-weight:400; padding:0 8px 0 28px; text-align:left; }
:global(.story-list-options-item:hover),:global(.story-list-options-item:focus-visible),:global(.story-list-options-item[data-highlighted]) { background:var(--surface-active); color:var(--control-plane-menu-hover-text); outline:none; }
:global(.story-list-options-item .absolute) { left:8px; width:12px; height:12px; }
:global(.story-list-options-item .absolute svg) { width:9px; height:9px; }
.story-sidebar-scroll { min-width:0; min-height:0; }
.story-sidebar-scroll-inner { min-width:0; padding:0 10px 12px; }
.story-sidebar-scroll :deep([data-task-handoff-scroll-viewport] > div) { width:100%; min-width:0 !important; }
.story-loading-overlay { position:absolute; inset:0; z-index:5; display:grid; place-items:center; border-radius:8px; background:color-mix(in srgb,var(--surface) 72%,transparent); backdrop-filter:blur(1px); }
.story-loading-spin { color:var(--text-muted); animation:story-loading-spin 0.9s linear infinite; }
@keyframes story-loading-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .story-loading-spin { animation:none; } }
.story-sidebar-resize-handle { position:relative; z-index:20; align-self:stretch; width:2px; min-width:2px; height:100%; margin-inline-end:12px; border:0; background:transparent; cursor:col-resize; padding:0; touch-action:none; }
.story-sidebar-resize-handle::after { display:block; width:2px; height:100%; margin:0 auto; background:var(--line); content:""; opacity:.45; transition:background 120ms ease,opacity 120ms ease,box-shadow 120ms ease; }
.story-sidebar-resize-handle:hover::after,.story-sidebar-resize-handle:focus-visible::after,.story-workspace[data-resizing="true"] .story-sidebar-resize-handle::after { background:color-mix(in srgb,var(--line-strong) 72%,var(--brand-accent)); box-shadow:0 0 0 1px color-mix(in srgb,var(--line-strong) 42%,transparent); opacity:1; }
.story-sidebar-resize-handle:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-3px; }
.story-workspace[data-resizing="true"] { user-select:none; cursor:col-resize; }
.story-tree + .story-tree { margin-top:2px; }
.story-tree-manual { cursor:grab; touch-action:pan-y; -webkit-touch-callout:none; }
.story-tree-manual:active { cursor:grabbing; }
.story-tree-dragging { opacity:.46; }
.story-tree[data-drop-position="before"] { box-shadow:inset 0 2px 0 var(--brand-accent); }
.story-tree[data-drop-position="after"] { box-shadow:inset 0 -2px 0 var(--brand-accent); }
:global(.story-pointer-overlay) { position:fixed; top:0; left:0; z-index:1000; display:flex; align-items:center; gap:8px; overflow:hidden; border:1px solid var(--line-strong); border-radius:6px; background:var(--surface-raised); box-shadow:var(--shadow-popover); color:var(--text-strong); font-size:13px; font-weight:500; padding:0 10px; pointer-events:none; user-select:none; will-change:transform; }
:global(.story-pointer-overlay span) { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
:global(body.story-pointer-dragging),:global(body.story-pointer-dragging *) { cursor:grabbing !important; user-select:none !important; }
:global(body.story-pointer-dragging iframe),:global(body.story-pointer-dragging webview) { pointer-events:none; }
.story-tree-children { display:grid; gap:2px; margin:2px 0 8px 16px; padding-left:8px; border-left:1px solid var(--line); }
.story-tree-collapse { display:grid; grid-template-rows:1fr; opacity:1; transition:grid-template-rows 180ms ease,opacity 140ms ease; }
.story-tree-collapse-inner { min-height:0; overflow:hidden; }
.story-tree-collapse-enter-from,.story-tree-collapse-leave-to { grid-template-rows:0fr; opacity:0; }
.story-tree-story-row { position:relative; }
.story-tree-item { position:relative; display:flex; align-items:center; width:100%; min-width:0; gap:8px; border:0; border-radius:6px; background:transparent; color:inherit; cursor:pointer; padding:8px; text-align:left; }
.story-tree-story { padding-right:36px; padding-left:32px; padding-block:10px; }
.story-tree-item:hover { background:var(--sidebar-row-hover-bg,var(--surface-active)); }
.story-tree-item.active,.story-tree-item.active:hover { background:var(--sidebar-row-selected-bg,var(--surface-active)); }
.story-tree-disclosure-button { position:absolute; z-index:1; top:50%; left:4px; display:grid; width:24px; height:24px; place-items:center; border:0; border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; transform:translateY(-50%); }
.story-tree-disclosure-button:hover,.story-tree-disclosure-button:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
.story-tree-disclosure { flex:0 0 auto; transition:transform 120ms ease; }
.story-tree-disclosure.expanded { transform:rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .story-tree-collapse,.story-tree-disclosure { transition:none; } }
.story-session-status,.story-session-icon { position:relative; display:grid; width:14px; height:14px; flex:0 0 auto; place-items:center; overflow:visible; }
.story-session-icon-status { position:absolute; top:-2px; right:-5px; }
.story-tree-item > .story-tree-item-copy { display:flex; align-items:center; min-width:0; flex:1; overflow:hidden; }
.story-tree-item > .story-tree-item-copy strong { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.3; }
.story-tree-item > .story-tree-item-copy.story-tree-item-detail { display:grid; gap:2px; line-height:1.5; overflow:visible; }
.story-tree-item > .story-tree-item-copy.story-tree-item-detail strong,
.story-tree-item > .story-tree-item-copy.story-tree-item-detail small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.5; }
.story-tree-item strong { font-size:13px; font-weight:500; }
.story-tree-item:not(.story-tree-story):not(.story-new-button):not(.story-tree-item-detailed) > .story-tree-item-copy strong { font-weight:400; }
.story-tree-item small,.story-tree-empty { color:var(--text-muted); font-size:12px; }
.story-tree-item:not(.story-tree-story):not(.story-new-button) { height:32px; padding-block:6px; }
.story-tree-item.story-tree-item-detailed:not(.story-tree-story):not(.story-new-button) { height:auto; padding-block:8px; }
.story-tree-more-documents { width:max-content; min-height:32px; border:0; background:transparent; color:var(--brand-accent); cursor:pointer; font-size:12px; font-weight:400; padding:6px 8px; text-align:left; }
.story-tree-more-documents:hover { text-decoration:underline; }
.story-tree-more-documents:focus-visible { border-radius:4px; outline:2px solid var(--focus-ring); outline-offset:-2px; }
.story-tree-item-hint { position:absolute; top:50%; right:8px; z-index:1; max-width:64%; overflow:hidden; padding-left:18px; color:var(--text-muted); font-size:12px; white-space:nowrap; text-overflow:ellipsis; pointer-events:none; opacity:0; transform:translateY(-50%); background:linear-gradient(90deg, transparent, var(--surface-active) 18px); transition:opacity 140ms ease; }
.story-tree-item:hover > .story-tree-item-hint { background:linear-gradient(90deg,transparent,var(--sidebar-row-hover-bg,var(--surface-active)) 18px); opacity:1; }
.story-tree-item.active > .story-tree-item-hint { background:linear-gradient(90deg,transparent,var(--sidebar-row-selected-bg,var(--surface-active)) 18px); }
.story-tree-item-unread > .story-tree-item-hint { right:24px; }
.story-session-unread { width:7px; height:7px; flex:0 0 auto; border-radius:999px; background:var(--status-info); box-shadow:0 0 0 3px color-mix(in srgb,var(--status-info) 18%,transparent); }
.story-tree-add { display:grid; grid:1fr/1fr; width:18px; height:18px; place-items:center; border:0; border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; }
.story-tree-story-add { position:absolute; top:50%; right:6px; width:24px; height:24px; transform:translateY(-50%); opacity:0; pointer-events:none; transition:opacity 120ms ease; }
.story-tree-story-row:hover .story-tree-story-add,.story-tree-story-add:focus-visible { opacity:1; pointer-events:auto; }
.story-tree-add:hover,.story-tree-add:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
.story-tree-add:disabled { cursor:default; }
.story-tree-story-add:disabled { opacity:0; pointer-events:none; }
.story-tree-story-row:hover .story-tree-story-add:disabled { opacity:.4; }
.story-tree-empty { padding:8px; }
.story-content { display:flex; min-width:0; min-height:0; flex-direction:column; overflow:hidden; padding:0 20px; }
.story-content.story-session-pane { padding:0; }
.story-content.story-session-pane > .story-session-creator { padding:0; background:transparent; }
.story-detail-scroll { flex:1; min-height:0; }
.story-detail-scroll :deep([data-task-handoff-scroll-viewport] > div) { width:100%; min-width:0 !important; }
.story-detail-scroll-inner { --story-detail-head-height:140px; display:grid; gap:12px; width:min(100%,1080px); min-width:0; margin:0 auto; padding:0 10px 32px 0; }
.story-detail-head { position:sticky; top:0; z-index:3; display:grid; gap:12px; min-width:0; padding-bottom:10px; background:var(--workspace-bg); }
.story-content-header { display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); padding:0 0 12px; flex:0 0 auto; }
.story-content-header > div:first-child:not(.story-content-title) { display:grid; min-width:0; gap:3px; }
.story-content-header .story-content-title { display:flex; flex:1 1 auto; align-items:baseline; gap:10px; min-width:0; }
.story-content-title h2 { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-content-title small { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.story-content-state { display:grid; flex:1; place-items:center; color:var(--text-muted); font-size:13px; padding:24px; }
.story-document-markdown { flex:1; min-height:0; color:var(--text); font-size:13px; line-height:1.6; }
.story-document-markdown :deep([data-task-handoff-scroll-viewport] > div) { width:100%; min-width:0 !important; }
.story-document-markdown-content { min-width:0; padding:16px 0 32px; }
.story-content-download { display:inline-flex; align-items:center; gap:6px; color:var(--text-muted); font-size:12px; text-decoration:none; }
.story-content-download:hover { color:var(--text-strong); }
.story-content-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.story-session-creator { flex:1; min-height:0; }
.story-detail-header-tabs { flex:0 0 auto; margin-left:auto; min-width:0; }
.story-detail-tabs { display:inline-flex; align-items:center; width:fit-content; height:32px; min-height:32px; border:1px solid var(--line); border-radius:7px; background:var(--surface-inset); padding:2px; }
.story-detail-tabs :deep(button) { height:26px; min-height:26px; border-radius:5px; font-size:12px; font-weight:500; padding:0 10px; }
.story-detail-tab-count { margin-right:4px; color:var(--text-strong); font-weight:500; }
.story-directory { scroll-margin-top:calc(var(--story-detail-head-height) + 12px); }
.story-directory { overflow:hidden; border:1px solid var(--line); border-radius:8px; background:var(--surface-raised); }
.story-directory-header { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:38px; border-bottom:1px solid var(--line); padding:0 12px; }
.story-directory-heading { display:flex; align-items:baseline; gap:7px; min-width:0; }
.story-directory-heading h3 { margin:0; color:var(--text-strong); font-size:13px; font-weight:500; }
.story-directory-heading span { color:var(--text-muted); font-size:12px; }
.story-session-tabs { width:auto; height:28px; min-height:28px; border:1px solid var(--line); border-radius:6px; background:var(--surface-inset); padding:2px; }
.story-session-tabs :deep(button) { height:22px; min-height:22px; border-radius:4px; font-size:12px; font-weight:400; padding:0 8px; }
.story-pagination { display:flex; align-items:center; justify-content:flex-end; gap:10px; min-height:36px; border-top:1px solid var(--line); color:var(--text-muted); font-size:12px; padding:3px 8px 3px 12px; }
.story-pagination > div { display:flex; align-items:center; gap:2px; }
.story-resource-item { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:10px; width:100%; min-width:0; border:0; background:transparent; color:inherit; cursor:pointer; padding:10px 12px; text-align:left; }
.story-resource-item + .story-resource-item { border-top:1px solid var(--line); }
.story-resource-item:hover, .story-resource-item.active { background:var(--surface-active); }
.story-resource-item-static, .story-resource-item-static:hover { cursor:default; background:var(--surface-raised); }
.story-resource-state { display:flex; align-items:center; gap:8px; min-height:64px; color:var(--text-muted); font-size:12px; padding:12px; }
.story-resource-state.story-error { color:var(--status-danger); }
.story-resource-icon { display:grid; flex:0 0 auto; width:28px; height:28px; place-items:center; color:var(--text-muted); }
.story-resource-session-icon { position:relative; }
.story-resource-session-status { position:absolute; top:2px; right:2px; }
.story-resource-copy { display:grid; gap:3px; min-width:0; }
.story-resource-copy strong { color:var(--text-strong); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-resource-copy small { color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-resource-unread { width:7px; height:7px; border-radius:999px; background:var(--status-info); box-shadow:0 0 0 3px color-mix(in srgb,var(--status-info) 18%,transparent); }
.story-action-item { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; background:transparent; }
.story-action-item + .story-action-item { border-top:1px solid var(--line); }
.story-action-item:hover { background:var(--surface-active); }
.story-action-run { display:flex; align-items:center; gap:10px; min-width:0; border:0; background:transparent; color:inherit; cursor:pointer; padding:10px 0 10px 12px; text-align:left; }
.story-action-run:disabled { cursor:default; }
.story-action-icon { display:flex; flex:0 0 auto; align-items:center; justify-content:center; width:28px; height:28px; color:var(--text-muted); }
.story-action-copy { display:grid; gap:3px; min-width:0; }
.story-action-copy strong { color:var(--text-strong); font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-action-copy small, .story-action-meta { color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-action-meta { display:block; }
.story-action-controls { display:flex; align-items:center; gap:6px; margin-right:12px; }
.story-action-automation-count,.story-action-edit { display:flex; flex:0 0 auto; align-items:center; justify-content:center; height:32px; border:1px solid var(--line); border-radius:7px; background:var(--surface-raised); color:var(--text-muted); cursor:pointer; padding:0; }
.story-action-automation-count { min-width:38px; gap:5px; font-size:12px; padding:0 8px; }
.story-action-edit { width:32px; }
.story-action-automation-count:hover,.story-action-automation-count:focus-visible,
.story-action-edit:hover,.story-action-edit:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
.story-action-edit:disabled { cursor:default; opacity:.5; }
:global(.story-action-automation-popover) { display:grid; width:min(320px,var(--reka-popover-content-available-width)); max-height:min(360px,var(--reka-popover-content-available-height)); grid-template-rows:auto minmax(0,1fr); overflow:hidden; padding:0; }
:global(.story-action-automation-popover-head) { display:flex; align-items:center; justify-content:space-between; gap:8px; border-bottom:1px solid var(--line); padding:7px 9px; }
:global(.story-action-automation-popover-head strong) { min-width:0; overflow:hidden; color:var(--text-strong); font-size:12px; font-weight:500; text-overflow:ellipsis; white-space:nowrap; }
:global(.story-action-automation-popover-head span),:global(.story-action-automation-empty) { color:var(--text-muted); font-size:12px; }
:global(.story-action-automation-popover-head span) { flex:0 0 auto; }
:global(.story-action-automation-popover-scroll) { min-height:0; }
:global(.story-action-automation-popover-list) { display:grid; padding:2px; }
:global(.story-action-automation-empty) { margin:0; padding:10px 9px; }
:global(.story-action-automation-link) { display:grid; gap:2px; width:100%; border:0; border-radius:5px; background:transparent; color:var(--text-strong); cursor:pointer; padding:5px 7px; text-align:left; }
:global(.story-action-automation-link:hover),:global(.story-action-automation-link:focus-visible) { background:var(--surface-active); outline:none; }
:global(.story-action-automation-link span),:global(.story-action-automation-link small) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
:global(.story-action-automation-link span) { font-size:12px; }
:global(.story-action-automation-link small) { color:var(--text-muted); font-size:12px; }
:global(.story-editor-dialog.story-action-editor-dialog) { max-width:840px; grid-template-rows:auto minmax(0,1fr) auto; overflow:hidden; }
:global(.story-action-editor-scroll) { min-height:0; }
.story-directory > .story-empty { min-height:64px; padding:22px 12px; }
.story-empty { color:var(--text-muted); font-size:12px; padding:16px; text-align:center; }
.story-empty-with-action { display:flex; align-items:center; justify-content:center; gap:8px; }
.story-error { color:var(--status-danger); font-size:12px; }
.story-editor-fields { display:grid; gap:14px; }
.story-editor-fields label { display:grid; gap:6px; color:var(--text-muted); font-size:12px; }
:global(.story-editor-dialog) { max-width:460px; }
.story-history-drawer-drag-region { -webkit-app-region:drag; height:var(--control-plane-titlebar-height); flex:0 0 var(--control-plane-titlebar-height); border-bottom:1px solid var(--line); }
.story-history-drawer-close { -webkit-app-region:no-drag; position:absolute; top:calc(var(--control-plane-titlebar-height) + 10px); left:-42px; display:grid; width:32px; height:32px; place-items:center; border:1px solid var(--line); border-radius:6px; background:var(--surface-raised); box-shadow:var(--shadow-soft); color:var(--text-muted); cursor:pointer; padding:0; }
.story-history-drawer-close:hover,.story-history-drawer-close:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
.story-history-panel { flex:1; min-height:0; overflow:hidden; }
.story-history-panel > * { height:100%; min-height:0; }
.story-history-panel > .story-history-ai-session-panel { --session-ai-scrollbar-outset:0px; }
:global(.story-history-drawer) { -webkit-app-region:no-drag; display:flex; width:min(760px,100vw) !important; max-width:min(760px,100vw) !important; flex-direction:column; gap:0 !important; overflow:visible; background:var(--workspace-bg); padding:0 !important; }
.story-dialog-header { flex-direction:row; align-items:flex-start; justify-content:space-between; gap:16px; text-align:left; }
.story-dialog-close { display:grid; flex:0 0 auto; width:30px; height:30px; place-items:center; border:0; border-radius:6px; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; }
.story-dialog-close:hover, .story-dialog-close:focus-visible { background:var(--surface-active); color:var(--text-strong); outline:none; }
@media (max-width:800px) { .story-view { padding:16px 0; } .story-workspace { grid-template-columns:minmax(220px,38%) minmax(0,1fr); } .story-sidebar-resize-handle { display:none; } .story-content-header { flex-wrap:wrap; padding:0 0 14px; } .story-detail-header-tabs { order:3; width:100%; margin-left:0; } .story-detail-tabs { width:100%; } .story-detail-tabs :deep(button) { flex:1; min-width:0; padding:0 5px; } .story-detail-scroll-inner { padding-right:6px; } }
@media (max-width:820px) { .story-history-drawer-close { top:12px; left:max(10px,calc(10px + var(--native-titlebar-controls-left-width))); } }
@media (max-width:560px) { .story-view { padding:10px 0; } .story-workspace { grid-template-columns:1fr; } .story-sidebar { max-height:38%; border-right:0; border-bottom:1px solid var(--line); } .story-detail-tabs { width:100%; } .story-detail-tabs :deep(button) { min-width:0; flex:1; padding:0 5px; } }
</style>
