import { createApp } from "vue";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import { i18n, initializeControlPlaneI18n } from "./i18n";
import "./styles/app.css";
import { initializeThemePreference } from "./utils/theme";

initializeThemePreference();
initializeControlPlaneI18n();
if (navigator.platform.toLowerCase().includes("mac")) {
  document.documentElement.classList.add("native-macos-titlebar");
}

createApp(App).use(i18n).use(VueQueryPlugin).mount("#app");
