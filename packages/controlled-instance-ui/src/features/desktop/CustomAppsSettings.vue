<template>
  <section class="settings-pane">
    <div class="section-head">
      <h2>Custom Apps</h2>
      <span v-if="customCatalog.data.value">{{ customCatalog.data.value.path }}</span>
    </div>
    <Card>
      <CardContent>
        <div class="custom-app-form">
          <Input v-model="form.id" placeholder="id" />
          <Input v-model="form.name" placeholder="name" />
          <Textarea v-model="form.description" class="launch-json" spellcheck="false" placeholder="description" />
          <Select v-model="form.kind">
            <SelectTrigger class="native-select"><SelectValue placeholder="App kind" /></SelectTrigger>
            <SelectContent><SelectItem value="tty">TTY</SelectItem><SelectItem value="gui">GUI</SelectItem></SelectContent>
          </Select>
          <Input v-model="form.command" placeholder="/usr/bin/app" />
          <Input v-model="form.args" placeholder='args, e.g. --new-window "https://example.com"' />
          <Input v-model="form.cwd" placeholder="/workspace" />
          <Textarea v-model="form.envJson" class="launch-json" spellcheck="false" placeholder='env JSON, e.g. {"LANG":"C.UTF-8"}' />
          <div v-if="form.kind === 'gui'" class="display-fields">
            <Input v-model="form.width" inputmode="numeric" placeholder="width" />
            <Input v-model="form.height" inputmode="numeric" placeholder="height" />
            <Input v-model="form.depth" inputmode="numeric" placeholder="depth" />
          </div>
          <div class="catalog-actions">
            <Button size="sm" @click="saveForm">{{ editingId ? "Update App" : "Add App" }}</Button>
            <Button v-if="editingId" variant="outline" size="sm" @click="resetForm">Cancel</Button>
          </div>
        </div>
      </CardContent>
      <CardContent>
        <Textarea v-model="catalogText" class="catalog-json" spellcheck="false" />
        <p v-if="loadError" class="form-error">{{ loadError }}</p>
      </CardContent>
      <CardFooter class="editor-actions">
        <Button variant="outline" size="sm" @click="resetCatalog">Reset</Button>
        <Button size="sm" @click="saveCatalog">Save</Button>
      </CardFooter>
      <CardContent v-if="error">
        <p class="form-error">{{ error }}</p>
      </CardContent>
    </Card>
    <div class="settings-list">
      <Card v-for="app in customCatalog.data.value?.items || []" :key="app.id">
        <CardContent class="catalog-item">
          <div class="catalog-head">
            <div>
              <div class="item-title">{{ app.name }}</div>
              <div class="item-meta">
                <Badge variant="secondary">{{ app.kind }}</Badge>
                <span>{{ app.command }}</span>
              </div>
            </div>
            <div class="catalog-actions">
              <Button variant="outline" size="sm" @click="edit(app)">Edit</Button>
              <Button variant="outline" size="sm" @click="remove(app.id)">Remove</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { saveCustomAppCatalog, useCustomAppCatalogQuery } from "../../api/queries";
import type { AppCatalogItem } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardFooter } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";

type CustomAppForm = {
  id: string;
  name: string;
  description: string;
  kind: "tty" | "gui";
  command: string;
  args: string;
  cwd: string;
  envJson: string;
  width: string;
  height: string;
  depth: string;
};

const queryClient = useQueryClient();
const customCatalog = useCustomAppCatalogQuery();
const catalogText = ref("[]");
const error = ref("");
const editingId = ref("");
const form = reactive<CustomAppForm>({
  id: "",
  name: "",
  description: "",
  kind: "tty",
  command: "",
  args: "",
  cwd: "",
  envJson: "{}",
  width: "",
  height: "",
  depth: "",
});

const loadError = computed(() => {
  const queryError = customCatalog.error.value;
  return queryError ? `Custom app catalog is invalid: ${queryError instanceof Error ? queryError.message : String(queryError)}` : "";
});

watch(
  () => customCatalog.data.value?.items,
  (items) => {
    catalogText.value = JSON.stringify(items || [], null, 2);
  },
  { immediate: true },
);

