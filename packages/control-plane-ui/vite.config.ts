import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/@xterm/")) {
            return "xterm";
          }
          if (id.includes("/reka-ui/") || id.includes("/@vueuse/")) {
            return "ui-vendor";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8081",
        ws: true,
        changeOrigin: true,
      },
      "/instances": {
        target: "http://127.0.0.1:8081",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
