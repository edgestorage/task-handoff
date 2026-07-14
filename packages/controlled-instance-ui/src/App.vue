<template>
  <ControlledInstanceShell />
  <Toaster position="top-right" rich-colors />
</template>

<script setup lang="ts">
import ControlledInstanceShell from "./apps/controlled-instance/ControlledInstanceShell.vue";
import { Toaster } from "./components/ui/sonner";
</script>
