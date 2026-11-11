<template>
  <ConfigProvider :teleport-to="portalHost">
  <section ref="viewer" class="remote-desktop-viewer" :class="{ 'is-connected': Boolean(session), embedded }" :aria-label="t('instances.remoteDesktop.title')">
    <div class="remote-desktop-layout">
    <header class="remote-desktop-head is-live">
      <div class="remote-desktop-live-toolbar">
        <h2 class="sr-only">{{ t("instances.remoteDesktop.title") }}</h2>
        <div class="remote-desktop-live-main">
          <Popover v-model:open="scopeMenuOpen">
            <PopoverTrigger as-child>
              <Button
                variant="ghost"
                size="sm"
                class="remote-desktop-scope-trigger"
                :disabled="switchingScope"
                :title="localScope ? t('instances.remoteDesktop.localScopeHint') : t('instances.remoteDesktop.independentScopeHint')"
                @click="prepareScopeMenu"
              >
                <span class="remote-desktop-stage-target-icon" aria-hidden="true">
                  <component :is="sourceIcon(target.kind)" :size="15" />
                </span>
                <span class="remote-desktop-scope-title">
                  <strong>{{ selectedTargetTitle }}</strong>
                  <ChevronDown :size="13" aria-hidden="true" />
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent class="remote-desktop-scope-popover p-0" align="start" :collision-padding="10" :side-offset="6">
              <div class="remote-desktop-scope-head">
                <div>
                  <strong>{{ session ? t("instances.remoteDesktop.switchScope") : t("instances.remoteDesktop.chooseTarget") }}</strong>
                  <p>{{ session ? (localScope ? t("instances.remoteDesktop.localScopeHint") : t("instances.remoteDesktop.independentScopeHint")) : t("instances.remoteDesktop.chooseTargetHint") }}</p>
                </div>
                <Button v-if="hasSourceProvider" variant="ghost" size="icon-sm" :disabled="sourcesLoading" :aria-label="t('instances.remoteDesktop.refreshSources')" :title="t('instances.remoteDesktop.refreshSources')" @click="loadSources">
                  <RefreshCw :class="{ 'remote-desktop-spin': sourcesLoading }" :size="14" aria-hidden="true" />
                </Button>
              </div>
              <ScrollArea class="remote-desktop-scope-scroll" :horizontal="false">
                <div class="remote-desktop-scope-options" role="listbox" :aria-label="t('instances.remoteDesktop.switchScope')">
                  <template v-for="group in sourceGroups" :key="group.kind">
                    <div class="remote-desktop-scope-group">
                      <span>{{ sourceKindLabel(group.kind) }}</span>
                      <span>{{ group.items.length }}</span>
                    </div>
                    <Button
                      v-for="item in group.items"
                      :key="item.sourceRef"
                      variant="ghost"
                      class="remote-desktop-scope-option"
                      :class="{ selected: target.kind === item.kind && target.sourceRef === item.sourceRef }"
                      role="option"
                      :aria-selected="target.kind === item.kind && target.sourceRef === item.sourceRef"
                      :disabled="!item.capturable"
                      :title="item.capturable ? item.title : item.reason || t('instances.remoteDesktop.unavailableSource')"
                      @click="selectScopeSource(item)"
                    >
                      <span class="remote-desktop-scope-option-icon" aria-hidden="true"><component :is="sourceIcon(item.kind)" :size="15" /></span>
                      <span class="remote-desktop-scope-option-copy">
                        <strong>{{ sourcePrimaryText(item) }}</strong>
                        <small>{{ [sourceSecondaryText(item), `${item.width} × ${item.height}`].filter(Boolean).join(" · ") }}</small>
                      </span>
                      <Check v-if="target.kind === item.kind && target.sourceRef === item.sourceRef" :size="14" aria-hidden="true" />
                    </Button>
                  </template>
                  <div v-if="sourcesLoading && !sources.length" class="remote-desktop-scope-state">
                    <LoaderCircle class="remote-desktop-spin" :size="14" aria-hidden="true" />
                    <span>{{ t("instances.remoteDesktop.loadingSources") }}</span>
                  </div>
                  <div v-else-if="sourcesError" class="remote-desktop-scope-state remote-desktop-scope-state-error">
                    <span>{{ sourcesError }}</span>
                    <Button variant="ghost" size="sm" @click="loadSources">{{ t("instances.remoteDesktop.retry") }}</Button>
                  </div>
                  <div v-else-if="!sources.length && !sourcesLoading" class="remote-desktop-scope-state">
                    <span>{{ t("instances.remoteDesktop.noSources") }}</span>
                  </div>
                </div>
              </ScrollArea>
            </PopoverContent>
          </Popover>
          <Badge v-if="session" class="remote-desktop-state" :data-tone="connectionTone" variant="outline" role="status" aria-live="polite">
            <span class="remote-desktop-state-dot" aria-hidden="true" />
            <span class="remote-desktop-state-label">{{ connectionLabel }}</span>
          </Badge>
        </div>
        <div class="remote-desktop-live-actions">
          <div v-if="session" class="remote-desktop-live-meta">
            <TooltipProvider :delay-duration="120">
              <div v-if="visibleTransportIndicators.length" class="remote-desktop-transport-status" role="group" :aria-label="t('instances.remoteDesktop.transportStatus')">
                <Tooltip v-for="transport in visibleTransportIndicators" :key="transport.key">
                  <TooltipTrigger as-child>
                    <span
                      class="remote-desktop-transport-indicator"
                      :class="{ 'is-active': transport.state === 'active' }"
                      :data-transport="transport.key"
                      tabindex="0"
                      role="img"
                      :aria-label="`${transport.label}: ${transport.status}`"
                    >
                      <component :is="transport.icon" :size="13" aria-hidden="true" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" :side-offset="8" class="remote-desktop-transport-tooltip">
                    <div class="remote-desktop-transport-tooltip-body">
                      <div class="remote-desktop-transport-tooltip-summary">
                        <div class="remote-desktop-transport-tooltip-heading">
                          <strong>{{ transport.label }}</strong>
                          <span>{{ transport.status }}</span>
                        </div>
                        <small>{{ transport.detail }}</small>
                      </div>
                      <div v-for="failure in failedTransportIndicators" :key="failure.key" class="remote-desktop-transport-tooltip-failure">
                        <div class="remote-desktop-transport-tooltip-heading">
                          <strong>{{ failure.label }}</strong>
                          <span>{{ failure.status }}</span>
                        </div>
                        <small>{{ failure.detail }}</small>
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
            <span v-if="session"><Users :size="12" aria-hidden="true" />{{ t("instances.remoteDesktop.viewerCount", { count: viewerCount }) }}</span>
            <span v-if="session && !fallbackActive && webRTCLatencyDetail"><Gauge :size="12" aria-hidden="true" />{{ webRTCLatencyDetail }}</span>
            <span v-if="resolution"><Maximize2 :size="12" aria-hidden="true" />{{ resolution }}</span>
            <span v-if="sessionDeadline"><Clock3 :size="12" aria-hidden="true" />{{ sessionDeadline }}</span>
            <span v-if="idleDeadline" class="remote-desktop-idle-deadline">{{ idleDeadline }}</span>
            <span v-if="clipboardStatus" class="remote-desktop-inline-status" role="status" :title="clipboardStatus">
              <Clipboard :size="12" aria-hidden="true" />{{ clipboardStatus }}
            </span>
          </div>
          <div v-if="session" class="remote-desktop-head-actions">
            <Button v-if="!isController && hasController" variant="default" size="sm" :disabled="!signalingReady || fallbackSwitching || controlRequestPending" :title="inputActionTitle" @click="primaryInputAction">
              <MousePointer2 :size="14" aria-hidden="true" />
              <span class="remote-desktop-action-label">{{ inputActionLabel }}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-sm" :disabled="switchingScope" :aria-label="t('instances.remoteDesktop.moreActions')" :title="t('instances.remoteDesktop.moreActions')">
                  <MoreHorizontal :size="16" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="remote-desktop-actions-menu" align="end" :collision-padding="10" :side-offset="6">
                <DropdownMenuLabel class="remote-desktop-actions-label">
                  <span>{{ t("instances.remoteDesktop.transportQuality") }}</span>
                  <small>{{ transportQualityLabel }}</small>
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup :model-value="transportResolution" @update:model-value="setTransportResolution(String($event))">
                  <DropdownMenuRadioItem v-for="option in transportResolutionOptions" :key="option.value" :value="option.value" :disabled="!signalingReady || fallbackSwitching">
                    <span class="remote-desktop-resolution-option">
                      <span>{{ option.label }}</span>
                      <small>{{ option.detail }}</small>
                    </span>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <p class="remote-desktop-actions-hint">{{ t("instances.remoteDesktop.transportResolutionHint") }}</p>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger :disabled="!signalingReady || fallbackSwitching">
                    <Gauge :size="14" aria-hidden="true" />
                    <span>{{ t("instances.remoteDesktop.transportFrameRate") }}</span>
                    <small class="remote-desktop-menu-value">{{ transportFrameRateLabel }}</small>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent class="remote-desktop-frame-rate-menu" :collision-padding="10" :side-offset="4">
                    <p class="remote-desktop-actions-hint">{{ t("instances.remoteDesktop.transportFrameRateHint") }}</p>
                    <DropdownMenuRadioGroup :model-value="transportFrameRate" @update:model-value="setTransportFrameRate(String($event))">
                      <DropdownMenuRadioItem v-for="option in transportFrameRateOptions" :key="option.value" :value="option.value" :disabled="!signalingReady || fallbackSwitching">
                        <span class="remote-desktop-resolution-option">
                          <span>{{ option.label }}</span>
                          <small>{{ option.detail }}</small>
                        </span>
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger :disabled="fallbackSwitching || transportPolicyReconnecting">
                    <Waypoints :size="14" aria-hidden="true" />
                    <span>{{ t("instances.remoteDesktop.connectionMethods") }}</span>
                    <small class="remote-desktop-menu-value">{{ connectionMethodsSummary }}</small>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent class="remote-desktop-connection-methods-menu" :collision-padding="10" :side-offset="4">
                    <p class="remote-desktop-actions-hint">{{ t("instances.remoteDesktop.connectionMethodsHint") }}</p>
                    <DropdownMenuCheckboxItem
                      v-for="method in connectionMethodOptions"
                      :key="method.key"
                      :model-value="method.enabled"
                      :disabled="method.disabled"
                      :title="method.disabledReason"
                      @update:model-value="setConnectionMethodEnabled(method.key, Boolean($event))"
                      @select.prevent
                    >
                      <span class="remote-desktop-connection-option">
                        <span>{{ method.label }}</span>
                        <small>{{ method.detail }}</small>
                      </span>
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem :disabled="!transportPolicyDirty || transportPolicyReconnecting" @select="applyConnectionMethods">
                      <RefreshCw :class="{ 'remote-desktop-spin': transportPolicyReconnecting }" :size="14" aria-hidden="true" />
                      <span>{{ transportPolicyReconnecting ? t("instances.remoteDesktop.applyingConnectionMethods") : t("instances.remoteDesktop.applyConnectionMethods") }}</span>
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem :disabled="!signalingReady || fallbackSwitching || inputResumePending || controlRequestPending" @select="toggleInputEnabled">
                  <MousePointer2 :size="14" aria-hidden="true" />
                  <span>{{ inputRequested ? t("instances.remoteDesktop.disableInput") : t("instances.remoteDesktop.enableInput") }}</span>
                  <Check v-if="inputRequested" :size="14" class="ml-auto" aria-hidden="true" />
                </DropdownMenuItem>
                <DropdownMenuSub v-if="clipboardSupported">
                  <DropdownMenuSubTrigger :disabled="!signalingReady || fallbackSwitching">
                    <Clipboard :size="14" aria-hidden="true" />
                    <span>{{ t("instances.remoteDesktop.clipboard") }}</span>
                    <small class="remote-desktop-menu-value">{{ clipboard ? t("instances.remoteDesktop.clipboardOn") : t("instances.remoteDesktop.clipboardOff") }}</small>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent class="remote-desktop-clipboard-menu" :collision-padding="10" :side-offset="4">
                    <p class="remote-desktop-actions-hint">{{ t("instances.remoteDesktop.clipboardHint") }}</p>
                    <DropdownMenuItem :disabled="clipboardBusy" @select="setClipboard(!clipboard)">
                      <LoaderCircle v-if="clipboardBusy" class="remote-desktop-spin" :size="14" aria-hidden="true" />
                      <Power v-else :size="14" aria-hidden="true" />
                      <span>{{ clipboard ? t("instances.remoteDesktop.clipboardDisable") : t("instances.remoteDesktop.clipboardEnable") }}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="!clipboard || clipboardBusy" @select="sendLocalClipboard">
                      <ClipboardCopy :size="14" aria-hidden="true" />
                      <span>{{ t("instances.remoteDesktop.clipboardSend") }}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="!clipboard || clipboardBusy" @select="readRemoteClipboard">
                      <ClipboardPaste :size="14" aria-hidden="true" />
                      <span>{{ t("instances.remoteDesktop.clipboardRead") }}</span>
                    </DropdownMenuItem>
                    <p v-if="clipboardStatus" class="remote-desktop-clipboard-status" role="status">{{ clipboardStatus }}</p>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem @select="toggleFullscreen">
                  <Minimize2 v-if="isFullscreen" :size="14" aria-hidden="true" />
                  <Maximize2 v-else :size="14" aria-hidden="true" />
                  <span>{{ isFullscreen ? t("instances.remoteDesktop.exitFullscreen") : t("instances.remoteDesktop.fullscreen") }}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem class="remote-desktop-menu-danger" :disabled="switchingScope" @select="stop">
                  <Square :size="13" aria-hidden="true" />
                  <span>{{ t("instances.remoteDesktop.stop") }}</span>
                </DropdownMenuItem>
                <DropdownMenuItem v-if="canManage" class="remote-desktop-menu-danger" :disabled="switchingScope" @select="forceStopOpen = true">
                  <OctagonX :size="15" aria-hidden="true" />
                  <span>{{ t("instances.remoteDesktop.forceStop") }}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <AlertDialog v-if="canManage" v-model:open="forceStopOpen">
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{{ t("instances.remoteDesktop.forceStopTitle") }}</AlertDialogTitle>
                  <AlertDialogDescription>{{ t("instances.remoteDesktop.forceStopDescription") }}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{{ t("instances.remoteDesktop.cancel") }}</AlertDialogCancel>
                  <AlertDialogAction class="remote-desktop-danger-action" @click="forceStop">{{ t("instances.remoteDesktop.forceStop") }}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </header>

    <div v-if="error || !signalTransportReady" class="remote-desktop-error-banner" role="alert">
      <CircleAlert :size="15" aria-hidden="true" />
      <span>{{ error || t("instances.remoteDesktop.secureTransportHint") }}</span>
    </div>

    <div v-if="!available" class="remote-desktop-unavailable">
      <span class="remote-desktop-unavailable-icon" aria-hidden="true"><MonitorOff :size="22" /></span>
      <strong>{{ t("instances.remoteDesktop.unavailable") }}</strong>
      <span>{{ t("instances.remoteDesktop.unavailableHint") }}</span>
    </div>

    <div v-else-if="switchingScope || transportPolicyReconnecting" class="remote-desktop-switching" role="status">
      <span class="remote-desktop-switching-icon" aria-hidden="true"><LoaderCircle class="remote-desktop-spin" :size="20" /></span>
      <span class="remote-desktop-switching-copy">
        <strong>{{ switchingOverlayTitle }}</strong>
        <span>{{ switchingOverlayHint }}</span>
      </span>
    </div>

    <div v-else-if="!session" class="remote-desktop-stage remote-desktop-stage-setup">
    <div class="remote-desktop-setup">
      <div class="remote-desktop-setup-main">
        <div class="remote-desktop-section-heading">
          <strong>{{ t("instances.remoteDesktop.chooseTarget") }}</strong>
          <span>{{ sourceKindLabel(target.kind) }}</span>
        </div>
        <div class="remote-desktop-targets" role="radiogroup" :aria-label="t('instances.remoteDesktop.chooseTarget')">
          <Button
            v-for="provider in sourceProviderOptions"
            :key="provider.kind"
            variant="outline"
            class="remote-desktop-target"
            :class="{ selected: target.kind === provider.kind }"
            role="radio"
            :aria-checked="target.kind === provider.kind"
            :disabled="!provider.available"
            :title="provider.available ? undefined : provider.reason || t('instances.remoteDesktop.sourceCaptureUnavailable')"
            @click="chooseSourceKind(provider.kind)"
          >
            <span class="remote-desktop-target-icon" aria-hidden="true"><component :is="sourceIcon(provider.kind)" :size="17" /></span>
            <span class="remote-desktop-target-copy">
              <strong>{{ sourceKindLabel(provider.kind) }}</strong>
              <small>{{ provider.available ? sourceKindDescription(provider.kind) : provider.reason || t("instances.remoteDesktop.sourceCaptureUnavailable") }}</small>
            </span>
          </Button>
        </div>

        <section v-if="target.kind" class="remote-desktop-sources" :aria-label="t('instances.remoteDesktop.sourcesTitle')">
          <div class="remote-desktop-sources-head">
            <div>
              <strong>{{ t("instances.remoteDesktop.sourcesTitle") }}</strong>
              <span>{{ sourceCountLabel }}</span>
            </div>
            <Button variant="ghost" size="icon-sm" :aria-label="t('instances.remoteDesktop.refreshSources')" :title="t('instances.remoteDesktop.refreshSources')" :disabled="sourcesLoading" @click="loadSources">
              <RefreshCw :class="{ 'remote-desktop-spin': sourcesLoading }" :size="14" />
            </Button>
          </div>
          <label class="remote-desktop-source-search">
            <Search :size="14" aria-hidden="true" />
            <Input v-model="sourceQuery" type="search" :aria-label="t('instances.remoteDesktop.searchSources')" :placeholder="t('instances.remoteDesktop.searchSources')" />
          </label>
          <div v-if="sourcesLoading && !sources.length" class="remote-desktop-source-state" role="status">
            <LoaderCircle class="remote-desktop-spin" :size="16" aria-hidden="true" />
            <span>{{ t("instances.remoteDesktop.loadingSources") }}</span>
          </div>
          <div v-else-if="sourcesError" class="remote-desktop-source-state remote-desktop-source-state-error" role="alert">
            <CircleAlert :size="15" aria-hidden="true" />
            <span>{{ sourcesError }}</span>
            <Button variant="outline" size="sm" @click="loadSources">{{ t("instances.remoteDesktop.retry") }}</Button>
          </div>
          <div v-else-if="!sources.length" class="remote-desktop-source-state">
            <MonitorOff :size="17" aria-hidden="true" />
            <span>{{ t("instances.remoteDesktop.noSources") }}</span>
          </div>
          <div v-else-if="!targetSources.length" class="remote-desktop-source-state">
            <Search :size="16" aria-hidden="true" />
            <span>{{ t("instances.remoteDesktop.noSourceMatches") }}</span>
          </div>
          <ScrollArea v-else class="remote-desktop-source-scroll" :horizontal="false">
            <div class="remote-desktop-source-list" role="listbox" :aria-label="t('instances.remoteDesktop.sourcesTitle')">
              <Button
                v-for="item in targetSources"
                :key="item.sourceRef"
                variant="ghost"
                class="remote-desktop-source-row"
                :class="{ selected: target.kind === item.kind && target.sourceRef === item.sourceRef }"
                role="option"
                :aria-selected="target.kind === item.kind && target.sourceRef === item.sourceRef"
                :disabled="!item.capturable"
                :title="item.capturable ? item.title : item.reason || t('instances.remoteDesktop.unavailableSource')"
                @click="selectSource(item)"
              >
                <span class="remote-desktop-source-icon" aria-hidden="true"><component :is="sourceIcon(item.kind)" :size="15" /></span>
                <span class="remote-desktop-source-copy">
                  <strong>{{ sourcePrimaryText(item) }}</strong>
                  <small>{{ sourceSecondaryText(item) }}</small>
                </span>
                <span class="remote-desktop-source-meta">
                  <span>{{ item.width }} × {{ item.height }}</span>
                  <small v-if="!item.capturable">{{ item.reason || t("instances.remoteDesktop.unavailableSource") }}</small>
                </span>
              </Button>
            </div>
          </ScrollArea>
          <p class="remote-desktop-source-hint">{{ t("instances.remoteDesktop.selectSource") }}</p>
        </section>
      </div>

      <aside class="remote-desktop-connect-panel">
        <div class="remote-desktop-connect-preview">
          <span class="remote-desktop-preview-icon" aria-hidden="true"><ScreenShare :size="20" /></span>
          <span class="remote-desktop-preview-kicker">{{ t("instances.remoteDesktop.readyToConnect") }}</span>
          <strong>{{ selectedTargetTitle }}</strong>
          <p>{{ selectedTargetDetail }}</p>
          <div v-if="capabilityChips.length" class="remote-desktop-capabilities">
            <span v-for="chip in capabilityChips" :key="chip">{{ chip }}</span>
          </div>
        </div>
        <p v-if="localScope" class="remote-desktop-scope-note">
          <Monitor :size="14" aria-hidden="true" />
          <span>{{ t("instances.remoteDesktop.localScopeHint") }}</span>
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="sm" class="remote-desktop-setup-methods">
              <Waypoints :size="14" aria-hidden="true" />
              <span>{{ t("instances.remoteDesktop.connectionMethods") }}</span>
              <small>{{ connectionMethodsSummary }}</small>
              <ChevronDown :size="13" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent class="remote-desktop-connection-methods-menu" align="end" :collision-padding="10" :side-offset="6">
            <p class="remote-desktop-actions-hint">{{ t("instances.remoteDesktop.connectionMethodsHint") }}</p>
            <DropdownMenuCheckboxItem
              v-for="method in connectionMethodOptions"
              :key="method.key"
              :model-value="method.enabled"
              :disabled="method.disabled"
              :title="method.disabledReason"
              @update:model-value="setConnectionMethodEnabled(method.key, Boolean($event))"
              @select.prevent
            >
              <span class="remote-desktop-connection-option">
                <span>{{ method.label }}</span>
                <small>{{ method.detail }}</small>
              </span>
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div class="remote-desktop-connect-footer">
          <p v-if="!target.sourceRef" class="remote-desktop-connect-hint">{{ t("instances.remoteDesktop.selectSource") }}</p>
          <Button
            class="remote-desktop-connect-button"
            :disabled="connecting || !canConnect || !signalTransportReady"
            :title="signalTransportReady ? undefined : t('instances.remoteDesktop.secureTransportHint')"
            @click="connect"
          >
            <LoaderCircle v-if="connecting" class="remote-desktop-spin" :size="15" aria-hidden="true" />
            <ScreenShare v-else :size="15" aria-hidden="true" />
            <span>{{ connecting ? t("instances.remoteDesktop.connecting") : t("instances.remoteDesktop.connect") }}</span>
          </Button>
        </div>
      </aside>
    </div>
    </div>

    <div v-else ref="stage" class="remote-desktop-stage">
      <div
        ref="surface"
        class="remote-desktop-surface"
        :class="{ 'remote-desktop-system-cursor': systemCursor }"
        tabindex="0"
        @pointermove="pointerMove"
        @pointerdown="pointerButton($event, true)"
        @pointerup="pointerButton($event, false)"
        @pointercancel="pointerCancel"
        @lostpointercapture="pointerCancel"
        @contextmenu.prevent
        @wheel="wheel"
        @keydown="key($event, true)"
        @keyup="key($event, false)"
        @compositionend="commitComposition"
        @blur="surfaceBlur"
        @focus="surfaceFocus"
      >
        <video v-show="!fallbackActive" ref="video" autoplay playsinline @loadedmetadata="updateResolution" @resize="updateResolution"></video>
        <canvas v-show="fallbackActive" ref="fallbackCanvas" class="remote-desktop-canvas" :aria-label="t('instances.remoteDesktop.fallbackActive')"></canvas>
        <div v-if="!streamReady" class="remote-desktop-overlay" role="status">
          <LoaderCircle class="remote-desktop-spin" :size="22" aria-hidden="true" />
          <strong>{{ establishingTitle }}</strong>
          <span>{{ establishingHint }}</span>
        </div>
        <div v-else-if="snapshot?.mediaPaused" class="remote-desktop-overlay">
          <Play :size="22" aria-hidden="true" />
          <strong>{{ t("instances.remoteDesktop.paused") }}</strong>
        </div>
        <div v-if="controlHintVisible" class="remote-desktop-interaction-hint" role="status" aria-live="polite">
          <MousePointer2 :size="14" aria-hidden="true" />
          <span>{{ hasController ? t("instances.remoteDesktop.viewingByOther", { count: viewerCount }) : t("instances.remoteDesktop.controlAvailable") }}</span>
          <Button variant="secondary" size="sm" :disabled="controlRequestPending || !signalingReady" @pointerdown.stop @click.stop="requestControl">
            {{ controlRequestPending ? t("instances.remoteDesktop.requestingControl") : t("instances.remoteDesktop.requestControl") }}
          </Button>
        </div>
        <span v-if="streamReady && !inputEnabled" class="remote-desktop-view-only">
          <MousePointer2 :size="13" aria-hidden="true" />
          {{ isController ? t("instances.remoteDesktop.viewOnly") : hasController ? t("instances.remoteDesktop.viewingByOther", { count: viewerCount }) : t("instances.remoteDesktop.controlAvailable") }}
        </span>
      </div>
    </div>
    </div>
    <div ref="portalHost" class="remote-desktop-portal-host"></div>
  </section>
  </ConfigProvider>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  isRecoverableRemoteDesktopInputResumeError,
  parseRemoteDesktopWebRTCStats,
  remoteDesktopInputResumeRetryDelayMs,
  RemoteDesktopWheelPump,
  REMOTE_DESKTOP_INPUT_RESUME_ACK_TIMEOUT_MS,
  type RemoteDesktopWebRTCStats,
} from "@task-handoff/control-plane-client";
import {
  AppWindow,
  Cable,
  Check,
  ChevronDown,
  CircleAlert,
  Clipboard,
  ClipboardCopy,
  ClipboardPaste,
  Clock3,
  Gauge,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Monitor,
  MonitorOff,
  MoreHorizontal,
  MousePointer2,
  OctagonX,
  Play,
  Power,
  Radio,
  RefreshCw,
  ScreenShare,
  Search,
  Square,
  Users,
  Waypoints,
} from "@lucide/vue";
import { ConfigProvider } from "reka-ui";
import {
  DesktopSessionSnapshotSchema,
  REMOTE_DESKTOP_CHANNEL_VERSION,
  REMOTE_DESKTOP_MAX_CLIPBOARD_TEXT_BYTES,
  REMOTE_DESKTOP_MAX_CLIPBOARD_WIRE_BYTES,
  REMOTE_DESKTOP_MAX_MESSAGE_BYTES,
  REMOTE_DESKTOP_SIGNAL_SUBPROTOCOL,
  DesktopFallbackFrameAssembler,
  decodeDesktopFallbackFrame,
  isRemoteDesktopLocalNetworkAddress,
  type DesktopCaptureSelection,
  type DesktopFallbackSession,
  type DesktopSessionSnapshot,
} from "@task-handoff/protocol/remote-desktop";
import { createRemoteDesktopSession, forceStopRemoteDesktopSession, listRemoteDesktopSources, requestRemoteDesktopFallback, stopRemoteDesktopSession, type RemoteDesktopCreated, type RemoteDesktopSource } from "../../../api/remoteDesktop";
import { useControlPlaneSettingsQuery } from "../../../api/queries";
import { translateApiError } from "../../../i18n/apiError";
import { parseInputSuspension, shouldResumeAfterInputSuspension } from "./remoteDesktopInputSuspension";
import { createRemoteDesktopDiagnostics, remoteDesktopErrorFields } from "./remoteDesktopDiagnostics";
import { parseSelectedSourceIdentity, resolveRefreshedSource, selectedSourceIdentity as toSelectedSourceIdentity, type SelectedSourceIdentity } from "./remoteDesktopSourceSelection";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Input } from "../../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import { createBrowserUuid } from "../../../lib/random-id";
import { remoteDesktopCapabilities } from "../remoteDesktopCapability";

