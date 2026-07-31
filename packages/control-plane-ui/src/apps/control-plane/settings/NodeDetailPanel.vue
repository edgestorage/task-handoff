<template>
  <section class="modal-section settings-panel-surface node-detail-panel">
    <ScrollArea v-if="selectedNode" class="node-detail-content">
      <div class="node-detail-content-inner">
        <div class="node-detail-header">
          <div class="node-detail-identity">
            <span>{{ status.locationLabel(selectedNode) }}</span>
            <div class="node-detail-title-row">
              <strong>{{ selectedNode.name }}</strong>
              <Tooltip>
                <RekaTooltipTrigger
                  as="button"
                  type="button"
                  class="node-diagnostic-badge"
                  :aria-label="status.buildTitle(selectedNode.id)"
                >
                  <Badge :variant="status.statusVariant(selectedNode.id)">{{ status.statusLabel(selectedNode.id) }}</Badge>
                </RekaTooltipTrigger>
                <TooltipContent class="node-diagnostic-tooltip" align="start" side="bottom">
                  <div class="node-diagnostic-tooltip-grid">
                    <span><b>{{ t("settings.nodeDetail.protocol") }}</b><em>{{ status.protocolLabel(selectedNode.id) }}</em></span>
                    <span><b>{{ t("settings.nodeDetail.build") }}</b><em>{{ status.buildLabel(selectedNode.id) }}</em></span>
                    <span><b>{{ t("settings.nodeDetail.package") }}</b><em>{{ status.packageLabel(selectedNode.id) }}</em></span>
                    <span v-if="status.build(selectedNode.id)?.imageRef"><b>{{ t("settings.nodeDetail.image") }}</b><em>{{ status.build(selectedNode.id)?.imageRef }}</em></span>
                    <span v-if="status.build(selectedNode.id)?.builtAt"><b>{{ t("settings.nodeDetail.built") }}</b><em>{{ status.build(selectedNode.id)?.builtAt }}</em></span>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
            <div class="node-detail-meta">
              <code v-if="nodeEndpointDisplay(selectedNode.endpoint)" :title="nodeEndpointDisplay(selectedNode.endpoint)">{{ nodeEndpointDisplay(selectedNode.endpoint) }}</code>
              <span v-if="nodeEndpointDisplay(selectedNode.endpoint)" aria-hidden="true">·</span>
              <span class="node-connection-mode">{{ localizedStatus(nodeConnectionModeKeys, selectedNode.connectionMode) }}</span>
            </div>
          </div>
          <div class="node-detail-header-actions">
            <Button variant="outline" size="sm" :disabled="headerActionState.check.disabled" @click="actions.checkSettingsNode(selectedNode.id)">
              <RefreshCw :size="14" />
              <span>{{ headerActionState.check.label }}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button
                  variant="outline"
                  size="icon-sm"
                  :aria-busy="headerActionState.menu.busy"
                  :aria-label="headerActionState.menu.label"
                >
                  <RefreshCw v-if="headerActionState.menu.busy" class="animate-spin motion-reduce:animate-none" :size="16" />
                  <MoreHorizontal v-else :size="16" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="node-detail-action-menu" align="end" :side-offset="6">
                <DropdownMenuItem class="node-detail-action-item" :disabled="headerActionState.rename.disabled" @select="actions.openNodeRename(selectedNode)">
                  <Pencil :size="14" />
                  <span>
                    <strong>{{ headerActionState.rename.label }}</strong>
                    <small>{{ t("settings.nodeDetail.renameDescription") }}</small>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem class="node-detail-action-item" :disabled="headerActionState.pairingInvite.disabled" @select="actions.createPairingInviteForNode(selectedNode.id)">
                  <KeyRound :size="14" />
                  <span>
                    <strong>{{ headerActionState.pairingInvite.label }}</strong>
                    <small>{{ t("settings.nodeDetail.pairingDescription") }}</small>
                  </span>
                </DropdownMenuItem>
                <template v-if="headerActionState.canDelete">
                  <DropdownMenuSeparator />
                  <DropdownMenuItem class="node-detail-action-item danger" :disabled="headerActionState.remove.disabled" @select="actions.removeNode(selectedNode)">
                    <Trash2 :size="14" />
                    <span>
                      <strong>{{ headerActionState.remove.label }}</strong>
                      <small>{{ t("settings.nodeDetail.removeDescription") }}</small>
                    </span>
                  </DropdownMenuItem>
                </template>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <Tabs v-model="activeTab" class="node-detail-tabs">
          <TabsList class="node-detail-tab-list" :aria-label="t('settings.nodeDetail.sections')">
            <TabsTrigger v-for="tab in tabs" :key="tab.value" class="node-detail-tab-trigger" :value="tab.value">
              <component :is="tab.icon" :size="14" />
              <span>{{ tab.label }}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent class="node-detail-tab-content" value="overview">
            <div class="node-metrics">
              <div>
                <span>{{ t("settings.nodeDetail.runtimes") }}</span>
                <strong>{{ resources.runtimes.length }}</strong>
              </div>
              <div>
                <span>{{ t("settings.nodeDetail.instances") }}</span>
                <strong>{{ resources.instances.length }}</strong>
              </div>
              <div>
                <span>{{ t("settings.nodeDetail.localFolders") }}</span>
                <strong>{{ resources.localFolders.length }}</strong>
              </div>
            </div>
            <div class="node-detail-section">
              <div class="section-head">
                <span>{{ t("settings.nodeDetail.diagnostics") }}</span>
              </div>
              <div class="node-diagnostic-grid">
                <span><b>{{ t("settings.nodeDetail.protocol") }}</b><em>{{ status.protocolLabel(selectedNode.id) }}</em></span>
                <span><b>{{ t("settings.nodeDetail.build") }}</b><em>{{ status.buildLabel(selectedNode.id) }}</em></span>
                <span><b>{{ t("settings.nodeDetail.package") }}</b><em>{{ status.packageLabel(selectedNode.id) }}</em></span>
                <span v-if="status.build(selectedNode.id)?.imageRef"><b>{{ t("settings.nodeDetail.image") }}</b><em>{{ status.build(selectedNode.id)?.imageRef }}</em></span>
                <span v-if="status.build(selectedNode.id)?.builtAt"><b>{{ t("settings.nodeDetail.built") }}</b><em>{{ status.build(selectedNode.id)?.builtAt }}</em></span>
              </div>
            </div>
            <div class="node-detail-section">
              <div class="section-head">
                <span>{{ t("settings.nodeDetail.diagnosticLog", { count: resources.diagnostics.length }) }}</span>
              </div>
              <div v-if="resources.diagnostics.length" class="node-diagnostic-log">
                <div v-for="entry in resources.diagnostics" :key="`${entry.method}-${entry.route}-${entry.code}-${entry.message}`" class="node-diagnostic-log-entry">
                  <div>
                    <Badge variant="secondary">{{ entry.code }}</Badge>
                    <code>{{ entry.method }} {{ entry.route }}</code>
                    <!-- i18n-audit-allow-next-line protocol-name: HTTP status code label -->
                    <small v-if="entry.statusCode">HTTP {{ entry.statusCode }}</small>
                  </div>
                  <p>{{ entry.message }}</p>
                  <ul v-if="entry.issues?.length">
                    <li v-for="issue in entry.issues" :key="`${issue.path}-${issue.message}`">
                      <!-- i18n-audit-allow-next-line code-token: protocol issue path fallback -->
                      <code>{{ issue.path || "payload" }}</code>
                      <span>{{ issue.message }}</span>
                    </li>
                  </ul>
                </div>
              </div>
              <p v-else class="settings-empty">{{ t("settings.nodeDetail.noDiagnostics") }}</p>
            </div>
            <div v-if="status.isBuiltinNode(selectedNode)" class="node-detail-section">
              <div class="section-head">
                <span>{{ t("settings.nodeDetail.tcpListener") }}</span>
                <Badge v-if="resources.externalListener" :variant="resources.externalListener.status === 'listening' ? 'default' : 'secondary'">
                  {{ localizedStatus(externalListenerStatusKeys, resources.externalListener.status) }} · {{ localizedStatus(externalListenerSourceKeys, resources.externalListener.source) }}
                </Badge>
              </div>
              <div class="node-listener-form">
                <label>
                  <span>{{ t("settings.nodeDetail.listenOn") }}</span>
                  <ControlPlaneSelect :model-value="resources.externalListenerBindScope" @update:model-value="actions.updateExternalListenerDraft('bindScope', $event)">
                    <ControlPlaneSelectItem value="loopback">{{ t("settings.nodeDetail.loopback") }}</ControlPlaneSelectItem>
                    <ControlPlaneSelectItem value="all-ipv4">{{ t("settings.nodeDetail.allIpv4") }}</ControlPlaneSelectItem>
                  </ControlPlaneSelect>
                </label>
                <label>
                  <span>{{ t("settings.nodeDetail.port") }}</span>
                  <ControlPlaneInput :model-value="resources.externalListenerPort" inputmode="numeric" placeholder="8091" @update:model-value="actions.updateExternalListenerDraft('port', $event)" />
                </label>
                <Button variant="outline" size="sm" :disabled="busy.loadingExternalListener || busy.savingExternalListener" @click="actions.saveExternalListener">
                  <ServerCog :size="14" />
                  <span>{{ busy.savingExternalListener ? t("settings.nodeDetail.applying") : busy.loadingExternalListener ? t("settings.nodeDetail.loading") : t("settings.nodeDetail.apply") }}</span>
                </Button>
              </div>
              <p v-if="resources.externalListenerBindScope === 'all-ipv4'" class="node-listener-warning">
                {{ t("settings.nodeDetail.listenerWarning") }}
              </p>
              <!-- i18n-audit-allow-next-line code-token: listener endpoint template -->
              <code v-if="resources.externalListener" class="node-listener-endpoint">http://&lt;host-ip-or-dns&gt;:{{ resources.externalListener.port }}</code>
              <p v-if="resources.externalListener?.error || resources.externalListenerError" class="control-plane-error">{{ resources.externalListenerError || resources.externalListener?.error }}</p>
            </div>
          </TabsContent>

          <TabsContent class="node-detail-tab-content" value="runtimes">
            <div class="node-detail-section flush-section">
              <div class="section-head">
                <span>{{ t("settings.nodeDetail.runtimes") }}</span>
              </div>
              <div class="node-resource-list">
                <div v-for="runtime in resources.runtimes" :key="runtime.id" class="node-resource-row">
                  <div>
                    <strong>{{ runtime.name }}</strong>
                    <code>{{ localizedStatus(runtimeTypeKeys, runtime.type) }} · {{ localizedStatus(runtimeAccessStrategyKeys, runtime.accessStrategy) }}</code>
                  </div>
                  <div class="settings-row-actions">
                    <Badge variant="secondary">{{ localizedStatus(nodeRuntimeStatusKeys, runtime.status) }}</Badge>
                    <Button variant="outline" size="sm" :disabled="busy.checkingRuntimeId === runtime.id" @click="actions.checkRuntime(runtime)">
                      <RefreshCw :size="14" />
                      <span>{{ busy.checkingRuntimeId === runtime.id ? t("settings.nodeDetail.checking") : t("settings.nodeDetail.check") }}</span>
                    </Button>
                    <Button v-if="runtime.labels['task-handoff.node-agent.builtin'] !== 'true'" variant="outline" size="sm" :disabled="busy.deletingRuntimeId === runtime.id" @click="actions.removeRuntime(runtime)">
                      <Trash2 :size="14" />
                      <span>{{ busy.deletingRuntimeId === runtime.id ? t("settings.nodeDetail.deleting") : t("settings.nodeDetail.delete") }}</span>
                    </Button>
                  </div>
                </div>
                <p v-if="!resources.runtimes.length" class="settings-empty">{{ t("settings.nodeDetail.noRuntimes") }}</p>
              </div>
            </div>
          </TabsContent>

          <TabsContent class="node-detail-tab-content" value="updates">
            <div class="node-detail-section flush-section">
              <div class="section-head">
                <span>{{ t("settings.nodeDetail.managedUpdates") }}</span>
                <div class="update-channel-select">
                  <ControlPlaneSelect :model-value="resources.updateChannel" @update:model-value="actions.setUpdateChannel">
                    <ControlPlaneSelectItem value="stable">{{ t("settings.nodeDetail.stable") }}</ControlPlaneSelectItem>
                    <ControlPlaneSelectItem value="beta">{{ t("settings.nodeDetail.beta") }}</ControlPlaneSelectItem>
                    <ControlPlaneSelectItem value="alpha">{{ t("settings.nodeDetail.alpha") }}</ControlPlaneSelectItem>
                  </ControlPlaneSelect>
                </div>
              </div>
              <div class="managed-update-groups">
                <section class="managed-update-group agent-update-group">
                  <div class="managed-update-group-head">
                    <ServerCog :size="18" />
                    <div>
                      <strong>{{ t("settings.nodeDetail.nodeAgent") }}</strong>
                      <span>{{ t("settings.nodeDetail.nodeAgentUpdateDescription") }}</span>
                    </div>
                  </div>
                  <div class="node-resource-row">
                    <div>
                      <strong>{{ selectedNode.name }}</strong>
                      <code>{{ updateSummary(status.build(selectedNode.id)?.packageVersion) }}</code>
                    </div>
                    <div class="settings-row-actions">
                      <Button variant="outline" size="sm" :disabled="busy.checkingUpdateNodeId === selectedNode.id" @click="actions.checkManagedUpdate(selectedNode.id)">
                        <RefreshCw :size="14" />
                        <span>{{ busy.checkingUpdateNodeId === selectedNode.id ? t("settings.nodeDetail.checking") : t("settings.nodeDetail.check") }}</span>
                      </Button>
                      <Button variant="outline" size="sm" :disabled="!canApplyUpdate() || busy.applyingUpdateNodeId === selectedNode.id" @click="actions.applyManagedUpdate(selectedNode.id)">
                        <Download :size="14" />
                        <span>{{ busy.applyingUpdateNodeId === selectedNode.id ? t("settings.nodeDetail.queuing") : t("settings.nodeDetail.update") }}</span>
                      </Button>
                    </div>
                  </div>
                  <p v-if="nodeUpdateCheck" class="section-description">
                    {{ t("settings.nodeDetail.updateImpact", { restarting: nodeUpdateCheck.impact.restartInstanceCount, active: nodeUpdateCheck.impact.activeInstanceCount, stopped: nodeUpdateCheck.impact.stoppedInstanceCount }) }}
                  </p>
                </section>

                <section class="managed-update-group instance-update-group">
                  <div class="managed-update-group-head">
                    <Boxes :size="18" />
                    <div>
                      <strong>{{ t("settings.nodeDetail.controlledInstances", { count: resources.instances.length }) }}</strong>
                      <span>{{ t("settings.nodeDetail.instanceConvergenceDescription") }}</span>
                    </div>
                  </div>
                  <div class="node-resource-list compact-list">
                    <div v-for="instance in resources.instances" :key="`update-${instance.id}`" class="node-resource-row">
                      <div>
                        <strong>{{ instance.name }}</strong>
                        <code>{{ runtimeVersionSummary(instance) }}</code>
                        <small v-if="instance.runtimeVersion?.error" class="settings-error">{{ instance.runtimeVersion.error.message }}</small>
                      </div>
                      <div class="settings-row-actions">
                        <Badge :variant="instance.runtimeVersion?.phase === 'matched' ? 'default' : 'secondary'">{{ runtimeVersionPhase(instance) }}</Badge>
                      </div>
                    </div>
                    <p v-if="!resources.instances.length" class="settings-empty">{{ t("settings.nodeDetail.noControlledInstances") }}</p>
                  </div>
                </section>
              </div>
            </div>
            <div class="node-detail-section">
              <div class="section-head">
                <span>{{ t("settings.nodeDetail.updateJobs", { count: resources.updateJobs.length }) }}</span>
                <Button variant="outline" size="sm" @click="actions.loadManagedUpdateJobs(selectedNode.id)">
                  <RefreshCw :size="14" />
                  <span>{{ t("settings.nodeDetail.refresh") }}</span>
                </Button>
              </div>
              <div class="node-resource-list compact-list">
                <div v-for="job in resources.updateJobs" :key="job.id" class="node-resource-row">
                  <div>
                    <span class="update-job-title">
                      <Badge variant="outline">{{ t("settings.nodeDetail.nodeRollout") }}</Badge>
                      <strong>{{ selectedNode.name }}</strong>
                    </span>
                    <code>{{ job.fromVersion || t("settings.nodeDetail.unknown") }} → {{ job.toVersion }}<span v-if="job.error"> · {{ job.error.message }}</span></code>
                    <small>{{ t("settings.nodeDetail.rolloutProgress", { matched: job.rollout.matchedInstanceCount, expected: job.rollout.expectedInstanceCount, failed: job.rollout.failedInstanceCount, deferred: job.rollout.deferredInstanceCount }) }}</small>
                  </div>
                  <Badge :variant="job.status === 'succeeded' ? 'default' : 'secondary'">{{ localizedStatus(updateJobStatusKeys, job.status) }}</Badge>
                </div>
                <p v-if="!resources.updateJobs.length" class="settings-empty">{{ t("settings.nodeDetail.noUpdateJobs") }}</p>
              </div>
            </div>
          </TabsContent>

          <TabsContent class="node-detail-tab-content fill-tab-content" value="storage">
            <div class="node-detail-section flush-section fill-section">
              <div class="section-head">
                <span>{{ t("settings.nodeDetail.localFolderCount", { count: resources.localFolders.length }) }}</span>
                <div class="node-folder-add-controls">
                  <ControlPlaneSelect :model-value="resources.nodeFolderDefaultImageId || '__none__'" :placeholder="t('settings.nodeDetail.defaultImage')" @update:model-value="actions.updateNodeFolderDefaultImage">
                    <ControlPlaneSelectItem value="__none__">{{ t("settings.nodeDetail.noDefaultImage") }}</ControlPlaneSelectItem>
                    <ControlPlaneSelectItem v-for="image in resources.nodeFolderImageOptions" :key="image.id" :value="image.id">{{ image.name }}</ControlPlaneSelectItem>
                  </ControlPlaneSelect>
                  <Button variant="outline" size="sm" :disabled="busy.creatingNodeLocalFolder" @click="actions.submitNodeLocalFolder">
                    <FolderOpen :size="14" />
                    <span>{{ busy.creatingNodeLocalFolder ? t("settings.nodeDetail.adding") : t("settings.nodeDetail.add") }}</span>
                  </Button>
                </div>
              </div>
              <ScrollArea class="node-resource-list compact-list">
                <div class="settings-scroll-content">
                  <div v-for="folder in resources.localFolders" :key="folder.id" class="node-resource-row">
                    <div>
                      <strong>{{ folder.name }}</strong>
                      <code>{{ folder.path }}</code>
                    </div>
                    <Button variant="outline" size="sm" :disabled="busy.deletingNodeLocalFolderId === folder.id" @click="actions.removeNodeLocalFolder(folder.id)">
                      <Trash2 :size="14" />
                      <span>{{ busy.deletingNodeLocalFolderId === folder.id ? t("settings.nodeDetail.deleting") : t("settings.nodeDetail.delete") }}</span>
                    </Button>
                  </div>
                  <p v-if="!resources.localFolders.length" class="settings-empty">{{ t("settings.nodeDetail.noLocalFolders") }}</p>
                </div>
              </ScrollArea>
              <p v-if="resources.localFoldersError" class="control-plane-error">{{ resources.localFoldersError }}</p>
            </div>
          </TabsContent>

          <TabsContent class="node-detail-tab-content" value="inventory">
            <div class="node-detail-section flush-section">
              <div class="section-head">
                <span>{{ t("settings.nodeDetail.dockerImages", { name: status.nameById(resources.selectedImageNodeId || selectedNode.id), count: resources.images.length }) }}</span>
                <Button variant="outline" size="sm" :disabled="busy.loadingNodeImagesId === selectedNode.id" @click="actions.loadNodeImages(selectedNode.id)">
                  <Monitor :size="14" />
                  <span>{{ busy.loadingNodeImagesId === selectedNode.id ? t("settings.nodeDetail.loading") : t("settings.nodeDetail.refresh") }}</span>
                </Button>
              </div>
              <ScrollArea class="node-resource-list image-inventory-list">
                <div class="settings-scroll-content">
                  <div v-for="image in resources.images" :key="`${selectedNode.id}-${image.reference}-${image.id}`" class="node-resource-row">
                    <div>
                      <strong>{{ image.reference }}</strong>
                      <code>{{ image.id }} · {{ image.size || t("settings.nodeDetail.unknownSize") }} · {{ image.createdSince || t("settings.nodeDetail.unknownAge") }}</code>
                    </div>
                  </div>
                  <p v-if="!resources.images.length" class="settings-empty">{{ t("settings.nodeDetail.noImages") }}</p>
                </div>
              </ScrollArea>
              <p v-if="resources.imagesError" class="control-plane-error">{{ resources.imagesError }}</p>
            </div>

            <div class="node-detail-section">
              <div class="section-head">
                <span>{{ t("settings.nodeDetail.instanceCount", { count: resources.instances.length }) }}</span>
              </div>
              <ScrollArea class="node-resource-list compact-list">
                <div class="settings-scroll-content">
                  <div v-for="instance in resources.instances" :key="instance.id" class="node-resource-row">
                    <div>
                      <strong>{{ instance.name }}</strong>
                      <code>{{ instance.source.type }} · {{ instance.image?.name || instance.imageSelection?.imageId }}</code>
                    </div>
                    <div class="node-resource-row-actions">
                      <Badge :variant="instance.connectionStatus === 'online' ? 'default' : 'secondary'">{{ localizedStatus(instanceStatusKeys, instance.status) }}</Badge>
                      <Button variant="outline" size="sm" :aria-label="t('settings.nodeDetail.instanceSettings', { name: instance.name })" @click="actions.openInstanceSettings(instance.id)">
                        <Settings :size="14" />
                        <span>{{ t("settings.nodeDetail.settings") }}</span>
                      </Button>
                    </div>
                  </div>
                  <p v-if="!resources.instances.length" class="settings-empty">{{ t("settings.nodeDetail.noInstances") }}</p>
                </div>
              </ScrollArea>
            </div>
          </TabsContent>

          <TabsContent class="node-detail-tab-content" value="remote">
            <div class="node-remote-panel">
              <div class="section-head compact-head">
                <span>{{ t("settings.nodeDetail.pairedKeys", { count: resources.controlPlanePairings.length }) }}</span>
                <Button variant="outline" size="sm" :disabled="busy.loadingRemoteKeysNodeId === selectedNode.id" @click="actions.loadControlPlaneAccess(selectedNode.id)">
                  <RefreshCw :size="14" />
                  <span>{{ busy.loadingRemoteKeysNodeId === selectedNode.id ? t("settings.nodeDetail.loading") : t("settings.nodeDetail.refresh") }}</span>
                </Button>
              </div>
              <div class="node-resource-list">
                <div v-for="pairing in resources.controlPlanePairings" :key="pairing.keyId" class="node-resource-row">
                  <div>
                    <strong>{{ pairing.name || pairing.id }}</strong>
                    <code>{{ pairing.keyId }} · {{ t("settings.nodeDetail.pairedAt", { time: localizedDateTime(pairing.pairedAt) }) }}</code>
                  </div>
                  <div class="settings-row-actions">
                    <Badge :variant="pairing.current ? 'default' : 'secondary'">{{ pairing.current ? t("settings.nodeDetail.currentRequester") : t("settings.nodeDetail.paired") }}</Badge>
                    <Button variant="outline" size="sm" :disabled="pairing.current || busy.deletingRemoteKeyId === pairing.keyId" @click="actions.removeRemoteKey(selectedNode.id, pairing.keyId)">
                      <Trash2 :size="14" />
                      <span>{{ busy.deletingRemoteKeyId === pairing.keyId ? t("settings.nodeDetail.deleting") : t("settings.nodeDetail.delete") }}</span>
                    </Button>
                  </div>
                </div>
                <p v-if="!resources.controlPlanePairings.length" class="settings-empty">{{ t("settings.nodeDetail.noPairedKeys") }}</p>
              </div>
              <p v-if="resources.remoteKeysError" class="control-plane-error">{{ resources.remoteKeysError }}</p>
            </div>

            <div class="node-remote-panel">
              <div class="section-head compact-head">
                <span>{{ t("settings.nodeDetail.activeConnections", { count: resources.controlPlaneConnections.length }) }}</span>
              </div>
              <div class="node-resource-list">
                <div v-for="connection in resources.controlPlaneConnections" :key="connection.id" class="node-resource-row">
                  <div>
                    <strong>{{ connection.name || connection.url }}</strong>
                    <code>{{ connection.url }} · {{ t("settings.nodeDetail.connectionPairing", { keyId: connection.pairingKeyId }) }}</code>
                    <small v-if="connection.error" class="control-plane-error">{{ connection.error }}</small>
                  </div>
                  <div class="settings-row-actions">
                    <Badge :variant="connection.status === 'connected' ? 'default' : 'secondary'">{{ localizedStatus(remoteConnectStatusKeys, connection.status) }}</Badge>
                    <Button variant="outline" size="sm" :disabled="busy.deletingControlPlaneConnectionId === connection.id" @click="actions.removeControlPlaneConnection(selectedNode.id, connection.id)">
                      <Trash2 :size="14" />
                      <span>{{ busy.deletingControlPlaneConnectionId === connection.id ? t("settings.nodeDetail.deleting") : t("settings.nodeDetail.delete") }}</span>
                    </Button>
                  </div>
                </div>
                <p v-if="!resources.controlPlaneConnections.length" class="settings-empty">{{ t("settings.nodeDetail.noActiveConnections") }}</p>
              </div>
            </div>

            <div class="node-remote-panel">
              <div class="section-head compact-head">
                <span>{{ t("settings.nodeDetail.addConnection") }}</span>
              </div>
              <div class="inline-create compact-create">
                <label>
                  <span>{{ t("settings.nodeDetail.controlPlaneUrl") }}</span>
                  <!-- i18n-audit-allow-next-line code-token: example control-plane URL -->
                  <ControlPlaneInput :model-value="resources.remoteConnect.controlPlaneUrl" placeholder="https://control-plane.example.com" @update:model-value="actions.updateRemoteConnect('controlPlaneUrl', $event)" />
                </label>
                <label>
                  <span>{{ t("settings.nodeDetail.joinToken") }}</span>
                  <ControlPlaneInput :model-value="resources.remoteConnect.joinToken" :placeholder="t('settings.nodeDetail.tokenPlaceholder')" @update:model-value="actions.updateRemoteConnect('joinToken', $event)" />
                </label>
                <label>
                  <span>{{ t("settings.nodeDetail.name") }}</span>
                  <ControlPlaneInput :model-value="resources.remoteConnect.controlPlaneName" :placeholder="t('settings.nodeDetail.optional')" @update:model-value="actions.updateRemoteConnect('controlPlaneName', $event)" />
                </label>
                <Button variant="outline" size="sm" :disabled="!resources.canConnectRemote || busy.connectingRemoteNodeId === selectedNode.id" @click="actions.connectSelectedNodeToRemote(selectedNode.id)">
                  <Plus :size="15" />
                  <span>{{ busy.connectingRemoteNodeId === selectedNode.id ? t("settings.nodeDetail.connecting") : t("settings.nodeDetail.connect") }}</span>
                </Button>
              </div>
              <p v-if="resources.remoteConnectResultByNodeId[selectedNode.id]" class="settings-success">
                {{ t("settings.nodeDetail.remoteResult", { status: localizedStatus(remoteConnectStatusKeys, resources.remoteConnectResultByNodeId[selectedNode.id].status) }) }}
                <span v-if="resources.remoteConnectResultByNodeId[selectedNode.id].error"> · {{ resources.remoteConnectResultByNodeId[selectedNode.id].error }}</span>
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </ScrollArea>
    <p v-else class="settings-empty">{{ t("settings.nodeDetail.selectNode") }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { Box, Boxes, Download, FolderOpen, Gauge, KeyRound, Monitor, MoreHorizontal, Network, Pencil, Plus, RefreshCw, ServerCog, Settings, Trash2 } from "@lucide/vue";
import { TooltipTrigger as RekaTooltipTrigger } from "reka-ui";
import type { BuildInfo, InstanceBoardItem, LocalDockerImage, Node, NodeAgentExternalListener, NodeControlPlaneConnection, NodeControlPlanePairing, NodeLocalFolder, NodeRuntime, SelectableImage, UpdateChannel, UpdateCheckResult, UpdateJob } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Tooltip, TooltipContent } from "../../../components/ui/tooltip";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { nodeEndpointDisplay } from "./nodeEndpointDisplay";
import { nodeDetailActionState } from "./nodeDetailActions";
import { externalListenerSourceKeys, externalListenerStatusKeys, instanceStatusKeys, nodeConnectionModeKeys, nodeRuntimeStatusKeys, remoteConnectStatusKeys, runtimeAccessStrategyKeys, runtimeTypeKeys, runtimeVersionStatusKeys, translateStatus, updateJobStatusKeys } from "../../../i18n/status";
import { formatDateTime } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";

