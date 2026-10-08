<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="instance-settings-dialog" aria-describedby="instance-settings-description">
      <DialogDescription id="instance-settings-description" class="sr-only">
        {{ t("instances.settings.description") }}
      </DialogDescription>
      <button type="button" class="instance-settings-close" :aria-label="t('instances.settings.close')" @click="handleOpenChange(false)">
        <X :size="16" />
      </button>

      <Tabs
        v-model="section"
        orientation="vertical"
        class="instance-settings-tabs"
        :class="{ 'instance-settings-tabs-unavailable': !instance }"
      >
        <div v-if="instance" class="instance-settings-sidebar">
          <div class="instance-settings-identity">
            <span class="instance-settings-identity-eyebrow">{{ t("instances.settings.eyebrow") }}</span>
            <DialogTitle class="instance-settings-identity-name">{{ instance.name }}</DialogTitle>
          </div>
          <ScrollArea class="instance-settings-nav-scroll">
            <TabsList class="instance-settings-nav" :aria-label="t('instances.settings.sections')">
              <div class="instance-settings-nav-group">
                <span class="instance-settings-nav-group-title">{{ t("instances.settings.sectionGroups.instance") }}</span>
                <TabsTrigger value="general"><SlidersHorizontal :size="14" />{{ t("instances.settings.general") }}</TabsTrigger>
              </div>
              <div class="instance-settings-nav-group">
                <span class="instance-settings-nav-group-title">{{ t("instances.settings.sectionGroups.agent") }}</span>
                <TabsTrigger value="ai"><Bot :size="14" />{{ t("instances.settings.ai") }}</TabsTrigger>
                <TabsTrigger value="browser"><Globe2 :size="14" />{{ t("instances.settings.browser") }}</TabsTrigger>
                <TabsTrigger value="codex"><AiAgentIcon agent="codex" :size="14" />{{ t("instances.settings.codex") }}</TabsTrigger>
                <TabsTrigger value="models"><Cpu :size="14" />{{ t("instances.settings.models") }}</TabsTrigger>
              </div>
              <div class="instance-settings-nav-group">
                <span class="instance-settings-nav-group-title">{{ t("instances.settings.sectionGroups.provisioning") }}</span>
                <TabsTrigger value="apps"><Boxes :size="14" />{{ t("instances.settings.apps") }}</TabsTrigger>
                <TabsTrigger value="git-credentials"><KeyRound :size="14" />{{ t("instances.settings.gitCredentials") }}</TabsTrigger>
              </div>
            </TabsList>
          </ScrollArea>
        </div>

        <div v-if="!instance" class="instance-settings-empty">
          <DialogTitle class="instance-settings-empty-title">{{ t("instances.settings.unavailableTitle") }}</DialogTitle>
          <p>{{ t("instances.settings.unavailable") }}</p>
        </div>
        <ScrollArea v-else class="instance-settings-scroll">
          <h2 class="instance-settings-content-title">{{ activeSectionLabel }}</h2>
          <TabsContent value="general" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.detailsTitle") }}</h3>
                <p>{{ t("instances.settings.detailsDescription") }}</p>
              </div>
              <dl class="instance-settings-grid instance-settings-surface">
                <div><dt>{{ t("instances.settings.id") }}</dt><dd><code>{{ instance.id }}</code></dd></div>
                <div><dt>{{ t("instances.settings.state") }}</dt><dd>{{ instanceStatusLabel(instance.status) }} · {{ connectionStatusLabel(instance.connectionStatus) }}</dd></div>
                <div><dt>{{ t("instances.settings.node") }}</dt><dd>{{ instance.node?.name || instance.nodeId }}</dd></div>
                <div><dt>{{ t("instances.settings.runtime") }}</dt><dd>{{ instance.runtime?.name || instance.runtimeId }}</dd></div>
                <div><dt>{{ t("instances.settings.image") }}</dt><dd>{{ instance.image?.name || instance.imageSelection?.imageId || t("instances.settings.none") }}</dd></div>
                <div><dt>{{ t("instances.settings.workspace") }}</dt><dd>{{ instance.workspace.path || instance.runtime?.workspacePath || t("instances.settings.notReported") }} · {{ instance.workspace.status }}</dd></div>
                <div><dt>{{ t("instances.settings.protocol") }}</dt><dd>{{ instance.protocolVersion || instance.build?.protocolVersion || t("instances.settings.notReported") }}</dd></div>
                <div><dt>{{ t("instances.settings.build") }}</dt><dd>{{ instance.build?.packageVersion || instance.instanceVersion || t("instances.settings.notReported") }}</dd></div>
              </dl>
            </section>

            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.configurationTitle") }}</h3>
                <p>{{ t("instances.settings.configurationDescription") }}</p>
              </div>
              <div class="instance-settings-control-surface instance-settings-surface">
                <div class="instance-settings-general-controls">
                  <label class="instance-settings-name-control">
                    <span>
                      <strong>{{ t("instances.settings.instanceName") }}</strong>
                      <small>{{ t("instances.settings.instanceNameDescription") }}</small>
                    </span>
                    <ControlPlaneInput v-model="instanceName" :disabled="savingGeneral" maxlength="160" :placeholder="t('instances.settings.instanceName')" />
                  </label>
                </div>
                <div class="instance-settings-general-actions">
                  <Button size="sm" :disabled="savingGeneral || !generalChanged || !validInstanceName || !validHistoryLimit || !validAttachmentRetention || !validFileAttachmentLimit" @click="saveGeneral">
                    {{ savingGeneral ? t("instances.settings.saving") : t("instances.settings.saveChanges") }}
                  </Button>
                </div>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="ai" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.aiConfigurationTitle") }}</h3>
                <p>{{ t("instances.settings.aiConfigurationDescription") }}</p>
              </div>
              <div class="instance-settings-control-surface instance-settings-surface">
                <div class="instance-settings-general-controls">
                  <label class="instance-settings-name-control"><span><strong>{{ t("instances.settings.aiSessionFileAttachmentLimit") }}</strong><small>{{ fileAttachmentLimitSupported ? t("instances.settings.aiSessionFileAttachmentLimitDescription") : t("instances.settings.aiSessionFileAttachmentLimitUnsupported") }}</small></span><ControlPlaneInput v-model="aiSessionMaxFileAttachmentKiB" type="number" min="1" :max="AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES / 1024" step="1" :disabled="savingGeneral || !fileAttachmentLimitSupported" /></label>
                  <label class="instance-settings-name-control"><span><strong>{{ t("instances.settings.aiSessionAttachmentRetention") }}</strong><small>{{ attachmentRetentionSupported ? t("instances.settings.aiSessionAttachmentRetentionDescription") : t("instances.settings.aiSessionAttachmentRetentionUnsupported") }}</small></span><ControlPlaneInput v-model="aiSessionAttachmentRetentionDays" type="number" min="0" :max="AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS" step="1" :disabled="savingGeneral || !attachmentRetentionSupported" /></label>
                  <p v-if="attachmentRetentionWillShorten" class="instance-settings-help instance-settings-row-note">{{ t("instances.settings.aiSessionAttachmentRetentionWarning") }}</p>
                  <label class="instance-settings-checkbox"><Checkbox :model-value="autoImportAgentConfigs" :disabled="savingGeneral" @update:model-value="autoImportAgentConfigs = $event === true" /><span><strong>{{ t("instances.settings.autoImport") }}</strong><small>{{ t("instances.settings.autoImportDescription") }}</small></span></label>
                  <label class="instance-settings-name-control"><span><strong>{{ t("instances.settings.aiSessionHistoryLimit") }}</strong><small>{{ historyLimitSupported ? t("instances.settings.aiSessionHistoryLimitDescription") : t("instances.settings.aiSessionHistoryLimitUnsupported") }}</small></span><ControlPlaneInput v-model="aiSessionHistoryLimit" type="number" min="1" :max="AI_SESSION_HISTORY_MAX_LIMIT" step="1" :disabled="savingGeneral || !historyLimitSupported" /></label>
                </div>
                <div class="instance-settings-general-actions"><Button size="sm" :disabled="savingGeneral || !aiChanged || !validHistoryLimit || !validAttachmentRetention || !validFileAttachmentLimit" @click="saveGeneral">{{ savingGeneral ? t("instances.settings.saving") : t("instances.settings.saveChanges") }}</Button></div>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="codex" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.codexConfigurationTitle") }}</h3>
                <p>{{ t("instances.settings.codexConfigurationPageDescription") }}</p>
              </div>
              <div v-if="!codexInstalled" class="instance-settings-control-surface instance-settings-surface">
                <div class="instance-settings-state instance-settings-app-missing">
                  <p>{{ t("instances.settings.codexNotInstalled") }}</p>
                  <Button size="sm" variant="outline" @click="section = 'apps'">{{ t("instances.settings.browserGoToApps") }}</Button>
                </div>
              </div>
              <div v-else class="instance-settings-control-surface instance-settings-surface">
                <div class="instance-settings-general-controls">
                  <div v-if="!codexSettingsSupported" class="instance-settings-state">{{ t("instances.settings.codexSettingsUnsupported") }}</div>
                  <label class="instance-settings-checkbox"><Checkbox :model-value="codexConfigEnabled" :disabled="savingCodex" @update:model-value="codexConfigEnabled = $event === true" /><span><strong>{{ t("instances.settings.codexConfiguration") }}</strong><small>{{ t("instances.settings.codexConfigurationDescription") }}</small></span></label>
                  <label class="instance-settings-select-control"><span><strong>{{ t("instances.settings.codexHome") }}</strong><small>{{ t("instances.settings.codexHomeDescription") }}</small></span><ControlPlaneSelect v-model="codexHomeMode" :disabled="savingCodex || !codexConfigEnabled"><ControlPlaneSelectItem value="default">{{ t("instances.settings.codexHomeDefault") }}</ControlPlaneSelectItem><ControlPlaneSelectItem v-if="instance.runtime?.type === 'local'" value="taskhandoff">{{ t("instances.settings.codexHomeTaskHandoff") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
                  <label class="instance-settings-select-control"><span><strong>{{ t("instances.settings.sessionPermissions") }}</strong><small>{{ t("instances.settings.sessionPermissionsDescription") }}</small></span><ControlPlaneSelect v-model="defaultCodexPermissionMode" :disabled="savingCodex || !codexConfigEnabled"><ControlPlaneSelectItem value="ask">{{ t("instances.settings.askApproval") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="auto-review">{{ t("instances.settings.approveForMe") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="full-access">{{ t("instances.settings.fullAccess") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
                  <label class="instance-settings-select-control"><span><strong>{{ t("instances.settings.codexVerbosity") }}</strong><small>{{ t("instances.settings.codexVerbosityDescription") }}</small></span><ControlPlaneSelect v-model="codexVerbosity" :disabled="codexControlsDisabled"><ControlPlaneSelectItem value="default">{{ t("instances.settings.followCodexDefault") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="low">{{ t("instances.settings.verbosityLow") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="medium">{{ t("instances.settings.verbosityMedium") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="high">{{ t("instances.settings.verbosityHigh") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
                  <label class="instance-settings-select-control"><span><strong>{{ t("instances.settings.codexPersonality") }}</strong><small>{{ t("instances.settings.codexPersonalityDescription") }}</small></span><ControlPlaneSelect v-model="codexPersonality" :disabled="codexControlsDisabled"><ControlPlaneSelectItem value="default">{{ t("instances.settings.followCodexDefault") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="none">{{ t("instances.settings.personalityNone") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="friendly">{{ t("instances.settings.personalityFriendly") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="pragmatic">{{ t("instances.settings.personalityPragmatic") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
                  <label class="instance-settings-checkbox"><Checkbox :model-value="codexMultiAgentEnabled" :disabled="codexControlsDisabled" @update:model-value="codexMultiAgentEnabled = $event === true" /><span><strong>{{ t("instances.settings.codexMultiAgent") }}</strong><small>{{ t("instances.settings.codexMultiAgentDescription") }}</small></span></label>
                  <label class="instance-settings-name-control"><span><strong>{{ t("instances.settings.codexMultiAgentConcurrency") }}</strong><small>{{ t("instances.settings.codexMultiAgentConcurrencyDescription") }}</small></span><ControlPlaneInput v-model="codexMultiAgentMaxThreads" type="number" min="1" max="64" step="1" :placeholder="t('instances.settings.followCodexDefault')" :disabled="codexControlsDisabled || !codexMultiAgentEnabled" /></label>
                  <label class="instance-settings-select-control"><span><strong>{{ t("instances.settings.codexDefaultSubagentModel") }}</strong><small>{{ t("instances.settings.codexDefaultSubagentModelDescription") }}</small></span><ControlPlaneSelect v-model="codexSubagentModel" :disabled="codexControlsDisabled || !codexMultiAgentEnabled"><ControlPlaneSelectItem value="default">{{ t("instances.settings.followCodexDefault") }}</ControlPlaneSelectItem><ControlPlaneSelectItem v-for="option in codexModelOptions" :key="option.value" :value="option.value">{{ option.label }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
                  <label class="instance-settings-select-control"><span><strong>{{ t("instances.settings.codexSubagentReasoning") }}</strong><small>{{ t("instances.settings.codexSubagentReasoningDescription") }}</small></span><ControlPlaneSelect v-model="codexSubagentReasoning" :disabled="codexControlsDisabled || !codexMultiAgentEnabled"><ControlPlaneSelectItem value="default">{{ t("instances.settings.followCodexDefault") }}</ControlPlaneSelectItem><ControlPlaneSelectItem v-for="effort in codexReasoningEfforts" :key="effort" :value="effort">{{ t(`instances.settings.codexReasoning.${effort}`) }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
                </div>
                <div class="instance-settings-general-actions"><Button size="sm" :disabled="savingCodex || !codexChanged || (codexSettingsSupported && !validCodexMaxThreads)" @click="saveCodex">{{ savingCodex ? t("instances.settings.saving") : t("instances.settings.saveChanges") }}</Button></div>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="browser" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <BrowserProfilesSection
                v-if="instance"
                :instance="instance"
                :app-management="appManagement"
                @open-apps="section = 'apps'"
                @open-session="(sessionId) => emit('open-app-session', instance!.id, sessionId)"
              />
            </section>
          </TabsContent>

          <TabsContent value="models" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.modelSelection") }}</h3>
                <p>{{ t("instances.settings.modelSelectionDescription") }}</p>
              </div>
              <div class="instance-model-surface instance-settings-surface">
                <ModelEntitySelection v-model="modelEntityIds" :models="models" :node-id="instance?.nodeId || ''" :disabled="savingModels || !codexConfigEnabled" @open-model-settings="emit('open-model-settings')" />
                <div class="instance-settings-general-actions">
                  <Button size="sm" :disabled="savingModels || !modelsChanged" @click="saveModels">
                    {{ savingModels ? t("instances.settings.saving") : t("instances.settings.saveModels") }}
                  </Button>
                </div>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="git-credentials" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.gitCredentialsTitle") }}</h3>
                <p>{{ t("instances.settings.gitCredentialsDescription") }}</p>
              </div>
              <div class="instance-git-directory instance-settings-surface">
                <div v-if="!gitBrokerSupported" class="instance-settings-state">{{ t("instances.settings.gitCredentialsUnsupported") }}</div>
                <div v-else-if="gitAssignments.error.value || gitCredentials.error.value" class="instance-settings-state instance-settings-state-error" role="alert">
                  <span>{{ gitCredentialError }}</span>
                  <Button size="sm" variant="outline" @click="refreshGitCredentials">{{ t("instances.settings.retry") }}</Button>
                </div>
                <template v-else>
                  <div v-if="gitCredentialMatchText" class="instance-git-match-preview" :data-status="gitCredentialMatchStatus">
                    <Globe2 :size="15" />
                    <span>{{ gitCredentialMatchText }}</span>
                    <Badge variant="secondary">{{ t(`instances.settings.gitCredentialMatchStatus.${gitCredentialMatchStatus}`) }}</Badge>
                  </div>
                  <div class="instance-git-assignment-create">
                    <ControlPlaneSelect v-model="selectedGitCredentialId" :placeholder="t('instances.settings.selectGitCredential')" :disabled="gitCredentialBusy">
                      <ControlPlaneSelectItem :value="noGitCredentialValue">{{ t("instances.settings.selectGitCredential") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem v-for="credential in assignableGitCredentials" :key="credential.id" :value="credential.id">{{ credential.name }} · {{ credential.scope.host }}{{ credential.scope.pathPrefix }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                    <Button size="sm" :disabled="!selectedGitCredentialId || selectedGitCredentialId === noGitCredentialValue || gitCredentialBusy" @click="authorizeGitCredential">
                      <KeyRound :size="14" />
                      {{ t("instances.settings.authorizeGitCredential") }}
                    </Button>
                  </div>
                  <div v-if="gitAssignments.isLoading.value" class="instance-settings-state">{{ t("instances.settings.gitCredentialsLoading") }}</div>
                  <div v-else-if="!gitAssignments.data.value?.length" class="instance-settings-state instance-settings-empty-state">
                    <KeyRound :size="26" aria-hidden="true" />
                    <span>{{ t("instances.settings.noGitCredentials") }}</span>
                  </div>
                  <div v-else class="instance-app-list instance-directory-list">
                    <article v-for="assignment in gitAssignments.data.value" :key="assignment.credentialId" class="instance-app-row instance-git-assignment-row">
                      <div class="instance-directory-identity">
                        <span class="instance-app-icon" aria-hidden="true"><KeyRound :size="16" /></span>
                        <div>
                          <strong>{{ gitCredentialName(assignment.credentialId) }}</strong>
                          <code>{{ gitCredentialScope(assignment.credentialId) }}</code>
                        </div>
                      </div>
                      <div class="instance-git-assignment-actions">
                        <Badge :variant="assignment.status === 'synced' ? 'default' : 'secondary'">{{ t(`instances.settings.gitCredentialStatus.${assignment.status}`) }}</Badge>
                        <Button size="sm" variant="outline" :disabled="gitCredentialBusy" @click="revokeGitCredential(assignment.credentialId)">{{ t("instances.settings.revokeGitCredential") }}</Button>
                      </div>
                    </article>
                  </div>
                </template>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="apps" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-app-heading">
                <div class="instance-settings-section-heading">
                  <h3>{{ t("instances.settings.managedApps") }}</h3>
                  <p>{{ t("instances.settings.managedAppsDescription") }}</p>
                </div>
                <div v-if="appManagement" class="instance-app-heading-actions">
                  <Badge variant="secondary">{{ appManagement.capabilities.platform }} · {{ appManagement.capabilities.arch }}</Badge>
                  <Button size="icon" variant="ghost" :aria-label="t('instances.settings.refreshApps')" :disabled="appManagementLoading" @click="refreshApps">
                    <RefreshCw :class="{ 'animate-spin motion-reduce:animate-none': appManagementLoading }" :size="14" />
                  </Button>
                </div>
              </div>
              <p v-if="appManagement" class="instance-settings-observed">{{ t("instances.settings.observed", { time: formatObservedAt(appManagement.observedAt), privilege: appManagement.capabilities.privilege }) }}</p>
              <div class="instance-app-directory instance-settings-surface">
                <div v-if="appManagementLoading && !appManagement" class="instance-settings-state">{{ t("instances.settings.appsLoading") }}</div>
                <div v-else-if="appManagementError" class="instance-settings-state instance-settings-state-error" role="alert">
                  <span>{{ t("instances.settings.appsUnavailable") }} · {{ appManagementError }}</span>
                  <Button size="sm" variant="outline" @click="refreshApps">{{ t("instances.settings.retry") }}</Button>
                </div>
                <div v-else-if="!appManagement" class="instance-settings-state">{{ t("instances.settings.noSnapshot") }}</div>
                <div v-else-if="!appManagement.apps.length" class="instance-settings-state instance-settings-empty-state">{{ t("instances.settings.noManagedApps") }}</div>
                <template v-else>
                <div class="instance-app-toolbar" :aria-label="t('instances.settings.appFilters')">
                  <div class="instance-app-filters">
                    <Button v-for="filter in appFilters" :key="filter.value" size="sm" :variant="appFilter === filter.value ? 'secondary' : 'ghost'" :aria-pressed="appFilter === filter.value" @click="appFilter = filter.value">
                      {{ filter.label }} <span>{{ filter.count }}</span>
                    </Button>
                  </div>
                  <small>{{ installableAppCount ? t("instances.settings.readyToInstall", { count: installableAppCount }) : t("instances.settings.noInstalls") }}</small>
                </div>
                <div v-if="!filteredManagedApps.length" class="instance-settings-state">{{ t("instances.settings.noFilterMatches") }}</div>
                <div v-else class="instance-app-list instance-directory-list">
                  <article v-for="app in filteredManagedApps" :key="app.id" class="instance-app-row instance-managed-app-row">
                    <div class="instance-app-main">
                      <div class="instance-app-identity">
                        <span class="instance-app-icon" aria-hidden="true">
                          <AiAgentIcon v-if="app.id === 'codex' || app.id === 'claude'" :agent="app.id" :size="17" />
                          <component :is="managedAppIcon(app)" v-else :size="17" />
                        </span>
                        <div class="instance-app-copy">
                          <strong>{{ app.name }}</strong>
                          <small v-if="app.description">{{ app.description }}</small>
                          <code>{{ app.id }} · {{ app.kind }}<template v-if="app.version"> · {{ app.version }}</template></code>
                          <small v-if="updateCheckLabel(app)" class="instance-app-update-check" :class="updateCheckClass(app)">{{ updateCheckLabel(app) }}</small>
                          <small v-if="appActionHint(app)" class="instance-app-action-reason">{{ appActionHint(app) }}</small>
                        </div>
                      </div>
                      <div class="instance-app-controls">
                        <Badge :variant="managedAppBadgeVariant(app.state)">{{ managedAppStateLabel(app.state) }}</Badge>
                        <Button v-if="activeJob(app)" size="sm" disabled>
                          <LoaderCircle class="animate-spin motion-reduce:animate-none" :size="13" />
                          {{ operationLabel(activeJob(app)!.operation) }}
                        </Button>
                        <DropdownMenu v-else-if="hasAppActions(app)">
                          <DropdownMenuTrigger as-child>
                            <Button size="sm" variant="outline" :disabled="operationSubmitting === app.id || checkingApps.has(app.id)" :aria-label="t('instances.settings.appActions')">
                              <LoaderCircle v-if="checkingApps.has(app.id)" class="animate-spin motion-reduce:animate-none" :size="13" />
                              <MoreHorizontal v-else :size="14" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" :side-offset="6" class="instance-app-actions-menu">
                            <DropdownMenuItem v-if="app.canInstall" :disabled="operationSubmitting === app.id" @select="openAppConfirmation(app, 'install')">{{ t("instances.settings.install") }}</DropdownMenuItem>
                            <DropdownMenuItem v-if="app.canUpdate" :disabled="checkingApps.has(app.id)" @select="runAppUpdateCheck(app)">{{ checkingApps.has(app.id) ? t("instances.settings.checkingUpdate") : t("instances.settings.checkUpdate") }}</DropdownMenuItem>
                            <DropdownMenuItem v-if="app.canUpdate" :disabled="operationSubmitting === app.id" @select="openAppConfirmation(app, 'update')">{{ t("instances.settings.update") }}</DropdownMenuItem>
                            <DropdownMenuSeparator v-if="app.canUninstall" />
                            <DropdownMenuItem v-if="app.canUninstall" class="instance-app-action-danger" :disabled="operationSubmitting === app.id" @select="openAppConfirmation(app, 'uninstall')">{{ t("instances.settings.uninstall") }}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    <div v-if="activeJob(app) || executionJob(app)?.command || executionJob(app)?.logTail || terminalJob(app)" class="instance-app-activity">
                      <small v-if="activeJob(app)" class="instance-app-job-line">{{ jobLabel(activeJob(app)!) }}</small>
                      <Progress v-if="progressPercent(activeJob(app)) !== undefined" :model-value="progressPercent(activeJob(app))" class="instance-app-progress" />
                      <details v-if="executionJob(app)?.command || executionJob(app)?.logTail" class="instance-app-terminal" :open="Boolean(activeJob(app))">
                        <summary>{{ activeJob(app) ? t("instances.settings.liveInstallerOutput") : t("instances.settings.installerOutput") }}<template v-if="executionJob(app)?.logTruncated"> · {{ t("instances.settings.latestLog") }}</template></summary>
                        <pre aria-live="polite">{{ executionOutput(executionJob(app)!) }}</pre>
                      </details>
                      <small v-if="terminalJob(app)" :class="terminalJob(app)?.state === 'succeeded' ? 'instance-settings-success' : 'instance-settings-error'" role="status">
                        {{ terminalJobLabel(terminalJob(app)!) }}<template v-if="terminalJob(app)?.error"> · {{ terminalJob(app)?.error?.message }}</template><template v-if="terminalJob(app)?.error?.retryable"> {{ t("instances.settings.retryDetected") }}</template>
                      </small>
                    </div>
                  </article>
                </div>
                </template>
              </div>
            </section>

            <section class="instance-settings-card instance-settings-group">
              <div class="instance-app-heading">
                <div class="instance-settings-section-heading">
                  <h3>{{ t("instances.settings.customLaunchers") }}</h3>
                  <p>{{ t("instances.settings.customLaunchersDescription") }}</p>
                </div>
                <Badge :variant="inventoryBadgeVariant">{{ inventoryStateLabel }}</Badge>
              </div>
              <p v-if="instance.appInventory" class="instance-settings-observed">{{ t("instances.settings.inventoryObserved", { time: formatObservedAt(instance.appInventory.observedAt) }) }}</p>
              <div class="instance-app-directory instance-settings-surface">
                <div v-if="!customInventoryApps.length" class="instance-settings-state instance-settings-empty-state">{{ t("instances.settings.noCustomLaunchers") }}</div>
                <div v-else class="instance-app-list instance-directory-list">
                  <article v-for="app in customInventoryApps" :key="app.id" class="instance-app-row instance-custom-app-row">
                    <div class="instance-directory-identity">
                      <span class="instance-app-icon" aria-hidden="true"><Boxes :size="16" /></span>
                      <div><strong>{{ app.name }}</strong><code>{{ app.id }} · {{ app.kind }}</code><small v-if="app.diagnosticCode">{{ t("instances.settings.executableMissing") }}</small></div>
                    </div>
                    <Badge :variant="app.availability === 'available' ? 'default' : 'secondary'">{{ app.availability }}</Badge>
                  </article>
                </div>
                <div v-if="instance.appInventory?.issues.length" class="instance-app-issues" role="status">
                  <strong>{{ t("instances.settings.inventoryDiagnostics") }}</strong>
                  <p v-for="issue in instance.appInventory.issues" :key="issue.code">{{ issue.message }} <code>{{ issue.code }}</code></p>
                </div>
              </div>
            </section>
          </TabsContent>
        </ScrollArea>
      </Tabs>

      <AlertDialog :open="Boolean(appConfirmation)" @update:open="(value) => { if (!value && !operationSubmitting) appConfirmation = undefined; }">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{{ appConfirmationTitle }}</AlertDialogTitle>
            <AlertDialogDescription>{{ appConfirmationDescription }}</AlertDialogDescription>
          </AlertDialogHeader>
          <div v-if="appConfirmation" class="instance-app-confirmation-summary">
            <span><small>{{ t("instances.settings.app") }}</small><strong>{{ appConfirmation.app.name }}</strong></span>
            <span><small>{{ t("instances.settings.target") }}</small><strong>{{ instance?.name }}</strong></span>
            <span><small>{{ t("instances.settings.privilege") }}</small><strong>{{ appManagement?.capabilities.privilege || t("instances.settings.notReported") }}</strong></span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel :disabled="Boolean(operationSubmitting)">{{ t("instances.settings.cancel") }}</AlertDialogCancel>
            <Button type="button" :disabled="Boolean(operationSubmitting)" @click="confirmAppOperation">
              <LoaderCircle v-if="operationSubmitting" class="animate-spin motion-reduce:animate-none" :size="14" />
              {{ appConfirmationConfirmLabel }}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Bot, Boxes, Cpu, Globe2, KeyRound, LoaderCircle, Monitor, MoreHorizontal, RefreshCw, SlidersHorizontal, TerminalSquare, X } from "@lucide/vue";
import { AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS, AI_SESSION_HISTORY_MAX_LIMIT, AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES, type AiSessionPermissionMode, type AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";
import { supportsAiSessionFileSizeLimitSettings, supportsControlledInstanceCodexManagedSettings, supportsGitCredentialProxy, supportsNodeAiSessionFileAttachmentLimit, supportsNodeCodexManagedSettings } from "@task-handoff/protocol/control-plane";
import { resolveGitCredential, type GitCredentialPublic } from "@task-handoff/protocol/managed-git-credentials";
import type { AppManagementJob, AppManagementOperation, AppManagementSnapshot, CodexInstanceSettings, InstanceBoardItem, ManagedAppProjection, ModelConfig, ModelSelection, UpdateControlledInstanceInput } from "../../../api/types";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import AiAgentIcon from "../../../components/AiAgentIcon.vue";
import { AI_SESSION_REASONING_EFFORTS } from "../../../components/ai-session/aiSessionReasoningEfforts";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Progress } from "../../../components/ui/progress";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import BrowserProfilesSection from "./BrowserProfilesSection.vue";
import ModelEntitySelection from "../../../components/models/ModelEntitySelection.vue";
import { useControlPlaneLocale } from "../../../i18n/index";
import { formatDateTime } from "../../../i18n/presentation";
import { connectionStatusKeys, instanceStatusKeys, translateStatus } from "../../../i18n/status";
import { translateApiError } from "../../../i18n/apiError";
import { authorizeInstanceGitCredential, revokeInstanceGitCredential, useGitCredentialsQuery, useInstanceGitCredentialAssignmentsQuery } from "../../../api/queries";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { instanceModelEntityId, instanceModelIdMatches } from "./instanceSettingsState";

const { t } = useI18n();
const { locale } = useControlPlaneLocale();
const instanceStatusLabel = (status: string) => translateStatus(instanceStatusKeys, status, t);
const connectionStatusLabel = (status: string) => translateStatus(connectionStatusKeys, status, t);

type InstanceSettingsSection = "general" | "ai" | "browser" | "codex" | "models" | "git-credentials" | "apps";
type AppFilter = "all" | "available" | "installed";

const props = defineProps<{
  open: boolean;
  initialSection?: InstanceSettingsSection;
  instance?: InstanceBoardItem;
  models: ModelConfig[];
  appManagement?: AppManagementSnapshot;
  appManagementLoading: boolean;
  appManagementError: string;
  refreshAppManagement: (instanceId: string) => Promise<void>;
  manageApp: (instanceId: string, appId: string, operation: AppManagementOperation) => Promise<void>;
  checkAppUpdate: (instanceId: string, appId: string) => Promise<void>;
  updateInstance: (instance: InstanceBoardItem, input: UpdateControlledInstanceInput) => Promise<void>;
}>();

const emit = defineEmits<{
  "open-app-session": [instanceId: string, sessionId: string];
  "open-model-settings": [];
  "update:open": [open: boolean];
}>();
const section = ref<InstanceSettingsSection>("general");
const sectionLabelKeys: Record<InstanceSettingsSection, string> = {
  general: "instances.settings.general",
  ai: "instances.settings.ai",
  browser: "instances.settings.browser",
  codex: "instances.settings.codex",
  models: "instances.settings.models",
  "git-credentials": "instances.settings.gitCredentials",
  apps: "instances.settings.apps",
};
const activeSectionLabel = computed(() => t(sectionLabelKeys[section.value]));
const instanceName = ref("");
const autoImportAgentConfigs = ref(true);
const codexConfigEnabled = ref(true);
const codexHomeMode = ref<"default" | "taskhandoff">("taskhandoff");
const defaultCodexPermissionMode = ref<AiSessionPermissionMode>("ask");
const codexVerbosity = ref<"default" | "low" | "medium" | "high">("default");
const codexPersonality = ref<"default" | "none" | "friendly" | "pragmatic">("default");
const codexMultiAgentEnabled = ref(true);
const codexMultiAgentMaxThreads = ref("");
const codexSubagentModel = ref("default");
const codexSubagentReasoning = ref<"default" | AiSessionReasoningEffort>("default");
const codexReasoningEfforts = AI_SESSION_REASONING_EFFORTS;
const aiSessionHistoryLimit = ref("50");
const aiSessionAttachmentRetentionDays = ref("30");
const aiSessionMaxFileAttachmentKiB = ref("500");
const modelSelection = ref<ModelSelection>({});
const savingGeneral = ref(false);
const savingCodex = ref(false);
const savingModels = ref(false);
const operationSubmitting = ref("");
const checkingApps = reactive(new Set<string>());
const appConfirmation = ref<{ app: ManagedAppProjection; operation: AppManagementOperation }>();
const appFilter = ref<AppFilter>("all");
const noGitCredentialValue = "__none__";
const selectedGitCredentialId = ref(noGitCredentialValue);
const gitCredentialBusy = ref(false);
const gitBrokerSupported = computed(() => Boolean(props.instance && supportsGitCredentialProxy(props.instance.capabilities)));
const gitCredentials = useGitCredentialsQuery(computed(() => props.open && section.value === "git-credentials" && gitBrokerSupported.value));
const gitAssignments = useInstanceGitCredentialAssignmentsQuery(computed(() => props.instance?.id || ""), computed(() => props.open && section.value === "git-credentials" && gitBrokerSupported.value));
const assignedGitCredentialIds = computed(() => new Set((gitAssignments.data.value || []).map((assignment) => assignment.credentialId)));
const assignableGitCredentials = computed(() => (gitCredentials.data.value || []).filter((credential) => credential.status === "enabled" && !assignedGitCredentialIds.value.has(credential.id)));
const gitCredentialError = computed(() => translateApiError(gitAssignments.error.value || gitCredentials.error.value, t, t("instances.settings.gitCredentialsLoadFailed")));
const gitCredentialMatch = computed(() => {
  const source = props.instance?.source;
  if (!source || source.type === "local-folder") return undefined;
  const syncedIds = new Set((gitAssignments.data.value || [])
    .filter((assignment) => assignment.status === "synced")
    .map((assignment) => assignment.credentialId));
  return resolveGitCredential(source.url, (gitCredentials.data.value || [])
    .filter((credential) => syncedIds.has(credential.id))
    .map((credential) => ({
      id: credential.id,
      kind: credential.kind,
      scope: credential.scope,
      status: credential.status,
      pinnedKnownHosts: credential.kind === "ssh-key",
    })));
});
const gitCredentialMatchStatus = computed(() => gitCredentialMatch.value?.status || "none");
const gitCredentialMatchText = computed(() => {
  const match = gitCredentialMatch.value;
  if (!match) return "";
  if (match.status === "unique") return t("instances.settings.gitCredentialMatchUnique", { name: gitCredentialName(match.credential.id) });
  if (match.status === "ambiguous") return t("instances.settings.gitCredentialMatchAmbiguous", { count: match.credentialIds.length });
  if (match.status === "missing-host-key") return t("instances.settings.gitCredentialMatchHostKey");
  if (match.status === "unsupported") return t("instances.settings.gitCredentialMatchUnsupported");
  return t("instances.settings.gitCredentialMatchNone");
});

function gitCredential(credentialId: string): GitCredentialPublic | undefined { return gitCredentials.data.value?.find((item) => item.id === credentialId); }
function gitCredentialName(credentialId: string) { return gitCredential(credentialId)?.name || credentialId; }
function gitCredentialScope(credentialId: string) {
  const credential = gitCredential(credentialId);
  return credential ? `${credential.scope.scheme}://${credential.scope.host}${credential.scope.port ? `:${credential.scope.port}` : ""}${credential.scope.pathPrefix}` : credentialId;
}
async function refreshGitCredentials() { await Promise.all([gitCredentials.refetch(), gitAssignments.refetch()]); }
async function authorizeGitCredential() {
  const instance = props.instance;
  if (!instance || selectedGitCredentialId.value === noGitCredentialValue) return;
  gitCredentialBusy.value = true;
  try {
    await authorizeInstanceGitCredential(instance.id, selectedGitCredentialId.value);
    selectedGitCredentialId.value = noGitCredentialValue;
    await refreshGitCredentials();
  } catch (cause) { showControlPlaneToast(translateApiError(cause, t, t("instances.settings.gitCredentialAuthorizeFailed")), "error"); }
  finally { gitCredentialBusy.value = false; }
}
async function revokeGitCredential(credentialId: string) {
  const instance = props.instance;
  if (!instance) return;
  gitCredentialBusy.value = true;
  try { await revokeInstanceGitCredential(instance.id, credentialId); await refreshGitCredentials(); }
  catch (cause) { showControlPlaneToast(translateApiError(cause, t, t("instances.settings.gitCredentialRevokeFailed")), "error"); }
  finally { gitCredentialBusy.value = false; }
}

const generalChanged = computed(() => Boolean(props.instance && instanceName.value.trim() !== props.instance.name));
const aiChanged = computed(() => Boolean(props.instance && (
  autoImportAgentConfigs.value !== props.instance.config.autoImportAgentConfigs
  || (historyLimitSupported.value && Number(aiSessionHistoryLimit.value) !== props.instance.config.aiSessionHistoryLimit)
  || (attachmentRetentionSupported.value && Number(aiSessionAttachmentRetentionDays.value) !== props.instance.config.aiSessionAttachmentRetentionDays)
  || (fileAttachmentLimitSupported.value && Number(aiSessionMaxFileAttachmentKiB.value) * 1024 !== props.instance.config.aiSessionMaxFileAttachmentBytes)
)));
const codexSettingsSupported = computed(() => {
  const agent = props.instance?.node?.capabilities?.agent;
  const nodeCapabilities = agent && typeof agent === "object" && !Array.isArray(agent)
    ? (agent as { capabilities?: unknown }).capabilities
    : undefined;
  return supportsNodeCodexManagedSettings(nodeCapabilities)
    && supportsControlledInstanceCodexManagedSettings(props.instance?.capabilities);
});
// 未安装时展示安装引导而不是无效表单；没有权威快照时保持现有设置界面。
const codexInstalled = computed(() => {
  const app = props.appManagement?.apps.find((candidate) => candidate.id === "codex");
  return !app || app.state === "installed";
});
const codexControlsDisabled = computed(() => savingCodex.value || !codexConfigEnabled.value || !codexSettingsSupported.value);
function codexModelValue(modelEntityId: string, modelName: string) {
  return `${encodeURIComponent(modelEntityId)}:${encodeURIComponent(modelName)}`;
}
const codexModelOptions = computed(() => {
  const assigned = new Set(normalizedSelection(props.instance?.modelSelection || {}).modelEntityIds || []);
  const nodeId = props.instance?.nodeId || "";
  return props.models
    .filter((model) => [...assigned].some((id) => instanceModelIdMatches(model, id)) && model.enabled && (model.protocols?.includes("openai-responses") || (!model.protocols?.length && model.app === "codex")))
    .flatMap((model) => (model.modelNames?.length ? model.modelNames : [{ name: model.model, order: 0 }])
      .slice()
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
      .map((entry) => ({ value: codexModelValue(instanceModelEntityId(model), entry.name), label: `${model.name} · ${entry.name}` })));
});
function currentCodexSettings(): CodexInstanceSettings {
  const selectedModel = codexSubagentModel.value === "default"
    ? undefined
    : codexModelOptions.value.find((option) => option.value === codexSubagentModel.value);
  const [encodedEntityId, encodedModelName] = selectedModel?.value.split(":") || [];
  return {
    ...(codexVerbosity.value === "default" ? {} : { modelVerbosity: codexVerbosity.value }),
    ...(codexPersonality.value === "default" ? {} : { personality: codexPersonality.value }),
    multiAgent: {
      enabled: codexMultiAgentEnabled.value,
      ...(codexMultiAgentMaxThreads.value ? { maxConcurrentThreads: Number(codexMultiAgentMaxThreads.value) } : {}),
      ...(encodedEntityId && encodedModelName ? { defaultModel: { modelEntityId: decodeURIComponent(encodedEntityId), modelName: decodeURIComponent(encodedModelName) } } : {}),
      ...(codexSubagentReasoning.value === "default" ? {} : { defaultReasoningEffort: codexSubagentReasoning.value }),
    },
  };
}
const codexChanged = computed(() => Boolean(props.instance && (
  codexConfigEnabled.value !== props.instance.config.codexConfigEnabled
  || codexHomeMode.value !== props.instance.config.codexHomeMode
  || defaultCodexPermissionMode.value !== props.instance.config.defaultCodexPermissionMode
  || (codexSettingsSupported.value && JSON.stringify(currentCodexSettings()) !== JSON.stringify(props.instance.config.codexSettings || { multiAgent: { enabled: true } }))
)));
const validCodexMaxThreads = computed(() => {
  if (!codexMultiAgentMaxThreads.value) return true;
  const value = Number(codexMultiAgentMaxThreads.value);
  return Number.isInteger(value) && value >= 1 && value <= 64;
});
const validInstanceName = computed(() => instanceName.value.trim().length > 0);
const validHistoryLimit = computed(() => {
  const value = Number(aiSessionHistoryLimit.value);
  return !historyLimitSupported.value || (Number.isInteger(value) && value >= 1 && value <= AI_SESSION_HISTORY_MAX_LIMIT);
});
const historyLimitSupported = computed(() => {
  const instance = props.instance;
  if (!instance) return false;
  const nodeAgent = instance.node?.capabilities?.agent;
  const nodeCapabilities = nodeAgent && typeof nodeAgent === "object" && !Array.isArray(nodeAgent)
    ? (nodeAgent as Record<string, unknown>).capabilities
    : undefined;
  const nodeSupported = Boolean(nodeCapabilities && typeof nodeCapabilities === "object" && !Array.isArray(nodeCapabilities)
    && (nodeCapabilities as Record<string, unknown>).aiSessionHistoryLimit === true);
  const features = instance.capabilities?.features;
  const instanceSupported = Boolean(features && typeof features === "object" && !Array.isArray(features)
    && (features as Record<string, unknown>).aiSessionPersistenceSettings === true);
  return nodeSupported && instanceSupported;
});
const validAttachmentRetention = computed(() => {
  const value = Number(aiSessionAttachmentRetentionDays.value);
  return !attachmentRetentionSupported.value || (Number.isInteger(value) && value >= 0 && value <= AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS);
});
const attachmentRetentionSupported = computed(() => {
  const instance = props.instance;
  if (!instance) return false;
  const nodeAgent = instance.node?.capabilities?.agent;
  const nodeCapabilities = nodeAgent && typeof nodeAgent === "object" && !Array.isArray(nodeAgent)
    ? (nodeAgent as Record<string, unknown>).capabilities
    : undefined;
  const nodeSupported = Boolean(nodeCapabilities && typeof nodeCapabilities === "object" && !Array.isArray(nodeCapabilities)
    && (nodeCapabilities as Record<string, unknown>).aiSessionAttachmentRetention === true);
  const features = instance.capabilities?.features;
  const feature = features && typeof features === "object" && !Array.isArray(features)
    ? (features as Record<string, unknown>).aiSessionConversationAttachments
    : undefined;
  return nodeSupported && Boolean(feature && typeof feature === "object" && !Array.isArray(feature) && (feature as Record<string, unknown>).retentionSettings === true);
});
const validFileAttachmentLimit = computed(() => {
  const value = Number(aiSessionMaxFileAttachmentKiB.value);
  return !fileAttachmentLimitSupported.value || (Number.isInteger(value) && value >= 1 && value <= AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES / 1024);
});
const fileAttachmentLimitSupported = computed(() => {
  const nodeAgent = props.instance?.node?.capabilities?.agent;
  const nodeCapabilities = nodeAgent && typeof nodeAgent === "object" && !Array.isArray(nodeAgent)
    ? (nodeAgent as Record<string, unknown>).capabilities
    : undefined;
  return supportsNodeAiSessionFileAttachmentLimit(nodeCapabilities)
    && supportsAiSessionFileSizeLimitSettings(props.instance?.capabilities);
});
const attachmentRetentionWillShorten = computed(() => Boolean(
  props.instance
  && attachmentRetentionSupported.value
  && Number(aiSessionAttachmentRetentionDays.value) < props.instance.config.aiSessionAttachmentRetentionDays,
));
const legacyModelSelectionNeedsUpgrade = computed(() => {
  const selection = props.instance?.modelSelection;
  return Boolean(selection && !selection.modelEntityIds?.length && legacyModelEntityIds(selection).length);
});
const modelsChanged = computed(() => legacyModelSelectionNeedsUpgrade.value
  || JSON.stringify(normalizedSelection(modelSelection.value)) !== JSON.stringify(normalizedSelection(props.instance?.modelSelection || {})));
const inventoryState = computed<"current" | "stale" | "not-reported" | "empty" | "degraded">(() => {
  const inventory = props.instance?.appInventory;
  if (!inventory) return "not-reported";
  if (inventory.issues.length) return "degraded";
  if (props.instance?.connectionStatus !== "online") return "stale";
  return inventory.items.length ? "current" : "empty";
});
const inventoryStateLabel = computed(() => ({
  current: t("instances.settings.inventoryCurrent"),
  stale: t("instances.settings.inventoryStale"),
  "not-reported": t("instances.settings.notReported"),
  empty: t("instances.settings.inventoryEmpty"),
  degraded: t("instances.settings.inventoryDegraded"),
})[inventoryState.value]);
const inventoryBadgeVariant = computed<"default" | "secondary" | "destructive">(() => inventoryState.value === "current" ? "default" : inventoryState.value === "degraded" ? "destructive" : "secondary");
const customInventoryApps = computed(() => props.instance?.appInventory?.items.filter((app) => app.source === "custom") || []);
const installableAppCount = computed(() => props.appManagement?.apps.filter((app) => app.canInstall).length || 0);
const installedAppCount = computed(() => props.appManagement?.apps.filter((app) => app.state === "installed").length || 0);
const appFilters = computed(() => [
  { value: "all" as const, label: t("instances.settings.filterAll"), count: props.appManagement?.apps.length || 0 },
  { value: "available" as const, label: t("instances.settings.filterAvailable"), count: installableAppCount.value },
  { value: "installed" as const, label: t("instances.settings.filterInstalled"), count: installedAppCount.value },
]);
const filteredManagedApps = computed(() => {
  const apps = props.appManagement?.apps || [];
  if (appFilter.value === "available") return apps.filter((app) => app.canInstall);
  if (appFilter.value === "installed") return apps.filter((app) => app.state === "installed");
  return apps;
});

watch(
  [() => props.open, () => props.instance?.id, () => props.initialSection],
  ([open]) => {
    if (!open || !props.instance) return;
    section.value = props.initialSection || "general";
    instanceName.value = props.instance.name;
    autoImportAgentConfigs.value = props.instance.config.autoImportAgentConfigs;
    codexConfigEnabled.value = props.instance.config.codexConfigEnabled;
    codexHomeMode.value = props.instance.config.codexHomeMode;
    defaultCodexPermissionMode.value = props.instance.config.defaultCodexPermissionMode;
    const codexSettings = props.instance.config.codexSettings;
    codexVerbosity.value = codexSettings?.modelVerbosity || "default";
    codexPersonality.value = codexSettings?.personality || "default";
    codexMultiAgentEnabled.value = codexSettings?.multiAgent.enabled ?? true;
    codexMultiAgentMaxThreads.value = codexSettings?.multiAgent.maxConcurrentThreads ? String(codexSettings.multiAgent.maxConcurrentThreads) : "";
    codexSubagentModel.value = codexSettings?.multiAgent.defaultModel
      ? codexModelValue(codexSettings.multiAgent.defaultModel.modelEntityId, codexSettings.multiAgent.defaultModel.modelName)
      : "default";
    codexSubagentReasoning.value = codexSettings?.multiAgent.defaultReasoningEffort || "default";
    aiSessionHistoryLimit.value = String(props.instance.config.aiSessionHistoryLimit);
    aiSessionAttachmentRetentionDays.value = String(props.instance.config.aiSessionAttachmentRetentionDays);
    aiSessionMaxFileAttachmentKiB.value = String(props.instance.config.aiSessionMaxFileAttachmentBytes / 1024);
    modelSelection.value = normalizedSelection(props.instance.modelSelection);
    appFilter.value = "all";
  },
  { immediate: true },
);

watch(() => props.instance, (instance) => {
  if (props.open && !instance) handleOpenChange(false);
});

watch(
  [() => props.open, () => props.instance?.id, () => section.value],
  ([open, instanceId, activeSection]) => {
    if (open && instanceId && (activeSection === "apps" || activeSection === "browser" || activeSection === "codex")) void props.refreshAppManagement(instanceId);
  },
  { immediate: true },
);

function handleOpenChange(open: boolean) {
  if (!open) {
    section.value = "general";
  }
  emit("update:open", open);
}

const modelEntityIds = computed<string[]>({
  get: () => modelSelection.value.modelEntityIds || [],
  set: (value) => {
    modelSelection.value = { modelEntityIds: [...new Set(value)] };
  },
});

function legacyModelEntityIds(value: ModelSelection) {
  return [...new Set([value.codexModelHash, value.claudeModelHash, value.opencodeModelHash]
    .filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function normalizedSelection(value: ModelSelection): ModelSelection {
  const ids = value.modelEntityIds !== undefined
    ? value.modelEntityIds
    : legacyModelEntityIds(value);
  return { modelEntityIds: [...new Set(ids)] };
}

async function saveGeneral() {
  if (!props.instance || savingGeneral.value || !validInstanceName.value || !validHistoryLimit.value || !validAttachmentRetention.value || !validFileAttachmentLimit.value) return;
  savingGeneral.value = true;
  try {
    const input: UpdateControlledInstanceInput = {
      config: {
        autoImportAgentConfigs: autoImportAgentConfigs.value,
        ...(historyLimitSupported.value ? { aiSessionHistoryLimit: Number(aiSessionHistoryLimit.value) } : {}),
        ...(attachmentRetentionSupported.value ? { aiSessionAttachmentRetentionDays: Number(aiSessionAttachmentRetentionDays.value) } : {}),
        ...(fileAttachmentLimitSupported.value ? { aiSessionMaxFileAttachmentBytes: Number(aiSessionMaxFileAttachmentKiB.value) * 1024 } : {}),
      },
    };
    if (generalChanged.value) input.name = instanceName.value.trim();
    await props.updateInstance(props.instance, input);
    instanceName.value = instanceName.value.trim();
    showControlPlaneToast(t("instances.settings.generalSaved"), "success");
  } catch (cause) {
    instanceName.value = props.instance.name;
    autoImportAgentConfigs.value = props.instance.config.autoImportAgentConfigs;
    aiSessionHistoryLimit.value = String(props.instance.config.aiSessionHistoryLimit);
    aiSessionAttachmentRetentionDays.value = String(props.instance.config.aiSessionAttachmentRetentionDays);
    aiSessionMaxFileAttachmentKiB.value = String(props.instance.config.aiSessionMaxFileAttachmentBytes / 1024);
    showControlPlaneToast(translateApiError(cause, t), "error");
  } finally {
    savingGeneral.value = false;
  }
}

async function saveCodex() {
  if (!props.instance || savingCodex.value || (codexSettingsSupported.value && !validCodexMaxThreads.value)) return;
  savingCodex.value = true;
  try {
    await props.updateInstance(props.instance, {
      config: {
        codexConfigEnabled: codexConfigEnabled.value,
        codexHomeMode: codexHomeMode.value,
        defaultCodexPermissionMode: defaultCodexPermissionMode.value,
        ...(codexSettingsSupported.value ? { codexSettings: currentCodexSettings() } : {}),
      },
    });
    showControlPlaneToast(t("instances.settings.codexSettingsSaved"), "success");
  } catch (cause) {
    const settings = props.instance.config.codexSettings;
    codexConfigEnabled.value = props.instance.config.codexConfigEnabled;
    codexHomeMode.value = props.instance.config.codexHomeMode;
    defaultCodexPermissionMode.value = props.instance.config.defaultCodexPermissionMode;
    codexVerbosity.value = settings?.modelVerbosity || "default";
    codexPersonality.value = settings?.personality || "default";
    codexMultiAgentEnabled.value = settings?.multiAgent.enabled ?? true;
    codexMultiAgentMaxThreads.value = settings?.multiAgent.maxConcurrentThreads ? String(settings.multiAgent.maxConcurrentThreads) : "";
    codexSubagentModel.value = settings?.multiAgent.defaultModel
      ? codexModelValue(settings.multiAgent.defaultModel.modelEntityId, settings.multiAgent.defaultModel.modelName)
      : "default";
    codexSubagentReasoning.value = settings?.multiAgent.defaultReasoningEffort || "default";
    showControlPlaneToast(translateApiError(cause, t), "error");
  } finally {
    savingCodex.value = false;
  }
}

async function saveModels() {
  if (!props.instance || savingModels.value) return;
  savingModels.value = true;
  try {
    await props.updateInstance(props.instance, { modelSelection: normalizedSelection(modelSelection.value) });
    showControlPlaneToast(t("instances.settings.modelsSaved"), "success");
  } catch (cause) {
    modelSelection.value = normalizedSelection(props.instance.modelSelection);
    showControlPlaneToast(translateApiError(cause, t), "error");
  } finally {
    savingModels.value = false;
  }
}

function formatObservedAt(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatDateTime(parsed, locale.value);
}

function refreshApps() {
  if (props.instance) void props.refreshAppManagement(props.instance.id);
}

function activeJob(app: ManagedAppProjection) {
  return props.appManagement?.activeJobs.find((job) => job.id === app.activeJobId || job.appId === app.id);
}

function terminalJob(app: ManagedAppProjection) {
  return props.appManagement?.recentJobs.find((job) => job.appId === app.id);
}

function executionJob(app: ManagedAppProjection) {
  return activeJob(app) || terminalJob(app);
}

function executionOutput(job: AppManagementJob) {
  if (job.logTail) return job.logTail;
  if (!job.command) return t("instances.settings.waitingInstaller");
  return `$ ${[job.command.executable, ...job.command.args].map(commandArgument).join(" ")}\n`;
}

function commandArgument(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function progressPercent(job?: AppManagementJob) {
  if (!job?.progress?.total || job.progress.current === undefined) return undefined;
  return Math.max(0, Math.min(100, (job.progress.current / job.progress.total) * 100));
}

function jobLabel(job: AppManagementJob) {
  const operation = operationLabel(job.operation);
  return `${job.state === "queued" ? t("instances.settings.queued") : operation}${job.phase ? ` · ${humanizeJobPhase(job.phase)}` : ""}`;
}

function operationLabel(operation: AppManagementOperation) {
  return operation === "install" ? t("instances.settings.installing")
    : operation === "update" ? t("instances.settings.updating")
      : t("instances.settings.uninstalling");
}

function operationNoun(operation: AppManagementOperation) {
  return operation === "install" ? t("instances.settings.installation")
    : operation === "update" ? t("instances.settings.update")
      : t("instances.settings.uninstallation");
}

function humanizeJobPhase(phase: string) {
  return phase.replace(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
}

function terminalJobLabel(job: AppManagementJob) {
  const operation = operationNoun(job.operation);
  if (job.state === "succeeded") return t("instances.settings.succeeded", { operation });
  if (job.state === "cancelled") return t("instances.settings.cancelled", { operation });
  if (job.state === "interrupted") return t("instances.settings.interrupted", { operation });
  return t("instances.settings.failed", { operation });
}

function managedAppBadgeVariant(state: ManagedAppProjection["state"]): "default" | "secondary" | "destructive" {
  return state === "installed" ? "default" : state === "broken" ? "destructive" : "secondary";
}

function managedAppStateLabel(state: ManagedAppProjection["state"]) {
  return ({
    installed: t("instances.settings.stateInstalled"),
    "not-installed": t("instances.settings.stateNotInstalled"),
    broken: t("instances.settings.stateBroken"),
    unsupported: t("instances.settings.stateUnsupported"),
  })[state];
}

function managedAppIcon(app: ManagedAppProjection) {
  if (app.kind === "gui") return app.id === "chromium" ? Globe2 : Monitor;
  if (app.kind === "web") return Globe2;
  return TerminalSquare;
}

function appActionHint(app: ManagedAppProjection) {
  if (activeJob(app) || app.canInstall || app.canUninstall || app.canUpdate) return "";
  const reason = app.state === "installed" || app.state === "broken"
    ? app.updateReason || app.uninstallReason
    : app.installReason;
  if (reason?.code === "BUNDLED" && app.state === "not-installed") return t("instances.settings.bundledUnavailable");
  return reason?.message || t("instances.settings.noAction");
}

function hasAppActions(app: ManagedAppProjection) {
  return Boolean(app.canInstall || app.canUpdate || app.canUninstall);
}

function openAppConfirmation(app: ManagedAppProjection, operation: AppManagementOperation) {
  appConfirmation.value = { app, operation };
}

async function runAppUpdateCheck(app: ManagedAppProjection) {
  if (!props.instance || checkingApps.has(app.id) || operationSubmitting.value) return;
  checkingApps.add(app.id);
  try {
    await props.checkAppUpdate(props.instance.id, app.id);
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t), "error");
  } finally {
    checkingApps.delete(app.id);
  }
}

function updateCheckLabel(app: ManagedAppProjection) {
  const check = app.updateCheck;
  if (!check) return "";
  if (check.status === "update-available") {
    return t("instances.settings.updateAvailable", {
      installed: check.installedVersion || app.version || t("instances.settings.notReported"),
      latest: check.latestVersion || t("instances.settings.notReported"),
    });
  }
  if (check.status === "up-to-date") return t("instances.settings.updateUpToDate");
  if (check.status === "unsupported") return t("instances.settings.updateUnsupported");
  return check.reason ? t("instances.settings.updateUnknownReason", { reason: check.reason }) : t("instances.settings.updateUnknown");
}

function updateCheckClass(app: ManagedAppProjection) {
  return app.updateCheck?.status === "update-available" ? "is-available" : "";
}

const appConfirmationTitle = computed(() => appConfirmation.value
  ? t("instances.settings.operationQuestion", { operation: operationNoun(appConfirmation.value.operation), name: appConfirmation.value.app.name })
  : "");

const appConfirmationDescription = computed(() => {
  const operation = appConfirmation.value?.operation;
  return operation === "uninstall" ? t("instances.settings.uninstallDescription")
    : operation === "update" ? t("instances.settings.updateDescription")
      : t("instances.settings.installDescription");
});

const appConfirmationConfirmLabel = computed(() => {
  if (operationSubmitting.value) return t("instances.settings.queuing");
  const operation = appConfirmation.value?.operation;
  return operation === "uninstall" ? t("instances.settings.confirmUninstall")
    : operation === "update" ? t("instances.settings.confirmUpdate")
      : t("instances.settings.confirmInstall");
});

async function confirmAppOperation() {
  if (!props.instance || !appConfirmation.value || operationSubmitting.value) return;
  const { app, operation } = appConfirmation.value;
  operationSubmitting.value = app.id;
  try {
    await props.manageApp(props.instance.id, app.id, operation);
    showControlPlaneToast(t("instances.settings.operationQueued", {
      operation: operationNoun(operation),
      name: app.name,
    }), "success");
    appConfirmation.value = undefined;
  } catch (cause) {
    showControlPlaneToast(translateApiError(cause, t), "error");
  } finally {
    operationSubmitting.value = "";
  }
}
</script>

<style scoped>
:global(.instance-settings-dialog[role="dialog"]) {
  width: min(920px, calc(100vw - 36px));
  max-width: 920px;
  height: 680px;
  max-height: calc(100vh - 36px);
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  gap: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 0;
}

.instance-settings-sidebar {
  display: grid;
  grid-area: nav;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  border-right: 1px solid var(--line);
}

.instance-settings-identity {
  display: grid;
  justify-items: start;
  gap: 6px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--line-subtle);
}

.instance-settings-identity-eyebrow {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.instance-settings-identity-name {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.instance-settings-close {
  display: grid;
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 1;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: var(--surface-hover);
  color: var(--text-muted);
  cursor: pointer;
}

.instance-settings-close:hover,
.instance-settings-close:focus-visible {
  background: var(--surface-active);
  color: var(--text-strong);
  outline: none;
}

.instance-settings-tabs {
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: "nav content";
  gap: 0;
  min-height: 0;
}

.instance-settings-tabs-unavailable {
  grid-template-columns: minmax(0, 1fr);
}

.instance-settings-nav-scroll {
  height: 100%;
  min-height: 0;
}

.instance-settings-nav {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  width: 100%;
  padding: 12px 8px 14px 6px;
  border: 0;
  border-radius: 0;
  background: transparent;
  gap: 16px;
}

.instance-settings-nav-group {
  display: grid;
  gap: 2px;
}

.instance-settings-nav-group-title {
  padding: 0 10px 6px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.instance-settings-nav :deep(button) {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  height: 32px;
  border-radius: 7px;
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  padding: 0 10px;
  text-align: left;
}

.instance-settings-nav :deep(.truncate) {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-width: 0;
  gap: 8px;
}

.instance-settings-nav :deep(.truncate svg) {
  flex: 0 0 auto;
}

.instance-settings-nav :deep(button:not([data-state="active"]):hover) {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.instance-settings-nav :deep(button[data-state="active"]) {
  background: var(--surface-active);
  color: var(--text-strong);
  box-shadow: none;
}

.instance-settings-scroll {
  grid-area: content;
  height: 100%;
  min-height: 0;
}

.instance-settings-content-title {
  margin: 16px 16px 14px;
  color: var(--text-strong);
  font-size: 19px;
  font-weight: 600;
}

.instance-settings-section {
  display: grid;
  gap: 18px;
  margin: 0;
  padding: 0 16px 20px;
}

.instance-settings-section[hidden] {
  display: none;
}

.instance-settings-card {
  display: grid;
  gap: 12px;
}

.instance-settings-card h3,
.instance-app-heading h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 600;
}

.instance-settings-section-heading {
  display: grid;
  gap: 2px;
  padding: 0 2px;
}

.instance-settings-section-heading p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
}

.instance-settings-group {
  gap: 7px;
}

.instance-settings-surface {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-raised);
}

.instance-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
  margin: 0;
}

.instance-settings-grid div {
  display: grid;
  min-width: 0;
  gap: 4px;
  padding: 12px 16px;
}

.instance-settings-grid div:nth-child(even) {
  border-left: 1px solid var(--line);
}

.instance-settings-grid div:nth-child(n + 3) {
  border-top: 1px solid var(--line);
}

.instance-settings-grid dt {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
}

.instance-settings-grid dd {
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--text-strong);
  font-size: 13px;
  line-height: 1.5;
}

.instance-settings-grid code {
  color: inherit;
  font-size: 11px;
}

.instance-settings-control-surface {
  display: grid;
}

.instance-settings-general-controls {
  display: grid;
  gap: 0;
}

.instance-settings-general-controls > label {
  padding: 14px 16px;
}

.instance-settings-general-controls > label + label,
.instance-settings-general-controls > .instance-settings-row-note + label,
.instance-settings-general-controls > label + .instance-settings-row-note {
  border-top: 1px solid var(--line);
}

.instance-settings-general-actions {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--line);
  padding: 10px 16px;
}

.instance-settings-row-note {
  background: var(--surface-inset);
  padding: 8px 16px;
}

.instance-settings-checkbox {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
}

.instance-settings-checkbox span,
.instance-settings-name-control > span,
.instance-settings-select-control > span {
  display: grid;
  gap: 5px;
}

.instance-settings-checkbox small,
.instance-settings-name-control small,
.instance-settings-select-control small,
.instance-model-grid small,
.instance-app-row small,
.instance-settings-help,
.instance-settings-observed {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.instance-settings-checkbox strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.instance-settings-name-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
  align-items: center;
  gap: 16px;
}

.instance-settings-name-control strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.instance-settings-select-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
  align-items: center;
  gap: 16px;
}

.instance-settings-select-control strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.instance-model-surface {
  display: grid;
}


.instance-app-heading,
.instance-app-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.instance-app-heading-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.instance-app-heading-actions :deep(button) {
  width: 28px;
  height: 28px;
}

.instance-app-heading > .instance-settings-section-heading {
  min-width: 0;
}

.instance-app-toolbar {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--line);
  padding: 6px 10px;
}

.instance-app-toolbar > small {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.instance-app-filters {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 3px;
}

.instance-app-filters :deep(button) {
  height: 27px;
  gap: 6px;
  padding-inline: 9px;
}

.instance-app-filters :deep(button span) {
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.instance-app-list {
  display: grid;
  gap: 8px;
}

.instance-directory-list {
  gap: 0;
}

.instance-directory-list .instance-app-row {
  min-height: 68px;
  padding: 10px 12px;
}

.instance-directory-list .instance-app-row + .instance-app-row {
  border-top: 1px solid var(--line);
}

.instance-app-row > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-managed-app-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch;
  justify-content: normal;
  background: transparent;
}

.instance-app-copy {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  gap: 3px;
}

.instance-app-copy > strong {
  color: var(--text-strong);
  font-size: 13px;
}

.instance-app-main,
.instance-app-identity {
  display: flex !important;
  min-width: 0;
  align-items: flex-start;
}

.instance-app-main {
  justify-content: space-between;
  gap: 16px;
}

.instance-app-identity {
  flex: 1 1 auto;
  gap: 10px;
}

.instance-app-icon {
  display: grid;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  color: var(--brand-accent-muted);
}

.instance-app-controls {
  display: flex !important;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px !important;
}

.instance-app-action-reason {
  color: var(--text-muted);
}

.instance-app-update-check {
  color: var(--text-muted);
}

.instance-app-update-check.is-available {
  color: var(--status-success);
  font-weight: 600;
}

.instance-app-action-danger {
  color: var(--status-danger, #dc2626);
}

.instance-app-activity {
  display: grid !important;
  gap: 5px !important;
  border-top: 1px solid var(--line);
  margin-top: 10px;
  padding-top: 9px;
}

.instance-app-job-line {
  color: var(--brand-accent-muted) !important;
  font-weight: 700;
}

.instance-app-progress {
  width: min(300px, 100%);
  margin-top: 3px;
}

.instance-app-terminal {
  width: 100%;
  margin-top: 5px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #071014;
}

.instance-app-confirmation-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 10px;
}

.instance-app-confirmation-summary span {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-app-confirmation-summary small {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.instance-app-confirmation-summary strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-app-terminal summary {
  cursor: pointer;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  padding: 7px 9px;
  user-select: none;
}

.instance-app-terminal pre {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  border-top: 1px solid var(--line);
  color: #d7e3e7;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.5;
  padding: 9px;
  white-space: pre-wrap;
  word-break: break-word;
}

.instance-app-row code,
.instance-app-issues code {
  overflow-wrap: anywhere;
  color: var(--text-muted);
  font-size: 11px;
}

.instance-app-issues {
  border-top: 1px solid var(--line);
  background: var(--surface-inset);
  padding: 10px 12px;
  color: var(--text);
  font-size: 12px;
}

.instance-app-issues p {
  margin: 5px 0 0;
}

.instance-settings-error {
  margin: 0;
  padding: 0 16px 12px;
  color: var(--status-danger);
  font-size: 12px;
}

.instance-settings-success {
  margin: 0;
  padding: 0 16px 12px;
  color: var(--status-success);
  font-size: 12px;
}

.instance-settings-empty {
  display: grid;
  grid-area: content;
  align-content: start;
  gap: 6px;
  color: var(--text-muted);
  font-size: 13px;
  padding: 18px 16px;
}

.instance-settings-empty-title {
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 600;
}

.instance-settings-state {
  display: flex;
  min-height: 112px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 12px;
  padding: 18px;
  text-align: center;
}

.instance-settings-state-error {
  color: var(--status-danger);
}

.instance-settings-app-missing {
  flex-direction: column;
}

.instance-settings-app-missing p {
  margin: 0;
}

.instance-settings-empty-state {
  align-content: center;
  display: grid;
  gap: 7px;
  justify-items: center;
}

.instance-app-directory,
.instance-git-directory {
  display: grid;
}

.instance-git-assignment-create {
  align-items: center;
  display: grid;
  gap: 8px;
  grid-template-columns: minmax(0, 1fr) auto;
  border-bottom: 1px solid var(--line);
  padding: 10px 12px;
}

.instance-git-match-preview {
  align-items: center;
  background: var(--surface-inset);
  border-bottom: 1px solid var(--line);
  color: var(--text-muted);
  display: grid;
  font-size: 12px;
  gap: 8px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  padding: 10px 12px;
}

.instance-git-match-preview[data-status="unique"] {
  color: var(--text);
}

.instance-git-assignment-row > div:first-child {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.instance-git-assignment-row {
  align-items: center;
}

.instance-directory-identity {
  display: flex !important;
  min-width: 0;
  align-items: flex-start;
  gap: 10px !important;
}

.instance-directory-identity > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-directory-identity strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.instance-custom-app-row {
  align-items: center;
}

.instance-git-assignment-row small {
  color: var(--text-muted);
  font-size: 12px;
}

.instance-git-assignment-actions {
  align-items: center;
  display: flex;
  gap: 8px;
}

@media (max-width: 680px) {
  .instance-settings-grid {
    grid-template-columns: 1fr;
  }

  .instance-settings-tabs {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      "nav"
      "content";
  }

  .instance-settings-tabs-unavailable {
    grid-template-rows: minmax(0, 1fr);
  }

  .instance-settings-sidebar {
    grid-template-rows: auto auto;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .instance-settings-identity {
    gap: 4px;
    padding: 12px 48px 10px 14px;
    border-bottom: 0;
  }

  .instance-settings-nav-scroll {
    height: auto;
  }

  .instance-settings-nav {
    flex-direction: row;
    align-items: center;
    gap: 4px;
    width: max-content;
    min-width: 100%;
    padding: 2px 14px 12px;
  }

  .instance-settings-nav-group {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .instance-settings-nav-group + .instance-settings-nav-group {
    margin-left: 6px;
    padding-left: 6px;
    border-left: 1px solid var(--line);
  }

  .instance-settings-nav-group-title {
    display: none;
  }

  .instance-settings-nav :deep(button) {
    width: auto;
    white-space: nowrap;
  }

  .instance-settings-content-title {
    margin: 14px 14px 12px;
  }

  .instance-settings-section {
    padding: 0 14px 18px;
  }

  .instance-settings-name-control,
  .instance-settings-select-control {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .instance-settings-grid div:nth-child(even) {
    border-left: 0;
  }

  .instance-settings-grid div:nth-child(n + 2) {
    border-top: 1px solid var(--line);
  }

  .instance-managed-app-row {
    padding: 10px;
  }

  .instance-app-toolbar,
  .instance-app-main {
    align-items: stretch;
    flex-direction: column;
  }

  .instance-app-controls {
    width: 100%;
    max-width: none;
    align-items: flex-start;
    justify-items: start;
  }

  .instance-app-confirmation-summary {
    grid-template-columns: 1fr;
  }

  .instance-git-assignment-create {
    align-items: stretch;
    grid-template-columns: 1fr;
  }
}
</style>