const { t } = useI18n();
const controlPlaneSettings = useControlPlaneSettingsQuery();
const props = defineProps<{
  instanceId: string;
  capabilities?: Record<string, unknown>;
  canManage?: boolean;
  embedded?: boolean;
  active?: boolean;
}>();

const remote = computed(() => remoteDesktopCapabilities({ capabilities: props.capabilities ?? {} } as any));
const available = computed(() => remote.value?.available === true);
const canManage = computed(() => props.canManage === true);
const sourceProviderOptions = computed(() => remote.value?.sourceProviders ?? []);
const hasSourceProvider = computed(() => sourceProviderOptions.value.some(provider => provider.available));
const clipboardSupported = computed(() => remote.value?.features.clipboard === true);
const localScope = computed(() => remote.value?.runtimeKind === "local");
const signalTransportReady = typeof window !== "undefined"
  && (window.isSecureContext || isRemoteDesktopLocalNetworkAddress(window.location.hostname));

const sources = ref<RemoteDesktopSource[]>([]);
const sourceQuery = ref("");
const sourcesLoading = ref(false);
const sourcesError = ref("");
type TargetSelection = { kind: string; sourceRef?: string };
type TransportResolutionValue = "auto" | "1080p" | "720p" | "540p" | "360p";
type TransportFrameRateValue = "auto" | "60" | "30" | "24" | "15";
type ConnectionMethodKey = "p2p" | "websocket" | "turn";
type ConnectionMethodAvailability = Record<ConnectionMethodKey, boolean>;
const CONNECTION_METHOD_KEYS: ConnectionMethodKey[] = ["p2p", "websocket", "turn"];
const TRANSPORT_RESOLUTION_PRESETS = [
  { value: "1080p" as const, width: 1920, height: 1080 },
  { value: "720p" as const, width: 1280, height: 720 },
  { value: "540p" as const, width: 960, height: 540 },
  { value: "360p" as const, width: 640, height: 360 },
];
const TRANSPORT_FRAME_RATE_PRESETS = [60, 30, 24, 15] as const;
type RemoteDesktopViewerPreferences = {
  target: TargetSelection;
  selectedSource?: SelectedSourceIdentity;
  transportResolution: TransportResolutionValue;
  transportFrameRate: TransportFrameRateValue;
  transportAvailability: ConnectionMethodAvailability;
};
const VIEWER_PREFERENCES_PREFIX = "task-handoff.control-plane.remote-desktop-viewer:";
const TRANSPORT_RESOLUTION_VALUES: TransportResolutionValue[] = ["auto", "1080p", "720p", "540p", "360p"];
const TRANSPORT_FRAME_RATE_VALUES: TransportFrameRateValue[] = ["auto", "60", "30", "24", "15"];

function viewerPreferencesKey(instanceId: string) {
  return `${VIEWER_PREFERENCES_PREFIX}${instanceId}`;
}

function loadViewerPreferences(instanceId: string): RemoteDesktopViewerPreferences | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const value = JSON.parse(
      window.localStorage?.getItem(viewerPreferencesKey(instanceId))
        || window.localStorage?.getItem(`${viewerPreferencesKey(instanceId)}:main`)
        || "null",
    ) as Record<string, any> | null;
    const rawTarget = value?.target;
    const target: TargetSelection | undefined = typeof rawTarget?.kind === "string" && rawTarget.kind.trim() && rawTarget.kind.length <= 64
      ? {
          kind: rawTarget.kind.trim(),
          ...(typeof rawTarget.sourceRef === "string" && rawTarget.sourceRef.trim() ? { sourceRef: rawTarget.sourceRef.trim() } : {}),
        }
      : undefined;
    const transportResolution = TRANSPORT_RESOLUTION_VALUES.includes(value?.transportResolution)
      ? value.transportResolution as TransportResolutionValue
      : "auto";
    const transportFrameRate = TRANSPORT_FRAME_RATE_VALUES.includes(value?.transportFrameRate)
      ? value.transportFrameRate as TransportFrameRateValue
      : "auto";
    const rawAvailability = value?.transportAvailability;
    const transportAvailability = rawAvailability && CONNECTION_METHOD_KEYS.some((key) => rawAvailability[key] === true)
      ? Object.fromEntries(CONNECTION_METHOD_KEYS.map((key) => [key, rawAvailability[key] === true])) as ConnectionMethodAvailability
      : { p2p: true, websocket: true, turn: true };
    const selectedSource = parseSelectedSourceIdentity(value?.selectedSource);
    return { target: target ?? { kind: "display" }, selectedSource, transportResolution, transportFrameRate, transportAvailability };
  } catch {
    return undefined;
  }
}

const viewerPreferences = loadViewerPreferences(props.instanceId);
const target = ref<TargetSelection>(viewerPreferences?.target ?? { kind: "display" });
const selectedSourceInfo = ref<SelectedSourceIdentity | undefined>(viewerPreferences?.selectedSource);
const session = ref<RemoteDesktopCreated>();
const snapshot = ref<DesktopSessionSnapshot>();
const error = ref("");
const connecting = ref(false);
const clipboard = ref(false);
const clipboardBusy = ref(false);
const clipboardStatus = ref("");
const inputEnabled = ref(false);
const controlRequestPending = ref(false);
const controlHintVisible = ref(false);
const streamReady = ref(false);
const signalingReady = ref(false);
const switchingScope = ref(false);
const scopeMenuOpen = ref(false);
const forceStopOpen = ref(false);
const transportResolution = ref<TransportResolutionValue>(viewerPreferences?.transportResolution ?? "auto");
const transportFrameRate = ref<TransportFrameRateValue>(viewerPreferences?.transportFrameRate ?? "auto");
const transportAvailability = ref<ConnectionMethodAvailability>(viewerPreferences?.transportAvailability ?? { p2p: true, websocket: true, turn: true });
const activeTransportAvailability = ref<ConnectionMethodAvailability>({ ...transportAvailability.value });
const transportPolicyReconnecting = ref(false);
const resolution = ref("");
const connectionState = ref<RTCIceConnectionState | RTCPeerConnectionState>("new");
const isFullscreen = ref(false);
type FallbackState = "idle" | "switching" | "active" | "reconnecting" | "failed";
type WebRTCRoute = "unknown" | "p2p" | "relay";
type TransportPathState = "active" | "pending" | "idle" | "failed";
const fallbackState = ref<FallbackState>("idle");
const transportUpgrading = ref(false);
const fallbackReason = ref<"ice-failed" | "recovery-timeout" | undefined>();
const webRTCRoute = ref<WebRTCRoute>("unknown");
const webRTCCandidatePair = ref<RemoteDesktopWebRTCStats>();
const webrtcPeerConnected = ref(false);
const webrtcPeerFailed = ref(false);
const webCodecsSupported = ref<boolean | null>(null);
const fallbackSize = ref<{ width: number; height: number }>();
const documentVisible = ref(typeof document === "undefined" ? true : document.visibilityState !== "hidden");

function persistViewerPreferences() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(viewerPreferencesKey(props.instanceId), JSON.stringify({
      target: target.value,
      selectedSource: selectedSourceInfo.value,
      transportResolution: transportResolution.value,
      transportFrameRate: transportFrameRate.value,
      transportAvailability: transportAvailability.value,
    } satisfies RemoteDesktopViewerPreferences));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

watch([target, selectedSourceInfo, transportResolution, transportFrameRate, transportAvailability], persistViewerPreferences, { deep: true });

const video = ref<HTMLVideoElement>();
const fallbackCanvas = ref<HTMLCanvasElement>();
const surface = ref<HTMLElement>();
const viewer = ref<HTMLElement>();
const portalHost = ref<HTMLElement>();

let ws: WebSocket | undefined;
let pc: RTCPeerConnection | undefined;
let awaitingRestart = false;
const channels = new Map<string, RTCDataChannel>();
let seq = 0;
let epoch = 0;
let inputAliveTimer: ReturnType<typeof setInterval> | undefined;
let signalAliveTimer: ReturnType<typeof setInterval> | undefined;
let pointerFrame: number | undefined;
let wheelFrame: number | undefined;
let controlHintTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPointer: { x: number; y: number } | undefined;
let wheelAnchor: { x: number; y: number } | undefined;
let lastPointer = { x: 0, y: 0 };
const wheelPump = new RemoteDesktopWheelPump();
const pressedButtons = new Set<number>();
let clipboardRequested = false;
let clipboardAutoEnableAttempted = false;
let clipboardRequestAutomatic = false;
let negotiationPending = false;
const inputRequested = ref(true);
let inputResumePending = false;
let inputResumeAckTimer: ReturnType<typeof setTimeout> | undefined;
let inputResumeRetryTimer: ReturnType<typeof setTimeout> | undefined;
let inputResumeRetryCount = 0;
let visibilityResumePending = false;
let visibilityResumeRevision: number | undefined;
let inputResumeGeneration = 0;
let closingSession = false;
let transportResolutionRequested = false;
let fallbackMedia: WebSocket | undefined;
let fallbackControl: WebSocket | undefined;
let fallbackSession: DesktopFallbackSession | undefined;
let fallbackGeneration = "";
let fallbackAttempt = 0;
let fallbackReconnectDeadline = 0;
let fallbackPairTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackRetryTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackNegotiationTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackHeadStartTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackUpgradeTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackDecoder: VideoDecoder | undefined;
let fallbackConfig: { codec: string; width: number; height: number; fps: number; bitrate: number } | undefined;
let fallbackDecoderNeedsReset = false;
let fallbackNeedsKeyframe = true;
let fallbackFirstFrame = false;
let fallbackLastKeyframeRequest = 0;
let fallbackLastTimestampUs = 0;
let fallbackProactive = false;
let fallbackUpgradeStartedAt = 0;
let webrtcFrameWatch = 0;
let webrtcUpgradeBaseline: number | undefined;
let webRTCTransportTimer: ReturnType<typeof setTimeout> | undefined;
let webRTCTransportPeer: RTCPeerConnection | undefined;
const fallbackAssembler = new DesktopFallbackFrameAssembler();

