import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AiSessionHistoryItem } from '@task-handoff/protocol/ai-sessions';

import { lifecycleGuidance } from '../../../src/ai-sessions/session-lifecycle';
import { useMobileTheme } from '../../../src/components/theme';
import { createMobileControlPlaneClient } from '../../../src/control-plane/client';
import { mobileProfileStore, mobileSecureStore } from '../../../src/control-plane/runtime';
import { InstanceHistory } from '../../../src/instances/InstanceNativeSections';
import { useI18n } from '../../../src/i18n';

export default function InstanceHistoryRoute() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { instanceId } = useLocalSearchParams<{ instanceId: string }>();
  const [items, setItems] = useState<AiSessionHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    void mobileProfileStore.active().then(async (profile) => {
      if (!profile) throw new Error('No active Control Plane.');
      const result = await createMobileControlPlaneClient(profile, mobileSecureStore).api.aiSessions.history(instanceId);
      if (live) setItems(result.items);
    }).catch((cause) => {
      if (live) setError(lifecycleGuidance(cause).message);
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [instanceId]);

  return <>
    <Stack.Screen options={{ title: t('nav.history') }} />
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{error}</Text> : null}
      {!error ? <InstanceHistory
        items={items}
        loading={loading}
        onOpen={(item) => router.push({ pathname: '/history/[instanceId]/[historyId]', params: { instanceId, historyId: item.id } })}
        standalone
      /> : null}
    </View>
  </>;
}

const styles = StyleSheet.create({
  error: { borderRadius: 12, fontSize: 13, lineHeight: 19, margin: 16, marginBottom: 0, padding: 12 },
  screen: { flex: 1 },
});
