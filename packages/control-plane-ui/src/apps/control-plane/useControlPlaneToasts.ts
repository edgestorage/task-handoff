import { toast } from "vue-sonner";

export type ControlPlaneToastKind = "error" | "info" | "success";

export function dismissControlPlaneToast(id: string | number) {
  toast.dismiss(id);
}

export function clearControlPlaneToasts() {
  toast.dismiss();
}

export function showControlPlaneToast(message: string, kind: ControlPlaneToastKind = "error") {
  toast[kind](message, { duration: 6000, closeButton: true });
}

export function useControlPlaneToasts() {
  return {
    dismissToast: dismissControlPlaneToast,
    clearToasts: clearControlPlaneToasts,
    showToast: showControlPlaneToast,
  };
}
