import { createApp } from "vue";
import { createPinia } from "pinia";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import { router } from "./router";
import "./styles/app.css";
import { initializeThemePreference } from "./utils/theme";

initializeThemePreference();

const desktopWindow = window as Window & { taskHandoffDesktop?: unknown };
const isDesktopShell = Boolean(desktopWindow.taskHandoffDesktop) || navigator.userAgent.includes("Electron");
if (isDesktopShell && navigator.platform.toLowerCase().includes("mac")) {
  document.documentElement.classList.add("native-macos-titlebar");
}

createApp(App).use(createPinia()).use(VueQueryPlugin).use(router).mount("#app");
