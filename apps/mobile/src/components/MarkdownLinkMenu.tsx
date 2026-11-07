import { useCallback, useMemo } from 'react';
import * as Clipboard from 'expo-clipboard';

import { useI18n } from '../i18n';
import { openSystemLink } from '../platform/links';
import { FloatingMenu, type FloatingMenuAnchor } from './menu/FloatingMenu';
import { type FloatingMenuItem, type FloatingMenuPage } from './menu/menu-model';
import { embeddedBrowserLink, mobileMarkdownLinkTarget } from './markdown-link-target';
import { useMobileToast } from './MobileToast';

export function MarkdownLinkMenu({
  anchor,
  onDismiss,
  onOpenBuiltinBrowser,
  url,
}: {
  anchor: FloatingMenuAnchor;
  onDismiss(): void;
  onOpenBuiltinBrowser?(url: string): void | Promise<void>;
  url: string;
}) {
  const { t } = useI18n();
  const toast = useMobileToast();
  const target = useMemo(() => mobileMarkdownLinkTarget(url), [url]);

  const copyLinkValue = useCallback(async (value: string) => {
    try {
      await Clipboard.setStringAsync(value);
      toast.show({ title: t('sessions.linkActions.copied'), tone: 'success' });
    } catch {
      toast.show({ title: t('sessions.linkActions.copyFailed'), tone: 'error' });
    }
  }, [t, toast]);
  const openLinkValue = useCallback((value: string) => {
    void openSystemLink(value).catch(() => {
      toast.show({ title: t('sessions.linkActions.openFailed'), tone: 'error' });
    });
  }, [t, toast]);
  const openBuiltinBrowserValue = useCallback((value: string) => {
    if (!onOpenBuiltinBrowser) return;
    void Promise.resolve(onOpenBuiltinBrowser(value)).catch(() => {
      toast.show({ title: t('browser.createFailed'), tone: 'error' });
    });
  }, [onOpenBuiltinBrowser, t, toast]);

  const page = useMemo<FloatingMenuPage | undefined>(() => {
    if (!target) return undefined;
    const embeddedUrl = target.kind === 'web' ? embeddedBrowserLink(target.url) : undefined;
    const items: FloatingMenuItem[] = target.kind === 'web'
      ? [
        ...(onOpenBuiltinBrowser && embeddedUrl ? [{
          key: 'builtin-browser',
          label: t('sessions.linkActions.openBuiltinBrowser'),
          icon: 'globe-outline' as const,
          onPress: () => openBuiltinBrowserValue(embeddedUrl),
        }] : []),
        { key: 'open', label: t('sessions.linkActions.open'), icon: 'open-outline', onPress: () => openLinkValue(target.url) },
        { key: 'copy', label: t('sessions.linkActions.copyLink'), icon: 'copy-outline', onPress: () => { void copyLinkValue(target.url); } },
      ]
      : [
        { key: 'copy', label: t('sessions.linkActions.copyPath'), icon: 'copy-outline', onPress: () => { void copyLinkValue(target.path); } },
      ];
    return {
      title: t('sessions.linkActions.title'),
      blocks: items.map((item) => ({ type: 'item', key: item.key, item })),
    };
  }, [copyLinkValue, onOpenBuiltinBrowser, openBuiltinBrowserValue, openLinkValue, t, target]);

  return page ? <FloatingMenu anchor={anchor} onDismiss={onDismiss} page={page} /> : null;
}
