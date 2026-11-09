/**
 * bcap script
 * @description Measure decoded-frame continuity and adaptive geometry during a bounded native GUI load.
 * @type read
 * @tags remote-desktop, load, acceptance
 * @param {object} input
 * @param {number} [input.seconds=20] Observation duration.
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();const samples=[];
  for(let i=0;i<Math.min(40,Math.max(1,input.seconds??20));i++) {
    const replies=await page.evaluate(()=>window.diagnostic.metricsReplies);
    await page.locator('#metrics').click();
    await page.waitForFunction(n=>window.diagnostic.metricsReplies>n,replies);
    const state=await page.evaluate(async()=>{const video=document.querySelector('video');const stats=(await window.harness.stats())[0];return {width:video.videoWidth,height:video.videoHeight,...stats,error:window.diagnostic.error,phase:window.diagnostic.snapshot?.phase,component:window.diagnostic.metrics};});
    samples.push({second:i,...state});await page.waitForTimeout(1000);
  }
  let frozenSeconds=0,maxFrozenSeconds=0;
  for(let i=1;i<samples.length;i++){frozenSeconds=samples[i].framesDecoded===samples[i-1].framesDecoded?frozenSeconds+1:0;maxFrozenSeconds=Math.max(maxFrozenSeconds,frozenSeconds);}
  return {ok:samples.every(s=>s.phase==='active'&&!s.error)&&maxFrozenSeconds<3,url:page.url(),maxFrozenSeconds,samples};
}
