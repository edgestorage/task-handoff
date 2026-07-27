<template>
  <AiSessionCodeBlock
    v-if="node.type === 'code_block'"
    v-bind="$attrs"
    :node="node"
  />
  <AiSessionAnimatedTextNode
    v-else
    v-bind="$attrs"
    :node="node"
  />
</template>

<script setup lang="ts">
import AiSessionAnimatedTextNode from "./AiSessionAnimatedTextNode.vue";
import AiSessionCodeBlock from "./AiSessionCodeBlock.vue";

defineOptions({ inheritAttrs: false });

type MarkdownTextNode = {
  type: "text";
  content: string;
  raw: string;
  center?: boolean;
};

type MarkdownCodeBlockNode = {
  type: "code_block";
  code?: unknown;
  language?: unknown;
  raw?: unknown;
};

defineProps<{
  node: MarkdownTextNode | MarkdownCodeBlockNode;
}>();
</script>
