import { createApp } from "vue";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import "./styles/app.css";
import { initializeThemePreference } from "./utils/theme";

initializeThemePreference();
if (navigator.platform.toLowerCase().includes("mac")) {
  document.documentElement.classList.add("native-macos-titlebar");
}

createApp(App).use(VueQueryPlugin).mount("#app");
