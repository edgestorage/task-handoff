import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useMobileTheme } from '../src/components/theme';
import { ActiveAiSessionsProvider } from '../src/ai-sessions/use-active-sessions';

export default function RootLayout() {
  const { colors, dark } = useMobileTheme();
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
            <Stack.Screen name="profiles" options={{ title: 'Control Planes' }} />
            <Stack.Screen name="control-planes/add" options={{ title: 'Add Control Plane' }} />
            <Stack.Screen name="control-planes/[controlPlaneId]" options={{ title: 'Control Plane' }} />
            <Stack.Screen name="nodes/[nodeId]" options={{ title: 'Node' }} />
            <Stack.Screen name="instances/[instanceId]" options={{ title: 'Instance' }} />
            <Stack.Screen name="sessions/new" options={{ title: 'New AI Session' }} />
            <Stack.Screen name="sessions/[instanceId]/[sessionId]" options={{ title: 'AI Session' }} />
            <Stack.Screen name="history/[instanceId]/[historyId]" options={{ title: 'Session History' }} />
          </Stack>
        </ActiveAiSessionsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
