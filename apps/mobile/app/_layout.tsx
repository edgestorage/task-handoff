import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
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
import { MobileControlPlaneRuntimeProvider } from '../src/control-plane/use-mobile-control-plane-runtime';
import { MobileToastProvider } from '../src/components/MobileToast';
import { ActiveTriggersProvider } from '../src/triggers/use-active-triggers';

export default function RootLayout() {
  return <MobileThemeProvider><MobileI18nProvider><TaskStatusSettingsProvider><LocalizedRootLayout /></TaskStatusSettingsProvider></MobileI18nProvider></MobileThemeProvider>;
}

function LocalizedRootLayout() {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const navigationTheme = useMemo(() => {
    const base = dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: colors.background,
        border: colors.border,
        card: colors.surface,
        notification: colors.error,
        primary: colors.primary,
        text: colors.text,
      },
    };
  }, [colors, dark]);
  return (
    <GestureHandlerRootView style={{ backgroundColor: colors.background, flex: 1 }}>
      <SafeAreaProvider>
        <MobileToastProvider>
          <StatusBar animated style={dark ? 'light' : 'dark'} />
          <ThemeProvider value={navigationTheme}>
          <MobileControlPlaneRuntimeProvider>
            <ActiveDirectoriesProvider>
              <InstanceScopeProvider>
                <ActiveAiSessionsProvider>
                  <ActiveAppSessionsProvider>
                  <ActiveTriggersProvider>
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
                    <Stack.Screen name="profiles" options={{ title: t('nav.settings'), ...iosTransparentHeaderOptions(dark) }} />
                    <Stack.Screen name="control-planes/add" options={{ title: t('nav.addControlPlane') }} />
                    <Stack.Screen name="control-planes/[controlPlaneId]" options={{ title: t('nav.controlPlane'), ...iosTransparentHeaderOptions(dark) }} />
                    <Stack.Screen name="nodes/[nodeId]" options={{ title: t('nav.node') }} />
                    <Stack.Screen name="instances/[instanceId]" options={{ title: t('nav.instance'), ...iosTransparentHeaderOptions(dark) }} />
                    <Stack.Screen name="sessions/new" options={{ headerStyle: { backgroundColor: colors.background }, title: '' }} />
                    <Stack.Screen name="sessions/[instanceId]/[sessionId]" options={{ title: t('nav.aiSession'), ...iosTransparentHeaderOptions(dark) }} />
                    <Stack.Screen name="app-sessions/new" options={{ title: t('nav.newAppSession') }} />
                    <Stack.Screen name="app-sessions/[instanceId]/[sessionId]" options={{ title: t('nav.terminal') }} />
                    <Stack.Screen name="history/[instanceId]/index" options={{ title: t('nav.history'), ...iosTransparentHeaderOptions(dark) }} />
                    <Stack.Screen name="history/[instanceId]/[historyId]" options={{ title: t('nav.sessionHistory'), ...iosTransparentHeaderOptions(dark) }} />
                    <Stack.Screen name="triggers/index" options={{ title: t('triggers.title'), ...iosTransparentHeaderOptions(dark) }} />
                    <Stack.Screen name="triggers/new" options={{ title: t('triggers.create') }} />
                    <Stack.Screen name="triggers/[configHash]" options={{ title: t('triggers.title'), ...iosTransparentHeaderOptions(dark) }} />
                    <Stack.Screen name="sessions/[instanceId]/[sessionId]/triggers" options={{ title: t('triggers.sessionTitle'), ...iosTransparentHeaderOptions(dark) }} />
                    <Stack.Screen name="icon-gallery" options={{ title: 'Ionicons 图标选择' }} />
                  </Stack>
                  </ActiveTriggersProvider>
                  </ActiveAppSessionsProvider>
                </ActiveAiSessionsProvider>
              </InstanceScopeProvider>
            </ActiveDirectoriesProvider>
          </MobileControlPlaneRuntimeProvider>
          </ThemeProvider>
        </MobileToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
