import { router, type NativeStackHeaderItem } from 'expo-router';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { PrimaryTabStack } from '../../../../src/components/PrimaryTabStack';
import { SystemIcon } from '../../../../src/components/SystemIcon';
import { useI18n } from '../../../../src/i18n';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';
import {
  getAiSessionInboxViewPreferences,
  subscribeAiSessionInboxViewPreferences,
  updateAiSessionInboxViewPreferences,
  type AiSessionInboxGroupBy,
} from '../../../../src/ai-sessions/inbox-view-preferences';

const GROUP_MODES = ['none', 'path', 'instance', 'node', 'agent'] as const;

export default function InboxLayout() {
  const { t } = useI18n();
  const { scope } = useInstanceScope();
  const preferences = useSyncExternalStore(
    subscribeAiSessionInboxViewPreferences,
    getAiSessionInboxViewPreferences,
    getAiSessionInboxViewPreferences,
  );
  const openNewSession = () => router.push(scope.kind === 'instance'
    ? { pathname: '/sessions/new', params: { instanceId: scope.instanceId } }
    : '/sessions/new');
  const selectPreference = (id: string) => {
    if (id === 'sort-status') updateAiSessionInboxViewPreferences({ sortByStatus: !preferences.sortByStatus });
    else if (id.startsWith('group-')) updateAiSessionInboxViewPreferences({ groupBy: id.slice(6) as AiSessionInboxGroupBy });
  };
  const groupActions = GROUP_MODES.map((groupBy) => ({
    id: `group-${groupBy}`,
    state: preferences.groupBy === groupBy ? 'on' as const : 'off' as const,
    title: t(`sessions.inbox.group.${groupBy}` as 'sessions.inbox.group.none'),
  }));
  const androidMenuActions: MenuAction[] = [
    {
      displayInline: true,
      id: 'sort-section',
      subactions: [{ id: 'sort-status', state: preferences.sortByStatus ? 'on' : 'off', title: t('sessions.inbox.sortByStatus') }],
      title: t('sessions.inbox.sort'),
    },
    { displayInline: true, id: 'group-section', subactions: groupActions, title: t('sessions.inbox.group') },
  ];
  const headerRightItems = () => [
    {
      accessibilityLabel: t('sessions.newAccessibility'),
      icon: { name: 'plus' as const, type: 'sfSymbol' as const },
      identifier: 'ai-session-create',
      label: t('sessions.newAccessibility'),
      onPress: openNewSession,
      sharesBackground: false,
      tintColor: '#ffffff',
      type: 'button' as const,
    },
    { type: 'spacing' as const, spacing: 8 },
    {
      accessibilityLabel: t('sessions.inbox.options'),
      icon: { name: 'ellipsis' as const, type: 'sfSymbol' as const },
      identifier: 'ai-session-list-options',
      label: t('sessions.inbox.options'),
      sharesBackground: false,
      tintColor: '#ffffff',
      type: 'menu' as const,
      menu: {
        title: t('sessions.inbox.options'),
        items: [
          {
            type: 'submenu' as const,
            label: t('sessions.inbox.sort'),
            inline: true,
            items: [{ type: 'action' as const, label: t('sessions.inbox.sortByStatus'), onPress: () => selectPreference('sort-status'), state: preferences.sortByStatus ? 'on' as const : 'off' as const }],
          },
          {
            type: 'submenu' as const,
            label: t('sessions.inbox.group'),
            inline: true,
            items: groupActions.map((action) => ({ type: 'action' as const, label: action.title, onPress: () => selectPreference(action.id), state: action.state })),
          },
        ],
      },
    },
  ] satisfies NativeStackHeaderItem[];
  const headerRight = () => <View style={styles.headerActions}>
    <Pressable accessibilityLabel={t('sessions.newAccessibility')} accessibilityRole="button" hitSlop={6} onPress={openNewSession} style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}>
      <SystemIcon android="add" color="#ffffff" ios="plus" size={20} />
    </Pressable>
    <MenuView actions={androidMenuActions} onPressAction={({ nativeEvent }) => selectPreference(nativeEvent.event)} title={t('sessions.inbox.options')}>
      <Pressable accessibilityLabel={t('sessions.inbox.options')} accessibilityRole="button" hitSlop={6} style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}>
        <SystemIcon android="more_horiz" color="#ffffff" ios="ellipsis" size={21} />
      </Pressable>
    </MenuView>
  </View>;

  return <PrimaryTabStack
    addAccessibilityLabel={t('sessions.newAccessibility')}
    onAdd={openNewSession}
    headerRight={headerRight}
    headerRightItems={headerRightItems}
    title={t('nav.aiSessions')}
  />;
}

const styles = StyleSheet.create({
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: 12, marginRight: 2 },
  headerButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 32 },
  headerButtonPressed: { opacity: 0.68, transform: [{ scale: 0.96 }] },
});
