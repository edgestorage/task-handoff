import { toast } from "vue-sonner";

export type ControlPlaneToastKind = "error" | "info" | "success";

export const CONTROL_PLANE_LOADING_TOAST_DELAY_MS = 800;

export type DelayedControlPlaneLoadingToast = {
  dismiss: () => void;
};

export function dismissControlPlaneToast(id: string | number) {
  toast.dismiss(id);
}

export function clearControlPlaneToasts() {
  toast.dismiss();
}

export function showControlPlaneToast(message: string, kind: ControlPlaneToastKind = "error") {
  toast[kind](message, { duration: 6000, closeButton: true });
}

export function showDelayedControlPlaneLoadingToast(
  message: string,
  delayMs = CONTROL_PLANE_LOADING_TOAST_DELAY_MS,
): DelayedControlPlaneLoadingToast {
  let toastId: string | number | undefined;
  let dismissed = false;
  const timer = globalThis.setTimeout(() => {
    if (dismissed) return;
    toastId = toast.loading(message, { duration: Infinity, closeButton: false });
  }, delayMs);

  return {
    dismiss() {
      if (dismissed) return;
      dismissed = true;
      globalThis.clearTimeout(timer);
      if (toastId !== undefined) toast.dismiss(toastId);
    },
  };
}

export function useControlPlaneToasts() {
  return {
    dismissToast: dismissControlPlaneToast,
    clearToasts: clearControlPlaneToasts,
    showToast: showControlPlaneToast,
  };
}