const { locale, t } = useI18n();

type NodeDetailTab = "overview" | "runtimes" | "updates" | "storage" | "inventory" | "remote";

type RemoteConnectDraft = {
  controlPlaneUrl: string;
  joinToken: string;
  controlPlaneName: string;
};

type RemoteConnectResult = {
  status: string;
  error?: string;
  checkedAt: string;
};

type NodeDiagnosticLog = {
  route: string;
  method: string;
  code: string;
  message: string;
  statusCode?: number;
  issues?: Array<{ path: string; message: string }>;
};

type NodeDetailActions = {
  checkRuntime: (runtime: NodeRuntime) => void | Promise<void>;
  checkSettingsNode: (nodeId: string) => void | Promise<void>;
  checkManagedUpdate: (nodeId: string) => void | Promise<void>;
  applyManagedUpdate: (nodeId: string) => void | Promise<void>;
  connectSelectedNodeToRemote: (nodeId: string) => void | Promise<void>;
  createPairingInviteForNode: (nodeId: string) => void | Promise<void>;
  loadNodeImages: (nodeId: string) => void | Promise<void>;
  loadControlPlaneAccess: (nodeId: string) => void | Promise<void>;
  loadManagedUpdateJobs: (nodeId: string) => void | Promise<void>;
  openNodeRename: (node: Node) => void;
  openInstanceSettings: (instanceId: string) => void;
  removeNode: (node: Node) => void | Promise<void>;
  removeNodeLocalFolder: (folderId: string) => void | Promise<void>;
  removeRemoteKey: (nodeId: string, keyId: string) => void | Promise<void>;
  removeControlPlaneConnection: (nodeId: string, connectionId: string) => void | Promise<void>;
  removeRuntime: (runtime: NodeRuntime) => void | Promise<void>;
  saveExternalListener: () => void | Promise<void>;
  submitNodeLocalFolder: () => void | Promise<void>;
  updateNodeFolderDefaultImage: (value: string) => void;
  setUpdateChannel: (value: string) => void;
  updateExternalListenerDraft: (field: "bindScope" | "port", value: string) => void;
  updateRemoteConnect: (field: keyof RemoteConnectDraft, value: string) => void;
};

