const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '../scripts/check-boundaries.mjs');

function runBundleCheck(contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-handoff-mobile-bundle-'));
  try {
    fs.writeFileSync(path.join(root, 'entry.hbc'), contents);
    return execFileSync(process.execPath, [script, '--bundle-dir', root], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function bundleFailure(contents) {
  try {
    runBundleCheck(contents);
    return undefined;
  } catch (error) {
    return error;
  }
}

test('allows the public accessTicketId grant field in mobile bundles', () => {
  expect(() => runBundleCheck('{"accessTicketId":"access_ticket_a"}')).not.toThrow();
});

test('still rejects an access ticket object in mobile bundles', () => {
  const error = bundleFailure('{"accessTicket":{"ticketId":"access_ticket_a"}}');
  expect(error?.status).toBe(1);
  expect(String(error?.stderr)).toContain('contains forbidden bundle token accessTicket');
});