type RecentRemoteDesktopFrame = {
  direction: "send" | "receive";
  channel: string;
  type: string;
  sequence?: number;
  bytes: number;
};
const recentRemoteDesktopFrames: RecentRemoteDesktopFrame[] = [];
const RECENT_REMOTE_DESKTOP_FRAME_LIMIT = 20;

function rememberRemoteDesktopFrame(frame: RecentRemoteDesktopFrame) {
  recentRemoteDesktopFrames.push(frame);
  if (recentRemoteDesktopFrames.length > RECENT_REMOTE_DESKTOP_FRAME_LIMIT) {
    recentRemoteDesktopFrames.splice(0, recentRemoteDesktopFrames.length - RECENT_REMOTE_DESKTOP_FRAME_LIMIT);
  }
}

function recentRemoteDesktopFrameSummary() {
  return recentRemoteDesktopFrames.map((frame) => {
    const sequence = frame.sequence === undefined ? "" : `#${frame.sequence}`;
    return `${frame.direction}:${frame.channel}:${frame.type}${sequence}:${frame.bytes}B`;
  }).join(" | ");
}

const remoteDesktopDiagnostics = createRemoteDesktopDiagnostics({
  enabled: () => controlPlaneSettings.data.value?.diagnosticLogs === true,
  context: () => ({
    instanceId: props.instanceId,
    viewerSessionId: session.value?.snapshot.viewerSessionId,
    sessionRevision: snapshot.value?.sessionRevision,
    controlRevision: snapshot.value?.controlRevision,
    phase: snapshot.value?.phase,
    surfaceTransport: snapshot.value?.transport,
    fallback: fallbackState.value,
    fallbackReason: fallbackReason.value,
    transportUpgrading: transportUpgrading.value,
    signalingReady: signalingReady.value,
    iceState: connectionState.value,
    inputEnabled: inputEnabled.value,
    inputRequested: inputRequested.value,
    controller: isController.value,
    hasController: hasController.value,
    viewerCount: viewerCount.value,
    inputEpoch: epoch,
    sentSequence: seq,
  }),
});

function recordRemoteDesktopDiagnostic(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}, error?: unknown) {
  remoteDesktopDiagnostics.record(event, {
    ...fields,
    ...(error === undefined ? {} : remoteDesktopErrorFields(error)),
    recentFrames: recentRemoteDesktopFrameSummary() || undefined,
  });
}

function remoteDesktopParseErrorFields(error: unknown) {
  const fields = remoteDesktopErrorFields(error);
  return {
    parserErrorName: fields.name,
    parserErrorStack: fields.stack,
  };
}

const FALLBACK_HEAD_START_MS = 500;
const FALLBACK_UPGRADE_RETRY_MS = 500;
const FALLBACK_UPGRADE_TIMEOUT_MS = 5_000;

const fallbackActive = computed(() => fallbackState.value === "active");
const fallbackSwitching = computed(() => fallbackState.value === "switching" || fallbackState.value === "reconnecting" || transportUpgrading.value);
const enabledTransportCount = computed(() => CONNECTION_METHOD_KEYS.filter((key) => transportAvailability.value[key]).length);
const webRTCTransportEnabled = computed(() => activeTransportAvailability.value.p2p || activeTransportAvailability.value.turn);
const websocketTransportEnabled = computed(() => activeTransportAvailability.value.websocket);
const transportPolicyDirty = computed(() => CONNECTION_METHOD_KEYS.some((key) => transportAvailability.value[key] !== activeTransportAvailability.value[key]));
const connectionMethodsSummary = computed(() => t("instances.remoteDesktop.connectionMethodsSummary", {
  enabled: enabledTransportCount.value,
  total: CONNECTION_METHOD_KEYS.length,
}));
const connectionMethodOptions = computed(() => {
  const options: { key: ConnectionMethodKey; label: string; activeDetail: string }[] = [
    {
      key: "p2p",
      label: t("instances.remoteDesktop.transportP2p"),
      activeDetail: t("instances.remoteDesktop.connectionMethodP2pDetail"),
    },
    {
      key: "websocket",
      label: t("instances.remoteDesktop.transportWebSocket"),
      activeDetail: t("instances.remoteDesktop.connectionMethodWebSocketDetail"),
    },
    {
      key: "turn",
      label: t("instances.remoteDesktop.transportRelay"),
      activeDetail: t("instances.remoteDesktop.connectionMethodTurnDetail"),
    },
  ];
  return options.map((option) => {
    const enabled = transportAvailability.value[option.key];
    const onlyRemaining = enabled && enabledTransportCount.value === 1;
    return {
      ...option,
      enabled,
      detail: enabled ? option.activeDetail : t("instances.remoteDesktop.connectionMethodDisabled"),
      disabled: fallbackSwitching.value || transportPolicyReconnecting.value || onlyRemaining,
      disabledReason: onlyRemaining ? t("instances.remoteDesktop.connectionMethodsAtLeastOne") : undefined,
    };
  });
});
const switchingOverlayTitle = computed(() => transportPolicyReconnecting.value
  ? t("instances.remoteDesktop.applyingConnectionMethods")
  : t("instances.remoteDesktop.switchingScope"));
const switchingOverlayHint = computed(() => transportPolicyReconnecting.value
  ? t("instances.remoteDesktop.applyingConnectionMethodsHint")
  : t("instances.remoteDesktop.switchScopeHint"));
const fallbackModeHint = computed(() => fallbackReason.value === "ice-failed"
  ? t("instances.remoteDesktop.fallbackAfterIceFailure")
  : fallbackReason.value === "recovery-timeout"
    ? t("instances.remoteDesktop.fallbackAfterTimeout")
    : t("instances.remoteDesktop.transportWebSocketActive"));
const webRTCCandidateDetail = computed(() => {
  const pair = webRTCCandidatePair.value;
  if (!pair) return "";
  return t("instances.remoteDesktop.transportCandidateDetail", {
    protocol: (pair.protocol || "unknown").toUpperCase(),
    local: candidateTypeLabel(pair.localCandidateType || "unknown"),
    remote: candidateTypeLabel(pair.remoteCandidateType || "unknown"),
  });
});
const webRTCLatencyDetail = computed(() => webRTCCandidatePair.value?.latencyMs === undefined
  ? ""
  : t("instances.remoteDesktop.transportLatency", { value: webRTCCandidatePair.value.latencyMs }));
const activeWebRTCDetail = computed(() => [webRTCCandidateDetail.value, webRTCLatencyDetail.value].filter(Boolean).join(" · "));
const transportIndicators = computed(() => {
  const fallbackConnecting = fallbackState.value === "switching" || fallbackState.value === "reconnecting";
  const fallbackSelected = fallbackActive.value || fallbackConnecting || transportUpgrading.value;
  const peerConnected = webrtcPeerConnected.value;
  const peerFailed = webrtcPeerFailed.value;
  const route = webRTCRoute.value;
  const p2pEnabled = activeTransportAvailability.value.p2p;
  const relayEnabled = activeTransportAvailability.value.turn;
  const websocketEnabled = activeTransportAvailability.value.websocket;
  const peerPending = webRTCTransportEnabled.value
    && Boolean(session.value)
    && !peerConnected
    && fallbackState.value === "idle"
    && connectionState.value !== "failed"
    && connectionState.value !== "closed";
  const p2pState: TransportPathState = !p2pEnabled
    ? "idle"
    : fallbackState.value === "idle" && peerConnected && route === "p2p"
      ? "active"
      : peerFailed && route !== "relay"
        ? "failed"
        : peerPending || (fallbackSelected && (!peerConnected || route !== "relay"))
          ? "pending"
          : "idle";
  const relayState: TransportPathState = !relayEnabled
    ? "idle"
    : fallbackState.value === "idle" && peerConnected && route === "relay"
      ? "active"
      : peerFailed && route === "relay"
        ? "failed"
        : fallbackSelected && peerConnected && route === "relay"
          ? "pending"
          : "idle";
  const websocketState: TransportPathState = !websocketEnabled
    ? "idle"
    : fallbackActive.value
      ? "active"
      : fallbackConnecting || transportUpgrading.value
        ? "pending"
        : "idle";
  return [
    {
      key: "p2p",
      label: t("instances.remoteDesktop.transportP2p"),
      icon: Cable,
      state: p2pState,
      status: transportStateLabel(p2pState),
      detail: p2pState === "failed"
        ? t("instances.remoteDesktop.transportP2pFailed")
        : p2pState === "active"
          ? activeWebRTCDetail.value || t("instances.remoteDesktop.transportP2pActive")
          : p2pState === "pending"
            ? peerConnected
              ? t("instances.remoteDesktop.transportP2pSwitching")
              : t("instances.remoteDesktop.transportP2pConnecting")
            : t("instances.remoteDesktop.transportP2pIdle"),
    },
    {
      key: "websocket",
      label: t("instances.remoteDesktop.transportWebSocket"),
      icon: Radio,
      state: websocketState,
      status: transportStateLabel(websocketState),
      detail: websocketState === "active"
        ? fallbackModeHint.value
        : websocketState === "pending"
          ? t("instances.remoteDesktop.fallbackSwitchingHint")
          : t("instances.remoteDesktop.transportWebSocketIdle"),
    },
    {
      key: "relay",
      label: t("instances.remoteDesktop.transportRelay"),
      icon: Waypoints,
      state: relayState,
      status: transportStateLabel(relayState),
      detail: relayState === "failed"
        ? t("instances.remoteDesktop.transportRelayFailed")
        : relayState === "active"
          ? activeWebRTCDetail.value || t("instances.remoteDesktop.transportRelayActive")
          : relayState === "pending"
            ? t("instances.remoteDesktop.transportRelaySwitching")
            : t("instances.remoteDesktop.transportRelayIdle"),
    },
  ];
});
const usedTransportKeys = ref<Set<string>>(new Set());
watch(transportIndicators, indicators => {
  const active = indicators.filter(indicator => indicator.state === "active");
  if (!active.length) return;
  const next = new Set(usedTransportKeys.value);
  for (const indicator of active) next.add(indicator.key);
  if (next.size !== usedTransportKeys.value.size) usedTransportKeys.value = next;
}, { immediate: true });
const visibleTransportIndicators = computed(() => transportIndicators.value.filter(indicator =>
  indicator.state !== "failed" && (indicator.state === "active" || usedTransportKeys.value.has(indicator.key)),
));
const failedTransportIndicators = computed(() => transportIndicators.value.filter(indicator => indicator.state === "failed"));
const establishingTitle = computed(() => fallbackState.value === "switching"
  ? t("instances.remoteDesktop.switchingFallback")
  : fallbackState.value === "reconnecting"
    ? t("instances.remoteDesktop.reconnectingFallback")
    : t("instances.remoteDesktop.establishing"));
const establishingHint = computed(() => fallbackSwitching.value
  ? t("instances.remoteDesktop.fallbackSwitchingHint")
  : t("instances.remoteDesktop.establishingHint"));

const selectedSource = computed(() => {
  if (!target.value.sourceRef) return undefined;
  return sources.value.find(source => source.kind === target.value.kind && source.sourceRef === target.value.sourceRef);
});

const filteredSources = computed(() => {
  const query = sourceQuery.value.trim().toLocaleLowerCase();
  if (!query) return sources.value;
  return sources.value.filter((item) => `${item.subtitle ?? ""} ${item.title} ${item.kind}`.toLocaleLowerCase().includes(query));
});
const targetSources = computed(() => filteredSources.value.filter(source => source.kind === target.value.kind));
const sourceGroups = computed(() => {
  const groups = new Map<string, RemoteDesktopSource[]>();
  for (const source of sources.value) {
    const group = groups.get(source.kind) ?? [];
    group.push(source);
    groups.set(source.kind, group);
  }
  return [...groups.entries()].map(([kind, items]) => ({ kind, items }));
});
const sourceCountLabel = computed(() => t("instances.remoteDesktop.sourceCount", { count: filteredSources.value.length }));
const systemCursor = computed(() => remote.value?.capture.cursor === false);
function sourceKindLabel(kind: string) {
  if (kind === "display") return t("instances.remoteDesktop.entireDesktop");
  if (kind === "window") return t("instances.remoteDesktop.singleWindow");
  if (kind === "application") return t("instances.remoteDesktop.applicationSource");
  if (kind === "region") return t("instances.remoteDesktop.regionSource");
  return kind;
}
function sourceKindDescription(kind: string) {
  if (kind === "display") return t("instances.remoteDesktop.entireDesktopDescription");
  if (kind === "window") return t("instances.remoteDesktop.singleWindowDescription");
  if (kind === "application") return t("instances.remoteDesktop.applicationSourceDescription");
  if (kind === "region") return t("instances.remoteDesktop.regionSourceDescription");
  return t("instances.remoteDesktop.sourceDescription");
}
function sourcePrimaryText(source: RemoteDesktopSource) {
  return source.title || sourceKindLabel(source.kind);
}
function sourceSecondaryText(source: RemoteDesktopSource) {
  return source.subtitle ?? "";
}
function sourceIcon(kind: string) {
  if (kind === "display") return Monitor;
  if (kind === "window") return AppWindow;
  return ScreenShare;
}
const selectedTargetTitle = computed(() => {
  if (selectedSource.value) return sourcePrimaryText(selectedSource.value);
  return sourceKindLabel(target.value.kind);
});
const selectedTargetDetail = computed(() => {
  const item = selectedSource.value;
  if (!item) return t("instances.remoteDesktop.selectSource");
  return [sourceSecondaryText(item), `${item.width} × ${item.height}`].filter(Boolean).join(" · ");
});
const capabilityChips = computed(() => {
  const values: string[] = [];
  const video = remote.value?.video;
  if (video?.maxWidth && video.maxHeight) values.push(t("instances.remoteDesktop.maxQuality", { width: video.maxWidth, height: video.maxHeight }));
  if (video?.maxFrameRate) values.push(t("instances.remoteDesktop.frameRate", { count: video.maxFrameRate }));
  const input = remote.value?.features;
  const inputs = [input?.keyboard ? t("instances.remoteDesktop.keyboard") : "", input?.mouse ? t("instances.remoteDesktop.mouse") : ""].filter(Boolean);
  if (inputs.length) values.push(inputs.join(" · "));
  return values;
});
const transportResolutionOptions = computed(() => {
  const maxWidth = remote.value?.video.maxWidth ?? 0;
  const maxHeight = remote.value?.video.maxHeight ?? 0;
  return [
    { value: "auto" as const, label: t("instances.remoteDesktop.autoResolution"), detail: t("instances.remoteDesktop.autoResolutionDetail"), width: null, height: null },
    ...TRANSPORT_RESOLUTION_PRESETS
      .filter((option) => maxWidth <= 0 || maxHeight <= 0 || (option.width <= maxWidth && option.height <= maxHeight))
      .map((option) => ({ ...option, label: option.value, detail: `${option.width} × ${option.height}` })),
  ];
});
const transportResolutionLabel = computed(() => {
  return transportResolutionOptions.value.find((option) => option.value === transportResolution.value)?.label
    ?? t("instances.remoteDesktop.autoResolution");
});
const transportFrameRateOptions = computed(() => {
  const maxFrameRate = remote.value?.video.maxFrameRate ?? 0;
  return [
    { value: "auto" as const, label: t("instances.remoteDesktop.autoFrameRate"), detail: t("instances.remoteDesktop.autoFrameRateDetail"), frameRate: null },
    ...TRANSPORT_FRAME_RATE_PRESETS
      .filter((frameRate) => maxFrameRate <= 0 || frameRate <= maxFrameRate)
      .map((frameRate) => ({
        value: String(frameRate) as TransportFrameRateValue,
        label: t("instances.remoteDesktop.frameRate", { count: frameRate }),
        detail: t("instances.remoteDesktop.frameRateLimit", { count: frameRate }),
        frameRate,
      })),
  ];
});
const transportFrameRateLabel = computed(() => {
  return transportFrameRateOptions.value.find((option) => option.value === transportFrameRate.value)?.label
    ?? t("instances.remoteDesktop.autoFrameRate");
});
const transportQualityLabel = computed(() => `${transportResolutionLabel.value} · ${transportFrameRateLabel.value}`);
const selectedCaptureSelection = computed<DesktopCaptureSelection | undefined>(() => {
  return target.value.sourceRef ? { sourceRef: target.value.sourceRef } : undefined;
});
const canConnect = computed(() => Boolean(selectedCaptureSelection.value));
const connectionTone = computed(() => {
  if (!session.value) return "neutral";
  if (fallbackState.value === "active") return "active";
  if (fallbackSwitching.value) return "warning";
  if (fallbackState.value === "failed") return "danger";
  if (connectionState.value === "connected" || connectionState.value === "completed") return "active";
  if (connectionState.value === "failed" || connectionState.value === "closed") return "danger";
  return "warning";
});
const connectionLabel = computed(() => {
  if (!session.value) return "";
  if (fallbackState.value === "active") return t("instances.remoteDesktop.connected");
  if (fallbackState.value === "switching") return t("instances.remoteDesktop.switchingFallback");
  if (fallbackState.value === "reconnecting") return t("instances.remoteDesktop.reconnectingFallback");
  if (fallbackState.value === "failed") return t("instances.remoteDesktop.failed");
  if (connectionState.value === "connected" || connectionState.value === "completed") return t("instances.remoteDesktop.connected");
  if (connectionState.value === "failed") return t("instances.remoteDesktop.failed");
  if (connectionState.value === "closed") return t("instances.remoteDesktop.closed");
  if (connectionState.value === "disconnected") return t("instances.remoteDesktop.reconnecting");
  return t("instances.remoteDesktop.connectingStatus");
});
const isController = computed(() => snapshot.value?.isController !== false);
const hasController = computed(() => snapshot.value?.hasController !== false);
const viewerCount = computed(() => snapshot.value?.viewerCount ?? 1);
const inputActionLabel = computed(() => {
  if (inputEnabled.value) return t("instances.remoteDesktop.inputActive");
  if (!isController.value) {
    return controlRequestPending.value
      ? t("instances.remoteDesktop.requestingControl")
      : t("instances.remoteDesktop.requestControl");
  }
  return t("instances.remoteDesktop.enableInput");
});
const inputActionTitle = computed(() => {
  if (!signalingReady.value) return t("instances.remoteDesktop.establishing");
  if (inputEnabled.value) return t("instances.remoteDesktop.inputActive");
  return inputActionLabel.value;
});
const formatTime = (value: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const sessionDeadline = computed(() => snapshot.value ? t("instances.remoteDesktop.sessionEnds", { time: formatTime(snapshot.value.sessionExpiresAt) }) : "");
const idleDeadline = computed(() => snapshot.value?.idleExpiresAt ? t("instances.remoteDesktop.idleEnds", { time: formatTime(snapshot.value.idleExpiresAt) }) : "");

type WireChannel = RTCDataChannel | WebSocket;

function wireOpen(channel: WireChannel | undefined): channel is WireChannel {
  if (!channel) return false;
  return typeof channel.readyState === "number"
    ? channel.readyState === WebSocket.OPEN
    : channel.readyState === "open";
}

function fallbackControlChannel() {
  return fallbackState.value === "active" && wireOpen(fallbackControl) ? fallbackControl : undefined;
}

function controlChannel(): WireChannel | undefined {
  const fallback = fallbackControlChannel();
  if (fallback) return fallback;
  const channel = channels.get("control");
  return wireOpen(channel) ? channel : undefined;
}

function outputChannel(name: string): WireChannel | undefined {
  const fallback = fallbackControlChannel();
  if (fallback) return fallback;
  const channel = channels.get(name);
  return wireOpen(channel) ? channel : undefined;
}

function wireChannelName(channel: WireChannel) {
  if (channel === ws) return "signal";
  if (channel === fallbackControl) return "fallback-control";
  if (channel === fallbackMedia) return "fallback-media";
  for (const [name, candidate] of channels) if (candidate === channel) return name;
  return typeof (channel as RTCDataChannel).label === "string" ? (channel as RTCDataChannel).label : "unknown";
}

function tracedWireChannel(channel: WireChannel) {
  return ["control", "fallback-control", "clipboard", "signal"].includes(wireChannelName(channel));
}

function wire(channel: WireChannel, type: string, payload: unknown = {}, maxBytes = REMOTE_DESKTOP_MAX_MESSAGE_BYTES) {
  const channelName = wireChannelName(channel);
  const traced = tracedWireChannel(channel);
  if (!wireOpen(channel)) {
    if (traced) recordRemoteDesktopDiagnostic("wire.reject", { channel: channelName, wireType: type, reason: "closed", nextSequence: seq + 1 });
    return false;
  }
  const nextSeq = seq + 1;
  let encoded: string;
  try {
    encoded = JSON.stringify({ v: REMOTE_DESKTOP_CHANNEL_VERSION, seq: nextSeq, type, payload });
  } catch (reason) {
    if (traced) recordRemoteDesktopDiagnostic("wire.reject", { channel: channelName, wireType: type, reason: "encode", nextSequence: nextSeq }, reason);
    return false;
  }
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > maxBytes) {
    if (traced) recordRemoteDesktopDiagnostic("wire.reject", { channel: channelName, wireType: type, reason: "size", nextSequence: nextSeq, bytes, maxBytes });
    return false;
  }
  try {
    channel.send(encoded);
  } catch (reason) {
    if (traced) recordRemoteDesktopDiagnostic("wire.reject", { channel: channelName, wireType: type, reason: "send", nextSequence: nextSeq, bytes }, reason);
    return false;
  }
  seq = nextSeq;
  if (traced) {
    rememberRemoteDesktopFrame({ direction: "send", channel: channelName, type, sequence: nextSeq, bytes });
    if (type !== "input.alive") {
      recordRemoteDesktopDiagnostic("wire.send", { channel: channelName, wireType: type, wireSequence: nextSeq, bytes });
    }
  }
  return true;
}