type NodeDetailBusy = {
  checkingNodeId: string;
  checkingRuntimeId: string;
  checkingUpdateNodeId: string;
  applyingUpdateNodeId: string;
  connectingRemoteNodeId: string;
  creatingNodeLocalFolder: boolean;
  creatingPairingInviteNodeId: string;
  deletingNodeId: string;
  deletingNodeLocalFolderId: string;
  deletingRemoteKeyId: string;
  deletingControlPlaneConnectionId: string;
  deletingRuntimeId: string;
  loadingNodeImagesId: string;
  loadingRemoteKeysNodeId: string;
  loadingExternalListener: boolean;
  renamingNodeId: string;
  savingExternalListener: boolean;
};

type NodeDetailResources = {
  canConnectRemote: boolean;
  images: LocalDockerImage[];
  imagesError: string;
  instances: InstanceBoardItem[];
  localFoldersError: string;
  localFolders: NodeLocalFolder[];
  nodeFolderDefaultImageId: string;
  nodeFolderImageOptions: SelectableImage[];
  remoteConnect: RemoteConnectDraft;
  remoteConnectResultByNodeId: Record<string, RemoteConnectResult>;
  controlPlanePairings: NodeControlPlanePairing[];
  controlPlaneConnections: NodeControlPlaneConnection[];
  remoteKeysError: string;
  diagnostics: NodeDiagnosticLog[];
  externalListener?: NodeAgentExternalListener;
  externalListenerBindScope: NodeAgentExternalListener["bindScope"];
  externalListenerError: string;
  externalListenerPort: string;
  runtimes: NodeRuntime[];
  selectedImageNodeId: string;
  selectedNodeIsLocal: boolean;
  updateChannel: UpdateChannel;
  updateChecks: Record<string, UpdateCheckResult>;
  updateJobs: UpdateJob[];
};

