type Listener = () => void;

let reauthenticationRequired = false;
const listeners = new Set<Listener>();

export function cloudAccountReauthenticationRequired() {
  return reauthenticationRequired;
}

/**
 * The cloud rejected a stored refresh credential. This is an app-wide state:
 * every cloud account session shares the same secure credential, so one
 * revoked device session invalidates the account surface and its relay
 * profiles together.
 */
export function markCloudAccountReauthenticationRequired() {
  if (reauthenticationRequired) return;
  reauthenticationRequired = true;
  emit();
}

export function clearCloudAccountReauthenticationRequired() {
  if (!reauthenticationRequired) return;
  reauthenticationRequired = false;
  emit();
}

export function subscribeCloudAccountReauthentication(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A prompt belongs to one reauthentication event, not to every later render. */
export function acknowledgeCloudAccountReauthentication() {
  clearCloudAccountReauthenticationRequired();
}

function emit() {
  for (const listener of listeners) listener();
}
