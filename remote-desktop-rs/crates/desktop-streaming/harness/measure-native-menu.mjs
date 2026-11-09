/**
 * bcap script
 * @description Measure input-to-visible-menu latency through real XTest and decoded H.264 frames.
 * @type act
 * @tags remote-desktop, latency, acceptance
 * @param {object} input
 * @param {number} [input.samples=20] Number of open/close measurements.
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  if(await page.title()!=='G1 native desktop harness') throw new Error('Wrong harness');
  await page.bringToFront();
  if(await page.evaluate(()=>window.diagnostic.inputEpoch===null)) await page.locator('#resume').click();
  await page.waitForFunction(()=>window.diagnostic.inputEpoch!==null);
  const samples=[];
  const pixel=async visible=>page.waitForFunction(visible=>{
    const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d');x.drawImage(document.querySelector('video'),0,0,1280,720);const p=x.getImageData(380,260,1,1).data;
    return visible ? p[0]>180&&p[1]>180&&p[2]>180 : p[0]<30;
  },visible,{timeout:3000});
  for(let i=0;i<Math.min(50,Math.max(1,input.samples??20));i++) {
    await page.locator('#video').press('Escape');await pixel(false);
    const start=Date.now();await page.locator('#video').click({button:'right',position:{x:200,y:180}});await pixel(true);samples.push(Date.now()-start);
  }
  await page.locator('#video').press('Escape');
  const ordered=[...samples].sort((a,b)=>a-b);
  return {ok:true,url:page.url(),samplesMs:samples,p50Ms:ordered[Math.ceil(ordered.length*.5)-1],p95Ms:ordered[Math.ceil(ordered.length*.95)-1],maxMs:ordered.at(-1),stats:await page.evaluate(()=>window.harness.stats())};
}