type NodeDetailStatus = {
  build: (nodeId: string) => Partial<BuildInfo> | undefined;
  buildLabel: (nodeId: string) => string;
  buildTitle: (nodeId: string) => string;
  isBuiltinNode: (node: Node) => boolean;
  locationLabel: (node: Node) => string;
  nameById: (nodeId: string) => string;
  packageLabel: (nodeId: string) => string;
  protocolLabel: (nodeId: string) => string;
  statusLabel: (nodeId: string) => string;
  statusVariant: (nodeId: string) => "default" | "secondary";
};

const props = defineProps<{
  actions: NodeDetailActions;
  busy: NodeDetailBusy;
  resources: NodeDetailResources;
  selectedNode?: Node;
  status: NodeDetailStatus;
}>();

const activeTab = ref<NodeDetailTab>("overview");
const localizedStatus = (keys: Record<string, string>, value: string) => translateStatus(keys, value, t);
const localizedDateTime = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatDateTime(parsed, locale.value as SupportedLocale);
};
const headerActionState = computed(() => nodeDetailActionState({
  nodeId: props.selectedNode?.id || "",
  isBuiltinNode: props.selectedNode ? props.status.isBuiltinNode(props.selectedNode) : false,
  checkingNodeId: props.busy.checkingNodeId,
  creatingPairingInviteNodeId: props.busy.creatingPairingInviteNodeId,
  deletingNodeId: props.busy.deletingNodeId,
  renamingNodeId: props.busy.renamingNodeId,
}, t));
const tabs = computed(() => [
  { value: "overview", label: t("settings.nodeDetail.overview"), icon: Gauge },
  { value: "runtimes", label: `${t("settings.nodeDetail.runtimes")} ${props.resources.runtimes.length}`, icon: Box },
  { value: "updates", label: t("settings.nodeDetail.updates"), icon: Download },
  { value: "storage", label: `${t("settings.nodeDetail.storage")} ${props.resources.localFolders.length}`, icon: FolderOpen },
  { value: "inventory", label: t("settings.nodeDetail.inventory"), icon: Monitor },
  { value: "remote", label: t("settings.nodeDetail.remote"), icon: Network },
] satisfies Array<{ value: NodeDetailTab; label: string; icon: Component }>);

