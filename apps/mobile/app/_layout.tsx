import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useMobileTheme } from '../src/components/theme';
import { ActiveAiSessionsProvider } from '../src/ai-sessions/use-active-sessions';
import { MobileI18nProvider, useI18n } from '../src/i18n';

export default function RootLayout() {
  return <MobileI18nProvider><LocalizedRootLayout /></MobileI18nProvider>;
}

function LocalizedRootLayout() {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  return (
    <GestureHandlerRootView style={{ backgroundColor: colors.background, flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar animated style={dark ? 'light' : 'dark'} />
        <ActiveAiSessionsProvider>
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: colors.background },
              headerBackButtonDisplayMode: 'minimal',
              headerShadowVisible: false,
              headerStyle: { backgroundColor: colors.surface },
              headerTintColor: colors.primary,
              headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: '600' },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="profiles" options={{ title: t('nav.controlPlanes') }} />
            <Stack.Screen name="control-planes/add" options={{ title: t('nav.addControlPlane') }} />
            <Stack.Screen name="control-planes/[controlPlaneId]" options={{ title: t('nav.controlPlane') }} />
            <Stack.Screen name="nodes/[nodeId]" options={{ title: t('nav.node') }} />
            <Stack.Screen name="instances/[instanceId]" options={{ title: t('nav.instance') }} />
            <Stack.Screen name="sessions/new" options={{ title: t('nav.newSession') }} />
            <Stack.Screen name="sessions/[instanceId]/[sessionId]" options={{ title: t('nav.aiSession') }} />
            <Stack.Screen name="history/[instanceId]/[historyId]" options={{ title: t('nav.sessionHistory') }} />
          </Stack>
        </ActiveAiSessionsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
