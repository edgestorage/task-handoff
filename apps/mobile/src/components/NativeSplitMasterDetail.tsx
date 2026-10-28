import { DarkTheme, DefaultTheme, type NativeStackNavigationOptions } from 'expo-router';
import { NavigationContainer, NavigationIndependentTree } from 'expo-router/react-navigation';
import { createNativeStackNavigator } from 'expo-router/native-stack';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Split } from 'react-native-screens/experimental';

import { AdaptiveContentWidthProvider, type AdaptiveHorizontalInsets } from './adaptive-layout';
import { useMobileTheme } from './theme';

export type NativeSplitPaneOptions = {
  detail: NativeStackNavigationOptions;
  list: NativeStackNavigationOptions;
};

const PaneNavigator = createNativeStackNavigator<{ Pane: undefined }>();
const PaneContentContext = createContext<{
  content: ReactNode;
  horizontalInsets?: Partial<AdaptiveHorizontalInsets>;
}>({ content: null });

function PaneContent() {
  const { content, horizontalInsets } = useContext(PaneContentContext);
  const [width, setWidth] = useState(0);
  return <View
    collapsable={false}
    onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    style={styles.fill}
  >
    <AdaptiveContentWidthProvider availableWidth={width || undefined} horizontalInsets={horizontalInsets}>{content}</AdaptiveContentWidthProvider>
  </View>;
}

function PaneNavigation({ children, horizontalInsets, options, testID }: {
  children: ReactNode;
  horizontalInsets?: Partial<AdaptiveHorizontalInsets>;
  options: NativeStackNavigationOptions;
  testID: string;
}) {
  const { colors, dark } = useMobileTheme();
  const theme = useMemo(() => {
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
  const screenOptions = useMemo<NativeStackNavigationOptions>(() => ({
    contentStyle: { backgroundColor: colors.background },
    headerShadowVisible: false,
    headerStyle: { backgroundColor: colors.surface },
    headerTintColor: colors.primary,
    headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: '600' },
    ...options,
  }), [colors, options]);
  const contentContext = useMemo(() => ({ content: children, horizontalInsets }), [children, horizontalInsets]);

  return <NavigationIndependentTree>
    <NavigationContainer theme={theme}>
      <PaneContentContext.Provider value={contentContext}>
        <View style={styles.fill} testID={testID}>
          <PaneNavigator.Navigator screenOptions={screenOptions}>
            <PaneNavigator.Screen component={PaneContent} name="Pane" />
          </PaneNavigator.Navigator>
        </View>
      </PaneContentContext.Provider>
    </NavigationContainer>
  </NavigationIndependentTree>;
}

export function NativeSplitMasterDetail({
  detail,
  detailOptions,
  detailWidth,
  listMaxWidth,
  list,
  listOptions,
  listMinWidth,
  listWidth,
  detailMinWidth,
  testID,
}: {
  detail: ReactNode;
  detailMinWidth: number;
  detailOptions: NativeStackNavigationOptions;
  detailWidth: number;
  list: ReactNode;
  listMaxWidth: number;
  listMinWidth: number;
  listOptions: NativeStackNavigationOptions;
  listWidth: number;
  testID: string;
}) {
  const [ready, setReady] = useState(false);
  const insets = useSafeAreaInsets();
  const listHorizontalInsets = useMemo(() => ({ left: insets.left }), [insets.left]);
  const detailHorizontalInsets = useMemo(() => ({ right: insets.right }), [insets.right]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  if (!ready) return <View collapsable={false} style={styles.fill} testID={testID} />;
  return <Split.Host
    collapsable={false}
    columnMetrics={{
      maximumPrimaryColumnWidth: listMaxWidth,
      minimumPrimaryColumnWidth: listMinWidth,
      minimumSecondaryColumnWidth: detailMinWidth,
      preferredPrimaryColumnWidthOrFraction: listWidth,
      preferredSecondaryColumnWidthOrFraction: detailWidth,
    }}
    displayModeButtonVisibility="never"
    preferredDisplayMode="oneBesideSecondary"
    preferredSplitBehavior="tile"
    presentsWithGesture={false}
    primaryBackgroundStyle="none"
    showSecondaryToggleButton={false}
    testID={testID}
  >
    <Split.Column>
      <PaneNavigation horizontalInsets={listHorizontalInsets} options={listOptions} testID={`${testID}-list`}>{list}</PaneNavigation>
    </Split.Column>
    <Split.Column>
      <PaneNavigation horizontalInsets={detailHorizontalInsets} options={detailOptions} testID={`${testID}-detail`}>{detail}</PaneNavigation>
    </Split.Column>
  </Split.Host>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