const nodeUpdateCheck = computed(() => props.resources.updateChecks[props.selectedNode?.id || ""]);

function updateSummary(fallback?: string) {
  const check = nodeUpdateCheck.value;
  if (!check) return t("settings.nodeDetail.currentNotChecked", { version: fallback || t("settings.nodeDetail.unknown") });
  if (!check.supported) return check.reason || t("settings.nodeDetail.updateUnsupported");
  if (!check.updateAvailable && check.reason) return check.reason;
  return `${check.currentVersion || fallback || t("settings.nodeDetail.unknown")} → ${check.availableVersion} · ${check.updateAvailable ? t("settings.nodeDetail.updateAvailable") : t("settings.nodeDetail.upToDate")}`;
}

function canApplyUpdate() {
  const check = nodeUpdateCheck.value;
  return Boolean(check?.supported && check.updateAvailable && check.preflightToken);
}

function runtimeVersionSummary(instance: InstanceBoardItem) {
  const state = instance.runtimeVersion;
  if (!state) return t("settings.nodeDetail.runtimeVersionUnavailable");
  return t(state.phase === "failed" && instance.status === "running" ? "settings.nodeDetail.runtimeVersionFailedSummary" : "settings.nodeDetail.runtimeVersionSummary", {
    actual: state.actualVersion || t("settings.nodeDetail.unknown"),
    desired: state.desiredVersion,
    attempt: state.attempt,
  });
}

