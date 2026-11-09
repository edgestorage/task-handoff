/**
 * bcap script
 * @description Measure a bounded chunk of a synthetic1920x1080GUI workload, input-marker response and decode/queue counters.
 * @type act
 * @tags remote-desktop, performance, benchmark
 * @param {object} input
 * @param {boolean} [input.connect=false] Establish a level4 viewer for the first chunk.
 * @param {number} [input.seconds=100] Chunk duration, at most100s.
 * @param {number} [input.samples=33] Marker samples, at most40.
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();
  if(input.connect){
    await page.evaluate(()=>{
      const create=RTCPeerConnection.prototype.createOffer;
      RTCPeerConnection.prototype.createOffer=async function(...args){const offer=await create.apply(this,args);return {type:offer.type,sdp:offer.sdp.replace(/profile-level-id=42e01f/g,'profile-level-id=42e028')};};
    });
    await page.locator('#connect').click();
    await page.waitForFunction(()=>window.diagnostic.decodedFrames>8,null,{timeout:10000});
    await page.waitForFunction(()=>document.querySelector('video').videoWidth===1920,null,{timeout:30000});
    await page.locator('#resume').click();await page.waitForFunction(()=>window.diagnostic.inputEpoch!==null);
  }
  if(await page.evaluate(()=>window.diagnostic.inputEpoch===null)){await page.locator('#resume').click();await page.waitForFunction(()=>window.diagnostic.inputEpoch!==null);}
  const seconds=Math.min(100,Math.max(1,input.seconds??100)),count=Math.min(40,Math.max(1,input.samples??33));
  const start=Date.now(),interval=seconds*1000/count,samples=[];
  const stats=()=>page.evaluate(async()=>({width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,stats:await window.harness.stats(),phase:window.diagnostic.snapshot?.phase,error:window.diagnostic.error}));
  const before=await stats();
  const marker=()=>page.evaluate(()=>{const v=document.querySelector('video'),c=document.createElement('canvas');c.width=1920;c.height=1080;const x=c.getContext('2d');x.drawImage(v,0,0,1920,1080);const p=x.getImageData(40,40,1,1).data;return p[0]>p[2];});
  for(let i=0;i<count;i++){
    const previous=await marker(),sent=Date.now();
    await page.locator('#video').click({position:{x:200,y:100}});
    try{await page.waitForFunction(previous=>{const v=document.querySelector('video'),c=document.createElement('canvas');c.width=1920;c.height=1080;const x=c.getContext('2d');x.drawImage(v,0,0,1920,1080);const p=x.getImageData(40,40,1,1).data;return (p[0]>p[2])!==previous;},previous,{timeout:2000});}catch(error){throw new Error(JSON.stringify({index:i,previous,current:await marker(),samples,state:await page.evaluate(()=>window.diagnostic),reason:error.message}));}
    samples.push({index:i,latencyMs:Date.now()-sent,...await stats()});
    const wait=start+(i+1)*interval-Date.now();if(wait>0)await page.waitForTimeout(wait);
  }
  const replies=await page.evaluate(()=>window.diagnostic.metricsReplies);
  await page.locator('#metrics').click();await page.waitForFunction(n=>window.diagnostic.metricsReplies>n,replies);
  const after=await stats(),ordered=samples.map(x=>x.latencyMs).sort((a,b)=>a-b);
  return {ok:samples.every(s=>s.phase==='active'&&!s.error),elapsedMs:Date.now()-start,count,before,after,p95Ms:ordered[Math.ceil(count*.95)-1],samples,component:await page.evaluate(()=>window.diagnostic.metrics)};
}