function send(type: string, payload: unknown, channelName = "input") {
  const channel = outputChannel(channelName);
  return channel ? wire(channel, type, payload) : false;
}

async function loadSources() {
  if (!hasSourceProvider.value || sourcesLoading.value) return;
  sourcesLoading.value = true;
  sourcesError.value = "";
  try {
    const previousRef = target.value.sourceRef;
    const previousSelection = selectedSourceInfo.value;
    sources.value = (await listRemoteDesktopSources(props.instanceId)).sources;
    const resolved = resolveRefreshedSource(sources.value, previousRef, previousSelection);
    if (resolved) {
      target.value = { kind: resolved.kind, sourceRef: resolved.sourceRef };
      selectedSourceInfo.value = toSelectedSourceIdentity(resolved);
      return;
    }
    if (!previousRef && !previousSelection) {
      const first = sources.value.find(source => source.kind === target.value.kind && source.capturable)
        ?? sources.value.find(source => source.capturable);
      if (first) {
        target.value = { kind: first.kind, sourceRef: first.sourceRef };
        selectedSourceInfo.value = toSelectedSourceIdentity(first);
      }
      return;
    }
    if (!session.value) {
      target.value = { kind: target.value.kind };
      selectedSourceInfo.value = undefined;
    }
  } catch (reason) {
    sourcesError.value = translateApiError(reason, t, t("instances.remoteDesktop.openFailed"));
  } finally {
    sourcesLoading.value = false;
  }
}

function chooseSourceKind(kind: string) {
  const first = sources.value.find(source => source.kind === kind && source.capturable);
  target.value = { kind, ...(first ? { sourceRef: first.sourceRef } : {}) };
  selectedSourceInfo.value = first ? toSelectedSourceIdentity(first) : undefined;
  if (!sources.value.length) void loadSources();
}

function selectSource(item: RemoteDesktopSource) {
  if (!item.capturable) return;
  target.value = { kind: item.kind, sourceRef: item.sourceRef };
  selectedSourceInfo.value = toSelectedSourceIdentity(item);
}

function sameTarget(left: TargetSelection, right: TargetSelection) {
  return left.kind === right.kind && left.sourceRef === right.sourceRef;
}

function prepareScopeMenu() {
  if (hasSourceProvider.value) void loadSources();
}

async function switchScope(next: TargetSelection, nextSource?: RemoteDesktopSource) {
  scopeMenuOpen.value = false;
  if (switchingScope.value || sameTarget(next, target.value)) {
    if (nextSource) {
      target.value = { kind: nextSource.kind, sourceRef: nextSource.sourceRef };
      selectedSourceInfo.value = toSelectedSourceIdentity(nextSource);
    }
    return;
  }
  if (!session.value) {
    target.value = next;
    selectedSourceInfo.value = nextSource ? toSelectedSourceIdentity(nextSource) : selectedSourceInfo.value;
    return;
  }
  switchingScope.value = true;
  try {
    if (!(await closeCurrentSession())) return;
    target.value = next;
    selectedSourceInfo.value = nextSource ? toSelectedSourceIdentity(nextSource) : selectedSourceInfo.value;
    await connect();
  } finally {
    switchingScope.value = false;
  }
}

function selectScopeSource(item: RemoteDesktopSource) {
  if (!item.capturable) return;
  void switchScope({ kind: item.kind, sourceRef: item.sourceRef }, item);
}

async function connect() {
  if (!signalTransportReady) {
    error.value = t("instances.remoteDesktop.secureTransportHint");
    return;
  }
  if (!canConnect.value || connecting.value) return;
  activeTransportAvailability.value = { ...transportAvailability.value };
  connecting.value = true;
  error.value = "";
  sourceQuery.value = "";
  clipboard.value = false;
  clipboardRequested = false;
  clipboardAutoEnableAttempted = false;
  clipboardRequestAutomatic = false;
  clipboardBusy.value = false;
  clipboardStatus.value = "";
  streamReady.value = false;
  signalingReady.value = false;
  inputRequested.value = true;
  inputResumeGeneration += 1;
  inputResumePending = false;
  clearInputResumeTimers();
  inputResumeRetryCount = 0;
  controlRequestPending.value = false;
  usedTransportKeys.value = new Set();
  resetFallbackRuntime();
  scopeMenuOpen.value = false;
  try {
    if (!sources.value.length) await loadSources();
    const captureSelection = selectedCaptureSelection.value;
    if (!captureSelection) return;
    const created = await createRemoteDesktopSession(props.instanceId, captureSelection);
    session.value = created;
    const socket = new WebSocket(new URL(created.signalUrl, window.location.href), REMOTE_DESKTOP_SIGNAL_SUBPROTOCOL);
    ws = socket;
    socket.binaryType = "arraybuffer";
    socket.onmessage = event => { if (ws === socket) void message(event); };
    socket.onopen = () => {
      if (ws !== socket) return;
      signalingReady.value = false;
      recordRemoteDesktopDiagnostic("signal.open");
    };
    socket.onerror = () => {
      if (ws !== socket) return;
      recordRemoteDesktopDiagnostic("signal.error", { reason: "websocket-error" });
      error.value = t("instances.remoteDesktop.signalingFailed");
    };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      recordRemoteDesktopDiagnostic("signal.close", { closeCode: event.code, closeReason: event.reason.slice(0, 200), clean: event.wasClean, closingSession });
      const closedSession = session.value;
      if (!closedSession) return;
      if (closingSession) {
        cleanup();
        return;
      }
      const message = error.value || t("instances.remoteDesktop.closed");
      stopSignalAlive();
      stopInputAlive();
      signalingReady.value = false;
      connectionState.value = "closed";
      clipboardBusy.value = false;
      clipboardRequested = false;
      void stopRemoteDesktopSession(props.instanceId, closedSession.snapshot.viewerSessionId).catch(() => undefined);
      cleanup();
      error.value = message;
    };
  } catch (reason) {
    recordRemoteDesktopDiagnostic("session.open.failed", {}, reason);
    error.value = translateApiError(reason, t, t("instances.remoteDesktop.openFailed"));
    session.value = undefined;
  } finally {
    connecting.value = false;
  }
}

function setConnectionMethodEnabled(key: ConnectionMethodKey, enabled: boolean) {
  if (transportAvailability.value[key] === enabled) return;
  if (!enabled && enabledTransportCount.value <= 1) return;
  transportAvailability.value = { ...transportAvailability.value, [key]: enabled };
}

async function applyConnectionMethods() {
  if (!session.value || !transportPolicyDirty.value || transportPolicyReconnecting.value) return;
  transportPolicyReconnecting.value = true;
  try {
    if (!(await closeCurrentSession())) return;
    await connect();
  } finally {
    transportPolicyReconnecting.value = false;
  }
}

function messageByteLength(event: MessageEvent) {
  if (typeof event.data === "string") return new TextEncoder().encode(event.data).byteLength;
  if (event.data instanceof ArrayBuffer) return event.data.byteLength;
  if (typeof Blob !== "undefined" && event.data instanceof Blob) return event.data.size;
  return undefined;
}

async function message(event: MessageEvent) {
  const dataKind = typeof event.data === "string" ? "text" : event.data instanceof ArrayBuffer ? "arraybuffer" : typeof event.data;
  const bytes = messageByteLength(event);
  let signalType = "unparsed";
  try {
    const value = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
    signalType = typeof value?.type === "string" ? value.type : "unknown";
    rememberRemoteDesktopFrame({ direction: "receive", channel: "signal", type: signalType, sequence: typeof value?.seq === "number" ? value.seq : undefined, bytes: bytes ?? 0 });
    if (value.type === "snapshot") {
      const next = DesktopSessionSnapshotSchema.parse(value.snapshot);
      const previousTransport = snapshot.value?.transport;
      snapshot.value = next;
      if (snapshot.value.phase === "stopped" || snapshot.value.phase === "failed") {
        error.value = translateApiError({ code: snapshot.value.reason }, t, t("instances.remoteDesktop.closed"));
        cleanup();
        return;
      }
      if (!next.isController) {
        visibilityResumePending = false;
        visibilityResumeRevision = undefined;
        releaseInputState();
        controlRequestPending.value = false;
      }
      if (next.isController && controlRequestPending.value) {
        controlRequestPending.value = false;
        inputRequested.value = true;
        resumeWanted();
      }
      if (
        visibilityResumePending
        && next.phase === "active"
        && !next.mediaPaused
        && (visibilityResumeRevision === undefined || next.sessionRevision > visibilityResumeRevision)
      ) {
        visibilityResumePending = false;
        visibilityResumeRevision = undefined;
        resumeWanted();
      }
      resumeWanted();
      enableClipboardByDefault();
      if (
        next.transport === "webrtc"
        && fallbackState.value !== "idle"
        && (previousTransport === "websocket-fallback" || transportUpgrading.value)
      ) commitTransportUpgrade();
      if (!pc && fallbackState.value === "idle" && webRTCTransportEnabled.value) await setupPeer();
    } else if (value.type === "configureIce") {
      if (!pc) return;
      await pc.setConfiguration(iceConfiguration(value.iceServers));
    } else if (value.type === "answer" && pc) {
      await pc.setRemoteDescription({ type: "answer", sdp: value.sdp });
    } else if (value.type === "ready") {
      signalingReady.value = true;
      startSignalAlive();
      applyTransportResolution();
      enableClipboardByDefault();
      if (!pc && fallbackState.value === "idle") {
        if (!webRTCTransportEnabled.value) {
          void beginFallback("ice-failed", "REMOTE_DESKTOP_ALL_WEBRTC_TRANSPORTS_DISABLED");
          return;
        }
        await setupPeer();
      }
      if (pc && !pc.localDescription) await startOffer(false);
    } else if (value.type === "iceConfiguration" && pc) {
      await pc.setConfiguration(iceConfiguration(value.iceServers));
      awaitingRestart = true;
      await startOffer(true);
    } else if (value.type === "iceRenewed" && pc) {
      await pc.setConfiguration(iceConfiguration(value.iceServers));
    } else if (value.type === "error") {
      const code = typeof value.code === "string" ? value.code : "REMOTE_DESKTOP_SIGNAL_INVALID";
      recordRemoteDesktopDiagnostic("signal.error", { signalCode: code, fallbackState: fallbackState.value, iceState: pc?.iceConnectionState });
      if (fallbackState.value !== "idle" && [
        "REMOTE_DESKTOP_NEGOTIATION_FAILED",
        "REMOTE_DESKTOP_ICE_CONFIG_INVALID",
        "REMOTE_DESKTOP_CANDIDATE_INVALID",
      ].includes(code)) return;
      error.value = translateApiError({ code }, t, t("instances.remoteDesktop.messageInvalid"));
      const iceState = pc?.iceConnectionState;
      if (fallbackState.value === "idle" && session.value && !closingSession && iceState !== "connected" && iceState !== "completed") {
        void beginFallback("recovery-timeout", code);
      }
    } else {
      recordRemoteDesktopDiagnostic("signal.message.unknown", { signalType, bytes });
    }
  } catch (reason) {
    recordRemoteDesktopDiagnostic("signal.message.failed", { dataKind, bytes, signalType, ...remoteDesktopParseErrorFields(reason) });
    error.value = translateApiError(reason, t, t("instances.remoteDesktop.messageInvalid"));
  }
}

async function startOffer(iceRestart: boolean) {
  if (!pc || negotiationPending || pc.signalingState === "closed") return;
  negotiationPending = true;
  try {
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    ws?.send(JSON.stringify({ type: "offer", requestId: createBrowserUuid(), sdp: offer.sdp }));
    if (!iceRestart) {
      armFallbackHeadStart();
      armNegotiationTimeout();
    }
  } finally {
    negotiationPending = false;
  }
}

function iceConfiguration(iceServers: RTCIceServer[] = []): RTCConfiguration {
  const filtered = iceServers.flatMap((server) => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => {
      const relay = /^turns?:/i.test(url);
      return relay ? activeTransportAvailability.value.turn : activeTransportAvailability.value.p2p;
    });
    return urls.length ? [{ ...server, urls }] : [];
  });
  return {
    iceServers: filtered,
    iceTransportPolicy: activeTransportAvailability.value.p2p ? "all" : "relay",
  };
}

async function setupPeer() {
  const peer = new RTCPeerConnection(iceConfiguration());
  const socket = ws;
  pc = peer;
  webrtcPeerFailed.value = false;
  webRTCRoute.value = "unknown";
  webRTCCandidatePair.value = undefined;
  peer.addTransceiver("video", { direction: "recvonly" });
  for (const [label, id] of [["control", 0], ["input", 1], ["pointer", 2], ["clipboard", 3]] as const) {
    const options: RTCDataChannelInit = { negotiated: true, id, ordered: label !== "pointer" };
    if (label === "pointer") options.maxRetransmits = 0;
    const channel = peer.createDataChannel(label, options);
    channels.set(label, channel);
    channel.onclose = () => recordRemoteDesktopDiagnostic("channel.close", { channel: label, readyState: channel.readyState });
    channel.onerror = (event) => recordRemoteDesktopDiagnostic(
      "channel.error",
      { channel: label, readyState: channel.readyState },
      (event as Event & { error?: unknown }).error,
    );
    if (label === "control") {
      channel.onmessage = controlMessage;
      channel.onopen = () => {
        recordRemoteDesktopDiagnostic("channel.open", { channel: label, readyState: channel.readyState });
        sendVisibility();
        applyTransportResolution();
        resumeWanted();
        enableClipboardByDefault();
      };
    } else {
      channel.onopen = () => recordRemoteDesktopDiagnostic("channel.open", { channel: label, readyState: channel.readyState });
    }
    if (label === "clipboard") channel.onmessage = clipboardMessage;
  }
  peer.ontrack = (event) => {
    const element = video.value;
    if (!element) return;
    element.srcObject = event.streams[0];
    void element.play().catch(() => undefined);
  };
  peer.oniceconnectionstatechange = () => {
    if (pc !== peer) return;
    connectionState.value = peer.iceConnectionState;
    webrtcPeerConnected.value = peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed";
    webrtcPeerFailed.value = peer.iceConnectionState === "failed";
    recordRemoteDesktopDiagnostic("peer.ice.state", { iceState: peer.iceConnectionState, connectionState: peer.connectionState, fallbackState: fallbackState.value });
    if (awaitingRestart && (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed")) {
      awaitingRestart = false;
      ws?.send(JSON.stringify({ type: "iceRestarted", requestId: createBrowserUuid() }));
    }
    if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
      clearFallbackHeadStart();
      clearRecoveryTimer();
      clearNegotiationTimer();
      startWebRTCTransportWatch(peer);
      void startWebRTCUpgradeWatch(peer);
    } else if (peer.iceConnectionState === "failed") {
      void beginFallback("ice-failed", "REMOTE_DESKTOP_ICE_FAILED");
    } else if (peer.iceConnectionState === "disconnected") {
      armRecoveryTimer();
    }
  };
  peer.onconnectionstatechange = () => {
    if (pc !== peer) return;
    connectionState.value = peer.connectionState;
    webrtcPeerConnected.value = peer.connectionState === "connected";
    webrtcPeerFailed.value = peer.connectionState === "failed";
    recordRemoteDesktopDiagnostic("peer.connection.state", { connectionState: peer.connectionState, iceState: peer.iceConnectionState, fallbackState: fallbackState.value });
    if (peer.connectionState === "connected") {
      clearFallbackHeadStart();
      clearRecoveryTimer();
      clearNegotiationTimer();
      startWebRTCTransportWatch(peer);
      void startWebRTCUpgradeWatch(peer);
    } else if (peer.connectionState === "failed") {
      void beginFallback("ice-failed", "REMOTE_DESKTOP_ICE_FAILED");
    }
  };
  peer.onicecandidate = (event) => {
    if (pc !== peer || ws !== socket || !event.candidate || socket.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "candidate",
      requestId: createBrowserUuid(),
      candidate: {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      },
    }));
  };
}

