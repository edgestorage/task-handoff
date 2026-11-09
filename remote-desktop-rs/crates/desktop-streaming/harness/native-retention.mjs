/**
 * bcap script
 * @description Launch a native desktop terminal from Openbox and verify it survives viewer teardown.
 * @type act
 * @tags remote-desktop, native, retention
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  if(await page.title()!=='G1 native desktop harness') throw new Error('Wrong harness');
  await page.bringToFront();
  if(await page.evaluate(()=>window.diagnostic.inputEpoch===null)) await page.locator('#resume').click();
  await page.waitForFunction(()=>window.diagnostic.inputEpoch!==null);
  // The preceding menu fixture leaves Openbox's terminal item at this location.
  await page.locator('#video').click({position:{x:245,y:190}});
  const first = await page.evaluate(()=>window.diagnostic.snapshot.viewerSessionId);
  await page.waitForFunction(()=>{
    const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d');x.drawImage(document.querySelector('video'),0,0,1280,720);
    const pixels=x.getImageData(0,0,1280,680).data;let white=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>200&&pixels[i+1]>200&&pixels[i+2]>200)white++;return white>20000;
  },null,{timeout:5000});
  await page.screenshot({path:'/tmp/g1-native-terminal.png'});
  await page.locator('#stop').click();
  await page.waitForFunction(()=>['stopped','failed'].includes(window.diagnostic.snapshot?.phase));
  await page.locator('#connect').click();
  await page.waitForFunction(old=>window.diagnostic.snapshot?.viewerSessionId!==old&&window.diagnostic.snapshot?.phase==='active'&&window.diagnostic.decodedFrames>0,first);
  await page.screenshot({path:'/tmp/g1-native-retained.png'});
  return {ok:true,first,reconnected:await page.evaluate(()=>window.diagnostic.snapshot.viewerSessionId),stats:await page.evaluate(()=>window.harness.stats())};
}
