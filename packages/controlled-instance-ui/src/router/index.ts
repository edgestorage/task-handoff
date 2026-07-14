import { createRouter, createWebHistory } from "vue-router";
import DashboardView from "../features/dashboard/DashboardView.vue";
import TriggersView from "../features/triggers/TriggersView.vue";
import AppsView from "../features/apps/AppsView.vue";
import { publicBasePath } from "../api/base";

export const router = createRouter({
  history: createWebHistory(publicBasePath() || "/"),
  routes: [
    { path: "/", component: DashboardView },
    { path: "/triggers", component: TriggersView },
    { path: "/apps", component: AppsView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