function clearFallbackHeadStart() {
  if (fallbackHeadStartTimer !== undefined) clearTimeout(fallbackHeadStartTimer);
  fallbackHeadStartTimer = undefined;
}

function armFallbackHeadStart() {
  clearFallbackHeadStart();
  if (fallbackState.value !== "idle" || !websocketTransportEnabled.value) return;
  fallbackHeadStartTimer = setTimeout(() => {
    fallbackHeadStartTimer = undefined;
    if (!pc || fallbackState.value !== "idle" || surfacePaused()) return;
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed" || pc.connectionState === "connected") return;
    void beginFallback("recovery-timeout", "REMOTE_DESKTOP_ICE_HEAD_START", true);
  }, FALLBACK_HEAD_START_MS);
}

function armNegotiationTimeout() {
  clearNegotiationTimer();
  if (fallbackState.value !== "idle") return;
  fallbackNegotiationTimer = setTimeout(() => {
    fallbackNegotiationTimer = undefined;
    if (!pc || fallbackState.value !== "idle" || surfacePaused()) return;
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") return;
    void beginFallback("recovery-timeout", "REMOTE_DESKTOP_ICE_TIMEOUT");
  }, 15_000);
}

function clearNegotiationTimer() {
  if (fallbackNegotiationTimer !== undefined) clearTimeout(fallbackNegotiationTimer);
  fallbackNegotiationTimer = undefined;
}

function armRecoveryTimer() {
  if (fallbackState.value !== "idle" || fallbackRecoveryTimer !== undefined) return;
  fallbackRecoveryTimer = setTimeout(() => {
    fallbackRecoveryTimer = undefined;
    if (!pc || fallbackState.value !== "idle" || surfacePaused()) return;
    if (pc.iceConnectionState === "disconnected") {
      void beginFallback("recovery-timeout", "REMOTE_DESKTOP_ICE_RECOVERY_TIMEOUT");
    }
  }, 15_000);
}

function clearRecoveryTimer() {
  if (fallbackRecoveryTimer !== undefined) clearTimeout(fallbackRecoveryTimer);
  fallbackRecoveryTimer = undefined;
}

function transportStateLabel(state: TransportPathState) {
  if (state === "active") return t("instances.remoteDesktop.transportStateActive");
  if (state === "pending") return t("instances.remoteDesktop.transportStatePending");
  if (state === "failed") return t("instances.remoteDesktop.transportStateFailed");
  return t("instances.remoteDesktop.transportStateIdle");
}

function candidateTypeLabel(type: string) {
  if (type === "host") return t("instances.remoteDesktop.transportCandidateHost");
  if (type === "srflx") return t("instances.remoteDesktop.transportCandidateSrflx");
  if (type === "prflx") return t("instances.remoteDesktop.transportCandidatePrflx");
  if (type === "relay") return t("instances.remoteDesktop.transportCandidateRelay");
  return t("instances.remoteDesktop.transportCandidateUnknown");
}

async function refreshWebRTCTransport(peer: RTCPeerConnection) {
  try {
    const stats = await peer.getStats();
    const diagnostics = parseRemoteDesktopWebRTCStats(stats);
    if (pc !== peer) return;
    if (!diagnostics?.path) {
      webRTCRoute.value = "unknown";
      webRTCCandidatePair.value = undefined;
      return;
    }
    webRTCRoute.value = diagnostics.path === "turn" ? "relay" : "p2p";
    webRTCCandidatePair.value = diagnostics;
  } catch {
    if (pc !== peer) return;
    webRTCRoute.value = "unknown";
    webRTCCandidatePair.value = undefined;
  }
}

function startWebRTCTransportWatch(peer: RTCPeerConnection) {
  if (pc !== peer || webRTCTransportPeer === peer) return;
  stopWebRTCTransportWatch();
  webRTCTransportPeer = peer;
  const poll = async () => {
    if (pc !== peer || webRTCTransportPeer !== peer) return;
    await refreshWebRTCTransport(peer);
    if (pc !== peer || webRTCTransportPeer !== peer) return;
    webRTCTransportTimer = setTimeout(() => void poll(), 2_000);
  };
  void poll();
}

function stopWebRTCTransportWatch() {
  if (webRTCTransportTimer !== undefined) clearTimeout(webRTCTransportTimer);
  webRTCTransportTimer = undefined;
  webRTCTransportPeer = undefined;
}

async function readWebRTCFrames(peer: RTCPeerConnection) {
  let frames = 0;
  try {
    const stats = await peer.getStats();
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && (report as RTCInboundRtpStreamStats).kind === "video") {
        frames = Math.max(frames, Number((report as RTCInboundRtpStreamStats).framesDecoded ?? 0));
      }
    });
  } catch {
    // Metadata fallback below still requires loaded video data.
  }
  return frames;
}

async function startWebRTCUpgradeWatch(peer: RTCPeerConnection) {
  if (pc !== peer || fallbackState.value === "idle") return;
  if (webrtcUpgradeBaseline === undefined) webrtcUpgradeBaseline = await readWebRTCFrames(peer);
  if (pc !== peer || isFallbackIdle()) return;
  watchWebRTCFrame(peer);
}

function isFallbackIdle() {
  return fallbackState.value === "idle";
}

function watchWebRTCFrame(peer: RTCPeerConnection) {
  if (pc !== peer || fallbackState.value === "idle") return;
  const token = ++webrtcFrameWatch;
  const element = video.value;
  const baselineTime = element?.currentTime ?? 0;
  const baselineFrames = webrtcUpgradeBaseline ?? 0;
  const started = performance.now();
  const check = async () => {
    if (token !== webrtcFrameWatch || pc !== peer || fallbackState.value === "idle") return;
    const frames = await readWebRTCFrames(peer);
    const element = video.value;
    const peerConnected = peer.connectionState === "connected"
      || peer.iceConnectionState === "connected"
      || peer.iceConnectionState === "completed";
    const ready = Boolean(element && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && element.videoWidth > 0);
    const progressed = frames > baselineFrames || Boolean(element && element.currentTime > baselineTime + 0.001);
    if (peerConnected && ready && progressed) {
      onWebRTCFrameReady();
      return;
    }
    if (performance.now() - started < 10_000) setTimeout(() => void check(), 100);
  };
  setTimeout(() => void check(), 50);
}

function onWebRTCFrameReady() {
  // Never abandon a fallback request only because WebRTC produced a frame.
  // The request may already have attached and made the component authoritative
  // for the fallback transport. Complete that path, then upgrade atomically.
  if (fallbackState.value === "active") {
    requestTransportUpgrade();
  }
}

async function detectWebCodecs() {
  if (
    typeof window === "undefined"
    || !window.isSecureContext
    || typeof VideoDecoder === "undefined"
    || typeof EncodedVideoChunk === "undefined"
  ) {
    webCodecsSupported.value = false;
    return false;
  }
  try {
    const support = await VideoDecoder.isConfigSupported({
      codec: "avc1.42E028",
      optimizeForLatency: true,
    });
    webCodecsSupported.value = support.supported === true;
  } catch {
    webCodecsSupported.value = false;
  }
  return webCodecsSupported.value === true;
}

async function fallbackUnavailableCode() {
  if (!websocketTransportEnabled.value) return "REMOTE_DESKTOP_FALLBACK_DISABLED";
  const capability = remote.value?.fallback;
  if (!capability?.available) return capability?.reason || "REMOTE_DESKTOP_FALLBACK_UNAVAILABLE";
  if (typeof window === "undefined" || !window.isSecureContext) return "REMOTE_DESKTOP_FALLBACK_SECURE_CONTEXT_REQUIRED";
  if (webCodecsSupported.value === null) await detectWebCodecs();
  if (webCodecsSupported.value !== true) return "REMOTE_DESKTOP_FALLBACK_WEBCODECS_UNSUPPORTED";
  return "";
}

async function beginFallback(reason: "ice-failed" | "recovery-timeout", diagnosticCode?: string, proactive = false) {
  if (!session.value || closingSession || fallbackState.value !== "idle" || surfacePaused()) return;
  clearFallbackHeadStart();
  const unavailable = await fallbackUnavailableCode();
  if (unavailable) {
    // A proactive head start must never turn a missing optional transport into
    // a session failure. The normal 15s negotiation deadline still applies.
    if (!proactive) await failRemoteSession(unavailable);
    return;
  }
  if (!session.value || closingSession || fallbackState.value !== "idle") return;
  webrtcUpgradeBaseline = pc ? await readWebRTCFrames(pc) : 0;
  if (!proactive) {
    clearNegotiationTimer();
    clearRecoveryTimer();
  }
  fallbackState.value = "switching";
  fallbackProactive = proactive;
  fallbackReason.value = reason;
  fallbackAttempt += 1;
  fallbackReconnectDeadline = Date.now() + 15_000;
  fallbackDiagnosticCode = diagnosticCode;
  suspend();
  inputResumePending = false;
  controlRequestPending.value = false;
  clipboardBusy.value = false;
  streamReady.value = false;
  await requestFallbackAttempt(reason, diagnosticCode, fallbackAttempt);
}

let fallbackDiagnosticCode: string | undefined;

async function requestFallbackAttempt(reason: "ice-failed" | "recovery-timeout", diagnosticCode: string | undefined, attempt: number) {
  if (attempt !== fallbackAttempt || !session.value || closingSession) return;
  try {
    const info = await requestRemoteDesktopFallback(
      props.instanceId,
      session.value.snapshot.viewerSessionId,
      reason,
      diagnosticCode,
    );
    if (attempt !== fallbackAttempt || !session.value || closingSession) return;
    fallbackSession = info;
    fallbackGeneration = info.fallbackGeneration;
    openFallbackSockets(info, attempt);
  } catch (reasonError) {
    if (attempt !== fallbackAttempt || !session.value || closingSession) return;
    const code = structuredErrorCode(reasonError);
    if (fallbackRetryable(code)) scheduleFallbackRetry(attempt, code);
    else if (fallbackProactive) cancelFallbackAttempt();
    else await failRemoteSession(code);
  }
}

function structuredErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "REMOTE_DESKTOP_FALLBACK_REQUEST_FAILED";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code ? code : "REMOTE_DESKTOP_FALLBACK_REQUEST_FAILED";
}

function fallbackRetryable(code: string) {
  return [
    "REMOTE_DESKTOP_FALLBACK_TOO_EARLY",
    "REMOTE_DESKTOP_FALLBACK_REQUEST_FAILED",
    "REMOTE_DESKTOP_FALLBACK_TICKET_INVALID",
    "REMOTE_DESKTOP_FALLBACK_CAPACITY",
    "REMOTE_DESKTOP_FALLBACK_ATTACH_FAILED",
    "REMOTE_DESKTOP_FALLBACK_CONTROL_FAILED",
    "REMOTE_DESKTOP_FALLBACK_SOCKET_ERROR",
    "REMOTE_DESKTOP_RATE_LIMIT",
    "REMOTE_DESKTOP_UPSTREAM_UNAVAILABLE",
  ].includes(code);
}

function openFallbackSockets(info: DesktopFallbackSession, attempt: number) {
  if (attempt !== fallbackAttempt || !session.value || closingSession) return;
  closeFallbackSockets();
  clearFallbackPairTimer();
  const media = new WebSocket(new URL(info.mediaUrl, window.location.href), info.mediaSubprotocol);
  const control = new WebSocket(new URL(info.controlUrl, window.location.href), info.controlSubprotocol);
  fallbackMedia = media;
  fallbackControl = control;
  media.binaryType = "arraybuffer";
  media.onmessage = event => {
    if (attempt !== fallbackAttempt || fallbackMedia !== media) return;
    if (typeof event.data === "string") handleFallbackMediaText(event.data, attempt);
    else if (event.data instanceof ArrayBuffer) handleFallbackBinary(event.data, attempt);
  };
  control.onmessage = event => {
    if (attempt !== fallbackAttempt || fallbackControl !== control || typeof event.data !== "string") return;
    try {
      handleFallbackControlValue(JSON.parse(event.data), attempt);
    } catch (reason) {
      recordRemoteDesktopDiagnostic("fallback.control.failed", { channel: "fallback-control", attempt, bytes: new TextEncoder().encode(event.data).byteLength, ...remoteDesktopParseErrorFields(reason) });
      handleFallbackTransportFailure(attempt, "REMOTE_DESKTOP_FALLBACK_CONTROL_FAILED");
    }
  };
  const failed = (role: "media" | "control", event: Event) => {
    const socketEvent = event as Event & { code?: number; reason?: string; wasClean?: boolean };
    recordRemoteDesktopDiagnostic("fallback.socket.failed", {
      channel: `fallback-${role}`,
      attempt,
      closeCode: socketEvent.code,
      closeReason: typeof socketEvent.reason === "string" ? socketEvent.reason.slice(0, 200) : undefined,
      clean: socketEvent.wasClean,
    });
    handleFallbackTransportFailure(attempt, "REMOTE_DESKTOP_FALLBACK_SOCKET_ERROR");
  };
  media.onclose = event => failed("media", event);
  control.onclose = event => failed("control", event);
  media.onerror = event => failed("media", event);
  control.onerror = event => failed("control", event);
  fallbackPairTimer = setTimeout(() => {
    fallbackPairTimer = undefined;
    if (attempt === fallbackAttempt && fallbackState.value === "switching") {
      handleFallbackTransportFailure(attempt, "REMOTE_DESKTOP_FALLBACK_ATTACH_FAILED");
    }
  }, 10_000);
}

function markFallbackReady(info: DesktopFallbackSession, attempt: number) {
  if (attempt !== fallbackAttempt || fallbackGeneration !== info.fallbackGeneration || !session.value) return;
  if (fallbackState.value === "active") return;
  clearFallbackPairTimer();
  clearFallbackHeadStart();
  clearFallbackUpgradeTimer();
  clearNegotiationTimer();
  clearRecoveryTimer();
  fallbackReconnectDeadline = 0;
  fallbackProactive = false;
  fallbackFirstFrame = false;
  fallbackNeedsKeyframe = true;
  fallbackState.value = "active";
  transportUpgrading.value = false;
  connectionState.value = "connected";
  error.value = "";
  applyTransportResolution();
  syncVisibility();
  enableClipboardByDefault();
  if (pc) void startWebRTCUpgradeWatch(pc);
  if (document.hasFocus()) resumeWanted();
}

function scheduleFallbackRetry(attempt: number, code: string) {
  if (attempt !== fallbackAttempt || !session.value || closingSession) return;
  if (fallbackReconnectDeadline === 0) fallbackReconnectDeadline = Date.now() + 15_000;
  if (Date.now() >= fallbackReconnectDeadline) {
    void failRemoteSession(code);
    return;
  }
  fallbackState.value = fallbackState.value === "active" ? "reconnecting" : fallbackState.value;
  if (fallbackState.value === "switching") fallbackState.value = "reconnecting";
  transportUpgrading.value = false;
  clearFallbackUpgradeTimer();
  fallbackAttempt += 1;
  const next = fallbackAttempt;
  closeFallbackSockets();
  closeFallbackDecoder();
  clearFallbackPairTimer();
  if (fallbackRetryTimer !== undefined) clearTimeout(fallbackRetryTimer);
  fallbackRetryTimer = setTimeout(() => {
    fallbackRetryTimer = undefined;
    if (fallbackReason.value) void requestFallbackAttempt(fallbackReason.value, fallbackDiagnosticCode, next);
  }, 750);
}

function handleFallbackTransportFailure(attempt: number, code: string) {
  if (attempt !== fallbackAttempt || !session.value || closingSession) return;
  if (fallbackState.value === "idle" || fallbackState.value === "failed") return;
  clearFallbackPairTimer();
  clearFallbackHeadStart();
  clearFallbackUpgradeTimer();
  transportUpgrading.value = false;
  closeFallbackSockets();
  closeFallbackDecoder();
  fallbackFirstFrame = false;
  streamReady.value = false;
  fallbackSize.value = undefined;
  suspend();
  inputResumePending = false;
  controlRequestPending.value = false;
  clipboardBusy.value = false;
  if (fallbackReconnectDeadline === 0) fallbackReconnectDeadline = Date.now() + 15_000;
  scheduleFallbackRetry(attempt, code);
}

function clearFallbackUpgradeTimer() {
  if (fallbackUpgradeTimer !== undefined) clearTimeout(fallbackUpgradeTimer);
  fallbackUpgradeTimer = undefined;
}

function requestTransportUpgrade() {
  if (fallbackState.value !== "active" || transportUpgrading.value) return;
  transportUpgrading.value = true;
  fallbackUpgradeStartedAt = Date.now();
  sendTransportUpgrade();
}

function sendTransportUpgrade() {
  clearFallbackUpgradeTimer();
  if (fallbackState.value !== "active" || !transportUpgrading.value) return;
  if (wireOpen(fallbackControl)) wire(fallbackControl, "transport.upgrade");
  if (Date.now() - fallbackUpgradeStartedAt < FALLBACK_UPGRADE_TIMEOUT_MS) {
    fallbackUpgradeTimer = setTimeout(sendTransportUpgrade, FALLBACK_UPGRADE_RETRY_MS);
  } else {
    transportUpgrading.value = false;
  }
}

function resetFallbackStateAfterTransport() {
  fallbackAttempt += 1;
  fallbackState.value = "idle";
  transportUpgrading.value = false;
  fallbackProactive = false;
  fallbackReason.value = undefined;
  fallbackDiagnosticCode = undefined;
  fallbackReconnectDeadline = 0;
  clearFallbackHeadStart();
  clearFallbackPairTimer();
  clearFallbackUpgradeTimer();
  if (fallbackRetryTimer !== undefined) clearTimeout(fallbackRetryTimer);
  fallbackRetryTimer = undefined;
  closeFallbackSockets();
  closeFallbackDecoder();
  fallbackSession = undefined;
  fallbackGeneration = "";
  fallbackSize.value = undefined;
  webrtcUpgradeBaseline = undefined;
}

