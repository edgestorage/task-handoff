export async function startSavedChatBridge(input: {
  persist: () => Promise<boolean>;
  start: () => Promise<unknown>;
  refresh: () => Promise<void>;
}) {
  const saved = await input.persist();
  if (!saved) return false;

  try {
    await input.start();
  } catch (error) {
    await input.refresh().catch(() => undefined);
    throw error;
  }
  await input.refresh();
  return true;
}
