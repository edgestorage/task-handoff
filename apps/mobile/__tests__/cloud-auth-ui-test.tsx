import { fireEvent, render } from '@testing-library/react-native';

import { OneTimeCodeInput, normalizeOneTimeCode } from '../src/components/OneTimeCodeInput';
import { MobileThemeProvider } from '../src/components/theme';

test('one-time code input normalizes pasted text to six digits', async () => {
  expect(normalizeOneTimeCode('12a 34-5678')).toBe('123456');
  const onChangeText = jest.fn();
  const screen = await render(<MobileThemeProvider><OneTimeCodeInput accessibilityLabel="Authenticator code" onChangeText={onChangeText} value="12"/></MobileThemeProvider>);

  expect(screen.getByTestId('one-time-code-boxes')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Authenticator code'), '12a 34-5678');
  expect(onChangeText).toHaveBeenCalledWith('123456');
  await screen.unmount();
});