function commitTransportUpgrade() {
  if (fallbackState.value === "idle") return;
  if (fallbackState.value !== "active") {
    cancelFallbackAttempt();
    return;
  }
  // The component drops the fallback-owned input epoch before releasing the
  // fallback sockets. Mirror that locally, then re-arm over WebRTC after the
  // upgrade so old epochs can never be replayed on the new transport.
  releaseInputState();
  resetFallbackStateAfterTransport();
  connectionState.value = pc?.connectionState === "connected" ? "connected" : pc?.iceConnectionState ?? "connected";
  updateResolution();
  streamReady.value = streamReady.value || Boolean(resolution.value);
  applyTransportResolution();
  syncVisibility();
  void video.value?.play().catch(() => undefined);
  if (document.hasFocus()) resumeWanted();
}

function cancelFallbackAttempt() {
  if (fallbackState.value !== "switching" && fallbackState.value !== "reconnecting") return;
  resetFallbackStateAfterTransport();
  connectionState.value = pc?.connectionState === "connected" ? "connected" : pc?.iceConnectionState ?? "connecting";
  updateResolution();
  streamReady.value = Boolean(resolution.value);
  applyTransportResolution();
  syncVisibility();
  void video.value?.play().catch(() => undefined);
  if (document.hasFocus()) resumeWanted();
}

async function failRemoteSession(code: string) {
  if (closingSession) return;
  const current = session.value;
  const message = translateApiError({ code }, t, t("instances.remoteDesktop.fallbackSessionFailed"));
  closingSession = true;
  suspend();
  try {
    if (current) await stopRemoteDesktopSession(props.instanceId, current.snapshot.viewerSessionId).catch(() => undefined);
  } finally {
    cleanup();
    closingSession = false;
    error.value = message;
  }
}

function closeFallbackSockets() {
  const media = fallbackMedia;
  const control = fallbackControl;
  fallbackMedia = undefined;
  fallbackControl = undefined;
  media?.close();
  control?.close();
}

function closeFallbackDecoder() {
  if (fallbackDecoder && fallbackDecoder.state !== "closed") {
    try { fallbackDecoder.close(); } catch { /* Decoder close is best effort. */ }
  }
  fallbackDecoder = undefined;
  fallbackConfig = undefined;
  fallbackDecoderNeedsReset = false;
  fallbackFirstFrame = false;
  fallbackNeedsKeyframe = true;
  fallbackLastTimestampUs = 0;
  fallbackAssembler.reset();
  const canvas = fallbackCanvas.value;
  canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

function clearFallbackPairTimer() {
  if (fallbackPairTimer !== undefined) clearTimeout(fallbackPairTimer);
  fallbackPairTimer = undefined;
}

function resetFallbackRuntime() {
  fallbackAttempt += 1;
  clearFallbackHeadStart();
  clearFallbackUpgradeTimer();
  clearNegotiationTimer();
  clearRecoveryTimer();
  clearFallbackPairTimer();
  if (fallbackRetryTimer !== undefined) clearTimeout(fallbackRetryTimer);
  fallbackRetryTimer = undefined;
  closeFallbackSockets();
  closeFallbackDecoder();
  fallbackSession = undefined;
  fallbackGeneration = "";
  fallbackReason.value = undefined;
  fallbackDiagnosticCode = undefined;
  fallbackReconnectDeadline = 0;
  fallbackProactive = false;
  transportUpgrading.value = false;
  webrtcFrameWatch += 1;
  webrtcUpgradeBaseline = undefined;
  fallbackSize.value = undefined;
  fallbackState.value = "idle";
}

function handleFallbackMediaText(text: string, attempt: number) {
  if (attempt !== fallbackAttempt) return;
  let value: any;
  try { value = JSON.parse(text); } catch { handleFallbackTransportFailure(attempt, "REMOTE_DESKTOP_FALLBACK_MEDIA_INVALID"); return; }
  if (value?.type === "fallback.configure") {
    const payload = value.payload;
    const width = Number(payload?.width);
    const height = Number(payload?.height);
    const fps = Number(payload?.fps);
    const bitrate = Number(payload?.bitrate);
    const codec = String(payload?.codec || "");
    if (!Number.isInteger(width) || width < 2 || width > 8192
      || !Number.isInteger(height) || height < 2 || height > 8192
      || !Number.isInteger(fps) || fps < 1 || fps > 120
      || !Number.isInteger(bitrate) || bitrate < 1 || bitrate > 8_000_000
      || codec !== "avc1.42E028") {
      handleFallbackTransportFailure(attempt, "REMOTE_DESKTOP_FALLBACK_MEDIA_INVALID");
      return;
    }
    fallbackConfig = { codec, width, height, fps, bitrate };
    fallbackSize.value = { width, height };
  } else if (value?.type === "fallback.error") {
    handleFallbackTransportFailure(attempt, String(value.payload?.code || "REMOTE_DESKTOP_FALLBACK_FAILED"));
  }
}

function handleFallbackBinary(buffer: ArrayBuffer, attempt: number) {
  if (attempt !== fallbackAttempt) return;
  let frame;
  try { frame = decodeDesktopFallbackFrame(buffer); } catch { handleFallbackTransportFailure(attempt, "REMOTE_DESKTOP_FALLBACK_MEDIA_INVALID"); return; }
  let assembled;
  try { assembled = fallbackAssembler.push(frame); } catch { handleFallbackTransportFailure(attempt, "REMOTE_DESKTOP_FALLBACK_MEDIA_INVALID"); return; }
  if (assembled.type !== "frame") return;
  if (assembled.skippedFrames) fallbackNeedsKeyframe = true;
  decodeFallbackVideo(assembled.payload, assembled.keyframe, assembled.timestampUs);
}

function ensureFallbackDecoder() {
  if (fallbackDecoder && fallbackDecoder.state !== "closed" && !fallbackDecoderNeedsReset) return fallbackDecoder;
  const config = fallbackConfig;
  if (!config) return undefined;
  closeFallbackDecoder();
  fallbackConfig = config;
  const decoder = new VideoDecoder({
    output: frame => {
      try { drawFallbackFrame(frame); } finally { frame.close(); }
    },
    error: () => {
      fallbackDecoderNeedsReset = true;
      fallbackNeedsKeyframe = true;
      requestFallbackKeyframe();
    },
  });
  decoder.configure({
    codec: config.codec,
    codedWidth: config.width,
    codedHeight: config.height,
    optimizeForLatency: true,
  });
  fallbackDecoder = decoder;
  fallbackDecoderNeedsReset = false;
  return decoder;
}

function decodeFallbackVideo(data: Uint8Array, keyframe: boolean, timestampUs: bigint) {
  if (!fallbackConfig) return;
  if (!keyframe && (fallbackNeedsKeyframe || !fallbackFirstFrame)) {
    requestFallbackKeyframe();
    return;
  }
  const decoder = ensureFallbackDecoder();
  if (!decoder) return;
  if (!keyframe && decoder.decodeQueueSize > 8) {
    fallbackNeedsKeyframe = true;
    requestFallbackKeyframe();
    return;
  }
  const timestamp = Math.max(Number(timestampUs), fallbackLastTimestampUs + 1);
  fallbackLastTimestampUs = timestamp;
  try {
    decoder.decode(new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp, data }));
    if (keyframe) fallbackNeedsKeyframe = false;
  } catch {
    fallbackDecoderNeedsReset = true;
    fallbackNeedsKeyframe = true;
    requestFallbackKeyframe();
  }
}

function drawFallbackFrame(frame: VideoFrame) {
  const width = frame.displayWidth || frame.codedWidth;
  const height = frame.displayHeight || frame.codedHeight;
  const canvas = fallbackCanvas.value;
  if (!canvas || !width || !height) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  context.drawImage(frame, 0, 0, width, height);
  fallbackSize.value = { width, height };
  resolution.value = `${width} × ${height}`;
  fallbackFirstFrame = true;
  streamReady.value = true;
}

function requestFallbackKeyframe() {
  if (!wireOpen(fallbackMedia)) return;
  const now = Date.now();
  if (now - fallbackLastKeyframeRequest < 500) return;
  fallbackLastKeyframeRequest = now;
  fallbackMedia.send(JSON.stringify({ type: "fallback.keyframe-request" }));
}

function handleFallbackControlValue(value: any, attempt: number) {
  if (attempt !== fallbackAttempt || !fallbackSession) return;
  if (value?.type === "fallback.ready") {
    if (value.payload?.fallbackGeneration !== fallbackSession.fallbackGeneration) return;
    markFallbackReady(fallbackSession, attempt);
    return;
  }
  if (value?.type === "transport.upgraded") {
    commitTransportUpgrade();
    return;
  }
  handleControlValue(value, "fallback-control");
  if (value?.type === "clipboard.written" || value?.type === "clipboard.text") handleClipboardValue(value);
}

function controlMessage(event: MessageEvent) {
  const bytes = messageByteLength(event);
  let value: any;
  try {
    value = JSON.parse(event.data);
  } catch (reason) {
    recordRemoteDesktopDiagnostic("control.message.failed", { stage: "parse", channel: "control", bytes, ...remoteDesktopParseErrorFields(reason) });
    return;
  }
  try {
    handleControlValue(value, "control");
  } catch (reason) {
    recordRemoteDesktopDiagnostic("control.message.failed", { stage: "handle", channel: "control", bytes }, reason);
    // Malformed control messages are handled by the connection-level handler.
  }
}

function handleControlValue(value: any, channel = "control") {
  const type = typeof value?.type === "string" ? value.type : "unknown";
  const inboundSequence = typeof value?.seq === "number" ? value.seq : undefined;
  rememberRemoteDesktopFrame({ direction: "receive", channel, type, sequence: inboundSequence, bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength });
  recordRemoteDesktopDiagnostic("control.message", { channel, controlType: type, inboundSequence });
  if (value.type === "input.resumed") {
    epoch = value.payload.inputEpoch;
    const attempt = inputResumeRetryCount + 1;
    inputEnabled.value = true;
    inputResumePending = false;
    clearInputResumeTimers();
    inputResumeRetryCount = 0;
    startInputAlive();
    recordRemoteDesktopDiagnostic("input.resumed", { inputEpoch: epoch, attempt });
  } else if (value.type === "input.suspended") {
    const notice = parseInputSuspension(value);
    const shouldResume = shouldResumeAfterInputSuspension(notice, {
      inputRequested: inputRequested.value,
      isController: isController.value,
      surfacePaused: surfacePaused(),
      documentFocused: document.hasFocus(),
    });
    releaseInputState();
    recordRemoteDesktopDiagnostic("input.suspended", {
      cause: notice.cause || undefined,
      recoverable: notice.recoverable,
      sessionRevision: notice.sessionRevision,
    });
    if (notice.sessionRevision !== undefined && snapshot.value) {
      snapshot.value = {
        ...snapshot.value,
        sessionRevision: Math.max(snapshot.value.sessionRevision, notice.sessionRevision),
      };
    }
    if (shouldResume) resumeWanted();
  } else if (value.type === "clipboard.enabled") {
    const automatic = clipboardRequestAutomatic;
    clipboardRequestAutomatic = false;
    clipboard.value = value.payload.enabled === true;
    clipboardBusy.value = false;
    if (clipboardRequested && !clipboard.value && !automatic) error.value = t("instances.remoteDesktop.clipboardUnavailable");
    clipboardRequested = false;
  } else if (value.type === "error") {
    clipboardBusy.value = false;
    controlRequestPending.value = false;
    const code = value.payload?.code || value.code;
    recordRemoteDesktopDiagnostic("control.error", { channel, controlType: type, controlCode: code, inboundSequence });
    if (transportUpgrading.value && code === "REMOTE_DESKTOP_WEBRTC_NOT_READY") return;
    if (code === "REMOTE_DESKTOP_INVALID_STATE" && inputEnabled.value) {
      recordRemoteDesktopDiagnostic("input.late-error.ignored", { controlCode: code, inputEpoch: epoch });
      return;
    }
    const retryingInput = (
      inputResumePending
      || inputResumeRetryTimer !== undefined
      || inputResumeRetryCount > 0
    ) && isRecoverableRemoteDesktopInputResumeError(code);
    if (retryingInput) {
      releaseInputState(false);
      recordRemoteDesktopDiagnostic("input.resume.error", {
        controlCode: code,
        sessionRevision: snapshot.value?.sessionRevision,
      });
      scheduleInputResumeRetry(code);
      return;
    }
    inputResumePending = false;
    clearInputResumeTimers();
    inputResumeRetryCount = 0;
    error.value = translateApiError({ code }, t, t("instances.remoteDesktop.messageInvalid"));
  } else if (value.type === "clipboard.written" || value.type === "clipboard.text") {
    // Fallback control combines clipboard responses with control frames; the
    // fallback caller handles these values after this function returns.
  } else {
    recordRemoteDesktopDiagnostic("control.message.unknown", { channel, controlType: type, inboundSequence });
  }
}

function handleClipboardValue(value: any) {
  if (value.type === "clipboard.written") {
    clipboardStatus.value = t("instances.remoteDesktop.clipboardSent");
  } else if (value.type === "clipboard.text") {
    const text = typeof value.payload?.text === "string" ? value.payload.text : "";
    if (new TextEncoder().encode(text).byteLength > REMOTE_DESKTOP_MAX_CLIPBOARD_TEXT_BYTES) {
      clipboardStatus.value = t("instances.remoteDesktop.clipboardTooLarge");
      return;
    }
    void navigator.clipboard?.writeText(text)
      .then(() => { clipboardStatus.value = t("instances.remoteDesktop.clipboardReceived"); })
      .catch(() => { clipboardStatus.value = t("instances.remoteDesktop.clipboardLocalUnavailable"); });
  } else if (value.type === "error") {
    clipboardStatus.value = t("instances.remoteDesktop.clipboardRemoteError");
  }
}

function clipboardMessage(event: MessageEvent) {
  const bytes = messageByteLength(event);
  let value: any;
  try {
    value = JSON.parse(event.data);
  } catch (reason) {
    recordRemoteDesktopDiagnostic("clipboard.message.failed", { stage: "parse", channel: "clipboard", bytes, ...remoteDesktopParseErrorFields(reason) });
    clipboardStatus.value = t("instances.remoteDesktop.messageInvalid");
    return;
  }
  try {
    const type = typeof value?.type === "string" ? value.type : "unknown";
    rememberRemoteDesktopFrame({ direction: "receive", channel: "clipboard", type, sequence: typeof value?.seq === "number" ? value.seq : undefined, bytes: bytes ?? 0 });
    recordRemoteDesktopDiagnostic("clipboard.message", { channel: "clipboard", clipboardType: type, bytes });
    handleClipboardValue(value);
  } catch (reason) {
    recordRemoteDesktopDiagnostic("clipboard.message.failed", { stage: "handle", channel: "clipboard", bytes }, reason);
    clipboardStatus.value = t("instances.remoteDesktop.messageInvalid");
  }
}

function modifiers(event: KeyboardEvent) {
  return (event.ctrlKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.shiftKey ? 4 : 0) | (event.metaKey ? 8 : 0);
}

function key(event: KeyboardEvent, down: boolean) {
  if (!inputEnabled.value) return;
  event.preventDefault();
  send("key", { inputEpoch: epoch, code: event.code, down, modifiers: modifiers(event), repeat: event.repeat });
}

function commitComposition(event: CompositionEvent) {
  const text = event.data;
  if (!inputEnabled.value || !text) return;
  const payload = { inputEpoch: epoch, text };
  const wireBytes = new TextEncoder().encode(JSON.stringify({ v: REMOTE_DESKTOP_CHANNEL_VERSION, seq: seq + 1, type: "text.commit", payload })).byteLength;
  if (wireBytes > REMOTE_DESKTOP_MAX_MESSAGE_BYTES) {
    error.value = t("instances.remoteDesktop.textTooLarge");
    return;
  }
  send("text.commit", payload);
}

function normalizedPointer(event: PointerEvent) {
  const element = fallbackActive.value ? fallbackCanvas.value : video.value;
  const rect = (element ?? surface.value)?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return { x: 0, y: 0 };
  const intrinsicWidth = fallbackActive.value ? fallbackSize.value?.width ?? 0 : video.value?.videoWidth ?? 0;
  const intrinsicHeight = fallbackActive.value ? fallbackSize.value?.height ?? 0 : video.value?.videoHeight ?? 0;
  const scale = intrinsicWidth > 0 && intrinsicHeight > 0
    ? Math.min(rect.width / intrinsicWidth, rect.height / intrinsicHeight)
    : 1;
  const contentWidth = intrinsicWidth > 0 ? intrinsicWidth * scale : rect.width;
  const contentHeight = intrinsicHeight > 0 ? intrinsicHeight * scale : rect.height;
  const left = rect.left + (rect.width - contentWidth) / 2;
  const top = rect.top + (rect.height - contentHeight) / 2;
  return {
    x: Math.max(0, Math.min(1, (event.clientX - left) / contentWidth)),
    y: Math.max(0, Math.min(1, (event.clientY - top) / contentHeight)),
  };
}

function pointerMove(event: PointerEvent) {
  if (!inputEnabled.value) return;
  const position = normalizedPointer(event);
  pendingPointer = position;
  lastPointer = position;
  if (pointerFrame !== undefined) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = undefined;
    const position = pendingPointer;
    pendingPointer = undefined;
    if (position && inputEnabled.value) send("pointer", { ...position, inputEpoch: epoch }, "pointer");
  });
}

function pointerButton(event: PointerEvent, down: boolean) {
  if (!inputEnabled.value) {
    if (down) showControlHint();
    return;
  }
  const position = normalizedPointer(event);
  lastPointer = position;
  if (down) {
    pressedButtons.add(event.button);
    try { surface.value?.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional. */ }
  } else {
    pressedButtons.delete(event.button);
    try { surface.value?.releasePointerCapture(event.pointerId); } catch { /* Pointer capture is optional. */ }
  }
  send("button", { ...position, button: event.button, down, inputEpoch: epoch });
}

function showControlHint() {
  if (inputEnabled.value || isController.value) return;
  controlHintVisible.value = true;
  if (controlHintTimer !== undefined) clearTimeout(controlHintTimer);
  controlHintTimer = setTimeout(() => {
    controlHintTimer = undefined;
    controlHintVisible.value = false;
  }, 2_600);
}

function pointerCancel() {
  if (inputEnabled.value) {
    for (const button of pressedButtons) send("button", { ...lastPointer, button, down: false, inputEpoch: epoch });
  }
  pressedButtons.clear();
}

function wheel(event: WheelEvent) {
  if (!inputEnabled.value) return;
  event.preventDefault();
  wheelAnchor = normalizedPointer(event as unknown as PointerEvent);
  wheelPump.add(event.deltaX, event.deltaY);
  if (wheelFrame !== undefined || wheelPump.idle) return;
  wheelFrame = requestAnimationFrame(flushWheelFrame);
}

