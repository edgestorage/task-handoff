import { computed, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { bindAiSessionTrigger, unbindAiSessionTrigger, useControlPlaneTriggersQuery } from "../../../api/queries";
import type { AiBoardCard } from "./aiBoardTypes";
import { isAiSessionTriggerDeployment, removeInstanceTriggerBinding, upsertInstanceTriggerBinding } from "../instanceTriggerCache.ts";

export function useAiBoardTriggers() {
  const queryClient = useQueryClient();
  const triggerBusyKey = ref("");
  const triggers = useControlPlaneTriggersQuery();
  const triggerTemplates = computed(() => triggers.data.value?.triggers || []);

  function boundTriggers(card: AiBoardCard) {
    return (card.instance.triggers?.configs || []).flatMap((entry) => entry.deployments.filter((deployment) => isAiSessionTriggerDeployment(deployment, card.session.id)));
  }

  function isTriggerBound(card: AiBoardCard, configHash: string) {
    return boundTriggers(card).some((deployment) => deployment.configHash === configHash);
  }

  function triggerActionKey(card: AiBoardCard, configHash: string) {
    return `${card.instance.id}:${card.session.id}:${configHash}`;
  }

  async function toggleTrigger(card: AiBoardCard, configHash: string) {
    const key = triggerActionKey(card, configHash);
    if (triggerBusyKey.value) {
      return;
    }
    triggerBusyKey.value = key;
    try {
      if (isTriggerBound(card, configHash)) {
        await unbindAiSessionTrigger(card.instance.id, card.session.id, configHash);
        removeInstanceTriggerBinding(queryClient, card.instance.id, card.session.id, configHash);
      } else {
        const created = await bindAiSessionTrigger(card.instance.id, card.session.id, configHash);
        upsertInstanceTriggerBinding(queryClient, card.instance.id, created);
      }
      await queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] });
    } finally {
      triggerBusyKey.value = "";
    }
  }

  return {
    boundTriggers,
    isTriggerBound,
    shortHash,
    toggleTrigger,
    triggerActionKey,
    triggerBusyKey,
    triggerTemplates,
  };
}

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}...` : value;
}
