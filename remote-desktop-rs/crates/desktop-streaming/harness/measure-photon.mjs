/**
 * bcap script
 * @description Measure trusted pointerdown to video-frame marker response on the same browser monotonic clock; retain API-call timing separately.
 * @type act
 * @tags remote-desktop, performance, benchmark
 * @param {object} input
 * @param {boolean} [input.connect=false] Establish a level4 viewer for the first chunk.
 * @param {number} [input.seconds=100] Chunk duration, at most100s.
 * @param {number} [input.samples=33] Marker samples, at most40.
 * @param {number} [input.receiverSlowdown=1] Explicit diagnostic CPU throttle:1,4,8,16; saved with results.
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();
  const slowdown=input.receiverSlowdown??1;
  if(![1,4,8,16].includes(slowdown))throw new Error('unsupported diagnostic slowdown');
  if(slowdown!==1){const client=await context.newCDPSession(page);await client.send('Emulation.setCPUThrottlingRate',{rate:slowdown});}
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
  if(await page.evaluate(()=>window.diagnostic.inputEpoch===null)){
    throw new Error('Input authority was lost between benchmark chunks');
  }
  await page.evaluate(()=>{
    window.referenceTrace=[];
    if(!window.referenceTraceInstalled){
      window.referenceTraceInstalled=true;
      const record=(kind,seq=null)=>{
        const list=window.referenceTrace;
        list.push({kind,seq,at:performance.now(),epoch:window.diagnostic.inputEpoch,hidden:document.hidden,focus:document.hasFocus()});
        if(list.length>60)list.shift();
      };
      const original=RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send=function(data){
        try{const value=JSON.parse(data);record('send:'+value.type,value.seq);}catch{}
        return original.call(this,data);
      };
      for(const kind of ['blur','focus','visibilitychange'])window.addEventListener(kind,()=>record(kind),true);
    }
  });
  const seconds=Math.min(100,Math.max(1,input.seconds??100)),count=Math.min(40,Math.max(1,input.samples??33));
  const start=Date.now(),interval=seconds*1000/count,samples=[];
  const stats=()=>page.evaluate(async()=>({width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,stats:await window.harness.stats(),phase:window.diagnostic.snapshot?.phase,error:window.diagnostic.error}));
  const before=await stats();
  for(let i=0;i<count;i++){
    await page.evaluate(()=>{
      const video=document.querySelector('video'),canvas=document.createElement('canvas');
      canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      const marker=()=>{ctx.drawImage(video,video.videoWidth*40/1920,video.videoHeight*40/1080,1,1,0,0,1,1);const p=ctx.getImageData(0,0,1,1).data;return p[0]>p[2];};
      const previous=marker();
      let finish,handle,timer,pressedAt=null,finished=false;
      const done=new Promise(resolve=>{finish=resolve;});
      const complete=value=>{
        if(finished)return;finished=true;clearTimeout(timer);
        video.removeEventListener('pointerdown',pressed,true);
        if(handle!==undefined)video.cancelVideoFrameCallback(handle);
        finish(value);
      };
      const frame=(now,metadata)=>{
        if(marker()!==previous){complete({latencyMs:performance.now()-pressedAt,displayLatencyMs:metadata.expectedDisplayTime-pressedAt});return;}
        handle=video.requestVideoFrameCallback(frame);
      };
      const pressed=event=>{
        if(!event.isTrusted||event.button!==0||pressedAt!==null)return;
        pressedAt=performance.now();
        handle=video.requestVideoFrameCallback(frame);
      };
      video.addEventListener('pointerdown',pressed,true);
      timer=setTimeout(()=>complete({error:pressedAt===null?'no trusted input':'marker deadline',previousMarker:previous,currentMarker:marker()}),2500);
      window.referencePhotonProbe={done};
    });
    const sent=Date.now();
    await page.locator('#video').click({position:{x:200,y:100}});
    const result=await page.evaluate(()=>window.referencePhotonProbe.done);
    if(result.error){
      const state=await stats(),trace=await page.evaluate(()=>window.referenceTrace);
      // Keep the original failure, then observe delayed delivery without sending
      // another click or resuming input. This is diagnosis, never a retry/pass.
      await page.waitForTimeout(5000);
      throw new Error(JSON.stringify({index:i,...result,samples,state,trace,afterGrace:await stats(),traceAfterGrace:await page.evaluate(()=>window.referenceTrace)}));
    }
    samples.push({index:i,...result,apiLatencyMs:Date.now()-sent,...await stats()});
    const wait=start+(i+1)*interval-Date.now();if(wait>0)await page.waitForTimeout(wait);
  }
  const replies=await page.evaluate(()=>window.diagnostic.metricsReplies);
  await page.locator('#metrics').click();await page.waitForFunction(n=>window.diagnostic.metricsReplies>n,replies);
  const after=await stats(),ordered=samples.map(x=>x.latencyMs).sort((a,b)=>a-b);
  return {receiverSlowdown:slowdown,ok:samples.every(s=>s.phase==='active'&&!s.error),elapsedMs:Date.now()-start,count,before,after,p95Ms:ordered[Math.ceil(count*.95)-1],samples,trace:await page.evaluate(()=>window.referenceTrace),measurement:'trusted-pointerdown-to-decoded-marker, same-browser performance.now',component:await page.evaluate(()=>window.diagnostic.metrics)};
}