function flushWheelFrame() {
  wheelFrame = undefined;
  if (!inputEnabled.value) {
    stopWheelPump();
    return;
  }
  const delta = wheelPump.take();
  if (delta && wheelAnchor) send("wheel", { ...wheelAnchor, deltaX: delta.x, deltaY: delta.y, inputEpoch: epoch });
  if (!wheelPump.idle) wheelFrame = requestAnimationFrame(flushWheelFrame);
}

function stopWheelPump() {
  wheelPump.clear();
  wheelAnchor = undefined;
  if (wheelFrame !== undefined) cancelAnimationFrame(wheelFrame);
  wheelFrame = undefined;
}

async function resume() {
  if (!isController.value) {
    requestControl();
    return;
  }
  inputRequested.value = true;
  if (!signalingReady.value || fallbackSwitching.value || inputEnabled.value || inputResumePending || surfacePaused()) return;
  const control = controlChannel();
  if (!control) return;
  inputResumePending = true;
  const generation = ++inputResumeGeneration;
  try {
    await (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.();
  } catch {
    // Keyboard Lock is optional and may be denied outside a fullscreen or Electron context.
  }
  if (
    generation !== inputResumeGeneration
    || !inputRequested.value
    || surfacePaused()
    || !document.hasFocus()
  ) {
    if (generation === inputResumeGeneration) inputResumePending = false;
    return;
  }
  if (!wire(control, "input.resume", { sessionRevision: snapshot.value?.sessionRevision })) {
    inputResumePending = false;
    return;
  }
  clearInputResumeRetryTimer();
  recordRemoteDesktopDiagnostic("input.resume.sent", {
    attempt: inputResumeRetryCount + 1,
    sessionRevision: snapshot.value?.sessionRevision,
  });
  armInputResumeAckTimeout();
  clipboardStatus.value = "";
  surface.value?.focus();
}

function armInputResumeAckTimeout() {
  clearInputResumeAckTimer();
  inputResumeAckTimer = setTimeout(() => {
    inputResumeAckTimer = undefined;
    if (
      !inputResumePending
      || !inputRequested.value
      || surfacePaused()
      || !isController.value
      || inputEnabled.value
    ) return;
    recordRemoteDesktopDiagnostic("input.resume.timeout", {
      attempt: inputResumeRetryCount + 1,
      sessionRevision: snapshot.value?.sessionRevision,
    });
    inputResumePending = false;
    scheduleInputResumeRetry("ack-timeout");
  }, REMOTE_DESKTOP_INPUT_RESUME_ACK_TIMEOUT_MS);
}

function scheduleInputResumeRetry(reason: string) {
  if (
    inputResumeRetryTimer !== undefined
    || !inputRequested.value
    || surfacePaused()
    || !isController.value
    || inputEnabled.value
  ) return;
  const attempt = inputResumeRetryCount;
  inputResumeRetryCount += 1;
  const delayMs = remoteDesktopInputResumeRetryDelayMs(attempt);
  recordRemoteDesktopDiagnostic("input.resume.retry", {
    attempt: attempt + 1,
    delayMs,
    reason,
    sessionRevision: snapshot.value?.sessionRevision,
  });
  inputResumeRetryTimer = setTimeout(() => {
    inputResumeRetryTimer = undefined;
    resumeWanted();
  }, delayMs);
}

function clearInputResumeAckTimer() {
  if (inputResumeAckTimer !== undefined) clearTimeout(inputResumeAckTimer);
  inputResumeAckTimer = undefined;
}

function clearInputResumeRetryTimer() {
  if (inputResumeRetryTimer !== undefined) clearTimeout(inputResumeRetryTimer);
  inputResumeRetryTimer = undefined;
}

function clearInputResumeTimers() {
  clearInputResumeAckTimer();
  clearInputResumeRetryTimer();
}

function primaryInputAction() {
  if (fallbackSwitching.value) return;
  if (isController.value && !inputEnabled.value) void resume();
  else if (!isController.value) requestControl();
}

function toggleInputEnabled() {
  if (inputRequested.value) {
    inputRequested.value = false;
    inputResumeGeneration += 1;
    suspend();
    return;
  }
  inputRequested.value = true;
  if (isController.value) resumeWanted();
  else requestControl();
}

function requestControl() {
  inputRequested.value = true;
  if (!signalingReady.value || fallbackSwitching.value || controlRequestPending.value || isController.value) return;
  const control = controlChannel();
  if (!control) return;
  controlRequestPending.value = true;
  if (!wire(control, "control.request")) {
    controlRequestPending.value = false;
  }
}

function releaseInputState(resetRetry = true) {
  try {
    (navigator as Navigator & { keyboard?: { unlock?: () => Promise<void> } }).keyboard?.unlock?.();
  } catch {
    // Keyboard Lock is optional.
  }
  stopInputAlive();
  stopPointerMove();
  stopWheelPump();
  pressedButtons.clear();
  epoch = 0;
  inputEnabled.value = false;
  inputResumeGeneration += 1;
  inputResumePending = false;
  clearInputResumeTimers();
  if (resetRetry) inputResumeRetryCount = 0;
}

function suspend() {
  const control = controlChannel();
  if (control && inputEnabled.value) wire(control, "input.suspend");
  releaseInputState();
}

function startInputAlive() {
  stopInputAlive();
  if (!inputEnabled.value) return;
  // Transport liveness is not business state polling. Keeping this below the
  // component's 1500 ms deadline prevents the input lease from expiring.
  inputAliveTimer = setInterval(() => {
    const control = controlChannel();
    if (!inputEnabled.value || surfacePaused() || !control) return;
    wire(control, "input.alive", { inputEpoch: epoch });
  }, 500);
}

function stopInputAlive() {
  if (inputAliveTimer !== undefined) clearInterval(inputAliveTimer);
  inputAliveTimer = undefined;
}

function signalAliveNow() {
  if (!signalingReady.value || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "signalAlive", requestId: createBrowserUuid() }));
}

function startSignalAlive() {
  stopSignalAlive();
  signalAliveNow();
  signalAliveTimer = setInterval(signalAliveNow, 2_000);
}

function stopSignalAlive() {
  if (signalAliveTimer !== undefined) clearInterval(signalAliveTimer);
  signalAliveTimer = undefined;
}

function stopPointerMove() {
  if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
  pointerFrame = undefined;
  pendingPointer = undefined;
}

function surfaceBlur(event: FocusEvent) {
  const next = event.relatedTarget;
  if (next instanceof Node && viewer.value?.contains(next)) return;
  suspend();
}

function resumeWanted() {
  if (!inputRequested.value || surfacePaused() || visibilityResumePending || snapshot.value?.phase !== "active") return;
  if (!isController.value) {
    if (!hasController.value) requestControl();
    return;
  }
  signalAliveNow();
  void resume();
}

function surfaceFocus() {
  resumeWanted();
}

function windowFocus() {
  resumeWanted();
}

function windowBlur() {
  suspend();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewer.value?.requestFullscreen();
  } catch (reason) {
    error.value = translateApiError(reason, t, t("instances.remoteDesktop.fullscreenFailed"));
  }
}

function syncFullscreen() {
  isFullscreen.value = Boolean(viewer.value && document.fullscreenElement === viewer.value);
}

function updateResolution() {
  if (fallbackActive.value && fallbackSize.value) {
    resolution.value = `${fallbackSize.value.width} × ${fallbackSize.value.height}`;
    return;
  }
  const element = video.value;
  resolution.value = element?.videoWidth && element.videoHeight ? `${element.videoWidth} × ${element.videoHeight}` : "";
  streamReady.value = Boolean(resolution.value);
}

function visibility() {
  documentVisible.value = document.visibilityState !== "hidden";
  syncVisibility();
}

function surfacePaused() {
  return documentVisible.value === false || props.active === false;
}

function sendVisibility() {
  const control = controlChannel();
  if (!control) return false;
  const hidden = surfacePaused();
  if (!wire(control, "visibility", { hidden })) return false;
  if (hidden) {
    visibilityResumePending = false;
    visibilityResumeRevision = undefined;
  } else {
    visibilityResumeRevision = snapshot.value?.sessionRevision;
    visibilityResumePending = true;
  }
  return true;
}

function syncVisibility() {
  const hidden = surfacePaused();
  sendVisibility();
  if (hidden) {
    suspend();
  } else {
    const control = controlChannel();
    if (signalingReady.value && control) {
      if (fallbackActive.value) requestFallbackKeyframe();
      else wire(control, "stream.keyframe", {});
    }
    if (fallbackState.value === "idle" && session.value && !webRTCTransportEnabled.value) {
      void beginFallback("ice-failed", "REMOTE_DESKTOP_ALL_WEBRTC_TRANSPORTS_DISABLED");
    } else if (fallbackState.value === "idle" && pc && (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected")) {
      void beginFallback("recovery-timeout", "REMOTE_DESKTOP_ICE_RECOVERY_TIMEOUT");
    } else if (fallbackState.value === "idle" && pc && pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") {
      armFallbackHeadStart();
    }
    resumeWanted();
  }
}

function requestClipboardEnabled(enabled: boolean, automatic = false) {
  const control = controlChannel();
  if (!control || !signalingReady.value) {
    if (!automatic) error.value = t("instances.remoteDesktop.connectionRequired");
    return false;
  }
  clipboardRequestAutomatic = automatic;
  clipboardRequested = enabled;
  clipboardBusy.value = true;
  clipboardStatus.value = "";
  if (!wire(control, "clipboard.enable", { enabled })) {
    clipboardBusy.value = false;
    clipboardRequested = false;
    clipboardRequestAutomatic = false;
    if (!automatic) error.value = t("instances.remoteDesktop.clipboardUnavailable");
    return false;
  }
  return true;
}

function enableClipboardByDefault() {
  if (clipboardAutoEnableAttempted || !clipboardSupported.value) return;
  if (!signalingReady.value || clipboard.value || clipboardBusy.value) return;
  if (!controlChannel()) return;
  clipboardAutoEnableAttempted = true;
  if (!requestClipboardEnabled(true, true)) clipboardAutoEnableAttempted = false;
}

function setClipboard(enabled: boolean) {
  requestClipboardEnabled(enabled);
}

function transportResolutionPayload() {
  const option = transportResolutionOptions.value.find((item) => item.value === transportResolution.value);
  const frameRate = transportFrameRateOptions.value.find((item) => item.value === transportFrameRate.value)?.frameRate ?? null;
  return {
    maxWidth: option?.width ?? null,
    maxHeight: option?.height ?? null,
    maxFrameRate: frameRate,
  };
}

function applyTransportResolution(showError = false) {
  if (transportResolution.value === "auto" && !transportResolutionRequested) return true;
  const control = controlChannel();
  if (!control) {
    recordRemoteDesktopDiagnostic("transport.resolution.failed", { reason: "control-channel-unavailable", showError, fallbackState: fallbackState.value, resolution: transportResolution.value });
    if (showError) error.value = t("instances.remoteDesktop.messageInvalid");
    return false;
  }
  if (!wire(control, "stream.resolution", transportResolutionPayload())) {
    recordRemoteDesktopDiagnostic("transport.resolution.failed", { reason: "wire-rejected", showError, fallbackState: fallbackState.value, resolution: transportResolution.value });
    if (showError) error.value = t("instances.remoteDesktop.messageInvalid");
    return false;
  }
  return true;
}

function setTransportResolution(value: string) {
  if (!transportResolutionOptions.value.some((option) => option.value === value)) return;
  transportResolution.value = value as TransportResolutionValue;
  transportResolutionRequested = true;
  applyTransportResolution(true);
}

function setTransportFrameRate(value: string) {
  if (!transportFrameRateOptions.value.some((option) => option.value === value)) return;
  transportFrameRate.value = value as TransportFrameRateValue;
  transportResolutionRequested = true;
  applyTransportResolution(true);
}

async function sendLocalClipboard() {
  if (!clipboard.value || clipboardBusy.value) return;
  try {
    const text = await navigator.clipboard.readText();
    if (new TextEncoder().encode(text).byteLength > REMOTE_DESKTOP_MAX_CLIPBOARD_TEXT_BYTES) {
      clipboardStatus.value = t("instances.remoteDesktop.clipboardTooLarge");
      return;
    }
    const channel = outputChannel("clipboard");
    if (!channel || !wire(channel, "clipboard.write", { text }, REMOTE_DESKTOP_MAX_CLIPBOARD_WIRE_BYTES)) {
      clipboardStatus.value = t("instances.remoteDesktop.clipboardTooLarge");
    }
  } catch {
    clipboardStatus.value = t("instances.remoteDesktop.clipboardLocalUnavailable");
  }
}

function readRemoteClipboard() {
  if (!clipboard.value || clipboardBusy.value) return;
  const channel = outputChannel("clipboard");
  if (!channel || !wire(channel, "clipboard.read", {})) {
    clipboardStatus.value = t("instances.remoteDesktop.clipboardUnavailable");
  }
}

async function closeCurrentSession() {
  const current = session.value;
  if (!current) return true;
  closingSession = true;
  error.value = "";
  try {
    await stopRemoteDesktopSession(props.instanceId, current.snapshot.viewerSessionId);
    return true;
  } catch (reason) {
    error.value = translateApiError(reason, t, t("instances.remoteDesktop.openFailed"));
    return false;
  } finally {
    cleanup();
    closingSession = false;
  }
}

async function stop() {
  if (!session.value) return;
  await closeCurrentSession();
}

async function forceStop() {
  if (!session.value) return;
  closingSession = true;
  error.value = "";
  try {
    await forceStopRemoteDesktopSession(props.instanceId, session.value.snapshot.viewerSessionId);
  } catch (reason) {
    error.value = translateApiError(reason, t, t("instances.remoteDesktop.openFailed"));
  } finally {
    cleanup();
    closingSession = false;
  }
}

function cleanup() {
  usedTransportKeys.value = new Set();
  resetFallbackRuntime();
  stopWebRTCTransportWatch();
  webrtcPeerConnected.value = false;
  webrtcPeerFailed.value = false;
  webRTCRoute.value = "unknown";
  webRTCCandidatePair.value = undefined;
  const element = video.value;
  if (element) element.srcObject = null;
  stopInputAlive();
  stopSignalAlive();
  stopPointerMove();
  stopWheelPump();
  pressedButtons.clear();
  session.value = undefined;
  snapshot.value = undefined;
  ws?.close();
  pc?.close();
  ws = undefined;
  pc = undefined;
  awaitingRestart = false;
  channels.clear();
  resolution.value = "";
  connectionState.value = "new";
  clipboard.value = false;
  clipboardBusy.value = false;
  clipboardStatus.value = "";
  clipboardRequested = false;
  clipboardAutoEnableAttempted = false;
  clipboardRequestAutomatic = false;
  inputEnabled.value = false;
  controlHintVisible.value = false;
  if (controlHintTimer !== undefined) clearTimeout(controlHintTimer);
  controlHintTimer = undefined;
  inputRequested.value = false;
  inputResumeGeneration += 1;
  inputResumePending = false;
  clearInputResumeTimers();
  inputResumeRetryCount = 0;
  scopeMenuOpen.value = false;
  streamReady.value = false;
  signalingReady.value = false;
  epoch = 0;
  if (document.fullscreenElement === viewer.value) void document.exitFullscreen().catch(() => undefined);
  isFullscreen.value = false;
}

watch([inputEnabled, isController], ([enabled, controller]) => {
  if (enabled || controller) controlHintVisible.value = false;
});
watch(clipboardSupported, supported => {
  if (supported) enableClipboardByDefault();
});

function syncSourceProviders() {
  const providers = remote.value?.sourceProviders ?? [];
  if (!providers.some(provider => provider.kind === target.value.kind && provider.available)) {
    const first = providers.find(provider => provider.available);
    if (first) target.value = { kind: first.kind };
  }
  if (providers.some(provider => provider.available)) void loadSources();
}

watch(() => props.active, () => syncVisibility());
watch(() => hasSourceProvider.value, available => {
  if (available) syncSourceProviders();
}, { immediate: true });

onMounted(() => {
  documentVisible.value = document.visibilityState !== "hidden";
  void detectWebCodecs();
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("fullscreenchange", syncFullscreen);
  window.addEventListener("focus", windowFocus);
  window.addEventListener("blur", windowBlur);
});
onBeforeUnmount(() => {
  const current = session.value;
  if (current) void stopRemoteDesktopSession(props.instanceId, current.snapshot.viewerSessionId).catch(() => undefined);
  suspend();
  document.removeEventListener("visibilitychange", visibility);
  document.removeEventListener("fullscreenchange", syncFullscreen);
  window.removeEventListener("focus", windowFocus);
  window.removeEventListener("blur", windowBlur);
  cleanup();
});
</script>

<style scoped>
.remote-desktop-viewer {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  max-height: min(62%, 760px);
  min-height: 0;
  margin: 0 0 10px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-raised);
  box-shadow: var(--shadow-soft);
}

.remote-desktop-layout {
  container-type: inline-size;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.remote-desktop-viewer.is-connected {
  flex: 0 1 58%;
  min-height: 340px;
  max-height: min(72%, 820px);
}

.remote-desktop-viewer.embedded {
  width: 100%;
  height: 100%;
  min-height: 0;
  max-height: none;
  flex: 1 1 auto;
  margin: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.remote-desktop-viewer:fullscreen {
  width: 100vw;
  height: 100vh;
  max-height: none;
  min-height: 100vh;
  margin: 0;
  border: 0;
  border-radius: 0;
  background: var(--surface-raised);
}

.remote-desktop-portal-host {
  display: contents;
}

.remote-desktop-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border-bottom: 1px solid var(--line-subtle);
  background: color-mix(in srgb, var(--surface-inset) 76%, var(--surface-raised));
}

.remote-desktop-head-actions {
  display: flex;
  min-width: 0;
}

.remote-desktop-unavailable-icon,
.remote-desktop-preview-icon,
.remote-desktop-target-icon,
.remote-desktop-stage-target-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  color: var(--brand-accent-muted);
  background: var(--brand-accent-soft);
}

.remote-desktop-stage-target-icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
}

.remote-desktop-head-actions {
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.remote-desktop-live-toolbar,
.remote-desktop-live-main,
.remote-desktop-live-actions,
.remote-desktop-live-meta {
  display: flex;
  min-width: 0;
  align-items: center;
}

.remote-desktop-live-toolbar {
  width: 100%;
  gap: 8px;
}

.remote-desktop-live-main {
  flex: 0 1 auto;
  gap: 4px;
}

.remote-desktop-live-actions {
  flex: 0 0 auto;
  gap: 10px;
  margin-left: auto;
}

.remote-desktop-live-meta {
  gap: 10px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
}

.remote-desktop-live-meta > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.remote-desktop-transport-status {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 1px;
  border: 1px solid var(--line-subtle);
  border-radius: 7px;
  background: color-mix(in srgb, var(--text-muted) 4%, transparent);
}

.remote-desktop-transport-indicator {
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--text-muted);
  cursor: help;
  opacity: 0.72;
  outline: none;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}

