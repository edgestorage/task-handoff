import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { MobileThemeProvider, useMobileTheme } from '../src/components/theme';
import { iosTransparentHeaderOptions } from '../src/components/navigation-header';
import { ActiveAiSessionsProvider } from '../src/ai-sessions/use-active-sessions';
import { ActiveAppSessionsProvider } from '../src/app-sessions/use-active-app-sessions';
import { ActiveDirectoriesProvider } from '../src/directories/use-directories';
import { InstanceScopeProvider } from '../src/instance-scope/use-instance-scope';
import { MobileI18nProvider, useI18n } from '../src/i18n';
import { TaskStatusSurface } from '../src/task-status/TaskStatusSurface';
import { TaskStatusSettingsProvider } from '../src/task-status/settings';
import { CarPlaySurface } from '../src/carplay/CarPlaySurface';

export default function RootLayout() {
  return <MobileThemeProvider><MobileI18nProvider><TaskStatusSettingsProvider><LocalizedRootLayout /></TaskStatusSettingsProvider></MobileI18nProvider></MobileThemeProvider>;
}

function LocalizedRootLayout() {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  return (
    <GestureHandlerRootView style={{ backgroundColor: colors.background, flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar animated style={dark ? 'light' : 'dark'} />
        <ActiveDirectoriesProvider>
        <InstanceScopeProvider>
        <ActiveAiSessionsProvider>
        <ActiveAppSessionsProvider>
          <TaskStatusSurface />
          <CarPlaySurface />
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
            <Stack.Screen name="profiles" options={{ headerShown: false, title: t('nav.settings') }} />
            <Stack.Screen name="control-planes/add" options={{ title: t('nav.addControlPlane') }} />
            <Stack.Screen name="control-planes/[controlPlaneId]" options={{ title: t('nav.controlPlane') }} />
            <Stack.Screen name="nodes/[nodeId]" options={{ title: t('nav.node') }} />
            <Stack.Screen name="instances/[instanceId]" options={{ title: t('nav.instance') }} />
            <Stack.Screen name="sessions/new" options={{ title: t('nav.newSession') }} />
            <Stack.Screen name="sessions/[instanceId]/[sessionId]" options={{ title: t('nav.aiSession'), ...iosTransparentHeaderOptions(dark) }} />
            <Stack.Screen name="app-sessions/new" options={{ title: t('nav.newAppSession') }} />
            <Stack.Screen name="app-sessions/[instanceId]/[sessionId]" options={{ title: t('nav.terminal') }} />
            <Stack.Screen name="history/[instanceId]/index" options={{ title: t('nav.history') }} />
            <Stack.Screen name="history/[instanceId]/[historyId]" options={{ title: t('nav.sessionHistory') }} />
          </Stack>
        </ActiveAppSessionsProvider>
        </ActiveAiSessionsProvider>
        </InstanceScopeProvider>
        </ActiveDirectoriesProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
