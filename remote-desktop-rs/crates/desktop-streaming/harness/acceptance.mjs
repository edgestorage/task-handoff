/**
 * bcap script
 * @description Verify the disposable G1 synthetic desktop harness through its UI.
 * @type act
 * @tags remote-desktop, synthetic, acceptance
 * @param {object} input
 * @returns {{ok: boolean, url?: string, title?: string, evidence: object}}
 * @match http://127.0.0.1:*
 */
export default async function (input) {
  if (await page.title() !== 'G1 synthetic desktop harness') throw new Error('Wrong harness');
  const evidence = {};
  let stage = "connect";
  const read = () => page.evaluate(() => structuredClone(window.diagnostic));
  try {
    const stats = () => page.evaluate(() => window.harness.stats());
    // This Playwright build treats an async waitForFunction predicate as a truthy
    // Promise before it resolves. Await the actual measurement on decoded frames.
    const waitKeyframe = old => page.evaluate(old => new Promise((resolve, reject) => {
      const video = document.querySelector('video'); let callback;
      const timeout = setTimeout(() => {video.cancelVideoFrameCallback(callback);reject(new Error('No new decoded IDR'));}, 10000);
      const check = async () => {
        const reports = await window.harness.stats();
        if(reports[0]?.keyFramesDecoded > old){clearTimeout(timeout);resolve(reports);}
        else callback = video.requestVideoFrameCallback(check);
      };
      callback = video.requestVideoFrameCallback(check);
    }), old);

    await page.bringToFront();
    const initialSession = (await read()).snapshot?.viewerSessionId;
    await page.locator('#connect').click();
    await page.waitForFunction(previous => window.diagnostic.snapshot?.viewerSessionId !== previous && window.diagnostic.decodedFrames > 15 && window.diagnostic.channels.length === 4, initialSession);
    evidence.connected = await stats();
    stage = 'resume';
    await page.locator('#resume').click();
    await page.waitForFunction(() => window.diagnostic.inputEpoch !== null);
    const firstEpoch = (await read()).inputEpoch;
    await page.locator('#video').press('a');
    await page.locator('#commit').fill('中文・日本語・é・😀');
    await page.locator('#commit').press('Enter');
    await page.waitForFunction(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); ctx.drawImage(document.querySelector('video'), 0, 0, 640, 360);
      // Accepted key/text operations and final Unicode commit drive separate video bars.
      return ctx.getImageData(6, 50, 1, 1).data[0] > 180 && ctx.getImageData(30, 95, 1, 1).data[0] > 180;
    });
    evidence.input = {acceptedOperationPixels: true, unicodeCommitPixels: true};
    stage = 'hidden';
    await page.locator('#hidden').click();
    await page.waitForFunction(() => window.diagnostic.snapshot.mediaPaused && window.diagnostic.snapshot.idleExpiresAt !== null && window.diagnostic.inputEpoch === null);
    // Explicit measurement windows allow any already-decoded video to drain.
    await page.waitForTimeout(500);
    const paused = (await read()).decodedFrames;
    await page.waitForTimeout(800);
    const pausedEnd = (await read()).decodedFrames;
    if (pausedEnd !== paused) throw new Error(`Video continued while paused: ${paused} -> ${pausedEnd}`);
    evidence.pause = {paused, pausedEnd};
    const keyframes = Math.max(evidence.connected[0].keyFramesDecoded, (await stats())[0].keyFramesDecoded);
    stage = 'visible';
    await page.locator('#visible').click();
    await page.waitForFunction(n => window.diagnostic.decodedFrames > n + 5 && !window.diagnostic.snapshot.mediaPaused, pausedEnd);
    if ((await read()).inputEpoch !== null) throw new Error('Visibility resumed input without consent');
    const resumedKeys = (await waitKeyframe(keyframes))[0].keyFramesDecoded;
    stage = 'resume';
    await page.locator('#resume').click();
    await page.waitForFunction(old => window.diagnostic.inputEpoch !== null && window.diagnostic.inputEpoch !== old, firstEpoch);
    evidence.epochs = [firstEpoch, (await read()).inputEpoch];
    const beforeRequest = Math.max(keyframes + 1, resumedKeys, (await stats())[0].keyFramesDecoded);
    evidence.idrBaselines = {beforeResume: keyframes, beforeRequest};
    stage = 'keyframe';
    await page.locator('#keyframe').click();
    evidence.idr = await waitKeyframe(beforeRequest);
    if(evidence.idr[0].keyFramesDecoded <= beforeRequest) throw new Error('Keyframe stats regressed');
    stage = 'clipboard';
    await page.locator('#clipboard').check();
    await page.waitForFunction(() => window.diagnostic.clipboardEnabled);
    const text = '中文・日本語・é・😀';
    await page.locator('#clipboardText').fill(text);
    await page.locator('#write').click();
    await page.waitForFunction(() => window.diagnostic.clipboardWrites === 1);
    await page.locator('#clipboardText').fill('');
    await page.locator('#read').click();
    await page.waitForFunction(text => window.diagnostic.clipboardText === text, text);
    evidence.clipboard = {unicodeRoundtrip: true};
    stage = 'clipboard';
    await page.locator('#clipboard').uncheck();
    await page.waitForFunction(() => !window.diagnostic.clipboardEnabled);
    await page.locator('#write').click();
    if ((await read()).clipboardWrites !== 1) throw new Error('Disabled clipboard accepted write');
    const second = await context.newPage();
    try {
      await second.goto(page.url());
      await second.locator('#connect').click();
      await second.waitForFunction(() => window.diagnostic.error === 'REMOTE_DESKTOP_BUSY');
      evidence.busy = (await second.evaluate(() => window.diagnostic.error));
    } finally { await second.close(); }
    await page.bringToFront();
    evidence.beforeStop = await read();
    stage = 'stop';
    await page.locator('#stop').click();
    await page.waitForFunction(() => ['stopped','failed'].includes(window.diagnostic.snapshot?.phase));
    const previous = (await read()).snapshot.viewerSessionId;
    await page.locator('#connect').click();
    await page.waitForFunction(previous => window.diagnostic.snapshot?.phase === 'active' && window.diagnostic.snapshot.viewerSessionId !== previous && window.diagnostic.decodedFrames > 5, previous);
    evidence.reconnected = await read();
    stage = 'stop';
    await page.locator('#stop').click();
    return {ok: true, url: page.url(), title: await page.title(), evidence};
  } catch (error) {
    return {ok:false,url:page.url(),title:await page.title(),stage,error:error.message,evidence,state:await read()};
  } finally {
    await page.locator('#stop').click().catch(() => {});
  }
}
