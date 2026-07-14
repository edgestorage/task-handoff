<template>
  <section class="panel channels-panel">
    <div class="panel-title-row">
      <div>
        <p class="panel-kicker">Integration endpoints</p>
        <h1>Channels</h1>
      </div>
      <Badge variant="outline">{{ channels.data.value?.length || 0 }} configured</Badge>
    </div>
    <div class="channel-grid">
      <Card v-for="channel in channels.data.value || []" :key="`${channel.channel}:${channel.instanceId}`" :class="channelCardClass(channel.channel)">
        <CardHeader class="channel-header">
          <div class="channel-identity">
            <span class="channel-glyph">{{ channelInitial(channel.channel) }}</span>
            <div>
              <CardTitle>{{ channelTitle(channel.channel) }}</CardTitle>
              <CardDescription>{{ channel.instanceId }}</CardDescription>
            </div>
          </div>
          <Badge :variant="formFor(channel).enabled ? 'default' : 'secondary'" class="channel-status">{{ formFor(channel).enabled ? "online" : "offline" }}</Badge>
        </CardHeader>
        <CardContent class="channel-form">
          <label class="field-row checkbox-row channel-toggle">
            <Checkbox :checked="formFor(channel).enabled" @update:checked="(value) => (formFor(channel).enabled = Boolean(value))" />
            <span>Accept incoming messages</span>
          </label>
          <label class="field-row">
            <span>Default Chat ID</span>
            <Input v-model="formFor(channel).defaultChatId" placeholder="chat id / conversation id" />
          </label>
          <label class="field-row">
            <span>Allowed User IDs</span>
            <Input v-model="formFor(channel).allowedUserIdsText" placeholder="comma separated user ids" />
          </label>
          <div v-for="secret in secretFields(channel.channel)" :key="secret.key" class="field-row secret-row">
            <span>{{ secret.label }}</span>
            <Input
              :model-value="formFor(channel).secrets[secret.key]"
              :placeholder="secretPlaceholder(channel, secret.key)"
              type="password"
              autocomplete="off"
              @update:model-value="(value) => updateSecret(channel, secret.key, String(value || ''))"
            />
            <label v-if="channel.secrets?.[secret.key]?.configured" class="checkbox-row clear-secret-row">
              <Checkbox :checked="formFor(channel).clearSecrets[secret.key]" @update:checked="(value) => (formFor(channel).clearSecrets[secret.key] = Boolean(value))" />
              <span>Clear configured secret</span>
            </label>
          </div>
        </CardContent>
        <CardFooter class="channel-actions">
          <div class="channel-feedback">
            <p v-if="savedKey === keyFor(channel)" class="save-ok">Saved</p>
            <p v-if="errorByKey[keyFor(channel)]" class="form-error">{{ errorByKey[keyFor(channel)] }}</p>
          </div>
          <Button size="sm" class="channel-save" @click="save(channel)">Save</Button>
        </CardFooter>
      </Card>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { reactive, ref, watchEffect } from "vue";
import { saveChannel, useChannelsQuery } from "../../api/queries";
import type { ChannelView } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";

type ChannelForm = {
  enabled: boolean;
  defaultChatId: string;
  allowedUserIdsText: string;
  secrets: Record<string, string>;
  clearSecrets: Record<string, boolean>;
};

const queryClient = useQueryClient();
const channels = useChannelsQuery();
const forms = reactive<Record<string, ChannelForm>>({});
const errorByKey = reactive<Record<string, string>>({});
const savedKey = ref("");

watchEffect(() => {
  for (const channel of channels.data.value || []) {
    const key = keyFor(channel);
    if (!forms[key]) {
      forms[key] = {
        enabled: channel.enabled,
        defaultChatId: channel.defaultChatId || "",
        allowedUserIdsText: (channel.allowedUserIds || []).join(", "),
        secrets: Object.fromEntries(secretFields(channel.channel).map((secret) => [secret.key, ""])),
        clearSecrets: Object.fromEntries(secretFields(channel.channel).map((secret) => [secret.key, false])),
      };
    }
  }
});

function keyFor(channel: ChannelView) {
  return `${channel.channel}:${channel.instanceId}`;
}

function formFor(channel: ChannelView) {
  const key = keyFor(channel);
  if (!forms[key]) {
    forms[key] = { enabled: false, defaultChatId: "", allowedUserIdsText: "", secrets: {}, clearSecrets: {} };
  }
  return forms[key];
}

function channelTitle(channel: ChannelView["channel"]) {
  return {
    telegram: "Telegram",
    wechat: "WeChat",
    dingding: "DingTalk",
  }[channel];
}

function channelInitial(channel: ChannelView["channel"]) {
  return {
    telegram: "TG",
    wechat: "WX",
    dingding: "DT",
  }[channel];
}

function channelCardClass(channel: ChannelView["channel"]) {
  return `channel-card channel-card-${channel}`;
}

function secretFields(channel: ChannelView["channel"]) {
  return {
    telegram: [{ key: "botToken", label: "Bot Token" }],
    wechat: [
      { key: "token", label: "Bot Token" },
      { key: "baseUrl", label: "Base URL" },
      { key: "contextToken", label: "Context Token" },
    ],
    dingding: [
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client Secret" },
      { key: "corpId", label: "Corp ID" },
      { key: "robotCode", label: "Robot Code" },
      { key: "cardTemplateId", label: "Card Template ID" },
      { key: "cardCallbackRouteKey", label: "Card Callback Route Key" },
    ],
  }[channel];
}

function secretPlaceholder(channel: ChannelView, key: string) {
  const secret = channel.secrets?.[key];
  return secret?.configured ? `Configured (${secret.preview || "hidden"})` : "Not configured";
}

function updateSecret(channel: ChannelView, key: string, value: string) {
  const form = formFor(channel);
  form.secrets[key] = value;
  if (value.trim()) {
    form.clearSecrets[key] = false;
  }
}

async function save(channel: ChannelView) {
  const key = keyFor(channel);
  errorByKey[key] = "";
  savedKey.value = "";
  const form = formFor(channel);
  const secrets = {
    ...Object.fromEntries(Object.entries(form.secrets).filter(([, value]) => value.trim())),
    ...Object.fromEntries(Object.entries(form.clearSecrets).filter(([, value]) => value).map(([secret]) => [secret, null])),
  };
  try {
    await saveChannel(channel.channel, channel.instanceId, {
      enabled: form.enabled,
      defaultChatId: form.defaultChatId.trim() || null,
      allowedUserIds: form.allowedUserIdsText
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      secrets: Object.keys(secrets).length ? secrets : undefined,
    });
    for (const secret of Object.keys(form.secrets)) {
      form.secrets[secret] = "";
      form.clearSecrets[secret] = false;
    }
    savedKey.value = key;
    await queryClient.invalidateQueries({ queryKey: ["channels"] });
  } catch (error) {
    errorByKey[key] = error instanceof Error ? error.message : String(error);
  }
}
</script>

<style src="../../styles/features/channels.css"></style>
