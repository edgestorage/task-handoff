import { createContext, useContext, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { AiSessionConversationAttachment } from '@task-handoff/protocol/ai-sessions';

import { AttachmentImage } from './AttachmentImage';
import { formatMobileAttachmentBytes } from './attachments';
import { useMobileTheme } from '../components/theme';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';

export const SessionAttachmentContext = createContext<{ client?: ControlPlaneClient; instanceId: string; sessionId: string } | undefined>(undefined);

export function MessageAttachments({ messageId, attachments }: { messageId: string; attachments: readonly AiSessionConversationAttachment[] }) {
  const scope = useContext(SessionAttachmentContext);
  const { colors } = useMobileTheme();
  const { t, locale } = useI18n();
  return <View style={styles.list}>{attachments.map((attachment) => attachment.kind === 'image' && attachment.contentState === 'available' && scope?.client
    ? <RemoteImage attachment={attachment} client={scope.client} instanceId={scope.instanceId} key={attachment.id} messageId={messageId} sessionId={scope.sessionId} />
    : <View key={attachment.id} style={[styles.file, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Icon color={colors.textMuted} name={attachment.kind === 'image' ? 'image-outline' : 'document-text-outline'} size={18} />
      <View style={styles.copy}><Text numberOfLines={1} style={[styles.meta, { color: colors.text }]}>{attachment.name}</Text><Text style={[styles.meta, { color: colors.textMuted }]}>{attachment.contentState === 'available' ? formatMobileAttachmentBytes(attachment.size, locale) : t(attachment.contentState === 'expired' ? 'attachments.expired' : 'attachments.missing')}</Text></View>
    </View>)}</View>;
}

function RemoteImage({ attachment, client, instanceId, sessionId, messageId }: { attachment: AiSessionConversationAttachment; client: ControlPlaneClient; instanceId: string; sessionId: string; messageId: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ requestKey: string; client: ControlPlaneClient; uri?: string; failed?: boolean }>();
  const attachmentId = attachment.id;
  const mime = attachment.mime;
  const requestKey = JSON.stringify([instanceId, sessionId, messageId, attachmentId, mime, attempt]);
  const state: { uri?: string; failed?: boolean } = result?.requestKey === requestKey && result.client === client ? result : {};
  useEffect(() => {
    let active = true;
    let file: File | undefined;
    // Use the shared client's binary transport so direct and Cloud Relay auth stay identical.
    void client.aiSessions.attachmentContent(instanceId, sessionId, messageId, attachmentId).then((response) => {
      if (!active) return;
      const extension = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'image';
      file = new File(Paths.cache, `session-image-${Crypto.randomUUID()}.${extension}`);
      file.create();
      file.write(response.body);
      setResult({ requestKey, client, uri: file.uri });
    }).catch(() => { if (active) setResult({ requestKey, client, failed: true }); });
    return () => {
      active = false;
      try { file?.delete(); } catch { /* Cache eviction may have already removed this copy. */ }
    };
  }, [client, instanceId, sessionId, messageId, attachmentId, mime, requestKey]);
  if (state.uri) return <AttachmentImage name={attachment.name} uri={state.uri} />;
  return <Pressable accessibilityLabel={state.failed ? t('common.retry') : t('common.loading')} accessibilityRole="button" disabled={!state.failed} onPress={() => setAttempt((value) => value + 1)} style={({ pressed }) => [styles.placeholder, { borderColor: colors.border, backgroundColor: colors.surface }, pressed && { opacity: 0.65 }]}>
    {state.failed ? <Text style={[styles.meta, { color: colors.error }]}>{t('common.retry')}</Text> : <ActivityIndicator color={colors.primary} />}
  </Pressable>;
}

const styles = StyleSheet.create({
  list: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8, maxWidth: '100%' },
  placeholder: { width: 64, height: 64, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  file: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 10, maxWidth: 280 },
  copy: { flexShrink: 1 },
  meta: { fontSize: 12, lineHeight: 18 },
});
