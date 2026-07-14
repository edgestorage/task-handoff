import { defineStore } from "pinia";

const STORAGE_KEY = "task-handoff-web-token";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    token: localStorage.getItem(STORAGE_KEY) || "",
  }),
  actions: {
    setToken(token: string) {
      this.token = token;
      if (token) {
        localStorage.setItem(STORAGE_KEY, token);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    },
  },
});
