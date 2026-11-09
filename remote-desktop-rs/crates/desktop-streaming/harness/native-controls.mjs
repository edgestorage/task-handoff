/**
 * bcap script
 * @description Verify native pause/IDR and explicit system-clipboard opt-in in the disposable G1 desktop.
 * @type act
 * @tags remote-desktop, native, clipboard
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();
  const before=await page.evaluate(()=>structuredClone(window.diagnostic));
  if(before.clipboardEnabled) throw new Error('Clipboard should start disabled');
  await page.locator('#clipboard').check();
  await page.waitForFunction(()=>window.diagnostic.clipboardEnabled);
  const text='中文・日本語・é・😀';
  await page.locator('#clipboardText').fill(text);
  await page.locator('#write').click();
  await page.waitForFunction(n=>window.diagnostic.clipboardWrites===n+1,before.clipboardWrites);
  await page.locator('#read').click();
  await page.waitForFunction(text=>window.diagnostic.clipboardText===text,text);
  await page.locator('#clipboard').uncheck();
  await page.waitForFunction(()=>!window.diagnostic.clipboardEnabled);
  await page.locator('#hidden').click();
  await page.waitForFunction(()=>window.diagnostic.snapshot.mediaPaused&&window.diagnostic.inputEpoch===null);
  await page.waitForTimeout(500);
  const paused=await page.evaluate(()=>window.diagnostic.decodedFrames);
  await page.waitForTimeout(800);
  if(await page.evaluate(()=>window.diagnostic.decodedFrames)!==paused) throw new Error('Native video continued while paused');
  const keys=(await page.evaluate(()=>window.harness.stats()))[0].keyFramesDecoded;
  await page.locator('#visible').click();
  await page.evaluate(keys=>new Promise((resolve,reject)=>{
    const video=document.querySelector('video');let callback;const timer=setTimeout(()=>{video.cancelVideoFrameCallback(callback);reject(new Error('Native IDR missing'));},5000);
    const check=async()=>{const stats=await window.harness.stats();if(stats[0].keyFramesDecoded>keys){clearTimeout(timer);resolve();}else callback=video.requestVideoFrameCallback(check);};callback=video.requestVideoFrameCallback(check);
  }),keys);
  return {ok:true,unicodeClipboard:true,pausedFrames:paused,stats:await page.evaluate(()=>window.harness.stats())};
}
