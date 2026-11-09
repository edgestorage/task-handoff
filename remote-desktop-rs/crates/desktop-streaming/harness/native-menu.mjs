/**
 * bcap script
 * @description Exercise native desktop menu with real pointer input in the G1 disposable harness.
 * @type act
 * @tags remote-desktop, native, acceptance
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  if (await page.title() !== 'G1 native desktop harness') throw new Error('Wrong harness');
  await page.bringToFront();
  if(await page.evaluate(()=>window.diagnostic.inputEpoch===null)) await page.locator('#resume').click();
  await page.waitForFunction(() => window.diagnostic.inputEpoch !== null);
  await page.locator('#video').press('Escape');
  await page.waitForFunction(() => { const c=document.createElement('canvas'); c.width=1280;c.height=720;const x=c.getContext('2d');x.drawImage(document.querySelector('video'),0,0,1280,720);return x.getImageData(380,260,1,1).data[0]<30;},null,{timeout:3000});
  const started = Date.now();
  await page.locator('#video').click({button:'right',position:{x:200,y:180}});
  await page.waitForFunction(() => {
    const c=document.createElement('canvas');c.width=1280;c.height=720;
    const x=c.getContext('2d');x.drawImage(document.querySelector('video'),0,0,1280,720);
    const p=x.getImageData(380,260,1,1).data;return p[0]>180&&p[1]>180&&p[2]>180;
  },null,{timeout:3000});
  const menuLatencyMs = Date.now()-started;
  await page.screenshot({path:'/tmp/g1-native-menu.png'});
  return {ok:true,menuLatencyMs,state:await page.evaluate(()=>window.diagnostic),stats:await page.evaluate(()=>window.harness.stats())};
}
