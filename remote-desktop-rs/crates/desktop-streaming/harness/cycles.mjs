/**
 * bcap script
 * @description Measure20 owned desktop viewer connect/close cycles and first-decoded-frame latency.
 * @type act
 * @tags remote-desktop, lifetime, acceptance
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();const samples=[];
  await page.locator('#stop').click();
  for(let cycle=0;cycle<20;cycle++){
    const previous=await page.evaluate(()=>window.diagnostic.snapshot?.viewerSessionId);
    const start=Date.now();
    await page.locator('#connect').click();
    await page.waitForFunction(old=>window.diagnostic.snapshot?.viewerSessionId!==old&&window.diagnostic.snapshot?.phase==='active'&&window.diagnostic.decodedFrames>2&&window.diagnostic.channels.length===4,previous,{timeout:10000});
    const connectedMs=Date.now()-start;
    const state=await page.evaluate(()=>structuredClone(window.diagnostic));
    if(state.error)throw new Error(state.error);
    const stop=Date.now();await page.locator('#stop').click();
    await page.waitForFunction(()=>['stopped','failed'].includes(window.diagnostic.snapshot?.phase),null,{timeout:5000});
    samples.push({cycle,connectedMs,stoppedMs:Date.now()-stop,session:state.snapshot.viewerSessionId});
  }
  const times=samples.map(x=>x.connectedMs).sort((a,b)=>a-b);
  return {ok:true,cycles:samples.length,firstFrameP95Ms:times[18],samples};
}
