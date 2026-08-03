import { createApp } from "vue";
import { VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import { i18n, initializeControlPlaneI18n } from "./i18n";
import "./styles/app.css";
import { initializeThemePreference } from "./utils/theme";

function limitIosViewportScale() {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIos) return;

  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewport) return;

  const directives = viewport.content
    .split(",")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !directive.startsWith("maximum-scale="));
  directives.push("maximum-scale=1");
  viewport.content = directives.join(", ");
}

limitIosViewportScale();
initializeThemePreference();
initializeControlPlaneI18n();
if (navigator.platform.toLowerCase().includes("mac")) {
  document.documentElement.classList.add("native-macos-titlebar");
}

createApp(App).use(i18n).use(VueQueryPlugin).mount("#app");