function runtimeVersionPhase(instance: InstanceBoardItem) {
  const phase = instance.runtimeVersion?.phase;
  return phase ? localizedStatus(runtimeVersionStatusKeys, phase) : t("settings.nodeDetail.unknown");
}

watch(
  () => props.selectedNode?.id,
  () => {
    activeTab.value = "overview";
  },
);
</script>

<style scoped>
.node-detail-content {
  max-height: 100%;
  min-height: 0;
  padding-right: 2px;
}

.node-detail-content :deep([data-reka-scroll-area-viewport] > div) {
  height: 100%;
  min-height: 100%;
}

.node-detail-content-inner {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 14px;
  min-height: 100%;
  padding-right: 2px;
}

.node-detail-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  min-width: 0;
}

.node-detail-identity {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.node-detail-identity > span,
.node-metrics span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.node-detail-title-row,
.node-detail-meta,
.node-detail-header-actions {
  display: flex;
  align-items: center;
  min-width: 0;
}

.node-detail-title-row {
  gap: 8px;
}

.node-detail-meta {
  gap: 5px;
  color: var(--text-muted);
  font-size: 11px;
}

.node-detail-header-actions {
  align-items: flex-start;
  justify-content: flex-end;
  gap: 7px;
  white-space: nowrap;
}

:global(.node-detail-action-menu) {
  display: grid;
  width: 280px;
  gap: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

:global(.node-detail-action-item) {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  min-height: 50px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--control-plane-menu-text);
  cursor: pointer;
  padding: 8px 10px;
  text-align: left;
}

:global(.node-detail-action-item > svg) {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}

:global(.node-detail-action-item > span) {
  display: grid;
  gap: 2px;
  min-width: 0;
}

:global(.node-detail-action-item strong),
:global(.node-detail-action-item small) {
  overflow: hidden;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.node-detail-action-item strong) {
  color: inherit;
  font-size: 12px;
  font-weight: 750;
}

:global(.node-detail-action-item small) {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
}

:global(.node-detail-action-item:hover),
:global(.node-detail-action-item:focus-visible),
:global(.node-detail-action-item[data-highlighted]) {
  background: var(--surface-active);
  color: var(--control-plane-menu-hover-text);
  outline: none;
}

:global(.node-detail-action-item.danger) {
  color: var(--status-danger);
}

:global(.node-detail-action-item.danger small) {
  color: color-mix(in srgb, var(--status-danger) 72%, var(--text-muted));
}

:global(.node-detail-action-item.danger:hover),
:global(.node-detail-action-item.danger:focus-visible),
:global(.node-detail-action-item.danger[data-highlighted]) {
  background: var(--status-danger-bg);
  color: var(--status-danger);
}

:global(.node-detail-action-item[data-disabled]) {
  cursor: default;
  opacity: 0.52;
}

.node-detail-header strong,
.node-resource-row strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-detail-header strong {
  min-width: 0;
  font-size: 18px;
}

.node-detail-header code,
.node-resource-row code {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-detail-meta code {
  flex: 0 1 auto;
}

.node-connection-mode {
  flex: 0 0 auto;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
}

.node-diagnostic-badge {
  display: inline-flex;
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  padding: 0;
  color: inherit;
  cursor: help;
  outline: none;
}

.node-diagnostic-badge:focus-visible {
  border-radius: 5px;
  outline: none;
  box-shadow: 0 0 0 2px var(--ring);
}

.node-listener-form {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(120px, 0.55fr) auto;
  align-items: end;
  gap: 10px;
}

.node-listener-form label {
  display: grid;
  gap: 6px;
}

.node-listener-form label > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.node-listener-warning {
  margin: 10px 0 0;
  color: var(--warning, #b7791f);
  font-size: 11px;
  line-height: 1.5;
}

.node-listener-endpoint {
  display: block;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 11px;
}

.node-detail-tabs {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
  min-width: 0;
}

.node-detail-tab-list {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1px;
  width: 100%;
  height: auto;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 2px;
}

.node-detail-tab-trigger {
  min-width: 0;
  height: 30px;
  gap: 6px;
  border-radius: 5px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
  padding: 0 8px;
}

.node-detail-tab-trigger :deep(.truncate) {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
}

.node-detail-tab-trigger:not([data-state="active"]):hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.node-detail-tab-trigger[data-state="active"] {
  background: var(--surface-active);
  color: var(--text-strong);
  box-shadow: none;
}

.node-detail-tab-content {
  display: grid;
  align-content: start;
  gap: 12px;
  min-height: 0;
  min-width: 0;
  margin-top: 0;
}

.node-detail-tab-content[hidden] {
  display: none;
}

.fill-tab-content {
  align-content: stretch;
}

.fill-section {
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  height: 100%;
  min-height: 0;
}

.node-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.node-metrics > div {
  display: grid;
  gap: 3px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 10px;
}

.node-metrics strong {
  color: var(--text-strong);
  font-size: 18px;
}

.node-detail-section,
.node-remote-panel {
  display: grid;
  gap: 9px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.flush-section,
.node-detail-tab-content > .node-remote-panel:first-child {
  border-top: 0;
  padding-top: 0;
}

.node-resource-list {
  display: grid;
  align-content: start;
  gap: 7px;
  min-height: 0;
}

.node-resource-list.compact-list {
  max-height: 220px;
}

.fill-section > .node-resource-list.compact-list {
  display: block;
  height: 100%;
  max-height: none;
}

.image-inventory-list {
  max-height: 220px;
}

.settings-scroll-content {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 100%;
  padding-right: 2px;
}

.node-resource-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 9px;
}

.node-resource-row > div:first-child {
  display: grid;
  min-width: 0;
  gap: 3px;
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

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.section-head span,
.node-remote-panel label span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.section-head > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.update-channel-select {
  flex: 0 0 150px;
  width: 150px;
}

.managed-update-groups {
  display: grid;
  gap: 20px;
}

.managed-update-group {
  display: grid;
  gap: 9px;
  min-width: 0;
  border-left: 3px solid var(--status-info);
  padding-left: 12px;
}

.instance-update-group {
  border-left-color: var(--status-warning);
}

.managed-update-group-head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
  color: var(--status-info);
}

.instance-update-group .managed-update-group-head {
  color: var(--status-warning);
}

.managed-update-group-head > svg {
  flex: 0 0 auto;
  margin-top: 1px;
}

.managed-update-group-head > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.managed-update-group-head strong {
  color: var(--text-strong);
  font-size: 13px;
}

.managed-update-group-head span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.35;
}

.update-job-title {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.update-job-title strong {
  min-width: 0;
}

.inline-create,
.node-remote-panel label {
  display: grid;
  gap: 7px;
}

.compact-create {
  gap: 8px;
}

.node-diagnostic-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.node-diagnostic-grid span {
  display: grid;
  min-width: 0;
  gap: 3px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 9px;
}

.node-diagnostic-grid b,
.node-diagnostic-grid em {
  overflow: hidden;
  font-size: 11px;
  font-style: normal;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-diagnostic-grid b {
  color: var(--text-muted);
  font-weight: 750;
}

.node-diagnostic-grid em {
  color: var(--text-strong);
  font-weight: 650;
}

.node-diagnostic-log {
  display: grid;
  gap: 8px;
}

.node-diagnostic-log-entry {
  display: grid;
  gap: 7px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 9px;
}

.node-diagnostic-log-entry > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.node-diagnostic-log-entry code,
.node-diagnostic-log-entry small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-diagnostic-log-entry p {
  margin: 0;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.4;
}

.node-diagnostic-log-entry ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.node-diagnostic-log-entry li {
  display: grid;
  grid-template-columns: minmax(80px, 0.35fr) minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
  color: var(--text-muted);
  font-size: 11px;
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

.node-resource-row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.node-folder-add-controls {
  display: grid;
  grid-template-columns: minmax(150px, 220px) auto;
  align-items: center;
  gap: 8px;
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

@media (max-width: 780px) {
  .node-detail-header,
  .node-metrics,
  .node-diagnostic-grid {
    grid-template-columns: 1fr;
  }

  .node-detail-tab-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .node-detail-header-actions {
    justify-content: flex-start;
  }

  .managed-update-group {
    padding-left: 9px;
  }
}
</style>
