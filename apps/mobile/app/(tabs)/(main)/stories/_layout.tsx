import { router, type NativeStackHeaderItem } from 'expo-router';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSyncExternalStore } from 'react';
import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { SystemIcon } from '../../../../src/components/SystemIcon';
import { useMobileControlPlaneRuntime } from '../../../../src/control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../../../../src/i18n';
import { getStoryViewPreferences, subscribeStoryViewPreferences, updateStoryViewPreferences } from '../../../../src/stories/story-view-preferences';

export default function StoriesLayout() {
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const preferences = useSyncExternalStore(subscribeStoryViewPreferences, getStoryViewPreferences, getStoryViewPreferences);
  const selectPreference = (action: string) => {
    if (action === 'compact' || action === 'detailed') updateStoryViewPreferences({ viewMode: action });
    else if (action === 'sort-name') updateStoryViewPreferences({ sortMode: 'name' });
    else if (action === 'sort-last') updateStoryViewPreferences({ sortMode: 'last-user-message' });
    else if (action === 'sort-manual') updateStoryViewPreferences({ sortMode: 'manual' });
  };
  const preferenceActions = [
    { id: 'compact', title: t('stories.compactMode'), state: preferences.viewMode === 'compact' ? 'on' as const : 'off' as const },
    { id: 'detailed', title: t('stories.detailedMode'), state: preferences.viewMode === 'detailed' ? 'on' as const : 'off' as const },
    { id: 'sort-name', title: t('stories.sort.name'), state: preferences.sortMode === 'name' ? 'on' as const : 'off' as const },
    { id: 'sort-last', title: t('stories.sort.lastAiSession'), state: preferences.sortMode === 'last-user-message' ? 'on' as const : 'off' as const },
    { id: 'sort-manual', title: t('stories.sort.manual'), state: preferences.sortMode === 'manual' ? 'on' as const : 'off' as const },
  ];
  const headerRightItems = runtime.storyCapability ? () => [
    {
      accessibilityLabel: t('stories.create'), icon: { name: 'plus' as const, type: 'sfSymbol' as const }, identifier: 'story-create', label: t('stories.create'), onPress: () => router.push('/stories/new' as never), sharesBackground: false, tintColor: '#ffffff', type: 'button' as const,
    },
    { type: 'spacing' as const, spacing: 8 },
    {
      accessibilityLabel: t('stories.listOptions'), icon: { name: 'ellipsis' as const, type: 'sfSymbol' as const }, identifier: 'story-list-options', label: t('stories.listOptions'), sharesBackground: false, tintColor: '#ffffff', type: 'menu' as const,
      menu: { title: t('stories.listOptions'), items: [
        ...preferenceActions.slice(0, 2).map((action) => ({ type: 'action' as const, label: action.title, onPress: () => selectPreference(action.id), state: action.state })),
        {
          type: 'submenu' as const,
          label: '',
          inline: true,
          items: preferenceActions.slice(2).map((action) => ({ type: 'action' as const, label: action.title, onPress: () => selectPreference(action.id), state: action.state })),
        },
      ] },
    },
  ] satisfies NativeStackHeaderItem[] : undefined;
  const headerRight = runtime.storyCapability ? () => <View style={styles.headerActions}>
    <Pressable accessibilityLabel={t('stories.create')} accessibilityRole="button" hitSlop={6} onPress={() => router.push('/stories/new' as never)} style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}><SystemIcon android="add" color="#ffffff" ios="plus" size={20} /></Pressable>
    <MenuView
      actions={preferenceActions as MenuAction[]}
      onPressAction={({ nativeEvent }) => selectPreference(nativeEvent.event)}
      title={t('stories.listOptions')}
    >
      <Pressable accessibilityLabel={t('stories.listOptions')} accessibilityRole="button" hitSlop={6} style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}><SystemIcon android="more_horiz" color="#ffffff" ios="ellipsis" size={21} /></Pressable>
    </MenuView>
  </View> : undefined;
  return <PrimaryTabStack
    addAccessibilityLabel={runtime.storyCapability ? t('stories.create') : undefined}
    onAdd={runtime.storyCapability ? () => router.push('/stories/new' as never) : undefined}
    headerRight={headerRight}
    headerRightItems={headerRightItems}
    title={t('nav.stories')}
  />;
}

const styles = StyleSheet.create({
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: 12, marginRight: 2 },
  headerButton: {
    alignItems: 'center',
    height: 34,
    justifyContent: 'center',
    width: 32,
  },
  headerButtonPressed: { opacity: 0.68, transform: [{ scale: 0.96 }] },
});
