import { useColorScheme } from 'react-native';

export const mobileLightColors = {
  background: '#f2f2f7', surface: '#ffffff', surfaceMuted: '#e9e9ef', text: '#000000', textMuted: '#636366', border: '#c6c6c8',
  primary: '#007aff', primaryButton: '#007aff', primarySoft: '#e5f1ff', notice: '#fff4ce', noticeText: '#7a4b00', error: '#c9342f', errorSoft: '#ffe9e7', code: '#1c1c1e', codeText: '#f2f2f7',
  syntaxComment: '#6e7781', syntaxKeyword: '#cf222e', syntaxString: '#116329', syntaxNumber: '#9a6700', syntaxTitle: '#0969da', syntaxType: '#8250df', tableStripe: '#f8f8fa',
} as const;

export const mobileDarkColors = {
  background: '#000000', surface: '#1c1c1e', surfaceMuted: '#2c2c2e', text: '#ffffff', textMuted: '#aeaeb2', border: '#38383a',
  primary: '#0a84ff', primaryButton: '#0a84ff', primarySoft: '#0c3158', notice: '#3b2f05', noticeText: '#ffd76a', error: '#ff6961', errorSoft: '#3f1715', code: '#1c1c1e', codeText: '#f2f2f7',
  syntaxComment: '#8b949e', syntaxKeyword: '#ff7b72', syntaxString: '#7ee787', syntaxNumber: '#e3b341', syntaxTitle: '#79c0ff', syntaxType: '#d2a8ff', tableStripe: '#242426',
} as const;

export type MobileThemeColors = typeof mobileLightColors | typeof mobileDarkColors;

export function useMobileTheme() {
  const dark = useColorScheme() === 'dark';
  return { dark, colors: dark ? mobileDarkColors : mobileLightColors };
}
