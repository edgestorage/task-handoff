const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../app/instances/[instanceId].tsx'), 'utf8');
const storyDetail = fs.readFileSync(path.resolve(__dirname, '../src/stories/StoryDetail.tsx'), 'utf8');

test('instance detail menu closes sessions from the authoritative AI Session snapshot', () => {
  expect(source).toMatch(/aiSessionState\.snapshot\?\.instances\.find/);
  expect(source).toMatch(/id: 'close-all-sessions'/);
  expect(source).toMatch(/Alert\.alert\(t\('sessions\.closeAllConfirmTitle'\)/);
  expect(source).toMatch(/aiSessionActions\.closeMany\(instanceSessions\.map/);
});

test('Story detail closes every matching snapshot session, including collapsed descendants', () => {
  expect(storyDetail).toMatch(/sessions\?\.instances[\s\S]*session\.storyId === story\.id/);
  expect(storyDetail).toMatch(/id: 'close-sessions'/);
  expect(storyDetail).toMatch(/aiSessionActions\.closeMany\(allLinkedSessions/);
  expect(storyDetail).not.toMatch(/allLinkedSessions[\s\S]{0,120}linkedSessions\.filter/);
});
