import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ApprovalCenterItem } from '@task-handoff/control-plane-client';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { approvalActions, itemTitle } from './approval-detail-model';
import { confirmDanger } from './confirm-action';

export function ApprovalInlineActions({ disabled, item, onDecision, onOpen, roleUnavailable = false, testID }: {
  disabled: boolean;
  item: ApprovalCenterItem;
  onDecision(decision: string): void;
  onOpen(): void;
  roleUnavailable?: boolean;
  testID?: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const actions = approvalActions(item, t);
  return <View style={styles.inlineActions} testID={testID}>
    {actions.slice(0, 3).map((action) => {
      const actionDisabled = disabled || (roleUnavailable && action.decision === 'approve');
      return <Pressable
        accessibilityLabel={action.open ? `${t('approvalCenter.answer')} ${itemTitle(item, t)}` : action.label}
        accessibilityRole="button"
        disabled={actionDisabled}
        key={action.key}
        testID={`approval-action-${item.key}-${action.decision ?? 'open'}`}
        onPress={() => {
          if (action.open) onOpen();
          else if (action.decision) {
            if (action.danger) confirmDanger(action.label, t('common.cancel'), () => onDecision(action.decision!));
            else onDecision(action.decision);
          }
        }}
        style={({ pressed }) => [styles.inlineButton, {
          backgroundColor: pressed ? colors.workbenchSelectionBackground : 'transparent',
          borderColor: action.danger ? colors.error : colors.border,
          opacity: actionDisabled ? 0.45 : 1,
        }]}
      >
        <Text style={[styles.inlineButtonText, { color: action.danger ? colors.error : colors.primary }]}>{action.label}</Text>
      </Pressable>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  inlineActions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 12, paddingHorizontal: 14, paddingTop: 12 },
  inlineButton: { alignItems: 'center', borderRadius: 9, borderWidth: 1, flexBasis: 78, flexGrow: 1, justifyContent: 'center', minHeight: 38, paddingHorizontal: 14 },
  inlineButtonText: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
});
