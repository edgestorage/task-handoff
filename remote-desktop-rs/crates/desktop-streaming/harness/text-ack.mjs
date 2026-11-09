/**
 * bcap script
 * @description Verify text completion ACK and exclusion of physical keys during native Unicode commit in an owned raw-stdin terminal.
 * @type act
 * @tags remote-desktop, input, acceptance
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();
  await page.waitForFunction(()=>window.diagnostic.snapshot?.phase==='active'&&window.diagnostic.decodedFrames>5);
  await page.locator('#resume').click();
  await page.waitForFunction(()=>window.diagnostic.inputEpoch!==null);
  const commits=await page.evaluate(()=>window.diagnostic.textCommits);
  const text='中文・日本語・é・😀 mixed ASCII punctuation !?';
  await page.locator('#commit').fill(text);
  // Deliver a physical Enter synchronously after commit submission. The native
  // actuator has not acknowledged text yet, so no Enter may reach the terminal.
  await page.evaluate(()=>{
    const field=document.querySelector('#commit');
    field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
    const video=document.querySelector('#video');
    for(const type of ['keydown','keyup'])video.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
  });
  await page.waitForFunction(n=>window.diagnostic.textCommits===n+1,commits,{timeout:4000});
  if(await page.evaluate(()=>window.diagnostic.inputEpoch===null||window.diagnostic.error))throw new Error('Native text invalidated the input lease');
  await page.locator('#video').press('Enter');
  return {ok:true,text,commitsBefore:commits,commitsAfter:await page.evaluate(()=>window.diagnostic.textCommits),expectedTerminalUtf8:text+'\r'};
}
