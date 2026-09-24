import { nextTick, type Ref } from "vue";

const FOCUS_RETRY_WINDOW_MS = 400;

/**
 * Hands focus to an inline tab title editor opened from a context menu item.
 *
 * Reka menus keep their focus trap attached while their content tears down, so a single synchronous
 * `focus()` is pulled back to the menu (and after unmount focus is restored to the trigger). The
 * editor therefore retries until the menu stops competing for focus; consumers also cancel the menu's
 * `closeAutoFocus` while an editor is open so the trigger restore cannot take focus back afterwards.
 */
export async function focusResourceTabTitleInput(input: Ref<HTMLInputElement | undefined>) {
  await nextTick();
  const deadline = performance.now() + FOCUS_RETRY_WINDOW_MS;
  const takeFocus = () => {
    const element = input.value;
    if (!element?.isConnected) return;
    if (document.activeElement !== element) {
      element.focus();
      element.select();
    }
    if (document.activeElement !== element && performance.now() < deadline) requestAnimationFrame(takeFocus);
  };
  takeFocus();
}
