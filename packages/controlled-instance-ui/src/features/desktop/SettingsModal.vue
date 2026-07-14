<template>
  <Dialog :open="true" @update:open="(open) => !open && $emit('close')">
    <DialogContent class="settings-modal gap-0 p-0" style="width: min(1280px, calc(100vw - 48px)); max-width: calc(100vw - 48px)">
      <header class="modal-header">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription class="sr-only">Configure the controlled instance, integrations, applications, and sessions.</DialogDescription>
      </header>
      <Tabs :model-value="activeSection" class="settings-modal-body" orientation="vertical" @update:model-value="setActiveSection">
        <TabsList class="settings-nav">
          <TabsTrigger v-for="item in sections" :key="item.id" :value="item.id" :class="{ active: activeSection === item.id }" @click="activeSection = item.id">
            {{ item.label }}
          </TabsTrigger>
        </TabsList>
        <ScrollArea class="settings-content">
          <main class="settings-content-inner">
          <TabsContent value="general"><DashboardView /></TabsContent>
          <TabsContent value="channels"><ChannelsView /></TabsContent>
          <TabsContent value="conversations"><ConversationsView /></TabsContent>
          <TabsContent value="tasks"><TasksView /></TabsContent>
          <TabsContent value="apps"><CustomAppsSettings /></TabsContent>
          <TabsContent value="sessions"><SessionsSettings /></TabsContent>
          <TabsContent value="settings"><SettingsView /></TabsContent>
          </main>
        </ScrollArea>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import ChannelsView from "../channels/ChannelsView.vue";
import ConversationsView from "../conversations/ConversationsView.vue";
import DashboardView from "../dashboard/DashboardView.vue";
import SettingsView from "../settings/SettingsView.vue";
import TasksView from "../tasks/TasksView.vue";
import CustomAppsSettings from "./CustomAppsSettings.vue";
import SessionsSettings from "./SessionsSettings.vue";

const props = defineProps<{
  section: string;
}>();

defineEmits<{
  close: [];
}>();

const activeSection = ref(props.section || "general");
const sections = [
  { id: "general", label: "General" },
  { id: "channels", label: "Channels" },
  { id: "conversations", label: "Conversations" },
  { id: "tasks", label: "Tasks" },
  { id: "apps", label: "Apps" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
];

function setActiveSection(section: string | number) {
  activeSection.value = String(section);
}

watch(
  () => props.section,
  (section) => {
    activeSection.value = section || "general";
  },
);
</script>

<style src="../../styles/layout/modal.css"></style>
