const RECOVERY_CODE_GROUP_SIZE = 5;

export function normalizeRecoveryCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatRecoveryCode(value: string) {
  return normalizeRecoveryCode(value).replace(new RegExp(`(.{${RECOVERY_CODE_GROUP_SIZE}})(?=.)`, 'g'), '$1-');
}

/**
 * Security actions accept either a six-digit authenticator code or a grouped recovery code.
 * Keep numeric input as an authenticator code and format anything containing a letter as a
 * recovery code, so pasted recovery codes do not retain arbitrary spaces or separators.
 */
export function normalizeSecondFactorCode(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/[A-Z]/.test(compact) && compact.length <= 6) return compact;
  return formatRecoveryCode(compact);
}
