import { useState, type ReactElement } from 'react';
import { Alert, type StyleProp, type ViewStyle } from 'react-native';
import * as Crypto from 'expo-crypto';
import type { ControlPlaneAiSessionSummary } from '@task-handoff/control-plane-client';

import { MenuView, type MenuAction } from '../components/InlineMenuView';
import { useMobileToast } from '../components/MobileToast';
import { SessionRenameModal } from '../components/SessionRenameModal';
import type { MobileAiSessionActionCoordinator } from './actions';
import { useI18n } from '../i18n';

export function AiSessionActionsMenu({ actions, children, disabled = false, instanceId, onOpen, session, style }: {
  actions?: MobileAiSessionActionCoordinator;
  children: ReactElement;
  disabled?: boolean;
  instanceId: string;
  onOpen?(): void;
  session: ControlPlaneAiSessionSummary;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useI18n();
  const toast = useMobileToast();
  const [closing, setClosing] = useState(false);
  const [markingUnread, setMarkingUnread] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameRequestId, setRenameRequestId] = useState(() => Crypto.randomUUID());
  const title = session.title || session.userPrompt || session.id;
  const canMutate = Boolean(actions) && !disabled;
  const canClose = canMutate && session.actions?.close !== false;
  const canRename = canMutate && session.actions?.rename === true;
  const canMarkUnread = canMutate && !session.unread;

  const markUnread = () => {
    if (!actions || markingUnread) return;
    setMarkingUnread(true);
    void actions.markUnread(instanceId, session.id).then((result) => {
      if (result.disposition === 'accepted') {
        toast.show({ title: t('sessions.markedUnread'), tone: 'success' });
        return;
      }
      toast.show({
        detail: result.disposition === 'failed' || result.disposition === 'result-unknown' ? result.error : undefined,
        title: t('sessions.markUnreadFailed'),
        tone: 'error',
      });
    }).finally(() => setMarkingUnread(false));
  };

  const openRename = () => {
    if (!canRename) return;
    setRenameRequestId(Crypto.randomUUID());
    setRenameError('');
    setRenameOpen(true);
  };

  const submitRename = (nextTitle: string) => {
    if (!actions || renaming) return;
    setRenaming(true);
    setRenameError('');
    void actions.rename(instanceId, session.id, {
      title: nextTitle,
      expectedTitle: session.title?.trim() || '',
      clientRequestId: renameRequestId,
    }).then((result) => {
      if (result.disposition === 'accepted') {
        setRenameOpen(false);
        return;
      }
      setRenameError(result.disposition === 'duplicate-blocked' ? t('sessions.renameBusy') : result.error);
    }).finally(() => setRenaming(false));
  };

  const close = () => {
    if (!actions || closing) return;
    setClosing(true);
    void actions.close(instanceId, session.id, Crypto.randomUUID()).then((result) => {
      if (result.disposition === 'accepted') return;
      toast.show({
        detail: result.disposition === 'duplicate-blocked' ? undefined : result.error,
        title: t('sessions.closeFailed'),
        tone: 'error',
      });
    }).finally(() => setClosing(false));
  };

  const requestClose = () => Alert.alert(
    t('sessions.closeConfirmTitle', { name: title.slice(0, 80) }),
    t('sessions.closeConfirmDescription'),
    [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('sessions.close'), style: 'destructive', onPress: close },
    ],
  );

  const menuActions: MenuAction[] = [
    ...(onOpen ? [{ id: 'open', image: 'bubble.left' as const, title: t('common.open') }] : []),
    ...(canMarkUnread ? [{
      attributes: { disabled: markingUnread || !actions },
      id: 'mark-unread',
      image: 'envelope' as const,
      title: t('sessions.markUnread'),
    }] : []),
    ...(canRename ? [{
      attributes: { disabled: renaming || !actions },
      id: 'rename',
      image: 'pencil' as const,
      title: t('sessions.rename'),
    }] : []),
    ...(canClose ? [{
      attributes: { destructive: true, disabled: closing || !actions },
      id: 'close',
      image: 'xmark.circle' as const,
      title: t('sessions.closeSession'),
    }] : []),
  ];

  return <>
    <MenuView
      actions={menuActions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === 'open') onOpen?.();
        else if (nativeEvent.event === 'mark-unread') markUnread();
        else if (nativeEvent.event === 'rename') openRename();
        else if (nativeEvent.event === 'close') requestClose();
      }}
      shouldOpenOnLongPress
      style={style}
      title={title}
    >{children}</MenuView>
    <SessionRenameModal
      busy={renaming}
      error={renameError}
      initialTitle={session.title || ''}
      onClose={() => { if (!renaming) setRenameOpen(false); }}
      onSubmit={submitRename}
      open={renameOpen}
    />
  </>;
}
