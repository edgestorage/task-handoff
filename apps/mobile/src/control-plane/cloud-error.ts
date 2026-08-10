export type CloudMobileErrorKind = 'reauthentication' | 'account-conflict' | 'service-unavailable' | 'control-plane-offline' | 'revoked' | 'version-incompatible' | 'quota-exceeded' | 'target-changed' | 'result-unknown';

export function cloudMobileError(error: unknown): { kind: CloudMobileErrorKind; code: string; retryable: boolean } {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  if (/ACCOUNT_SWITCH_REQUIRES_LOGOUT|ACCOUNT_ALREADY_SIGNED_IN/.test(code)) return { kind: 'account-conflict', code, retryable: false };
  if (/REAUTHENTICATION|ACCESS_TOKEN|REFRESH|DEVICE.*REVOKED|SESSION.*REVOKED/.test(code)) return { kind: 'reauthentication', code, retryable: false };
  if (/BINDING.*REVOKED|BINDING_NOT_FOUND|REVOCATION/.test(code)) return { kind: 'revoked', code, retryable: false };
  if (/VERSION|PROTOCOL|UNSUPPORTED/.test(code)) return { kind: 'version-incompatible', code, retryable: false };
  if (/QUOTA|RATE_LIMIT|CAPACITY/.test(code)) return { kind: 'quota-exceeded', code, retryable: true };
  if (/TARGET_IDENTITY|FINGERPRINT/.test(code)) return { kind: 'target-changed', code, retryable: false };
  if (/CONTROL_PLANE.*UNAVAILABLE|TARGET_NOT_FOUND|OFFLINE/.test(code)) return { kind: 'control-plane-offline', code, retryable: true };
  if (/NETWORK|CONNECTION|SERVICE_UNAVAILABLE|DATABASE_UNAVAILABLE|RELAY_SOCKET/.test(code) || error instanceof TypeError) return { kind: 'service-unavailable', code, retryable: true };
  return { kind: 'result-unknown', code: code || 'CLOUD_RESULT_UNKNOWN', retryable: true };
}

export function cloudMobileErrorMessage(error: unknown, zh: boolean) {
  const state = cloudMobileError(error);
  const messages = zh ? {
    'reauthentication': '登录已失效，请重新登录 Thandoff 账户。', 'account-conflict': '此 App 已登录一个 Thandoff 账户；请先退出当前账户再切换。', 'service-unavailable': 'Thandoff 云服务暂时不可达，直连配置仍可继续使用。', 'control-plane-offline': 'Control Plane 当前离线或后台连接尚未恢复。', revoked: '设备或 Control Plane 绑定已被撤销，请重新登录或重新绑定。', 'version-incompatible': '客户端与 Thandoff 云服务版本不兼容，请升级后重试。', 'quota-exceeded': '中转额度或容量暂时不足，请稍后重试。', 'target-changed': 'Control Plane 身份指纹已变化，已阻止连接。', 'result-unknown': '操作结果暂时无法确认，请刷新状态后再决定是否重试。',
  } : {
    'reauthentication': 'Your Thandoff account session expired. Sign in again.', 'account-conflict': 'This app is already signed in to a Thandoff account. Sign out before switching.', 'service-unavailable': 'The cloud service is unavailable. Direct profiles remain usable.', 'control-plane-offline': 'The Control Plane is offline or its background connection has not recovered.', revoked: 'This device or Control Plane binding was revoked. Sign in or bind again.', 'version-incompatible': 'The client and cloud service versions are incompatible. Upgrade and retry.', 'quota-exceeded': 'Relay quota or capacity is temporarily unavailable.', 'target-changed': 'The Control Plane identity fingerprint changed, so the connection was blocked.', 'result-unknown': 'The result cannot be confirmed yet. Refresh state before retrying.',
  };
  return messages[state.kind];
}