.remote-desktop-transport-indicator.is-active {
  background: color-mix(in srgb, var(--brand-accent) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand-accent) 24%, transparent);
  color: var(--brand-accent-muted);
  opacity: 1;
}

:global(.remote-desktop-transport-tooltip-failure) {
  display: grid;
  min-width: 0;
  gap: 3px;
  padding-top: 6px;
  border-top: 1px solid var(--line-subtle);
}

.remote-desktop-transport-indicator:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand-accent) 58%, transparent);
  outline-offset: 1px;
}

:global(.remote-desktop-transport-tooltip) {
  box-sizing: border-box;
  width: max-content;
  max-width: min(280px, calc(100vw - 24px));
  white-space: normal;
}

:global(.remote-desktop-transport-tooltip-body) {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 8px;
}

:global(.remote-desktop-transport-tooltip-summary) {
  display: grid;
  min-width: 0;
  gap: 3px;
}

:global(.remote-desktop-transport-tooltip-heading) {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
}

:global(.remote-desktop-transport-tooltip-heading strong) {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
}

:global(.remote-desktop-transport-tooltip-heading span) {
  color: var(--text-muted);
  font-size: 11px;
}

:global(.remote-desktop-transport-tooltip small) {
  display: block;
  min-width: 0;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
  overflow-wrap: anywhere;
}

.remote-desktop-inline-status {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}

:global(.remote-desktop-actions-menu),
:global(.remote-desktop-clipboard-menu),
:global(.remote-desktop-connection-methods-menu),
:global(.remote-desktop-frame-rate-menu) {
  box-sizing: border-box;
  width: min(288px, var(--reka-dropdown-menu-content-available-width, calc(100vw - 20px)));
  max-width: calc(100vw - 20px);
  max-height: var(--reka-dropdown-menu-content-available-height, calc(100vh - 24px));
  overflow-x: hidden;
  overflow-y: auto;
  border-color: var(--line-strong);
  padding: 5px;
}

:global(.remote-desktop-actions-label) {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
}

:global(.remote-desktop-actions-label small),
:global(.remote-desktop-resolution-option small),
:global(.remote-desktop-connection-option small),
:global(.remote-desktop-menu-value) {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
}

:global(.remote-desktop-resolution-option) {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

:global(.remote-desktop-resolution-option > span) {
  min-width: 0;
  white-space: normal;
}

:global(.remote-desktop-resolution-option small) {
  flex: 0 0 auto;
  text-align: right;
  white-space: nowrap;
}

:global(.remote-desktop-connection-option) {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

:global(.remote-desktop-connection-option > span) {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}

:global(.remote-desktop-connection-option small) {
  line-height: 16px;
  overflow-wrap: anywhere;
  white-space: normal;
}

:global(.remote-desktop-actions-hint) {
  box-sizing: border-box;
  margin: 0;
  padding: 3px 8px 7px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
  overflow-wrap: anywhere;
  white-space: normal;
}

:global(.remote-desktop-menu-value) {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.remote-desktop-menu-danger) {
  color: var(--status-danger);
}

:global(.remote-desktop-menu-danger:focus) {
  background: var(--status-danger-bg);
  color: var(--status-danger);
}

.remote-desktop-state {
  display: inline-flex;
  gap: 5px;
  height: 22px;
  padding: 0 7px;
  border-color: var(--line);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  line-height: 20px;
}

.remote-desktop-state-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
}

.remote-desktop-state[data-tone="active"] {
  border-color: color-mix(in srgb, var(--status-success) 36%, var(--line));
  background: var(--status-success-bg);
  color: var(--status-success);
}

.remote-desktop-state[data-tone="warning"] {
  border-color: color-mix(in srgb, var(--status-warning) 40%, var(--line));
  background: var(--status-warning-bg);
  color: var(--status-warning);
}

.remote-desktop-state[data-tone="danger"] {
  border-color: color-mix(in srgb, var(--status-danger) 34%, var(--line));
  background: var(--status-danger-bg);
  color: var(--status-danger);
}

.remote-desktop-error-banner {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 13px;
  border-bottom: 1px solid color-mix(in srgb, var(--status-danger) 24%, var(--line-subtle));
  background: var(--status-danger-bg);
  color: var(--status-danger);
  font-size: 12px;
  line-height: 17px;
}

.remote-desktop-error-banner > svg {
  flex: 0 0 auto;
  margin-top: 1px;
}

.remote-desktop-unavailable {
  display: grid;
  flex: 1 1 auto;
  place-items: center;
  align-content: center;
  gap: 6px;
  min-height: 150px;
  padding: 24px;
  color: var(--text-muted);
  text-align: center;
}

.remote-desktop-unavailable-icon {
  width: 42px;
  height: 42px;
  margin-bottom: 2px;
  border: 1px solid var(--line-subtle);
  border-radius: 12px;
  color: var(--text-subtle);
  background: var(--surface-inset);
}

.remote-desktop-unavailable strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.remote-desktop-unavailable span:last-child {
  max-width: 420px;
  font-size: 12px;
  line-height: 18px;
}

.remote-desktop-setup {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 286px);
  min-height: 0;
  overflow: auto;
}

.remote-desktop-setup-main {
  min-width: 0;
  padding: 13px;
}

.remote-desktop-section-heading,
.remote-desktop-sources-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.remote-desktop-section-heading {
  margin-bottom: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.remote-desktop-section-heading strong,
.remote-desktop-sources-head strong {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
}

.remote-desktop-section-heading span,
.remote-desktop-sources-head span {
  color: var(--text-subtle);
  font-size: 12px;
  font-weight: 400;
}

.remote-desktop-targets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.remote-desktop-target {
  display: flex;
  height: auto;
  min-height: 70px;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 10px;
  padding: 10px;
  border-color: var(--line-subtle);
  background: var(--surface-inset);
  color: var(--text);
  text-align: left;
  white-space: normal;
}

.remote-desktop-target:hover:not(:disabled),
.remote-desktop-target:focus-visible {
  border-color: var(--line-strong);
  background: var(--surface-hover);
}

.remote-desktop-target.selected {
  border-color: color-mix(in srgb, var(--brand-accent) 58%, var(--line));
  background: color-mix(in srgb, var(--brand-accent-soft) 72%, var(--surface-inset));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand-accent) 24%, transparent);
}

.remote-desktop-target-icon {
  width: 31px;
  height: 31px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 20%, var(--line-subtle));
  border-radius: 8px;
}

.remote-desktop-target-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.remote-desktop-target-copy strong {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}

.remote-desktop-target-copy small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}

.remote-desktop-sources {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px solid var(--line-subtle);
}

.remote-desktop-sources-head {
  margin-bottom: 8px;
}

.remote-desktop-sources-head > div {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.remote-desktop-source-search {
  position: relative;
  display: block;
}

.remote-desktop-source-search > svg {
  position: absolute;
  top: 50%;
  left: 10px;
  z-index: 1;
  color: var(--text-subtle);
  transform: translateY(-50%);
}

.remote-desktop-source-search :deep(input) {
  height: 32px;
  padding-left: 30px;
  border-color: var(--line-subtle);
  background: var(--surface-inset);
  font-size: 12px;
}

.remote-desktop-source-scroll {
  height: clamp(116px, 21vh, 214px);
  margin-top: 7px;
  padding-right: 4px;
}

.remote-desktop-source-list {
  display: grid;
  gap: 2px;
}

.remote-desktop-source-row {
  display: flex;
  width: 100%;
  height: auto;
  min-height: 40px;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 6px 8px;
  color: var(--text);
  text-align: left;
  white-space: normal;
}

.remote-desktop-source-row:hover:not(:disabled),
.remote-desktop-source-row:focus-visible {
  background: var(--surface-hover);
}

.remote-desktop-source-row.selected {
  background: var(--brand-accent-soft);
  color: var(--text-strong);
}

.remote-desktop-source-icon {
  display: inline-flex;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-subtle);
  border-radius: 7px;
  color: var(--text-muted);
  background: var(--surface-raised);
}

.remote-desktop-source-copy {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  gap: 1px;
}

.remote-desktop-source-copy strong,
.remote-desktop-source-copy small,
.remote-desktop-source-meta,
.remote-desktop-source-meta small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remote-desktop-source-copy strong {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}

.remote-desktop-source-copy small,
.remote-desktop-source-meta {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 15px;
}

.remote-desktop-source-meta {
  display: grid;
  flex: 0 0 auto;
  justify-items: end;
  max-width: 42%;
  color: var(--text-subtle);
  text-align: right;
}

.remote-desktop-source-meta small {
  color: var(--status-warning);
}

.remote-desktop-source-state {
  display: flex;
  min-height: 82px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

.remote-desktop-source-state-error {
  flex-wrap: wrap;
  color: var(--status-danger);
}

.remote-desktop-source-hint {
  margin: 6px 0 0;
  color: var(--text-subtle);
  font-size: 12px;
  line-height: 16px;
}

.remote-desktop-connect-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 13px;
  border-left: 1px solid var(--line-subtle);
  background: color-mix(in srgb, var(--surface-inset) 74%, var(--surface-raised));
}

.remote-desktop-connect-preview {
  display: grid;
  gap: 5px;
  padding: 12px;
  border: 1px solid var(--line-subtle);
  border-radius: 10px;
  background: var(--surface-raised);
  box-shadow: 0 1px 2px var(--workspace-grid);
}

.remote-desktop-preview-icon {
  width: 34px;
  height: 34px;
  margin-bottom: 4px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 24%, var(--line-subtle));
  border-radius: 9px;
}

.remote-desktop-preview-kicker {
  color: var(--brand-accent-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}

.remote-desktop-connect-preview > strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 500;
  line-height: 19px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remote-desktop-connect-preview > p {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 17px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.remote-desktop-capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 2px;
}

.remote-desktop-capabilities > span {
  padding: 2px 6px;
  border: 1px solid var(--line-subtle);
  border-radius: 5px;
  color: var(--text-muted);
  background: var(--surface-inset);
  font-size: 12px;
  line-height: 16px;
}

.remote-desktop-scope-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 17px;
}

.remote-desktop-scope-note > svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--text-subtle);
}

.remote-desktop-connect-footer {
  display: grid;
  gap: 7px;
  margin-top: auto;
}

.remote-desktop-connect-hint {
  margin: 0;
  color: var(--text-subtle);
  font-size: 12px;
  line-height: 16px;
}

.remote-desktop-connect-button {
  width: 100%;
}

.remote-desktop-setup-methods {
  display: grid;
  width: 100%;
  height: auto;
  min-height: 32px;
  grid-template-areas:
    "icon label chevron"
    "icon summary chevron";
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  justify-content: stretch;
  column-gap: 7px;
  row-gap: 1px;
  padding: 6px 9px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  text-align: left;
}

.remote-desktop-setup-methods > svg:first-child {
  grid-area: icon;
}

.remote-desktop-setup-methods > svg:last-child {
  grid-area: chevron;
}

.remote-desktop-setup-methods > span {
  grid-area: label;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remote-desktop-setup-methods > small {
  grid-area: summary;
  color: var(--text-subtle);
  font-size: 12px;
  font-weight: 400;
  text-align: left;
}

.remote-desktop-stage {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  background: var(--surface-inset);
}

.remote-desktop-stage-setup {
  overflow: hidden;
}

.remote-desktop-scope-trigger {
  display: flex;
  width: auto;
  max-width: min(280px, 42vw);
  height: auto;
  min-height: 32px;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  padding: 3px 6px 3px 4px;
  border-color: transparent;
  background: transparent;
  color: var(--text);
  text-align: left;
  white-space: nowrap;
}

.remote-desktop-scope-trigger:hover:not(:disabled),
.remote-desktop-scope-trigger:focus-visible {
  border-color: var(--line-subtle);
  background: var(--surface-hover);
}

.remote-desktop-scope-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.remote-desktop-scope-title strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remote-desktop-scope-title > svg {
  flex: 0 0 auto;
  color: var(--text-subtle);
}

.remote-desktop-scope-popover {
  display: flex;
  width: min(360px, var(--reka-popover-content-available-width));
  max-height: var(--reka-popover-content-available-height);
  flex-direction: column;
  overflow: hidden;
}

.remote-desktop-scope-head {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 12px 9px;
  border-bottom: 1px solid var(--line-subtle);
}

.remote-desktop-scope-head > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.remote-desktop-scope-head strong {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
  line-height: 17px;
}

.remote-desktop-scope-head p,
.remote-desktop-scope-unavailable {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 17px;
}

.remote-desktop-scope-scroll {
  flex: 1 1 auto;
  min-height: 0;
  max-height: min(310px, calc(var(--reka-popover-content-available-height) - 75px));
  padding: 5px;
}

.remote-desktop-scope-options {
  display: grid;
  gap: 2px;
}

.remote-desktop-scope-option {
  display: flex;
  width: 100%;
  height: auto;
  min-height: 46px;
  align-items: center;
  justify-content: flex-start;
  gap: 9px;
  padding: 7px 8px;
  color: var(--text);
  text-align: left;
  white-space: normal;
}

.remote-desktop-scope-option:hover:not(:disabled),
.remote-desktop-scope-option:focus-visible {
  background: var(--surface-hover);
}

.remote-desktop-scope-option.selected {
  background: var(--brand-accent-soft);
}

.remote-desktop-scope-option > svg:last-child {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--brand-accent-muted);
}

.remote-desktop-scope-option-icon {
  display: inline-flex;
  flex: 0 0 auto;
  width: 27px;
  height: 27px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-subtle);
  border-radius: 7px;
  color: var(--text-muted);
  background: var(--surface-raised);
}

.remote-desktop-scope-option-copy {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  gap: 1px;
}

.remote-desktop-scope-option-copy strong,
.remote-desktop-scope-option-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remote-desktop-scope-option-copy strong {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}

.remote-desktop-scope-option-copy small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}

.remote-desktop-scope-group {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 4px 3px;
  color: var(--text-subtle);
  font-size: 12px;
  line-height: 16px;
}

.remote-desktop-scope-state {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

.remote-desktop-scope-state-error {
  flex-wrap: wrap;
  color: var(--status-danger);
}

.remote-desktop-scope-unavailable {
  margin: 3px 3px 5px;
  padding: 9px;
  border: 1px solid var(--line-subtle);
  border-radius: 8px;
  background: var(--surface-inset);
}

.remote-desktop-idle-deadline {
  color: var(--status-warning);
}

.remote-desktop-surface {
  position: relative;
  flex: 1 1 auto;
  min-height: 210px;
  overflow: hidden;
  background: #050506;
  cursor: none;
  outline: none;
}

.remote-desktop-surface.remote-desktop-system-cursor,
.remote-desktop-surface.remote-desktop-system-cursor video,
.remote-desktop-surface.remote-desktop-system-cursor canvas {
  cursor: default;
}

.remote-desktop-surface:focus-visible {
  box-shadow: inset 0 0 0 2px var(--brand-accent);
}

.remote-desktop-surface video,
.remote-desktop-surface canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: none;
  object-fit: contain;
}

.remote-desktop-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 7px;
  padding: 24px;
  color: rgb(255 255 255 / 86%);
  background: rgb(5 5 6 / 76%);
  text-align: center;
}

.remote-desktop-overlay strong {
  font-size: 13px;
  font-weight: 500;
}

.remote-desktop-overlay span {
  max-width: 420px;
  color: rgb(255 255 255 / 62%);
  font-size: 12px;
  line-height: 17px;
}

.remote-desktop-view-only {
  position: absolute;
  bottom: 10px;
  left: 10px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 7px;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 6px;
  color: rgb(255 255 255 / 78%);
  background: rgb(5 5 6 / 66%);
  font-size: 12px;
  line-height: 16px;
  backdrop-filter: blur(8px);
}

.remote-desktop-interaction-hint {
  position: absolute;
  bottom: 42px;
  left: 50%;
  display: inline-flex;
  max-width: min(420px, calc(100% - 24px));
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 11px;
  border: 1px solid rgb(255 255 255 / 16%);
  border-radius: 10px;
  color: rgb(255 255 255 / 88%);
  background: rgb(16 17 20 / 92%);
  font-size: 12px;
  line-height: 16px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 32%);
  transform: translateX(-50%);
  animation: remote-desktop-hint-in 120ms ease-out;
  backdrop-filter: blur(10px);
}

.remote-desktop-interaction-hint span {
  min-width: 0;
}

@keyframes remote-desktop-hint-in {
  from {
    opacity: 0;
    transform: translate(-50%, 4px);
  }
}

.remote-desktop-switching {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 180px;
  padding: 24px;
  background: var(--surface-inset);
}

.remote-desktop-switching-icon {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 24%, var(--line-subtle));
  border-radius: 10px;
  color: var(--brand-accent-muted);
  background: var(--brand-accent-soft);
}

.remote-desktop-switching-copy {
  display: grid;
  gap: 2px;
}

.remote-desktop-switching-copy strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.remote-desktop-switching-copy span {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 17px;
}

:global(.remote-desktop-spin) {
  animation: remote-desktop-spin 1s linear infinite;
}

.remote-desktop-danger-action {
  background: var(--destructive);
  color: var(--destructive-foreground);
}

.remote-desktop-danger-action:hover {
  background: color-mix(in srgb, var(--destructive) 88%, black);
}

:global(.remote-desktop-clipboard-status) {
  margin: 8px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--line-subtle);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 17px;
  overflow-wrap: anywhere;
  white-space: normal;
}

@keyframes remote-desktop-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  :global(.remote-desktop-spin) {
    animation-duration: 1.8s;
  }
}

@container (max-width: 760px) {
  .remote-desktop-setup {
    grid-template-columns: minmax(0, 1fr);
  }

  .remote-desktop-connect-panel {
    border-top: 1px solid var(--line-subtle);
    border-left: 0;
  }

  .remote-desktop-connect-footer {
    margin-top: 0;
  }

  .remote-desktop-live-meta {
    display: none;
  }

  .remote-desktop-scope-trigger {
    max-width: min(240px, 42vw);
  }
}

@container (max-width: 520px) {
  .remote-desktop-head-actions {
    justify-content: flex-end;
  }

  .remote-desktop-targets {
    grid-template-columns: minmax(0, 1fr);
  }

  .remote-desktop-live-toolbar {
    gap: 4px;
  }

  .remote-desktop-live-main {
    gap: 2px;
  }

  .remote-desktop-scope-trigger {
    max-width: min(190px, 40vw);
  }

  .remote-desktop-action-label,
  .remote-desktop-state-label {
    display: none;
  }

  .remote-desktop-state {
    gap: 0;
    padding: 0 6px;
  }
}
</style>
