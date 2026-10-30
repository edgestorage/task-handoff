import { cloudMobileError, cloudMobileErrorMessage } from '../src/control-plane/cloud-error';

test('invalid credentials are reported as a credential error instead of an unknown result', () => {
  const error = Object.assign(new Error('Email or password is invalid.'), {
    code: 'INVALID_CREDENTIALS',
    status: 400,
  });

  expect(cloudMobileError(error)).toEqual({
    kind: 'invalid-credentials',
    code: 'INVALID_CREDENTIALS',
    retryable: false,
  });
  expect(cloudMobileErrorMessage(error, true)).toBe('邮箱或密码不正确。');
  expect(cloudMobileErrorMessage(error, false)).toBe('Email or password is incorrect.');
});

test('uncoded failures remain unknown results', () => {
  expect(cloudMobileError(new Error('Unexpected response')).kind).toBe('result-unknown');
});
