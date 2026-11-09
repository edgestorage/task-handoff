/**
 * bcap script
 * @description Verify changing H.264 level/resource constraints on one live viewer drains old encoded work and recovers with IDR.
 * @type act
 * @tags remote-desktop, codec, renegotiation
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();await page.reload();
  await page.evaluate(()=>{
    window.receiveLimits={level:'28'};
    const original=RTCPeerConnection.prototype.createOffer;
    RTCPeerConnection.prototype.createOffer=async function(...args){
      const value=await original.apply(this,args),test=window.receiveLimits;
      const sdp=value.sdp.split('\r\n').map(line=>{
        if(!/profile-level-id=42e0/.test(line))return line;
        return line.replace(/profile-level-id=42e0[0-9a-f]{2}/g,'profile-level-id=42e0'+test.level).replace(/;max-fs=[^;\r\n]+/g,'').replace(/;max-mbps=[^;\r\n]+/g,'')+(test.maxFs?';max-fs='+test.maxFs+';max-mbps=12000':'');
      }).join('\r\n');return {type:value.type,sdp};
    };
  });
  const samples=[];
  try {
    await page.locator('#connect').click();
    await page.waitForFunction(()=>window.diagnostic.decodedFrames>8&&document.querySelector('video').videoWidth===1920,null,{timeout:12000});
    const first=await page.evaluate(()=>window.diagnostic.snapshot.viewerSessionId);
    for(const test of [{level:'1f',width:1280,height:720},{level:'28',width:1920,height:1080},{level:'28',maxFs:1200}]) {
      await page.locator('#resume').click();await page.waitForFunction(()=>window.diagnostic.inputEpoch!==null);
      const old=await page.evaluate(async()=>({negotiations:window.diagnostic.negotiations,keyframes:(await window.harness.stats())[0].keyFramesDecoded}));
      await page.evaluate(test=>{window.receiveLimits=test;},test);
      await page.locator('#renegotiate').click();
      await page.waitForFunction(n=>window.diagnostic.negotiations===n+1&&window.diagnostic.inputEpoch===null,old.negotiations,{timeout:8000});
      await page.waitForFunction(test=>{const v=document.querySelector('video');return test.width?v.videoWidth===test.width&&v.videoHeight===test.height:Math.ceil(v.videoWidth/16)*Math.ceil(v.videoHeight/16)<=test.maxFs;},test,{timeout:8000});
      const measured=await page.evaluate(async()=>({width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,stats:await window.harness.stats(),session:window.diagnostic.snapshot.viewerSessionId,error:window.diagnostic.error}));
      if(measured.error||measured.session!==first||measured.stats[0].keyFramesDecoded<=old.keyframes)throw new Error('Format transition failed '+JSON.stringify(measured));
      samples.push({test,...measured});
    }
    return {ok:true,samples};
  } catch(error){throw new Error(error.message+' '+JSON.stringify(await page.evaluate(()=>window.diagnostic)));}
  finally {await page.locator('#stop').click();await page.reload();}
}