function parsedJson<T>(value: string, fallback: T, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (parseError) {
    throw new Error(`${label} is invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
  }
}

function numberFromInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Display values must be positive integers.");
  }
  return parsed;
}

function shellSplit(value: string) {
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((match) => match.replace(/^(['"])(.*)\1$/, "$2"));
}

function catalogItems() {
  const parsed = JSON.parse(catalogText.value || "[]");
  if (!Array.isArray(parsed)) {
    throw new Error("Custom Apps JSON must be an array.");
  }
  return parsed as AppCatalogItem[];
}

function appFromForm(): AppCatalogItem {
  const id = form.id.trim();
  const name = form.name.trim();
  const command = form.command.trim();
  if (!id || !name || !command) {
    throw new Error("Custom app id, name, and command are required.");
  }
  const app: AppCatalogItem = { id, name, kind: form.kind, command };
  if (form.description.trim()) {
    app.description = form.description.trim();
  }
  const args = shellSplit(form.args);
  if (args.length) {
    app.args = args;
  }
  if (form.cwd.trim()) {
    app.cwd = form.cwd.trim();
  }
  const env = parsedJson<unknown>(form.envJson, {}, "Custom app env");
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((value) => typeof value !== "string")) {
    throw new Error("Custom app env JSON must be an object with string values.");
  }
  if (Object.keys(env).length) {
    app.env = env as Record<string, string>;
  }
  if (form.kind === "gui") {
    const display = {
      width: numberFromInput(form.width),
      height: numberFromInput(form.height),
      depth: numberFromInput(form.depth),
    };
    const cleanDisplay = Object.fromEntries(Object.entries(display).filter(([, value]) => value !== undefined));
    if (Object.keys(cleanDisplay).length) {
      app.display = cleanDisplay;
    }
  }
  return app;
}

function resetForm() {
  editingId.value = "";
  Object.assign(form, { id: "", name: "", description: "", kind: "tty", command: "", args: "", cwd: "", envJson: "{}", width: "", height: "", depth: "" });
}

function edit(app: AppCatalogItem) {
  editingId.value = app.id;
  Object.assign(form, {
    id: app.id,
    name: app.name,
    description: app.description || "",
    kind: app.kind === "gui" ? "gui" : "tty",
    command: app.command || "",
    args: (app.args || []).map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" "),
    cwd: app.cwd || "",
    envJson: JSON.stringify(app.env || {}, null, 2),
    width: app.display?.width === undefined ? "" : String(app.display.width),
    height: app.display?.height === undefined ? "" : String(app.display.height),
    depth: app.display?.depth === undefined ? "" : String(app.display.depth),
  });
}

async function saveForm() {
  error.value = "";
  try {
    const items = catalogItems();
    const app = appFromForm();
    if (!editingId.value && items.some((item) => item.id === app.id)) {
      throw new Error("Custom app id already exists.");
    }
    if (editingId.value && app.id !== editingId.value && items.some((item) => item.id === app.id)) {
      throw new Error("Custom app id already exists.");
    }
    const next = editingId.value ? items.map((item) => (item.id === editingId.value ? app : item)) : [...items, app];
    await saveCustomAppCatalog(next);
    catalogText.value = JSON.stringify(next, null, 2);
    resetForm();
    await queryClient.invalidateQueries({ queryKey: ["app-catalog"] });
    await queryClient.invalidateQueries({ queryKey: ["app-catalog-custom"] });
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  }
}

async function remove(appId: string) {
  error.value = "";
  try {
    const next = catalogItems().filter((app) => app.id !== appId);
    await saveCustomAppCatalog(next);
    catalogText.value = JSON.stringify(next, null, 2);
    if (editingId.value === appId) {
      resetForm();
    }
    await queryClient.invalidateQueries({ queryKey: ["app-catalog"] });
    await queryClient.invalidateQueries({ queryKey: ["app-catalog-custom"] });
  } catch (removeError) {
    error.value = removeError instanceof Error ? removeError.message : String(removeError);
  }
}

function resetCatalog() {
  error.value = "";
  catalogText.value = JSON.stringify(customCatalog.data.value?.items || [], null, 2);
}

async function saveCatalog() {
  error.value = "";
  try {
    await saveCustomAppCatalog(catalogItems());
    await queryClient.invalidateQueries({ queryKey: ["app-catalog"] });
    await queryClient.invalidateQueries({ queryKey: ["app-catalog-custom"] });
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  }
}
</script>

<style src="../../styles/features/apps/custom-apps-settings.css"></style>
