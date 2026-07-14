import { createRouter, createWebHistory } from "vue-router";
import DashboardView from "../features/dashboard/DashboardView.vue";
import ChannelsView from "../features/channels/ChannelsView.vue";
import ConversationsView from "../features/conversations/ConversationsView.vue";
import TasksView from "../features/tasks/TasksView.vue";
import TriggersView from "../features/triggers/TriggersView.vue";
import AppsView from "../features/apps/AppsView.vue";
import SettingsView from "../features/settings/SettingsView.vue";
import { publicBasePath } from "../api/base";

export const router = createRouter({
  history: createWebHistory(publicBasePath() || "/"),
  routes: [
    { path: "/", component: DashboardView },
    { path: "/channels", component: ChannelsView },
    { path: "/conversations", component: ConversationsView },
    { path: "/tasks", component: TasksView },
    { path: "/triggers", component: TriggersView },
    { path: "/apps", component: AppsView },
    { path: "/settings", component: SettingsView },
  ],
});
