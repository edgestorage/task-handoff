<template>
  <section class="control-settings-page" :aria-label="t('settings.title')">
      <div class="control-settings-page-actions">
        <Button variant="outline" size="sm" @click="emit('back')">
          <ArrowLeft :size="14" />
          <span>{{ t("common.actions.back") }}</span>
        </Button>
        <Tabs :model-value="settingsSection" @update:model-value="(value) => setSettingsSection(value as SettingsSection)">
          <TabsList class="control-settings-tabs" :aria-label="t('settings.sections')">
            <TabsTrigger v-for="item in settingsSections" :key="item.id" :value="item.id">{{ item.label }}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <ScrollArea v-if="settingsSection === 'triggers'" class="settings-section-scroll" :horizontal="false">
        <div class="settings-section-scroll-content">
          <ControlPlaneTriggersView :instances="instances" />
        </div>
      </ScrollArea>

      <BasicSettingsSection
        v-else-if="settingsSection === 'basic'"
        :applying-server-update="applyingServerUpdate"
        :checking-server-update="checkingServerUpdate"
        :desktop-update-state="desktopUpdates.state.value"
        :desktop-updates-available="desktopUpdates.available"
        v-model:public-base-url="publicBaseUrl"
        :public-base-url-message="publicBaseUrlMessage"
        v-model:mention-trigger="mentionTrigger"
        :mention-trigger-error="mentionTriggerError"
        v-model:command-trigger="commandTrigger"
        :command-trigger-error="commandTriggerError"
        :saving-trigger-settings="savingTriggerSettings"
        :trigger-settings-at-defaults="triggerSettingsAtDefaults"
        :trigger-settings-dirty="triggerSettingsDirty"
        :trigger-settings-message="triggerSettingsMessage"
        :trigger-settings-message-error="triggerSettingsMessageError"
        :saving-public-base-url="savingPublicBaseUrl"
        :server-current-version="serverCurrentVersion"
        :server-unavailable-reason="serverUnavailableReason"
        :server-update-channel="updateChannel"
        :server-update-check="serverUpdateCheck"
        :server-update-job="serverUpdateJob"
        :server-updates-available="serverUpdatesAvailable"
        :theme-preference="themePreference"
        :diagnostic-logs="diagnosticLogs"
        :saving-diagnostic-logs="savingDiagnosticLogs"
        :exporting-diagnostic-logs="exportingDiagnosticLogs"
        @apply-server-update="applyServerUpdate"
        @check-server-update="checkServerUpdate"
        @check-desktop-update="runDesktopUpdateAction(desktopUpdates.check)"
        @download-desktop-update="runDesktopUpdateAction(desktopUpdates.download)"
        @detect-public-base-url="detectPublicBaseUrl"
        @save-public-base-url="savePublicBaseUrl"
        @reset-triggers="resetTriggerSettings"
        @install-desktop-update="runDesktopUpdateAction(desktopUpdates.install)"
        @open-desktop-release="runDesktopUpdateAction(desktopUpdates.openReleasePage)"
        @save-triggers="saveTriggerSettings"
        @update:server-update-channel="setUpdateChannel"
        @update:desktop-update-channel="setDesktopUpdateChannel"
        @update:theme-preference="setThemePreference"
        @update:diagnostic-logs="setDiagnosticLogs"
        @export-diagnostic-logs="exportDiagnosticLogs"
      />

      <ScrollArea v-else-if="settingsSection === 'chat'" class="settings-section-scroll" :horizontal="false">
        <div class="settings-section-scroll-content">
          <ChatBridgeSettingsSection
            :chat="chatSettings"
            :error-text="errorText"
            :gateway-error="chatGatewayStatus.error.value"
            :is-refreshing="chatBridges.isFetching.value || chatGatewayStatus.isFetching.value"
            :refresh-chat="refreshChat"
          />
        </div>
      </ScrollArea>

      <MobileSessionsSettingsSection v-else-if="settingsSection === 'mobile-sessions'" />

      <AccountSecuritySettingsSection v-else-if="settingsSection === 'account'" />

      <CloudConnectivitySettingsSection v-else-if="settingsSection === 'cloud-connectivity'" />

      <ScrollArea v-else-if="settingsSection === 'models'" class="settings-section-scroll" :horizontal="false">
        <div class="settings-section-scroll-content">
      <div class="project-management-grid">
        <section class="modal-section settings-panel-surface">
          <div class="section-head">
            <span>{{ t("settings.modelRegistry.count", { count: models.data.value?.length || 0 }) }}</span>
          </div>
          <ScrollArea class="registered-project-list">
            <div class="settings-scroll-content">
            <article v-for="model in models.data.value || []" :key="model.id" class="registered-project-row model-card" data-model-row>
              <header class="model-card-header">
                <div class="model-card-title">
                  <strong>{{ model.name }}</strong>
                  <code>{{ model.model }}</code>
                </div>
                <div class="model-card-badges">
                  <Badge variant="secondary">{{ model.app }}</Badge>
                  <Badge :variant="model.enabled ? 'default' : 'secondary'">{{ model.enabled ? t("settings.modelRegistry.enabled") : t("settings.modelRegistry.disabled") }}</Badge>
                </div>
              </header>
              <div class="model-card-endpoint" :title="model.endpoint">{{ model.endpoint }}</div>
              <div class="model-card-meta">
                <span>{{ t("settings.modelRegistry.credential", { value: model.keyPreview || (model.keySet ? t("settings.modelRegistry.set") : t("settings.modelRegistry.missing")) }) }}</span>
                <span>{{ t("settings.modelRegistry.references", { count: model.referenceCount || 0 }) }}</span>
              </div>
              <div class="model-location-list" :aria-label="t('settings.modelRegistry.locations')">
                <div v-for="location in model.locations || []" :key="modelLocationKey(location)" class="model-location-row">
                  <MapPin :size="13" aria-hidden="true" />
                  <span>{{ modelLocationLabel(location) }}</span>
                  <small v-if="location.type === 'node'">{{ t("settings.modelRegistry.references", { count: location.referenceCount }) }}</small>
                </div>
              </div>
              <footer class="settings-row-actions model-card-actions">
                <Button variant="outline" size="sm" class="icon-button" :disabled="!model.locations?.some((location) => location.type === 'control-plane') || savingModelId === model.id || !canMoveModel(model.id, -1)" :aria-label="t('settings.modelRegistry.moveUp')" :title="t('settings.modelRegistry.moveUp')" @click="moveModel(model.id, -1)">
                  <ChevronUp :size="14" />
                </Button>
                <Button variant="outline" size="sm" class="icon-button" :disabled="!model.locations?.some((location) => location.type === 'control-plane') || savingModelId === model.id || !canMoveModel(model.id, 1)" :aria-label="t('settings.modelRegistry.moveDown')" :title="t('settings.modelRegistry.moveDown')" @click="moveModel(model.id, 1)">
                  <ChevronDown :size="14" />
                </Button>
                <Button variant="outline" size="sm" class="model-edit-button" :disabled="savingModelId === model.id" @click="editModel(model)">
                  <Settings :size="14" />
                  <span>{{ t("settings.modelRegistry.editAll") }}</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="outline" size="sm" class="model-delete-trigger" :disabled="deletingModelId === model.id || !model.locations?.length">
                      <Trash2 :size="14" />
                      <span>{{ deletingModelId === model.id ? t("settings.modelRegistry.deleting") : t("settings.modelRegistry.deleteFrom") }}</span>
                      <ChevronDown :size="13" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="model-location-menu" align="end" :side-offset="6">
                    <DropdownMenuItem
                      v-for="location in model.locations || []"
                      :key="`delete-${modelLocationKey(location)}`"
                      class="model-location-menu-item"
                      :disabled="location.type === 'node' && location.referenceCount > 0"
                      @select="removeModel(model, location)"
                    >
                      <Trash2 :size="14" />
                      <span>
                        <strong>{{ modelLocationLabel(location) }}</strong>
                        <small v-if="location.type === 'node' && location.referenceCount > 0">{{ t("settings.modelRegistry.inUseBy", { count: location.referenceCount }) }}</small>
                        <small v-else>{{ t("settings.modelRegistry.deleteLocation") }}</small>
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </footer>
            </article>
            <p v-if="!(models.data.value || []).length" class="settings-empty">{{ t("settings.modelRegistry.empty") }}</p>
            </div>
          </ScrollArea>
          <div v-if="modelRegistry.data.value?.nodeDiagnostics.length" class="model-node-diagnostics" role="status" aria-live="polite">
            <div class="model-node-diagnostics-head">
              <AlertTriangle :size="15" aria-hidden="true" />
              <strong>{{ t("settings.modelRegistry.diagnostics") }}</strong>
              <Button variant="ghost" size="sm" :disabled="modelRegistry.isFetching.value" @click="modelRegistry.refetch()">
                <RefreshCw :size="13" />
                <span>{{ modelRegistry.isFetching.value ? t("settings.modelRegistry.retrying") : t("common.actions.retry") }}</span>
              </Button>
            </div>
            <div v-for="diagnostic in modelRegistry.data.value.nodeDiagnostics" :key="`${diagnostic.nodeId}:${diagnostic.code}`" class="model-node-diagnostic-row">
              <strong>{{ nodeName(diagnostic.nodeId) }}</strong>
              <span>{{ diagnostic.message }}</span>
              <code>{{ diagnostic.code }}</code>
            </div>
          </div>
          <p v-if="modelSaveSuccess" class="settings-success">{{ modelSaveSuccess }}</p>
        </section>

        <section class="modal-section settings-panel-surface">
          <div class="section-head model-form-head">
            <div>
              <span>{{ editingModelId ? t("settings.modelRegistry.edit") : t("settings.modelRegistry.add") }}</span>
              <small>{{ editingModelId ? t("settings.modelRegistry.editDescription", { count: editingModelLocationCount }) : t("settings.modelRegistry.addDescription") }}</small>
            </div>
            <button v-if="editingModelId" type="button" @click="resetModelForm">{{ t("settings.modelRegistry.new") }}</button>
          </div>
          <div class="inline-create">
            <label v-if="!editingModelId">
              <span>{{ t("settings.fields.location") }}</span>
              <ControlPlaneSelect v-model="settingsModel.locationScope" :placeholder="t('settings.modelRegistry.selectLocation')">
                <ControlPlaneSelectItem value="control-plane">{{ t("settings.modelRegistry.controlPlane") }}</ControlPlaneSelectItem>
                <ControlPlaneSelectItem v-for="node in nodes.data.value || []" :key="node.id" :value="node.id">{{ t("settings.modelRegistry.nodeLocation", { name: node.name }) }}</ControlPlaneSelectItem>
              </ControlPlaneSelect>
            </label>
            <div v-else class="model-edit-scope">
              <span>{{ t("settings.fields.location") }}</span>
              <div><Layers :size="15" /><strong>{{ t("settings.modelRegistry.allLocations", { count: editingModelLocationCount }) }}</strong></div>
            </div>
            <label>
              <span>{{ t("settings.fields.name") }}</span>
              <ControlPlaneInput v-model="settingsModel.name" :placeholder="t('settings.modelRegistry.namePlaceholder')" />
            </label>
            <label>
              <span>{{ t("settings.fields.endpoint") }}</span>
              <!-- i18n-audit-allow-next-line code-token: example model API endpoint -->
              <ControlPlaneInput v-model="settingsModel.endpoint" placeholder="https://api.openai.com/v1" />
            </label>
            <div class="model-field">
              <div class="model-field-head">
                <span>{{ t("settings.modelRegistry.model") }}</span>
                <Button variant="ghost" size="sm" :disabled="!canDiscoverModels || discoveringModels" @click="fetchModelOptions">
                  <RefreshCw :size="13" :class="{ 'spin': discoveringModels }" />
                  <span>{{ discoveringModels ? t("settings.modelRegistry.discovering") : t("settings.modelRegistry.discover") }}</span>
                </Button>
              </div>
              <div class="model-input-row">
                <!-- i18n-audit-allow-next-line product-name: example model identifier -->
                <ControlPlaneInput v-model="settingsModel.model" :aria-label="t('settings.modelRegistry.model')" placeholder="gpt-5-codex" />
                <Popover v-model:open="modelPickerOpen">
                  <PopoverTrigger as-child>
                    <Button variant="outline" size="sm" class="model-picker-trigger" :disabled="!discoveredModels.length" :aria-label="t('settings.modelRegistry.chooseDiscovered')">
                      <ChevronsUpDown :size="14" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    class="model-picker-popover"
                    align="end"
                    :collision-padding="12"
                    :side-offset="6"
                    :style="{ width: 'min(360px, var(--reka-popover-content-available-width))', padding: '4px' }"
                  >
                    <Command class="model-picker-command" :model-value="settingsModel.model" @update:model-value="selectDiscoveredModel">
                      <CommandInput class="model-picker-search-input" :placeholder="t('settings.modelRegistry.searchModels')" />
                      <ScrollArea class="model-picker-scroll" :horizontal="false">
                        <CommandList class="model-picker-list">
                          <CommandEmpty>{{ t("settings.modelRegistry.noModelMatches") }}</CommandEmpty>
                          <CommandGroup class="model-picker-group">
                            <CommandItem v-for="option in discoveredModels" :key="option.id" class="model-picker-option" :value="option.id">
                              <span>{{ option.id }}</span>
                              <small v-if="option.ownedBy">{{ option.ownedBy }}</small>
                              <Check :size="14" :class="{ 'model-option-unselected': option.id !== settingsModel.model }" />
                            </CommandItem>
                          </CommandGroup>
                        </CommandList>
                      </ScrollArea>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              <small>{{ t("settings.modelRegistry.manualModelHint") }}</small>
              <small v-if="!selectedNodeSupportsModelEndpointProbe">{{ t("settings.modelRegistry.probeUnsupported") }}</small>
            </div>
            <label>
              <span>{{ t("settings.fields.apiKey") }}</span>
              <ControlPlaneInput v-model="settingsModel.key" type="password" :placeholder="editingModelId ? t('settings.modelRegistry.keepKey') : t('settings.fields.apiKey')" />
              <small v-if="editingModelId">{{ t("settings.modelRegistry.keepCredential") }}</small>
            </label>
            <label>
              <span>{{ t("settings.fields.app") }}</span>
              <ControlPlaneSelect v-model="settingsModel.app" :placeholder="t('settings.modelRegistry.selectApp')">
                <ControlPlaneSelectItem value="codex">Codex</ControlPlaneSelectItem>
                <ControlPlaneSelectItem value="claude">Claude</ControlPlaneSelectItem>
              </ControlPlaneSelect>
            </label>
            <div class="checkbox-row">
              <label>
                <Checkbox :model-value="settingsModel.enabled" @update:model-value="(value) => settingsModel.enabled = value === true" />
                <span>{{ t("common.status.enabled") }}</span>
              </label>
            </div>
            <p v-if="modelEndpointFeedback" class="model-endpoint-feedback" :data-kind="modelEndpointFeedback.kind">{{ modelEndpointFeedback.text }}</p>
            <div class="model-form-actions">
              <Button variant="outline" size="sm" :disabled="!canTestModel || testingModel" @click="checkModel">
                <Activity :size="14" />
                <span>{{ testingModel ? t("settings.modelRegistry.testing") : t("settings.modelRegistry.test") }}</span>
              </Button>
              <Button size="sm" class="model-submit" :disabled="!canSaveModel || savingModelId === formModelBusyId" @click="saveModel">
                <Plus :size="15" />
                <span>{{ savingModelId === formModelBusyId ? t("settings.modelRegistry.saving") : editingModelId ? t("settings.modelRegistry.save") : t("settings.modelRegistry.create") }}</span>
              </Button>
            </div>
          </div>
        </section>
      </div>
        </div>
      </ScrollArea>

      <ScrollArea v-else-if="settingsSection === 'images'" class="settings-section-scroll" :horizontal="false">
        <div class="settings-section-scroll-content">
      <div class="image-management-grid">
        <section class="modal-section settings-panel-surface image-market-section">
          <div class="image-market-head">
            <div>
              <strong>{{ t("settings.imageRegistry.marketTitle") }}</strong>
              <span>{{ t("settings.imageRegistry.marketDescription") }}</span>
            </div>
            <Badge variant="secondary">{{ t("settings.imageRegistry.marketCount", { count: marketCatalog.data.value?.catalog.items.length || 0 }) }}</Badge>
          </div>
          <div class="market-image-grid">
            <article v-for="image in marketCatalog.data.value?.catalog.items || []" :key="image.id" class="market-image-card">
              <ImageArtwork compact class="market-image-artwork" :cover="image.cover" :icon-size="18" :name="image.name" />
              <div class="market-image-content">
                <div class="market-image-title">
                  <strong>{{ image.name }}</strong>
                  <Badge variant="secondary">{{ t("settings.imageRegistry.official") }}</Badge>
                </div>
                <p>{{ resolveImageDescription(image, locale) }}</p>
                <div class="market-capability-list">
                  <span v-for="capability in image.capabilities.slice(0, 3)" :key="capability">{{ capabilityLabel(capability) }}</span>
                  <span v-if="image.capabilities.length > 3">+{{ image.capabilities.length - 3 }}</span>
                </div>
                <div class="market-image-footer">
                  <span :data-status="catalogAvailabilityStatus(image.id)"><i />{{ catalogAvailabilityLabel(image.id) }}</span>
                  <code :title="`${image.repository}:${image.defaultTag}`">{{ image.repository }}:{{ image.defaultTag }}</code>
                </div>
              </div>
            </article>
          </div>
          <p v-if="marketCatalog.data.value?.status.error" class="settings-empty">{{ marketCatalog.data.value.status.error }}</p>
        </section>

        <section class="modal-section settings-panel-surface image-custom-section">
          <div class="image-registry-head">
            <div>
              <strong>{{ t("settings.imageRegistry.customTitle") }}</strong>
              <span>{{ t("settings.imageRegistry.customDescription", { count: images.data.value?.length || 0 }) }}</span>
            </div>
            <div class="image-registry-actions">
              <ControlPlaneSelect v-model="imageCatalogNodeId" :placeholder="t('settings.imageRegistry.selectNode')">
                <ControlPlaneSelectItem v-for="node in nodes.data.value || []" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem>
              </ControlPlaneSelect>
              <Button size="sm" @click="imageCreateOpen = !imageCreateOpen">
                <Plus :size="14" />
                <span>{{ t("settings.imageRegistry.add") }}</span>
              </Button>
            </div>
          </div>

          <p v-if="imageCreateSuccess" class="settings-success">{{ imageCreateSuccess }}</p>

          <ScrollArea class="registered-image-list">
            <div class="settings-scroll-content image-registry-list">
              <div v-for="image in images.data.value || []" :key="image.id" class="registered-image-row">
                <ImageArtwork compact class="registered-image-artwork" :cover="image.cover" :icon-size="15" :name="image.name" />
                <div class="registered-image-copy">
                  <strong>{{ image.name }}</strong>
                  <code>{{ image.reference }}</code>
                </div>
                <span class="registered-image-availability">{{ catalogAvailabilityLabel(image.id) }}</span>
                <div class="settings-row-actions">
                  <Badge variant="secondary">{{ imagePullPolicyLabel(image.pullPolicy) }}</Badge>
                  <Button variant="outline" size="sm" :disabled="deletingImageId === image.id" @click="removeImageProfile(image)">
                    <Trash2 :size="14" />
                    <span>{{ deletingImageId === image.id ? t("settings.imageRegistry.deleting") : t("common.actions.delete") }}</span>
                  </Button>
                </div>
              </div>
              <p v-if="!(images.data.value || []).length" class="settings-empty">{{ t("settings.imageRegistry.empty") }}</p>
            </div>
          </ScrollArea>

          <Dialog v-model:open="imageCreateOpen">
            <DialogContent class="registry-image-dialog">
              <DialogHeader>
                <DialogTitle>{{ t("settings.imageRegistry.addTitle") }}</DialogTitle>
                <DialogDescription>{{ t("settings.imageRegistry.referenceDescription") }}</DialogDescription>
              </DialogHeader>
              <div class="registry-dialog-fields">
                <label>
                  <span>{{ t("settings.fields.name") }}</span>
                  <ControlPlaneInput v-model="settingsImage.name" :placeholder="t('settings.imageRegistry.namePlaceholder')" />
                </label>
                <label>
                  <span>{{ t("settings.imageRegistry.reference") }}</span>
                  <!-- i18n-audit-allow-next-line code-token: example OCI image reference -->
                  <ControlPlaneInput v-model="settingsImage.reference" placeholder="docker.io/org/image:v1" />
                </label>
              </div>
              <DialogFooter>
                <Button variant="outline" @click="closeImageCreate">{{ t("common.actions.cancel") }}</Button>
                <Button :disabled="!canCreateImage || savingImage" @click="submitRegistryImage">
                  <Plus :size="14" />
                  <span>{{ savingImage ? t("settings.imageRegistry.adding") : t("settings.imageRegistry.add") }}</span>
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
      </div>
        </div>
      </ScrollArea>

      <EnvironmentTemplatesSettings v-else-if="settingsSection === 'environment-templates'" :nodes="nodes.data.value || []" />

      <ScrollArea v-else-if="settingsSection === 'projects'" class="settings-section-scroll" :horizontal="false">
        <div class="settings-section-scroll-content">
      <div class="project-management-grid">
        <section class="modal-section settings-panel-surface">
          <div class="section-head">
            <span>{{ t("settings.projectRegistry.count", { count: projects.data.value?.length || 0 }) }}</span>
          </div>
          <ScrollArea class="registered-project-list">
            <div class="settings-scroll-content">
            <div v-for="project in projects.data.value || []" :key="project.id" class="registered-project-row">
              <div>
                <strong>{{ project.name }}</strong>
                <code>{{ projectSourceLabel(project) }}</code>
              </div>
              <div class="settings-row-actions">
                <Badge variant="secondary">{{ projectInUse(project.id) ? t("settings.projectRegistry.inUse") : project.workspacePolicy.mode }}</Badge>
                <Button variant="outline" size="sm" :disabled="projectInUse(project.id) || deletingProjectId === project.id" @click="removeProject(project)">
                  <Trash2 :size="14" />
                  <span>{{ deletingProjectId === project.id ? t("settings.projectRegistry.deleting") : t("common.actions.delete") }}</span>
                </Button>
              </div>
            </div>
            <p v-if="!(projects.data.value || []).length" class="settings-empty">{{ t("settings.projectRegistry.empty") }}</p>
            </div>
          </ScrollArea>
        </section>

        <section class="modal-section settings-panel-surface">
          <div class="section-head">
            <span>{{ t("settings.projectRegistry.addTitle") }}</span>
          </div>
          <div class="inline-create">
            <label>
              <span>{{ t("settings.fields.name") }}</span>
              <ControlPlaneInput v-model="settingsProject.name" :placeholder="t('settings.projectRegistry.namePlaceholder')" />
            </label>
            <label>
              <span>{{ t("settings.projectRegistry.gitUrl") }}</span>
              <!-- i18n-audit-allow-next-line code-token: example Git remote URL -->
              <ControlPlaneInput v-model="settingsProject.url" placeholder="https://github.com/org/repo" />
            </label>
            <div class="settings-form-grid">
              <label>
                <span>{{ t("settings.projectRegistry.defaultImage") }}</span>
                <ControlPlaneSelect v-model="settingsDefaultImageSelectValue" :placeholder="t('settings.projectRegistry.useDefault')">
                  <ControlPlaneSelectItem :value="DEFAULT_SELECT_VALUE">{{ t("settings.projectRegistry.useDefault") }}</ControlPlaneSelectItem>
                  <ControlPlaneSelectItem v-for="image in imageOptions.data.value || []" :key="image.id" :value="image.id">{{ image.name }}</ControlPlaneSelectItem>
                </ControlPlaneSelect>
              </label>
              <label>
                <span>{{ t("settings.projectRegistry.defaultRuntime") }}</span>
                <ControlPlaneSelect v-model="settingsDefaultRuntimeSelectValue" :placeholder="t('settings.projectRegistry.useDefault')">
                  <ControlPlaneSelectItem :value="DEFAULT_SELECT_VALUE">{{ t("settings.projectRegistry.useDefault") }}</ControlPlaneSelectItem>
                  <ControlPlaneSelectItem v-for="runtime in nodeRuntimeItems" :key="runtime.id" :value="runtime.id">{{ runtimeName(runtime) }}</ControlPlaneSelectItem>
                </ControlPlaneSelect>
              </label>
            </div>
            <Button variant="outline" size="sm" :disabled="!canCreateSettingsProject || creatingSettingsProject" @click="createSettingsProject">
              <Plus :size="15" />
              <span>{{ creatingSettingsProject ? t("settings.projectRegistry.creating") : t("settings.projectRegistry.create") }}</span>
            </Button>
          </div>
          <p v-if="settingsProjectSuccess" class="settings-success">{{ settingsProjectSuccess }}</p>
        </section>
      </div>
        </div>
      </ScrollArea>

      <div v-else class="node-management-grid">
        <TooltipProvider :delay-duration="120">
          <section class="modal-section settings-panel-surface node-list-panel">
            <div class="section-head">
              <span>{{ t("settings.nodeRegistry.count", { count: nodes.data.value?.length || 0 }) }}</span>
              <div class="section-head-actions">
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="outline" size="sm">
                      <Plus :size="14" />
                      <span>{{ t("settings.nodeRegistry.add") }}</span>
                      <ChevronDown :size="13" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="node-add-menu" align="end" :side-offset="6">
                    <DropdownMenuItem v-if="!hasLocalNode" class="node-add-menu-item" :disabled="syncingLocalNode" @select="addLocalNode">
                      <MonitorCog :size="16" aria-hidden="true" />
                      <span>
                        <strong>{{ syncingLocalNode ? t("settings.nodeRegistry.addingLocal") : t("settings.nodeRegistry.addLocal") }}</strong>
                        <small>{{ t("settings.nodeRegistry.localDescription") }}</small>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem class="node-add-menu-item" @select="openRemoteNodeDialog">
                      <Server :size="16" aria-hidden="true" />
                      <span>
                        <strong>{{ t("settings.nodeRegistry.addRemote") }}</strong>
                        <small>{{ t("settings.nodeRegistry.remoteDescription") }}</small>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem class="node-add-menu-item" :disabled="creatingJoinInvite" @select="createJoinInvite">
                      <KeyRound :size="16" aria-hidden="true" />
                      <span>
                        <strong>{{ creatingJoinInvite ? t("settings.nodeRegistry.generatingToken") : t("settings.nodeRegistry.generateToken") }}</strong>
                        <small>{{ t("settings.nodeRegistry.tokenDescription") }}</small>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem class="node-add-menu-item" :disabled="creatingJoinInvite" @select="openNodeAgentInstallGuide">
                      <Download :size="16" aria-hidden="true" />
                      <span>
                        <strong>{{ creatingNodeAgentInstall ? t("settings.nodeRegistry.preparingGuide") : t("settings.nodeRegistry.installScript") }}</strong>
                        <small>{{ t("settings.nodeRegistry.installDescription") }}</small>
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" size="sm" :disabled="nodes.isFetching.value" @click="refresh">
                  <RefreshCw :size="14" />
                  <span>{{ nodes.isFetching.value ? t("common.actions.refreshing") : t("common.actions.refresh") }}</span>
                </Button>
              </div>
            </div>
            <div v-if="pendingProxyClaims.isLoading.value" class="pending-proxy-state" role="status">{{ t("settings.nodeDetail.loading") }}</div>
            <div v-else-if="pendingProxyClaims.error.value" class="pending-proxy-state control-plane-error" role="alert">
              <span>{{ translateApiError(pendingProxyClaims.error.value, t) }}</span>
              <Button type="button" size="sm" variant="outline" @click="pendingProxyClaims.refetch()">{{ t("common.actions.retry") }}</Button>
            </div>
            <div v-else-if="pendingProxyClaims.data.value?.length" class="pending-proxy-claims" role="region" :aria-label="t('settings.controlPlaneProxy.pendingClaims')">
              <div class="pending-proxy-heading">
                <AlertTriangle :size="15" aria-hidden="true" />
                <strong>{{ t("settings.controlPlaneProxy.pendingClaims") }}</strong>
              </div>
              <p>{{ t("settings.controlPlaneProxy.pendingClaimsDescription") }}</p>
              <p v-if="pendingClaimError" class="control-plane-error" role="alert">{{ pendingClaimError }}</p>
              <ScrollArea class="pending-proxy-list" :horizontal="false">
                <div class="pending-proxy-list-content">
                  <div v-for="claim in pendingProxyClaims.data.value" :key="claim.id" class="pending-proxy-row">
                    <span>{{ claim.proxyOrigin }} · {{ t(`settings.controlPlaneProxy.claimStatus.${claim.status}`) }}</span>
                    <div>
                      <Button type="button" size="sm" variant="outline" :disabled="Boolean(pendingClaimBusyId)" @click="resumeProxyClaim(claim.claimId)">
                        {{ pendingClaimBusyId === claim.claimId && pendingClaimAction === 'resume' ? t("settings.controlPlaneProxy.resuming") : t("settings.controlPlaneProxy.resume") }}
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        :disabled="Boolean(pendingClaimBusyId)"
                        :aria-label="t(pendingClaimBusyId === claim.claimId && pendingClaimAction === 'cancel' ? 'settings.controlPlaneProxy.cancelling' : 'settings.controlPlaneProxy.cancelClaim')"
                        @click="cancelProxyClaim(claim.claimId)"
                      >
                        <RefreshCw v-if="pendingClaimBusyId === claim.claimId && pendingClaimAction === 'cancel'" class="proxy-spin" :size="14" />
                        <Trash2 v-else :size="14" />
                      </Button>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </div>
            <ScrollArea class="node-list">
              <div class="settings-scroll-content">
              <button v-for="target in orderedNodes" :key="target.id" type="button" class="node-list-item" :class="{ active: selectedNodeId === target.id }" @click="selectNode(target.id)">
                <span class="node-status-dot" :class="nodeStatusClass(target.id)" />
                <span>
                  <strong>{{ target.name }}</strong>
                  <small>{{ nodeLocationLabel(target) }} · {{ nodeEndpointDisplay(target.endpoint) || target.connectionMode }}</small>
                </span>
                <span class="node-list-meta">
                  <Tooltip @update:open="refreshNodeConnectionDiagnostics">
                    <TooltipTrigger as-child>
                      <span class="node-diagnostic-badge" :aria-label="nodeBuildTitle(target.id)">
                        <Badge :variant="nodeStatusVariant(target.id)">{{ nodeStatusLabel(target.id) }}</Badge>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent class="node-diagnostic-tooltip" align="end" side="bottom">
                      <div class="node-diagnostic-tooltip-grid">
                        <span><b>{{ t("settings.nodeRegistry.protocol") }}</b><em>{{ nodeProtocolLabel(target.id) }}</em></span>
                        <span><b>{{ t("settings.nodeRegistry.build") }}</b><em>{{ nodeBuildLabel(target.id) }}</em></span>
                        <span><b>{{ t("settings.nodeRegistry.package") }}</b><em>{{ nodePackageLabel(target.id) }}</em></span>
                        <span v-if="nodeBuild(target.id)?.imageRef"><b>{{ t("settings.nodeRegistry.image") }}</b><em>{{ nodeBuild(target.id)?.imageRef }}</em></span>
                        <span v-if="nodeBuild(target.id)?.builtAt"><b>{{ t("settings.nodeRegistry.built") }}</b><em>{{ nodeBuild(target.id)?.builtAt }}</em></span>
                      </div>
                      <NodeConnectionDiagnostics class="node-list-connection-diagnostics" :diagnostics="target.connectionDiagnostics" />
                    </TooltipContent>
                  </Tooltip>
                  <small>{{ nodeRuntimeSummary(target.id) }} · {{ nodeInstanceSummary(target.id) }}</small>
                </span>
              </button>
              <p v-if="!orderedNodes.length" class="settings-empty">{{ t("settings.nodeRegistry.empty") }}</p>
              </div>
            </ScrollArea>
          </section>

          <NodeDetailPanel
            :actions="nodeDetailActions"
            :busy="nodeDetailBusy"
            :resources="nodeDetailResources"
            :selected-node="selectedNode"
            :status="nodeDetailStatus"
          />
        </TooltipProvider>
      </div>
      <NodeStorageFolderPickerDialog
        :breadcrumbs="nodeStorageFolderBreadcrumbs"
        :can-confirm="nodeStorageFolderCanConfirm"
        :can-go-up="nodeStorageFolderCanGoUp"
        :current-path="nodeStorageFolderCurrentPath"
        :error="nodeStorageFolderError"
        :loading="nodeStorageFolderLoading"
        :node-name="nodeStorageFolderTarget?.name || ''"
        :open="nodeStorageFolderDialogOpen"
        :places="nodeStorageFolderPlaces"
        :rows="nodeStorageFolderRows"
        :selected-path="nodeStorageFolderSelectedPath"
        :submit-error="nodeStorageFolderSubmitError"
        :submitting="nodeStorageFolderSubmitting"
        @confirm="confirmNodeStorageFolder"
        @navigate="navigateNodeStorageFolder"
        @refresh="refreshNodeStorageFolderRoots"
        @select="selectNodeStorageFolder"
        @up="goUpNodeStorageFolder"
        @update:open="setNodeStorageFolderDialogOpen"
      />
      <Dialog :open="nodeRenameOpen" @update:open="setNodeRenameOpen">
        <DialogContent class="node-rename-dialog">
          <DialogHeader>
            <DialogTitle>{{ t("settings.nodeRegistry.rename") }}</DialogTitle>
            <DialogDescription>{{ t("settings.nodeRegistry.renameDescription") }}</DialogDescription>
          </DialogHeader>

          <form class="node-rename-form" @submit.prevent="submitNodeRename">
            <label for="node-rename-name">{{ t("settings.fields.name") }}</label>
            <ControlPlaneInput
              id="node-rename-name"
              :model-value="nodeRenameDraft"
              :maxlength="160"
              :aria-invalid="Boolean(nodeRenameError)"
              :aria-describedby="nodeRenameError ? 'node-rename-error' : undefined"
              :disabled="Boolean(renamingNodeId)"
              autofocus
              @update:model-value="updateNodeRenameDraft"
            />
            <p v-if="nodeRenameError" id="node-rename-error" class="control-plane-error" role="alert">{{ nodeRenameError }}</p>

            <DialogFooter>
              <Button type="button" variant="outline" :disabled="Boolean(renamingNodeId)" @click="setNodeRenameOpen(false)">{{ t("common.actions.cancel") }}</Button>
              <Button type="submit" :disabled="!canSubmitNodeRename">
                <span>{{ t("common.actions.save") }}</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog :open="remoteNodeDialogOpen" @update:open="setRemoteNodeDialogOpen">
        <DialogContent class="remote-node-dialog">
          <DialogHeader>
            <DialogTitle>{{ t("settings.nodeRegistry.addRemote") }}</DialogTitle>
            <DialogDescription>{{ t("settings.nodeRegistry.remoteDialogDescription") }}</DialogDescription>
          </DialogHeader>

          <form class="remote-node-form" @submit.prevent="submitRemoteNode">
            <ScrollArea class="remote-node-form-scroll" :horizontal="false">
              <div class="remote-node-form-content">
            <Tabs v-model="remoteNodeMode" class="remote-node-tabs">
              <TabsList class="remote-node-mode-tabs">
                <TabsTrigger value="direct">{{ t("settings.controlPlaneProxy.directMode") }}</TabsTrigger>
                <TabsTrigger value="control-plane-proxy">{{ t("settings.controlPlaneProxy.proxyMode") }}</TabsTrigger>
              </TabsList>
              <TabsContent value="direct" class="remote-node-mode-content">
                <label>
                  <span>{{ t("settings.fields.name") }}</span>
                  <ControlPlaneInput v-model="settingsNode.name" :placeholder="t('settings.nodeDetail.remoteNamePlaceholder')" />
                </label>
                <label>
                  <span>{{ t("settings.fields.endpoint") }}</span>
                  <!-- i18n-audit-allow-next-line code-token: example node endpoint -->
                  <ControlPlaneInput v-model="settingsNode.endpoint" placeholder="http://10.0.0.12:8091" />
                </label>
                <label>
                  <span>{{ t("settings.nodeRegistry.joinToken") }}</span>
                  <ControlPlaneInput v-model="settingsNode.joinToken" :placeholder="t('settings.nodeDetail.pairingTokenPlaceholder')" />
                </label>
              </TabsContent>
              <TabsContent value="control-plane-proxy" class="remote-node-mode-content">
                <div class="proxy-trust-notice">
                  <ShieldAlert :size="18" />
                  <span>{{ t("settings.controlPlaneProxy.trustWarning") }}</span>
                </div>
                <label>
                  <span>{{ t("settings.controlPlaneProxy.proxyOrigin") }}</span>
                  <!-- i18n-audit-allow-next-line code-token: example trusted control-plane origin -->
                  <ControlPlaneInput v-model="proxyNodeDraft.proxyOrigin" :aria-describedby="proxyNodeErrorField === 'origin' ? 'proxy-node-error' : undefined" :aria-invalid="proxyNodeErrorField === 'origin'" placeholder="https://control-plane.example.com" />
                </label>
                <div class="remote-node-field">
                  <label for="proxy-invite-token">{{ t("settings.controlPlaneProxy.inviteToken") }}</label>
                  <div class="proxy-token-input">
                    <ControlPlaneInput
                      id="proxy-invite-token"
                      v-model="proxyNodeDraft.inviteToken"
                      :aria-describedby="proxyNodeErrorField === 'token' ? 'proxy-node-error' : undefined"
                      :aria-invalid="proxyNodeErrorField === 'token'"
                      autocomplete="off"
                      :placeholder="t('settings.controlPlaneProxy.inviteTokenPlaceholder')"
                      :type="showProxyInviteToken ? 'text' : 'password'"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      :aria-label="t(showProxyInviteToken ? 'settings.controlPlaneProxy.hideToken' : 'settings.controlPlaneProxy.showToken')"
                      :aria-pressed="showProxyInviteToken"
                      @click="showProxyInviteToken = !showProxyInviteToken"
                    >
                      <EyeOff v-if="showProxyInviteToken" :size="15" />
                      <Eye v-else :size="15" />
                    </Button>
                  </div>
                </div>
                <label>
                  <span>{{ t("settings.fields.name") }}</span>
                  <ControlPlaneInput v-model="proxyNodeDraft.name" :placeholder="t('settings.controlPlaneProxy.optionalName')" />
                </label>
                <label class="proxy-trust-confirmation">
                  <Checkbox
                    :aria-describedby="proxyNodeErrorField === 'trust' ? 'proxy-node-error' : undefined"
                    :aria-invalid="proxyNodeErrorField === 'trust'"
                    :model-value="proxyNodeDraft.trusted"
                    @update:model-value="(value) => proxyNodeDraft.trusted = value === true"
                  />
                  <span>{{ t("settings.controlPlaneProxy.trustConfirmation") }}</span>
                </label>
              </TabsContent>
            </Tabs>
            <p v-if="proxyNodeError" id="proxy-node-error" class="control-plane-error" role="alert">{{ proxyNodeError }}</p>
            <p v-if="settingsNodeSuccess" class="settings-success">{{ settingsNodeSuccess }}</p>
              </div>
            </ScrollArea>

            <DialogFooter>
              <Button type="button" variant="outline" @click="setRemoteNodeDialogOpen(false)">{{ t("common.actions.cancel") }}</Button>
              <Button type="submit" :disabled="!canSubmitRemoteNode || creatingRemoteNode">
                <Plus :size="15" />
                <span>{{ creatingRemoteNode ? t("settings.nodeRegistry.creating") : t("settings.nodeRegistry.create") }}</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <GeneratedTokenDialog
        v-if="generatedToken"
        :expires-at="generatedToken.expiresAt"
        :title="t(generatedToken.titleKey)"
        :token="generatedToken.token"
        @close="generatedToken = undefined"
      />
      <NodeAgentInstallDialog
        v-if="nodeAgentInstallInvite"
        :expires-at="nodeAgentInstallInvite.expiresAt"
        :initial-control-plane-url="nodeAgentInstallControlPlaneUrl"
        :join-token="nodeAgentInstallInvite.joinToken"
        :open="Boolean(nodeAgentInstallInvite)"
        :version="nodeAgentInstallVersion"
        @close="nodeAgentInstallInvite = undefined"
      />
      <AlertDialog :open="Boolean(pendingClaimForceId)" @update:open="(open) => !open && (pendingClaimForceId = '')">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{{ t("settings.controlPlaneProxy.forceCancelTitle") }}</AlertDialogTitle>
            <AlertDialogDescription>{{ t("settings.controlPlaneProxy.forceCancelConfirm") }}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel>
            <AlertDialogAction :disabled="pendingClaimAction === 'force-cancel'" @click="forceCancelProxyClaim">
              {{ pendingClaimAction === 'force-cancel' ? t("settings.controlPlaneProxy.forceCancelling") : t("settings.controlPlaneProxy.forceCancel") }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { Activity, AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronUp, ChevronsUpDown, Download, Eye, EyeOff, KeyRound, Layers, MapPin, MonitorCog, Plus, RefreshCw, Server, Settings, ShieldAlert, Trash2 } from "@lucide/vue";
import { cancelControlPlaneProxyClaim, claimControlPlaneProxyNode, controlPlaneQueryKeys, downloadControlPlaneDiagnosticLogs, getNodeExternalListener, resumeControlPlaneProxyClaim, updateControlPlaneSettings, updateNodeExternalListener, useAuthSessionQuery, useChatBridgesQuery, useChatGatewayStatusQuery, useControlPlaneSettingsQuery, useImageOptionsQuery, useImagesQuery, useInstanceBoardPayloadQuery, useMarketCatalogQuery, useModelRegistryQuery, useModelsQuery, useNodeImageAvailabilityQuery, useNodeRuntimesPayloadQuery, useNodesQuery, usePendingControlPlaneProxyClaimsQuery, useProjectsQuery, useServerUpdateCheckQuery } from "../../../api/queries";
import { invalidateControlPlaneDomains } from "../../../api/queryInvalidation";
import type { BuildInfo, ControlPlaneSettings, InstanceBoardItem, ModelLocation, Node, NodeAgentExternalListener, UpdateChannel } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../../components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import ControlPlaneTriggersView from "../triggers/ControlPlaneTriggersView.vue";
import BasicSettingsSection from "./AppearanceSettingsSection.vue";
import ChatBridgeSettingsSection from "./ChatBridgeSettingsSection.vue";
import MobileSessionsSettingsSection from "./MobileSessionsSettingsSection.vue";
import AccountSecuritySettingsSection from "./AccountSecuritySettingsSection.vue";
import { useChatBridgeSettings } from "./useChatBridgeSettings";
import { useImageSettings } from "./useImageSettings";
import { useModelSettings } from "./useModelSettings";
import { useProjectSettings } from "./useProjectSettings";
import ImageArtwork from "../shared/ImageArtwork.vue";
import { resolveImageDescription } from "../shared/imageDescription";
import { useNodeResourceSettings } from "./useNodeResourceSettings";
import { useNodeSettings } from "./useNodeSettings";
import { useDesktopUpdates, type DesktopUpdateChannel } from "./useDesktopUpdates";
import NodeDetailPanel from "./NodeDetailPanel.vue";
import NodeConnectionDiagnostics from "./NodeConnectionDiagnostics.vue";
import NodeAgentInstallDialog from "./NodeAgentInstallDialog.vue";
import NodeStorageFolderPickerDialog from "./NodeStorageFolderPickerDialog.vue";
import GeneratedTokenDialog from "./GeneratedTokenDialog.vue";
import EnvironmentTemplatesSettings from "./EnvironmentTemplatesSettings.vue";
import CloudConnectivitySettingsSection from "./CloudConnectivitySettingsSection.vue";
import { nodeEndpointDisplay } from "./nodeEndpointDisplay";
import { getThemePreference, saveThemePreference, type ThemePreference } from "../../../utils/theme";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { connectionStatusKeys, translateStatus } from "../../../i18n/status";
import { translateApiError } from "../../../i18n/apiError";
import { normalizeProxyOrigin, proxyClaimForceDeleteAllowed, proxyClaimValidation } from "./controlPlaneProxyUi";

type SettingsSection = "basic" | "chat" | "images" | "environment-templates" | "projects" | "nodes" | "models" | "triggers" | "mobile-sessions" | "account" | "cloud-connectivity";
type NodeDiagnosticLog = {
  route: string;
  method: string;
  code: string;
  message: string;
  statusCode?: number;
  issues?: Array<{ path: string; message: string }>;
};

const props = defineProps<{
  chooseProjectFolder?: () => Promise<string | { path: string; ownerNodeId?: string } | undefined>;
  initialSection?: SettingsSection;
  instances: InstanceBoardItem[];
}>();

const emit = defineEmits<{
  back: [];
  openInstanceSettings: [instanceId: string];
  "section-change": [section: SettingsSection];
}>();

const { locale, t } = useI18n();

const DEFAULT_SELECT_VALUE = "__default__";
const modelPickerOpen = ref(false);
const authSession = useAuthSessionQuery();
const settingsSections = computed<Array<{ id: SettingsSection; label: string }>>(() => [
  { id: "nodes", label: t("settings.nodes") },
  { id: "images", label: t("settings.images") },
  { id: "environment-templates", label: t("settings.environmentTemplates") },
  { id: "projects", label: t("settings.projects") },
  { id: "models", label: t("settings.models") },
  { id: "triggers", label: t("triggers.title") },
  { id: "chat", label: t("settings.chat") },
  { id: "mobile-sessions", label: t("settings.mobileSessions.navigation") },
  ...(authSession.data.value?.enabled ? [{ id: "account" as const, label: t("settings.account.navigation") }] : []),
  ...(authSession.data.value?.user?.role === "admin" ? [{ id: "cloud-connectivity" as const, label: t("settings.cloud.navigation") }] : []),
  { id: "basic", label: t("settings.basic") },
]);

const queryClient = useQueryClient();
const projects = useProjectsQuery();
const models = useModelsQuery();
const modelRegistry = useModelRegistryQuery();
const images = useImagesQuery();
const imageOptions = useImageOptionsQuery();
const marketCatalog = useMarketCatalogQuery();
const nodes = useNodesQuery();
const nodeRuntimes = useNodeRuntimesPayloadQuery();
const board = useInstanceBoardPayloadQuery();
const chatBridges = useChatBridgesQuery();
const chatGatewayStatus = useChatGatewayStatusQuery();
const controlPlaneSettings = useControlPlaneSettingsQuery();
const desktopUpdates = useDesktopUpdates();
const updateChannel = computed<UpdateChannel>(() => controlPlaneSettings.data.value?.updateChannel || "stable");
const diagnosticLogs = computed(() => controlPlaneSettings.data.value?.diagnosticLogs === true);

const settingsSection = ref<SettingsSection>(props.initialSection || "nodes");
watch(() => authSession.data.value?.user?.role, (role) => {
  if (role !== "admin" && settingsSection.value === "cloud-connectivity") setSettingsSection("nodes");
}, { immediate: true });
watch(() => authSession.data.value?.enabled, (enabled) => {
  if (!enabled && settingsSection.value === "account") setSettingsSection("nodes");
}, { immediate: true });
const themePreference = ref<ThemePreference>(getThemePreference());
const publicBaseUrl = ref("");
const publicBaseUrlMessage = ref("");
const savingPublicBaseUrl = ref(false);
const savingDiagnosticLogs = ref(false);
const exportingDiagnosticLogs = ref(false);
const mentionTrigger = ref("@");
const mentionTriggerError = computed(() => validMentionTrigger(mentionTrigger.value) ? "" : t("settings.composer.mentionInvalid"));
const commandTrigger = ref("/");
const triggerSettingsMessage = ref("");
const triggerSettingsMessageError = ref(false);
const savingTriggerSettings = ref(false);
const commandTriggerError = computed(() => validCommandTrigger(commandTrigger.value) ? "" : t("settings.composer.commandInvalid"));
const triggerSettingsAtDefaults = computed(() => commandTrigger.value === "/" && mentionTrigger.value === "@");
const triggerSettingsDirty = computed(() => mentionTrigger.value !== (controlPlaneSettings.data.value?.mentionTrigger || "@") || commandTrigger.value !== (controlPlaneSettings.data.value?.commandTrigger || "/"));
const remoteNodeDialogOpen = ref(false);
const remoteNodeMode = ref<"direct" | "control-plane-proxy">("direct");
const creatingProxyNode = ref(false);
const proxyNodeError = ref("");
const proxyNodeErrorField = ref<"origin" | "token" | "trust" | "form">("form");
const proxyNodeDraft = ref({ proxyOrigin: "", inviteToken: "", name: "", trusted: false });
const showProxyInviteToken = ref(false);
const pendingClaimBusyId = ref("");
const pendingClaimAction = ref<"resume" | "cancel" | "force-cancel">();
const pendingClaimError = ref("");
const pendingClaimForceId = ref("");
const pendingProxyClaims = usePendingControlPlaneProxyClaimsQuery();
const creatingNodeAgentInstall = ref(false);
const nodeAgentInstallInvite = ref<{ joinToken: string; expiresAt: string }>();
const nodeAgentInstallControlPlaneUrl = computed(() => publicBaseUrl.value.trim() || window.location.origin);
const codexModels = computed(() => (models.data.value || []).filter((model) => model.app === "codex"));
const claudeModels = computed(() => (models.data.value || []).filter((model) => model.app === "claude"));
const nodeRuntimeItems = computed(() => nodeRuntimes.data.value?.data || []);
const boardItems = computed(() => board.data.value?.data || []);
const projectIdsInUse = computed(() => new Set(boardItems.value.map((instance) => instance.projectId)));
const nodeDiagnosticsByNodeId = computed(() => {
  const diagnostics: Record<string, NodeDiagnosticLog[]> = {};
  const seen = new Set<string>();
  for (const error of [...(nodeRuntimes.data.value?.meta?.nodeErrors || []), ...(board.data.value?.meta?.nodeErrors || [])]) {
    const issuesKey = JSON.stringify(error.issues || []);
    const key = `${error.nodeId}:${error.method}:${error.route}:${error.code}:${error.message}:${error.statusCode || ""}:${issuesKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    (diagnostics[error.nodeId] ||= []).push({
      route: error.route,
      method: error.method,
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      issues: error.issues?.map((issue) => ({
        path: issue.path?.join(".") || "",
        message: issue.message,
      })),
    });
  }
  return diagnostics;
});

watch(
  () => props.initialSection,
  (section) => {
    if (section) {
      if (section !== "nodes") closeNodeStorageFolderPicker();
      settingsSection.value = section;
    }
  },
);

watch(
  () => controlPlaneSettings.data.value?.publicBaseUrl,
  (value) => {
    publicBaseUrl.value = value || "";
  },
  { immediate: true },
);

watch(
  () => controlPlaneSettings.data.value?.mentionTrigger,
  (value) => {
    mentionTrigger.value = value || "@";
  },
  { immediate: true },
);

watch(
  () => controlPlaneSettings.data.value?.commandTrigger,
  (value) => {
    commandTrigger.value = value || "/";
  },
  { immediate: true },
);

watch(
  () => controlPlaneSettings.data.value?.diagnosticLogs,
  (enabled) => {
    if (typeof enabled !== "boolean") return;
    void (window as Window & {
      taskHandoffDesktop?: { setDiagnosticLogsEnabled?: (value: boolean) => Promise<unknown> };
    }).taskHandoffDesktop?.setDiagnosticLogsEnabled?.(enabled);
  },
  { immediate: true },
);

async function refresh() {
  await invalidateControlPlaneDomains(queryClient, ["manual"]);
}

const refreshProjects = () => invalidateControlPlaneDomains(queryClient, ["projects"]);
const refreshImages = () => invalidateControlPlaneDomains(queryClient, ["images"]);
const refreshModels = () => invalidateControlPlaneDomains(queryClient, ["models"]);
const refreshNodeTopology = () => invalidateControlPlaneDomains(queryClient, ["nodeTopology"]);
const refreshNodeRuntimeState = () => invalidateControlPlaneDomains(queryClient, ["nodeRuntimeState"]);
const refreshNodeFolders = () => invalidateControlPlaneDomains(queryClient, ["nodeFolders"]);

async function syncRenamedNode(renamed: Node) {
  queryClient.setQueryData<Node[]>(["control-plane-nodes"], (current) => {
    if (!current) return [renamed];
    return current.map((node) => node.id === renamed.id ? renamed : node);
  });
  await Promise.allSettled([
    queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodes }),
    queryClient.refetchQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }),
  ]);
}

const chatSettings = useChatBridgeSettings({
  bridges: chatBridges.data,
  errorText,
  gatewayStatus: chatGatewayStatus.data,
  refresh: refreshChat,
  translate: t,
});
const { clearChatFeedback } = chatSettings;
const {
  canCreateSettingsProject,
  clearDefaultImage,
  clearDefaultRuntime,
  clearProjectFeedback,
  createSettingsProject,
  creatingSettingsProject,
  deletingProjectId,
  projectSourceLabel,
  removeProject,
  settingsDefaultImageSelectValue,
  settingsDefaultRuntimeSelectValue,
  settingsProject,
  settingsProjectSuccess,
} = useProjectSettings({
  errorText,
  onProjectDeleted() {},
  projectInUse,
  refreshProjects,
  translate: t,
});
const {
  checkingRuntimeId,
  closeNodeStorageFolderPicker,
  confirmNodeStorageFolder,
  goUpNodeStorageFolder,
  creatingNodeLocalFolder,
  deletingNodeLocalFolderId,
  deletingRuntimeId,
  isControlPlaneBuiltinNode,
  isControlPlaneLocalNode,
  nodeLocalFolders,
  nodeStorageFolderCanConfirm,
  nodeStorageFolderBreadcrumbs,
  nodeStorageFolderCanGoUp,
  nodeStorageFolderCurrentPath,
  nodeStorageFolderDialogOpen,
  nodeStorageFolderError,
  nodeStorageFolderLoading,
  nodeStorageFolderPlaces,
  nodeStorageFolderRows,
  nodeStorageFolderSelectedPath,
  nodeStorageFolderSubmitError,
  nodeStorageFolderSubmitting,
  nodeStorageFolderTarget,
  navigateNodeStorageFolder,
  nodeLocationLabel,
  orderedNodes,
  removeNodeLocalFolder,
  renameNodeLocalFolder,
  renamingNodeLocalFolderId,
  removeRuntime,
  runtimeName,
  checkRuntime,
  selectedNode,
  selectedNodeId,
  selectedNodeInstances,
  selectedNodeIsLocal,
  selectedNodeRuntimes,
  selectNode,
  selectNodeStorageFolder,
  setNodeStorageFolderDialogOpen,
  submitNodeLocalFolder,
  refreshNodeStorageFolderRoots,
} = useNodeResourceSettings({
  chooseProjectFolder: props.chooseProjectFolder,
  clearDefaultRuntime,
  errorText,
  instances: boardItems,
  nodes: nodes.data,
  refreshFolders: refreshNodeFolders,
  refreshRuntimeState: refreshNodeRuntimeState,
  runtimes: nodeRuntimeItems,
  translate: t,
});
const externalListener = ref<NodeAgentExternalListener>();
const externalListenerBindScope = ref<NodeAgentExternalListener["bindScope"]>("loopback");
const externalListenerPort = ref("8091");
const externalListenerError = ref("");
const loadingExternalListener = ref(false);
const savingExternalListener = ref(false);

async function loadExternalListener() {
  const node = selectedNode.value;
  if (!node || !isControlPlaneBuiltinNode(node)) {
    externalListener.value = undefined;
    externalListenerError.value = "";
    return;
  }
  loadingExternalListener.value = true;
  externalListenerError.value = "";
  try {
    const listener = await getNodeExternalListener(node.id);
    externalListener.value = listener;
    externalListenerBindScope.value = listener.bindScope;
    externalListenerPort.value = String(listener.port);
  } catch (error) {
    externalListenerError.value = errorText(error);
  } finally {
    loadingExternalListener.value = false;
  }
}

function updateExternalListenerDraft(field: "bindScope" | "port", value: string) {
  if (field === "bindScope") {
    if (value === "loopback" || value === "all-ipv4") externalListenerBindScope.value = value;
    return;
  }
  externalListenerPort.value = value;
}

async function saveExternalListener() {
  const node = selectedNode.value;
  if (!node || !isControlPlaneBuiltinNode(node) || savingExternalListener.value) return;
  const port = Number(externalListenerPort.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    externalListenerError.value = t("settings.nodeDetail.invalidListenerPort");
    return;
  }
  const scopeChangedToAll = externalListener.value?.bindScope !== "all-ipv4" && externalListenerBindScope.value === "all-ipv4";
  const portChanged = externalListener.value?.port !== port;
  const warnings = [
    scopeChangedToAll ? t("settings.nodeDetail.listenerExposeWarning") : "",
    portChanged ? t("settings.nodeDetail.listenerEndpointWarning") : "",
  ].filter(Boolean);
  if (warnings.length && !window.confirm(`${warnings.join("\n\n")}\n\n${t("settings.nodeDetail.listenerApplyConfirm")}`)) return;

  savingExternalListener.value = true;
  externalListenerError.value = "";
  try {
    externalListener.value = await updateNodeExternalListener(node.id, { bindScope: externalListenerBindScope.value, port });
    showControlPlaneToast(t("settings.nodeDetail.listenerUpdated"), "success");
  } catch (error) {
    externalListenerError.value = errorText(error);
    showControlPlaneToast(externalListenerError.value);
  } finally {
    savingExternalListener.value = false;
    await loadExternalListener();
  }
}

watch(
  () => selectedNode.value?.id,
  () => { void loadExternalListener(); },
  { immediate: true },
);
const imageCatalogNodeId = ref("");
const imageCreateOpen = ref(false);
const imageAvailability = useNodeImageAvailabilityQuery(() => imageCatalogNodeId.value);
const hasLocalNode = computed(() => (nodes.data.value || []).some(isControlPlaneLocalNode));
watch(
  () => nodes.data.value,
  (items) => {
    if (imageCatalogNodeId.value && (items || []).some((node) => node.id === imageCatalogNodeId.value)) return;
    imageCatalogNodeId.value = items?.[0]?.id || "";
  },
  { immediate: true },
);
const {
  canCreateImage,
  clearImageFeedback,
  createRegistryImage: createRegistryImageAction,
  deletingImageId,
  imageCreateSuccess,
  removeImageProfile,
  savingImage,
  settingsImage,
} = useImageSettings({
  errorText,
  images: images.data,
  onImageDeleted: clearDefaultImage,
  refreshImages,
  translate: t,
});
function closeImageCreate() {
  imageCreateOpen.value = false;
  clearImageFeedback();
}

async function submitRegistryImage() {
  await createRegistryImageAction();
  if (imageCreateSuccess.value) imageCreateOpen.value = false;
}
const {
  canDiscoverModels,
  canSaveModel,
  canTestModel,
  checkModel,
  canMoveModel,
  clearModelFeedback,
  deletingModelId,
  discoveredModels,
  discoveringModels,
  editModel,
  editingModelId,
  formModelBusyId,
  modelSaveSuccess,
  modelEndpointFeedback,
  moveModel,
  removeModel,
  resetModelForm,
  saveModel,
  savingModelId,
  selectedNodeSupportsModelEndpointProbe,
  settingsModel,
  testingModel,
  fetchModelOptions,
} = useModelSettings({
  errorText,
  models: () => models.data.value || [],
  nodes: () => nodes.data.value || [],
  onModelDeleted() {},
  refreshModels,
  translate: t,
});
function selectDiscoveredModel(value: unknown) {
  if (typeof value !== "string") return;
  settingsModel.model = value;
  modelPickerOpen.value = false;
}
const editingModelLocationCount = computed(() => {
  const model = (models.data.value || []).find((item) => item.id === editingModelId.value);
  return model?.locations?.length || 1;
});

function nodeName(nodeId: string) {
  return (nodes.data.value || []).find((node) => node.id === nodeId)?.name || nodeId;
}

function modelLocationKey(location: ModelLocation) {
  return location.type === "control-plane" ? "control-plane" : `node:${location.nodeId}`;
}

function modelLocationLabel(location: ModelLocation) {
  return location.type === "control-plane" ? t("settings.modelRegistry.controlPlane") : nodeName(location.nodeId);
}
const {
  addLocalNode,
  applyManagedUpdate,
  applyingUpdateNodeId,
  canConnectRemote,
  canCreateNode,
  canSubmitNodeRename,
  checkSettingsNode,
  checkManagedUpdate,
  checkingUpdateNodeId,
  checkingNodeId,
  clearNodeFeedback,
  connectSelectedNodeToRemote,
  connectingRemoteNodeId,
  createJoinInvite,
  createPairingInviteForNode,
  createSettingsNode,
  generatedToken,
  creatingJoinInvite,
  creatingPairingInviteNodeId,
  creatingNode,
  deletingNodeId,
  deletingRemoteKeyId,
  deletingControlPlaneConnectionId,
  loadControlPlaneAccess,
  loadManagedUpdateJobs,
  loadNodeImages,
  loadingRemoteKeysNodeId,
  loadingNodeImagesId,
  nodeRenameDraft,
  nodeRenameError,
  nodeRenameOpen,
  openNodeRename,
  removeNode,
  removeRemoteKey,
  removeControlPlaneConnection,
  renamingNodeId,
  resetNodeRename,
  nodeImageError,
  nodeImages,
  nodeStatusById,
  nodeNameById,
  selectedImageNodeId,
  remoteConnectResultByNodeId,
  controlPlanePairingsByNodeId,
  controlPlaneConnectionsByNodeId,
  remoteKeysErrorByNodeId,
  remoteConnect,
  settingsNode,
  settingsNodeSuccess,
  setNodeRenameOpen,
  submitNodeRename,
  syncingLocalNode,
  updateChecks,
  updateJobs,
  updateNodeRenameDraft,
} = useNodeSettings({
  errorText,
  onNodeDeleted: clearDefaultRuntime,
  onNodeRenamed: syncRenamedNode,
  refreshNodeRuntimeState,
  refreshNodeTopology,
  nodes: () => nodes.data.value || [],
  runtimes: () => nodeRuntimeItems.value,
  updateChannel: () => updateChannel.value,
  translate: t,
});

function openRemoteNodeDialog() {
  clearNodeFeedback();
  proxyNodeError.value = "";
  proxyNodeErrorField.value = "form";
  remoteNodeDialogOpen.value = true;
}

const canSubmitRemoteNode = computed(() => remoteNodeMode.value === "direct"
  ? canCreateNode.value
  : !proxyClaimValidation(proxyNodeDraft.value));
const creatingRemoteNode = computed(() => creatingNode.value || creatingProxyNode.value);

async function openNodeAgentInstallGuide() {
  if (creatingNodeAgentInstall.value) return;
  creatingNodeAgentInstall.value = true;
  try {
    const invite = await createJoinInvite(false);
    if (invite) nodeAgentInstallInvite.value = invite;
  } finally {
    creatingNodeAgentInstall.value = false;
  }
}

function setRemoteNodeDialogOpen(open: boolean) {
  remoteNodeDialogOpen.value = open;
  if (!open) {
    clearNodeFeedback();
    proxyNodeError.value = "";
    proxyNodeErrorField.value = "form";
    proxyNodeDraft.value = { proxyOrigin: "", inviteToken: "", name: "", trusted: false };
    showProxyInviteToken.value = false;
  }
}

async function submitRemoteNode() {
  if (remoteNodeMode.value === "control-plane-proxy") {
    await submitProxyNode();
    return;
  }
  await createSettingsNode();
  if (settingsNodeSuccess.value) {
    setRemoteNodeDialogOpen(false);
  }
}

function proxyValidationMessage() {
  const issue = proxyClaimValidation(proxyNodeDraft.value);
  proxyNodeErrorField.value = issue || "form";
  return issue ? t(`settings.controlPlaneProxy.validation.${issue}`) : "";
}

async function submitProxyNode() {
  proxyNodeError.value = proxyValidationMessage();
  if (proxyNodeError.value || creatingProxyNode.value) return;
  creatingProxyNode.value = true;
  try {
    const result = await claimControlPlaneProxyNode({
      proxyOrigin: normalizeProxyOrigin(proxyNodeDraft.value.proxyOrigin),
      inviteToken: proxyNodeDraft.value.inviteToken.trim(),
      name: proxyNodeDraft.value.name.trim() || undefined,
    });
    await invalidateControlPlaneDomains(queryClient, ["nodeTopology", "controlPlaneProxy"]);
    selectNode(result.node.id);
    setRemoteNodeDialogOpen(false);
    showControlPlaneToast(t("settings.controlPlaneProxy.nodeAdded", { name: result.node.name }), "success");
  } catch (error) {
    proxyNodeErrorField.value = "form";
    proxyNodeError.value = translateApiError(error, t);
    await pendingProxyClaims.refetch();
  } finally {
    creatingProxyNode.value = false;
  }
}

async function resumeProxyClaim(id: string) {
  if (pendingClaimBusyId.value) return;
  pendingClaimBusyId.value = id;
  pendingClaimAction.value = "resume";
  pendingClaimError.value = "";
  try {
    const result = await resumeControlPlaneProxyClaim(id);
    await invalidateControlPlaneDomains(queryClient, ["nodeTopology", "controlPlaneProxy"]);
    selectNode(result.node.id);
    setRemoteNodeDialogOpen(false);
  } catch (error) {
    pendingClaimError.value = translateApiError(error, t);
  } finally {
    pendingClaimBusyId.value = "";
    pendingClaimAction.value = undefined;
  }
}

async function cancelProxyClaim(id: string) {
  if (pendingClaimBusyId.value) return;
  pendingClaimBusyId.value = id;
  pendingClaimAction.value = "cancel";
  pendingClaimError.value = "";
  try {
    await cancelControlPlaneProxyClaim(id);
    await pendingProxyClaims.refetch();
  } catch (error) {
    if (proxyClaimForceDeleteAllowed(error)) {
      pendingClaimForceId.value = id;
    } else {
      pendingClaimError.value = translateApiError(error, t);
    }
  } finally {
    pendingClaimBusyId.value = "";
    pendingClaimAction.value = undefined;
  }
}

async function forceCancelProxyClaim() {
  const id = pendingClaimForceId.value;
  if (!id || pendingClaimBusyId.value) return;
  pendingClaimBusyId.value = id;
  pendingClaimAction.value = "force-cancel";
  pendingClaimError.value = "";
  try {
    const result = await cancelControlPlaneProxyClaim(id, true);
    await pendingProxyClaims.refetch();
    if (!result.deleted && pendingProxyClaims.data.value?.some((claim) => claim.claimId === id)) {
      pendingClaimError.value = t("settings.controlPlaneProxy.forceCancelFailed");
      return;
    }
    pendingClaimForceId.value = "";
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    pendingClaimBusyId.value = "";
    pendingClaimAction.value = undefined;
  }
}

async function setUpdateChannel(value: string) {
  if (value !== "stable" && value !== "beta" && value !== "alpha") return;
  try {
    const saved = await updateControlPlaneSettings({ updateChannel: value });
    queryClient.setQueryData<ControlPlaneSettings>(["control-plane-settings"], saved);
    for (const key of Object.keys(updateChecks)) delete updateChecks[key];
  } catch (error) {
    showControlPlaneToast(errorText(error));
  }
}

async function setDiagnosticLogs(enabled: boolean) {
  if (savingDiagnosticLogs.value || enabled === diagnosticLogs.value) return;
  savingDiagnosticLogs.value = true;
  try {
    const saved = await updateControlPlaneSettings({ diagnosticLogs: enabled });
    queryClient.setQueryData<ControlPlaneSettings>(["control-plane-settings"], saved);
    showControlPlaneToast(t(enabled ? "settings.diagnosticLogs.enabledMessage" : "settings.diagnosticLogs.disabledMessage"), "success");
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    savingDiagnosticLogs.value = false;
  }
}

async function exportDiagnosticLogs() {
  if (exportingDiagnosticLogs.value) return;
  exportingDiagnosticLogs.value = true;
  try {
    const { blob, filename } = await downloadControlPlaneDiagnosticLogs();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showControlPlaneToast(t("settings.diagnosticLogs.exported"), "success");
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    exportingDiagnosticLogs.value = false;
  }
}

const serverUpdateNode = computed(() => (nodes.data.value || []).find((node) => isControlPlaneBuiltinNode(node)));
const serverUpdateNodeId = computed(() => serverUpdateNode.value?.id || "");
const isDesktopApp = Boolean((window as Window & { taskHandoffDesktop?: unknown }).taskHandoffDesktop);
const serverUpdatesAvailable = computed(() => Boolean(serverUpdateNodeId.value && !isDesktopApp));
const serverUnavailableReason = computed(() => isDesktopApp ? t("settings.appearance.desktopReleaseOnly") : t("settings.appearance.builtinServerUnavailable"));
const serverUpdateQueryNodeId = computed(() => serverUpdatesAvailable.value ? serverUpdateNodeId.value : "");
const serverUpdateQuery = useServerUpdateCheckQuery(serverUpdateQueryNodeId, updateChannel);
const serverUpdateCheck = computed(() => serverUpdateQuery.data.value);
const serverCurrentVersion = computed(() => serverUpdateNodeId.value ? nodeBuild(serverUpdateNodeId.value)?.packageVersion : undefined);
const nodeAgentInstallVersion = computed(() => {
  const version = serverCurrentVersion.value?.trim();
  return version && version !== "unknown" ? version : undefined;
});
const serverUpdateJob = computed(() => updateJobs.value.find((job) => job.nodeId === serverUpdateNodeId.value));
const checkingServerUpdate = computed(() => serverUpdateQuery.isFetching.value);
const applyingServerUpdate = computed(() => applyingUpdateNodeId.value === serverUpdateNodeId.value);

async function checkServerUpdate() {
  if (serverUpdatesAvailable.value) await serverUpdateQuery.refetch();
}

async function applyServerUpdate() {
  if (serverUpdatesAvailable.value) await applyManagedUpdate(serverUpdateNodeId.value, serverUpdateCheck.value);
}

async function runDesktopUpdateAction(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    showControlPlaneToast(errorText(error));
  }
}

async function setDesktopUpdateChannel(value: string) {
  if (value !== "stable" && value !== "beta" && value !== "alpha") return;
  await runDesktopUpdateAction(() => desktopUpdates.setChannel(value as DesktopUpdateChannel));
}

const nodeDetailActions = computed(() => ({
  checkRuntime,
  checkSettingsNode,
  checkManagedUpdate,
  applyManagedUpdate,
  connectSelectedNodeToRemote,
  createPairingInviteForNode,
  loadNodeImages,
  loadControlPlaneAccess,
  loadManagedUpdateJobs,
  refreshNodeConnectionState: async () => { await nodes.refetch(); },
  openInstanceSettings: (instanceId: string) => emit("openInstanceSettings", instanceId),
  openNodeRename,
  removeNode,
  removeNodeLocalFolder,
  renameNodeLocalFolder,
  removeRemoteKey,
  removeControlPlaneConnection,
  removeRuntime,
  saveExternalListener,
  submitNodeLocalFolder,
  setUpdateChannel,
  updateExternalListenerDraft,
  updateRemoteConnect,
}));

const nodeDetailBusy = computed(() => ({
  checkingNodeId: checkingNodeId.value,
  checkingUpdateNodeId: checkingUpdateNodeId.value,
  applyingUpdateNodeId: applyingUpdateNodeId.value,
  checkingRuntimeId: checkingRuntimeId.value,
  connectingRemoteNodeId: connectingRemoteNodeId.value,
  creatingNodeLocalFolder: creatingNodeLocalFolder.value,
  creatingPairingInviteNodeId: creatingPairingInviteNodeId.value,
  deletingNodeId: deletingNodeId.value,
  deletingNodeLocalFolderId: deletingNodeLocalFolderId.value,
  renamingNodeLocalFolderId: renamingNodeLocalFolderId.value,
  deletingRemoteKeyId: deletingRemoteKeyId.value,
  deletingControlPlaneConnectionId: deletingControlPlaneConnectionId.value,
  deletingRuntimeId: deletingRuntimeId.value,
  loadingNodeImagesId: loadingNodeImagesId.value,
  loadingRemoteKeysNodeId: loadingRemoteKeysNodeId.value,
  loadingExternalListener: loadingExternalListener.value,
  renamingNodeId: renamingNodeId.value,
  savingExternalListener: savingExternalListener.value,
}));

const nodeDetailResources = computed(() => ({
  canConnectRemote: canConnectRemote.value,
  images: nodeImages.value,
  imagesError: nodeImageError.value,
  instances: selectedNodeInstances.value,
  localFoldersError: nodeLocalFolders.error.value ? errorText(nodeLocalFolders.error.value) : "",
  localFolders: nodeLocalFolders.data.value || [],
  remoteConnect,
  remoteConnectResultByNodeId,
  controlPlanePairings: selectedNode.value ? controlPlanePairingsByNodeId[selectedNode.value.id] || [] : [],
  controlPlaneConnections: selectedNode.value ? controlPlaneConnectionsByNodeId[selectedNode.value.id] || [] : [],
  remoteKeysError: selectedNode.value ? remoteKeysErrorByNodeId[selectedNode.value.id] || "" : "",
  diagnostics: selectedNode.value ? nodeDiagnosticsByNodeId.value[selectedNode.value.id] || [] : [],
  externalListener: externalListener.value,
  externalListenerBindScope: externalListenerBindScope.value,
  externalListenerError: externalListenerError.value,
  externalListenerPort: externalListenerPort.value,
  runtimes: selectedNodeRuntimes.value,
  selectedImageNodeId: selectedImageNodeId.value,
  selectedNodeIsLocal: selectedNodeIsLocal.value,
  updateChannel: updateChannel.value,
  updateChecks,
  updateJobs: updateJobs.value,
}));

const nodeDetailStatus = {
  build: nodeBuild,
  buildLabel: nodeBuildLabel,
  buildTitle: nodeBuildTitle,
  isBuiltinNode: isControlPlaneBuiltinNode,
  locationLabel: nodeLocationLabel,
  nameById: nodeNameById,
  packageLabel: nodePackageLabel,
  protocolLabel: nodeProtocolLabel,
  statusLabel: nodeStatusLabel,
  statusVariant: nodeStatusVariant,
};

watch(
  () => selectedNode.value?.id,
  (nodeId, previousNodeId) => {
    if (previousNodeId && nodeId !== previousNodeId) resetNodeRename();
    if (nodeId) {
      void loadControlPlaneAccess(nodeId);
      void loadManagedUpdateJobs(nodeId);
    }
  },
  { immediate: true },
);

async function setSettingsSection(section: SettingsSection) {
  if (section !== "nodes") closeNodeStorageFolderPicker();
  settingsSection.value = section;
  emit("section-change", section);
  clearImageFeedback();
  clearProjectFeedback();
  clearNodeFeedback();
  clearModelFeedback();
  clearChatFeedback();
  publicBaseUrlMessage.value = "";
  if (section === "chat") {
    await refreshChat();
  }
  if (section === "basic" && serverUpdateNodeId.value) {
    await loadManagedUpdateJobs(serverUpdateNodeId.value);
  }
}

function setThemePreference(theme: ThemePreference) {
  themePreference.value = theme;
  saveThemePreference(theme);
}

function detectPublicBaseUrl() {
  publicBaseUrl.value = window.location.origin;
  publicBaseUrlMessage.value = t("settings.publicAccess.currentFilled");
}

async function savePublicBaseUrl() {
  if (savingPublicBaseUrl.value) {
    return;
  }
  savingPublicBaseUrl.value = true;
  publicBaseUrlMessage.value = "";
  try {
    const saved = await updateControlPlaneSettings({ publicBaseUrl: publicBaseUrl.value.trim() || undefined });
    publicBaseUrl.value = saved.publicBaseUrl || "";
    publicBaseUrlMessage.value = t("settings.publicAccess.saved");
    await queryClient.invalidateQueries({ queryKey: ["control-plane-settings"] });
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    savingPublicBaseUrl.value = false;
  }
}

function validMentionTrigger(value: string) {
  return Array.from(value).length === 1 && !/[\p{L}\p{N}\s/\\]/u.test(value);
}

function resetTriggerSettings() {
  commandTrigger.value = "/";
  mentionTrigger.value = "@";
  triggerSettingsMessage.value = t("settings.composer.defaultsReady");
  triggerSettingsMessageError.value = false;
}

async function saveTriggerSettings() {
  if (savingTriggerSettings.value || !triggerSettingsDirty.value || !validMentionTrigger(mentionTrigger.value) || !validCommandTrigger(commandTrigger.value)) return;
  savingTriggerSettings.value = true;
  triggerSettingsMessage.value = "";
  triggerSettingsMessageError.value = false;
  try {
    const saved = await updateControlPlaneSettings({
      commandTrigger: commandTrigger.value,
      mentionTrigger: mentionTrigger.value,
    });
    commandTrigger.value = saved.commandTrigger;
    mentionTrigger.value = saved.mentionTrigger;
    triggerSettingsMessage.value = t("settings.composer.saved");
    queryClient.setQueryData<ControlPlaneSettings>(["control-plane-settings"], saved);
  } catch (error) {
    triggerSettingsMessage.value = errorText(error);
    triggerSettingsMessageError.value = true;
    showControlPlaneToast(triggerSettingsMessage.value);
  } finally {
    savingTriggerSettings.value = false;
  }
}

function validCommandTrigger(value: string) {
  return Array.from(value).length === 1 && !/[\p{L}\p{N}\s\\]/u.test(value) && value !== mentionTrigger.value;
}

async function refreshChat() {
  await invalidateControlPlaneDomains(queryClient, ["chat"]);
}

function catalogAvailabilityStatus(imageId: string) {
  const availability = imageAvailability.data.value?.find((item) => item.image.id === imageId);
  if (!imageCatalogNodeId.value || !availability) return "unknown";
  return availability.status;
}

function catalogAvailabilityLabel(imageId: string) {
  const status = catalogAvailabilityStatus(imageId);
  if (!imageCatalogNodeId.value) return t("settings.imageRegistry.selectNodeHint");
  if (status === "unknown") return t("settings.imageRegistry.availabilityUnknown");
  return status === "available" ? t("settings.imageRegistry.availableOnNode") : t("settings.imageRegistry.pullOnCreate");
}

function capabilityLabel(capability: string) {
  const key = `common.imageCapabilities.${capability}`;
  return t(key, capability);
}

function imagePullPolicyLabel(policy: string) {
  if (policy === "if-not-present") return t("settings.imageRegistry.pullIfMissing");
  if (policy === "always") return t("settings.imageRegistry.pullAlways");
  if (policy === "never") return t("settings.imageRegistry.pullNever");
  return t("common.status.unknownValue", { value: policy });
}

function projectInUse(projectId: string) {
  return projectIdsInUse.value.has(projectId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function nodeAgent(nodeId: string) {
  const checkedAgent = asRecord(nodeStatusById[nodeId]?.agent);
  if (checkedAgent) {
    return checkedAgent;
  }
  const node = (nodes.data.value || []).find((item) => item.id === nodeId);
  return asRecord(node?.capabilities["agent"]);
}

function nodeBuild(nodeId: string): Partial<BuildInfo> | undefined {
  return asRecord(nodeAgent(nodeId)?.build) as Partial<BuildInfo> | undefined;
}

function nodeProtocolLabel(nodeId: string) {
  const protocolVersion = nodeAgent(nodeId)?.protocolVersion;
  return typeof protocolVersion === "string" && protocolVersion ? protocolVersion : nodeBuild(nodeId)?.protocolVersion || t("common.status.unknown");
}

function nodeBuildLabel(nodeId: string) {
  const build = nodeBuild(nodeId);
  return build?.buildId || build?.gitCommit?.slice(0, 12) || t("common.status.unknown");
}

function nodePackageLabel(nodeId: string) {
  return nodeBuild(nodeId)?.packageVersion || t("common.status.unknown");
}

function nodeBuildTitle(nodeId: string) {
  const build = nodeBuild(nodeId);
  return [
    `${t("settings.nodeDetail.protocol")}: ${nodeProtocolLabel(nodeId)}`,
    `${t("settings.nodeDetail.build")}: ${nodeBuildLabel(nodeId)}`,
    `${t("settings.nodeDetail.package")}: ${nodePackageLabel(nodeId)}`,
    build?.imageRef ? `${t("settings.nodeDetail.image")}: ${build.imageRef}` : undefined,
    build?.builtAt ? `${t("settings.nodeDetail.built")}: ${build.builtAt}` : undefined,
  ].filter(Boolean).join("\n");
}

function nodeRuntimeSummary(nodeId: string) {
  const count = nodeRuntimeItems.value.filter((runtime) => runtime.nodeId === nodeId).length;
  return t("settings.nodeDetail.runtimeCount", { count });
}

function nodeInstanceSummary(nodeId: string) {
  const instances = boardItems.value.filter((instance) => instance.nodeId === nodeId);
  const running = instances.filter((instance) => instance.status === "running").length;
  return t("settings.nodeDetail.runningCount", { running, total: instances.length });
}

function nodeStatusValue(nodeId: string) {
  const node = (nodes.data.value || []).find((item) => item.id === nodeId);
  return nodeStatusById[nodeId]?.status || node?.status || "unknown";
}

function nodeStatusLabel(nodeId: string) {
  return translateStatus(connectionStatusKeys, nodeStatusValue(nodeId), t);
}

function nodeStatusVariant(nodeId: string) {
  return nodeStatusValue(nodeId) === "online" ? "default" : "secondary";
}

function nodeStatusClass(nodeId: string) {
  return `status-${nodeStatusValue(nodeId)}`;
}

function refreshNodeConnectionDiagnostics(open: boolean) {
  if (open) void nodes.refetch();
}

function updateRemoteConnect(field: "controlPlaneUrl" | "joinToken" | "controlPlaneName", value: string) {
  remoteConnect[field] = value;
}

function errorText(error: unknown) {
  const fallback = error instanceof Error ? error.message : String(error);
  return translateApiError(error, t, fallback);
}
</script>

<style scoped>
.control-settings-page {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  align-items: start;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  gap: 12px;
  background:
    radial-gradient(circle at 62% -10%, var(--brand-accent-soft), transparent 28rem),
    var(--surface-inset);
  color: var(--text);
  padding: 18px;
}

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.control-settings-page :deep(.trigger-board) {
  padding: 12px;
}

.settings-section-scroll {
  align-self: stretch;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.settings-section-scroll :deep([data-task-handoff-scroll-viewport] > div) {
  min-width: 100%;
  min-height: 100%;
}

.settings-section-scroll-content {
  min-width: 0;
  padding: 0 10px 18px 0;
}

.control-settings-page-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-width: 0;
  gap: 10px;
}

.control-settings-tabs,
.source-toggle {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  height: 32px;
  min-height: 32px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 2px;
}

.control-settings-tabs {
  align-self: start;
  gap: 1px;
}

.control-settings-tabs button,
.source-toggle button {
  height: 26px;
  min-height: 26px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 750;
  padding: 0 10px;
}

.source-toggle button {
  min-height: 26px;
  padding: 0 9px;
}

.control-settings-tabs button:hover,
.control-settings-tabs button:focus-visible,
.control-settings-tabs button[data-state="active"],
.source-toggle button:hover,
.source-toggle button:focus-visible,
.source-toggle button.active {
  background: var(--surface-active);
  color: var(--text-strong);
  outline: none;
}

.image-management-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.project-management-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.1fr);
  align-items: start;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.node-management-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.78fr) minmax(0, 1.22fr);
  align-items: start;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.node-list-panel,
.node-detail-panel {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}

.node-list-panel {
  grid-template-rows: auto auto minmax(0, 1fr);
}

.node-list {
  min-height: 0;
  padding-right: 2px;
}

.settings-scroll-content {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 100%;
  padding-right: 2px;
}

.node-list-item {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 9px;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  color: inherit;
  cursor: pointer;
  padding: 10px;
  text-align: left;
}

.node-list-item:hover,
.node-list-item:focus-visible,
.node-list-item.active {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  outline: none;
}

.node-list-item > span:nth-child(2) {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.node-list-item strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-list-item small,
.node-list-item code {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-status-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--text-subtle);
  margin-top: 4px;
  box-shadow: 0 0 0 3px var(--surface-subtle);
}

.node-status-dot.status-online {
  background: var(--status-success);
  box-shadow: 0 0 0 3px var(--brand-accent-soft);
}

.node-status-dot.status-offline,
.node-status-dot.status-failed {
  background: var(--status-danger);
  box-shadow: 0 0 0 3px var(--status-danger-bg);
}

.node-list-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  grid-column: 2;
  min-width: 0;
}

.node-diagnostic-badge {
  display: inline-flex;
  cursor: help;
  outline: none;
}

:global(.node-diagnostic-tooltip) {
  min-width: 230px;
  max-width: min(360px, 80vw);
  border: 1px solid var(--line-strong) !important;
  background: var(--surface-inset) !important;
  color: var(--text) !important;
  box-shadow: var(--shadow-popover);
}

:global(.node-diagnostic-tooltip-grid) {
  display: grid;
  gap: 7px;
}

:global(.node-diagnostic-tooltip-grid span) {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

:global(.node-diagnostic-tooltip-grid b),
:global(.node-diagnostic-tooltip-grid em) {
  overflow: hidden;
  font-size: 11px;
  font-style: normal;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.node-diagnostic-tooltip-grid b) {
  color: var(--text-muted) !important;
  font-weight: 750;
}

:global(.node-diagnostic-tooltip-grid em) {
  color: var(--text-strong) !important;
  font-weight: 650;
}

.node-list-connection-diagnostics {
  margin-top: 9px;
  border-top: 1px solid var(--line-subtle);
  padding-top: 9px;
}

:global(.node-add-menu) {
  width: 280px;
}

:global(.node-add-menu-item) {
  align-items: flex-start !important;
  gap: 10px !important;
  min-height: 50px;
  padding: 8px 10px !important;
}

:global(.node-add-menu-item > svg) {
  flex: 0 0 auto;
  margin-top: 2px;
}

:global(.node-add-menu-item > span) {
  display: grid;
  gap: 2px;
  min-width: 0;
}

:global(.node-add-menu-item strong),
:global(.node-add-menu-item small) {
  overflow: hidden;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.node-add-menu-item strong) {
  color: inherit;
  font-size: 12px;
  font-weight: 750;
}

:global(.node-add-menu-item small) {
  color: var(--text-muted);
  font-size: 11px;
}

.remote-node-dialog {
  width: min(520px, calc(100vw - 36px));
  max-height: calc(100dvh - 36px);
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
}

:global(.node-rename-dialog.node-rename-dialog) {
  width: min(460px, calc(100vw - 36px)) !important;
}

.node-rename-form {
  display: grid;
  gap: 10px;
}

.node-rename-form > label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.node-rename-form .control-plane-error {
  margin: 0;
}

.remote-node-form {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 14px;
  min-height: 0;
}

.remote-node-form-scroll { min-height: 0; }
.remote-node-form-content { display: grid; gap: 14px; padding-right: 10px; }

.remote-node-form label,
.remote-node-field {
  display: grid;
  gap: 7px;
}

.remote-node-form label > span,
.remote-node-field > label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.remote-node-mode-tabs { width: 100%; }
.remote-node-mode-tabs :deep(button) { flex: 1; }
.remote-node-mode-content { display: grid; gap: 12px; margin-top: 12px; }
.proxy-token-input { position: relative; }
.proxy-token-input .control-plane-input { padding-right: 40px; }
.proxy-token-input button { position: absolute; top: 1px; right: 1px; width: 32px; height: 32px; }
.proxy-trust-notice { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-inset); font-size: 12px; line-height: 1.5; }
.proxy-trust-notice svg { flex: none; color: var(--warning, var(--text-muted)); }
.proxy-trust-confirmation { grid-template-columns: auto minmax(0, 1fr) !important; align-items: start; color: var(--text); font-size: 12px; line-height: 1.5; }
.pending-proxy-state, .pending-proxy-claims { font-size: 12px; }
.pending-proxy-state { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pending-proxy-claims { display: grid; gap: 6px; min-height: 0; border: 1px solid var(--status-warning); border-radius: 7px; background: var(--status-warning-bg); padding: 9px; }
.pending-proxy-heading { display: flex; align-items: center; gap: 6px; color: var(--text-strong); }
.pending-proxy-claims > p { margin: 0; color: var(--text-muted); }
.pending-proxy-list { max-height: min(180px, max(88px, calc(100dvh - 480px))); }
.pending-proxy-list-content { min-width: 0; padding-right: 10px; }
.pending-proxy-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.pending-proxy-row > span { min-width: 0; overflow-wrap: anywhere; }
.pending-proxy-row > div { display: flex; gap: 6px; }
.proxy-spin { animation: proxy-spin 0.8s linear infinite; }
@keyframes proxy-spin { to { transform: rotate(360deg); } }

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.section-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.section-head > span,
.modal-section label span,
.project-model-picker > span {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.section-head > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-head .inline-flex {
  flex: 0 0 auto;
}

.section-head button:not(.inline-flex) {
  border: 0;
  background: transparent;
  color: var(--status-success);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  padding: 0;
}

.section-head button:not(.inline-flex):hover,
.section-head button:not(.inline-flex):focus-visible {
  color: var(--brand-accent);
  outline: none;
}

.registered-image-list,
.local-image-list,
.registered-project-list {
  min-height: 0;
}

.registered-image-list,
.registered-project-list {
  max-height: min(520px, calc(100vh - 270px));
}

.local-image-list {
  max-height: min(470px, calc(100vh - 330px));
}

.runtime-image-panel {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--line);
  margin-top: 12px;
  padding-top: 12px;
}

.registered-image-row,
.local-image-row,
.registered-project-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 9px;
}

.settings-row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
}

.registered-image-row > div:first-child,
.local-image-row > div:first-child,
.registered-project-row > div:first-child {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.registered-image-row strong,
.local-image-row strong,
.registered-project-row strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.registered-image-row code,
.local-image-row span,
.registered-project-row code,
.image-meta-line {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-meta-line {
  line-height: 1.35;
}

.model-card {
  gap: 9px;
  padding: 12px;
  transition: border-color 140ms ease, background 140ms ease;
}

.model-card:hover {
  border-color: var(--line-strong);
  background: var(--surface-hover);
}

.model-card-header,
.model-card-badges,
.model-card-meta,
.model-location-row,
.model-node-diagnostics-head {
  display: flex;
  align-items: center;
}

.model-card-header {
  justify-content: space-between;
  gap: 10px;
}

.model-card-title {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.model-card-title strong {
  font-size: 14px;
}

.model-card-title code {
  color: var(--text-muted);
  font-size: 11px;
}

.model-card-badges {
  flex: 0 0 auto;
  gap: 5px;
}

.model-card-endpoint {
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-card-meta {
  flex-wrap: wrap;
  gap: 6px 14px;
  color: var(--text-muted);
  font-size: 11px;
}

.model-location-list {
  display: grid;
  gap: 5px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}

.model-location-row {
  min-width: 0;
  gap: 6px;
  color: var(--text);
  font-size: 11px;
}

.model-location-row svg {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.model-location-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-location-row small {
  flex: 0 0 auto;
  color: var(--text-muted);
  margin-left: auto;
}

.model-card-actions {
  border-top: 1px solid var(--line);
  padding-top: 9px;
}

.model-card-actions .model-edit-button {
  margin-left: auto;
}

:global(.model-location-menu) {
  min-width: 250px;
}

:global(.model-location-menu-item) {
  align-items: flex-start !important;
  gap: 9px !important;
  padding-block: 8px !important;
}

:global(.model-location-menu-item > svg) {
  color: var(--status-danger);
  margin-top: 2px;
}

:global(.model-location-menu-item > span) {
  display: grid;
  gap: 2px;
  min-width: 0;
}

:global(.model-location-menu-item strong),
:global(.model-location-menu-item small) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.model-location-menu-item strong) {
  color: var(--text-strong);
  font-size: 12px;
}

:global(.model-location-menu-item small) {
  color: var(--text-muted);
  font-size: 10px;
}

.model-node-diagnostics {
  display: grid;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--status-danger) 35%, var(--line));
  border-radius: 7px;
  background: var(--status-danger-bg);
  color: var(--text);
  font-size: 11px;
  padding: 9px;
}

.model-node-diagnostics-head {
  gap: 7px;
}

.model-node-diagnostics-head > svg {
  flex: 0 0 auto;
  color: var(--status-danger);
}

.model-node-diagnostics-head > button {
  height: 26px;
  margin-left: auto;
}

.model-node-diagnostics-head strong {
  color: var(--text-strong);
  font-size: 12px;
}

.model-node-diagnostic-row {
  display: grid;
  grid-template-columns: minmax(90px, 0.35fr) minmax(0, 1fr) auto;
  gap: 8px;
  border-top: 1px solid color-mix(in srgb, var(--status-danger) 25%, transparent);
  padding-top: 7px;
}

.model-node-diagnostic-row strong,
.model-node-diagnostic-row span,
.model-node-diagnostic-row code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-node-diagnostic-row code {
  color: var(--status-danger);
  font-size: 10px;
}

.model-form-head {
  align-items: flex-start;
}

.model-form-head > div {
  display: grid;
  gap: 4px;
}

.model-form-head small,
.inline-create label > small {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 550;
  line-height: 1.4;
}

.model-edit-scope {
  display: grid;
  gap: 7px;
}

.model-edit-scope > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.model-edit-scope > div {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  color: var(--text-muted);
  padding: 0 10px;
}

.model-edit-scope strong {
  color: var(--text);
  font-size: 12px;
}

.model-submit {
  flex: 1 1 auto;
}

.model-field {
  display: grid;
  gap: 7px;
}

.model-field > small {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.model-field-head,
.model-input-row,
.model-form-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}

.model-field-head {
  justify-content: space-between;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.model-field-head button {
  min-height: 26px;
  height: 26px;
  padding-inline: 7px;
  font-size: 12px;
}

.model-input-row > :first-child {
  min-width: 0;
  flex: 1 1 auto;
}

.model-picker-trigger {
  width: 34px;
  min-width: 34px;
  padding: 0;
}

:global(.model-picker-popover) {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  width: min(360px, var(--reka-popover-content-available-width));
  height: min(360px, var(--reka-popover-content-available-height));
  overflow: hidden;
  border-color: var(--line);
  background: var(--surface-raised);
  padding: 4px;
}

.model-picker-command {
  display: grid;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  border-radius: 7px;
  background: transparent;
}

.model-picker-command :deep([cmdk-input-wrapper]) {
  height: 34px;
  gap: 7px;
  margin: 2px 2px 4px;
  border: 1px solid var(--line-subtle);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 0 9px;
}

.model-picker-command :deep([cmdk-input-wrapper]:focus-within) {
  border-color: var(--focus-ring);
}

.model-picker-command :deep([cmdk-input-wrapper] > svg) {
  width: 14px;
  height: 14px;
  margin-right: 0;
}

.model-picker-search-input {
  height: 32px;
  padding: 0;
  font-size: 12px;
}

.model-picker-scroll {
  min-height: 0;
  max-height: none;
}

.model-picker-scroll :deep([data-task-handoff-scroll-viewport]) {
  padding-right: 8px;
}

.model-picker-list {
  max-height: none;
  overflow: visible;
}

.model-picker-group {
  padding: 0;
}

.model-picker-option {
  min-height: 32px;
  border-radius: 6px;
  cursor: pointer;
  padding: 5px 8px;
  font-size: 12px;
}

.model-picker-option:hover,
.model-picker-option:focus-visible,
.model-picker-option[data-highlighted] {
  background: var(--surface-active);
  color: var(--text-strong);
}

.model-picker-option[data-state="checked"] {
  background: var(--surface-active);
  color: var(--status-success);
}

.model-picker-option > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-picker-option > span + svg {
  margin-left: auto;
}

.model-picker-popover small {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 11px;
}

.model-option-unselected {
  opacity: 0;
}

.model-endpoint-feedback {
  margin: 0;
  color: var(--status-success);
  font-size: 12px;
  line-height: 1.45;
}

.model-endpoint-feedback[data-kind="error"] {
  color: var(--status-danger);
}

.model-form-actions > button:first-child {
  flex: 0 0 auto;
}

.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.checkbox-row,
.project-model-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.modal-section .checkbox-row label {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  gap: 7px;
  min-height: 32px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 11px;
}

.modal-section .checkbox-row label:hover,
.modal-section .checkbox-row label:focus-within {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  color: var(--text-strong);
}

.modal-section .checkbox-row label:has([data-state="checked"]) {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--text-strong);
}

.project-model-picker label {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 11px 0 34px;
}

.project-model-picker input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  margin: 0;
}

.project-model-picker label::before {
  position: absolute;
  left: 11px;
  top: 50%;
  display: grid;
  width: 15px;
  height: 15px;
  place-items: center;
  border: 1px solid var(--text-subtle);
  border-radius: 4px;
  background: var(--surface-inset);
  color: transparent;
  content: "";
  font-size: 13px;
  font-weight: 900;
  line-height: 1;
  transform: translateY(-50%);
}

.project-model-picker label:hover,
.project-model-picker label:focus-within {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  color: var(--text-strong);
}

.project-model-picker label:has(input:focus-visible) {
  outline: 2px solid var(--brand-accent);
  outline-offset: 2px;
}

.project-model-picker label:has(input:checked) {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--text-strong);
}

.project-model-picker label:has(input:checked)::before {
  border-color: var(--brand-accent);
  background: var(--brand-accent);
  color: var(--surface-inset);
  content: "✓";
}

.project-model-picker {
  margin-top: 5px;
}

.project-model-picker small {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
}

.project-model-picker.create-picker {
  display: flex;
  margin-top: 0;
}

.settings-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.image-market-section {
  grid-column: 1 / -1;
}

.image-custom-section {
  min-height: 0;
}

.image-registry-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.image-registry-head > div:first-child {
  display: grid;
  gap: 3px;
}

.image-registry-head > div:first-child > strong {
  color: var(--text-strong);
  font-size: 13px;
}

.image-registry-head > div:first-child > span {
  color: var(--text-muted);
  font-size: 12px;
}

.image-registry-actions {
  display: grid;
  grid-template-columns: minmax(170px, 220px) auto;
  align-items: center;
  gap: 8px;
}

:global(.registry-image-dialog) {
  width: min(520px, calc(100vw - 32px));
  max-width: 520px;
}

.registry-dialog-fields {
  display: grid;
  gap: 12px;
}

.registry-dialog-fields label {
  display: grid;
  min-width: 0;
  gap: 6px;
}

.registry-dialog-fields label > span {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 700;
}

.image-registry-list {
  display: grid;
  gap: 6px;
}

.registered-image-row {
  grid-template-columns: 36px minmax(0, 1fr) minmax(120px, auto) auto;
  gap: 10px;
  border-color: var(--line-subtle);
  background: var(--surface);
  padding: 6px;
}

.registered-image-row:hover {
  border-color: var(--line);
  background: var(--surface-hover);
}

.registered-image-artwork {
  width: 36px;
  height: 36px;
  min-height: 36px;
  border-radius: 7px;
}

.registered-image-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.registered-image-availability {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-market-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.image-market-head > div {
  display: grid;
  gap: 3px;
}

.image-market-head strong {
  color: var(--text-strong);
  font-size: 13px;
}

.image-market-head span {
  color: var(--text-muted);
  font-size: 12px;
}

.market-image-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.market-image-card {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: start;
  min-height: 112px;
  min-width: 0;
  overflow: hidden;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-raised);
  padding: 10px;
  transition: border-color 120ms ease, background 120ms ease;
}

.market-image-card:hover {
  border-color: var(--line-strong);
  background: var(--surface-hover);
}

.market-image-artwork {
  width: 40px;
  height: 40px;
  min-height: 40px;
  border-radius: 8px;
}

.market-image-content {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 5px;
}

.market-image-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.market-image-title strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.market-image-content p {
  overflow: hidden;
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.market-capability-list {
  display: flex;
  min-width: 0;
  gap: 4px;
  overflow: hidden;
}

.market-capability-list span {
  flex: 0 0 auto;
  border: 1px solid var(--line-subtle);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 700;
  line-height: 17px;
  padding: 0 5px;
}

.market-image-footer {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--line-subtle);
}

.market-image-footer span,
.market-image-footer code {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.market-image-footer span {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
}

.market-image-footer span i {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--text-subtle);
}

.market-image-footer span[data-status="available"] i {
  background: var(--status-success);
}

.market-image-footer span[data-status="pull-required"] i {
  background: var(--status-warning);
}

.market-image-footer code {
  min-width: 0;
  flex: 1 1 auto;
  text-align: right;
}

.modal-section label,
.inline-create {
  display: grid;
  gap: 7px;
}

.inline-create {
  gap: 9px;
}

.settings-empty,
.settings-success,
.control-plane-error {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
}

.settings-empty {
  color: var(--text-muted);
}

.settings-success {
  color: var(--status-success);
}

.control-plane-error {
  color: var(--status-danger);
}

.modal-section .list-filter {
  display: flex;
  grid-template-columns: none;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  color: var(--text-muted);
  padding: 0 9px;
}

.modal-section .list-filter input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  font-size: 13px;
  outline: none;
}

.modal-section .list-filter input::placeholder {
  color: var(--text-subtle);
}

.modal-section .local-image-filter {
  margin-bottom: 0;
}

.modal-section .local-image-filter ~ .control-plane-error,
.modal-section .local-image-filter ~ .settings-success,
.modal-section .local-image-filter ~ .local-image-list {
  margin-top: 2px;
}

@media (max-width: 1080px) {
  .market-image-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 780px) {
  .market-image-grid {
    grid-template-columns: 1fr;
  }
  .image-management-grid,
  .project-management-grid,
  .node-management-grid,
  .settings-form-grid {
    grid-template-columns: 1fr;
  }

  .control-settings-page {
    padding: 12px;
  }

  .settings-section-scroll-content {
    padding-right: 6px;
  }

  .image-registry-head {
    display: grid;
  }

  .image-registry-actions {
    grid-template-columns: 1fr;
  }

  .registered-image-row {
    grid-template-columns: 36px minmax(0, 1fr);
  }

  .registered-image-availability,
  .registered-image-row .settings-row-actions {
    grid-column: 2;
  }
}
</style>
<style src="./SettingsPanelSurface.css"></style>
