export const NotificationFeedbackType = {
  Error: 'error',
  Success: 'success',
  Warning: 'warning',
} as const;

export const notificationAsync = jest.fn(async () => undefined);
export const selectionAsync = jest.fn(async () => undefined);
