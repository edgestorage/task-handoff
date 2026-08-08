import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useMobileTheme } from '../src/components/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];
type IconGroupKey = 'ai' | 'app' | 'instances';

type IconGroup = {
  icons: IoniconName[];
  key: IconGroupKey;
  title: string;
};

const iconGroups: IconGroup[] = [
  {
    key: 'ai',
    title: 'AI 会话',
    icons: [
      'chatbubbles-outline',
      'chatbubbles',
      'chatbox-ellipses-outline',
      'chatbox-ellipses',
      'chatbubble-ellipses-outline',
      'chatbubble-ellipses',
      'chatbox-outline',
      'chatbox',
      'chatbubble-outline',
      'chatbubble',
      'sparkles-outline',
      'sparkles',
      'hardware-chip-outline',
      'hardware-chip',
    ],
  },
  {
    key: 'app',
    title: 'App 会话',
    icons: [
      'desktop-outline',
      'desktop',
      'apps-outline',
      'apps',
      'browsers-outline',
      'browsers',
      'grid-outline',
      'grid',
      'layers-outline',
      'layers',
      'cube-outline',
      'cube',
      'code-working-outline',
      'code-working',
      'code-slash-outline',
      'code-slash',
      'terminal-outline',
      'terminal',
    ],
  },
  {
    key: 'instances',
    title: '实例',
    icons: [
      'server-outline',
      'server',
      'hardware-chip-outline',
      'hardware-chip',
      'git-network-outline',
      'git-network',
      'file-tray-stacked-outline',
      'file-tray-stacked',
      'cloud-outline',
      'cloud',
      'cube-outline',
      'cube',
      'layers-outline',
      'layers',
      'desktop-outline',
      'desktop',
      'business-outline',
      'business',
    ],
  },
];

const initialSelection: Record<IconGroupKey, IoniconName> = {
  ai: 'chatbubbles-outline',
  app: 'desktop-outline',
  instances: 'server-outline',
};

export default function IconGalleryScreen() {
  const { colors } = useMobileTheme();
  const [selected, setSelected] = useState(initialSelection);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      {iconGroups.map((group) => (
        <View key={group.key} style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{group.title}</Text>
            <Text numberOfLines={1} style={[styles.selectionName, { color: colors.primary }]}>
              {selected[group.key]}
            </Text>
          </View>

          <View style={styles.grid}>
            {group.icons.map((name) => {
              const active = selected[group.key] === name;
              return (
                <Pressable
                  accessibilityLabel={`${group.title} ${name}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  key={name}
                  onPress={() => setSelected((current) => ({ ...current, [group.key]: name }))}
                  style={({ pressed }) => [
                    styles.iconOption,
                    {
                      backgroundColor: active ? colors.surfaceMuted : colors.surface,
                      borderColor: active ? colors.primary : colors.border,
                    },
                    pressed && styles.pressed,
                  ]}
                >
                  <Ionicons color={active ? colors.primary : colors.text} name={name} size={28} />
                  <Text
                    numberOfLines={2}
                    style={[styles.iconName, { color: active ? colors.primary : colors.textMuted }]}
                  >
                    {name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingBottom: 40 },
  section: { paddingHorizontal: 16, paddingTop: 22 },
  sectionHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    minHeight: 24,
  },
  sectionTitle: { fontSize: 17, fontWeight: '700' },
  selectionName: { flex: 1, fontSize: 12, marginLeft: 12, textAlign: 'right' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconOption: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 92,
    paddingHorizontal: 4,
    paddingVertical: 10,
    width: '31.5%',
  },
  pressed: { opacity: 0.65 },
  iconName: { fontSize: 11, lineHeight: 14, marginTop: 8, textAlign: 'center' },
});
