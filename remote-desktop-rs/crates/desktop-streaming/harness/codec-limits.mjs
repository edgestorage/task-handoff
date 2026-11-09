/**
 * bcap script
 * @description Verify native1080p level4, level3.1 downscale and receiver max-fs constraints on an explicitly owned1920x1080 fixture display.
 * @type act
 * @tags remote-desktop, codec, acceptance
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();const results=[];
  for(const test of [{level:'1f',width:1280,height:720},{level:'28',width:1920,height:1080},{level:'28',maxFs:1200}]) {
    await page.reload();
    await page.evaluate(test=>{
      window.codecAnswer=null;
      const offer=RTCPeerConnection.prototype.createOffer;
      RTCPeerConnection.prototype.createOffer=async function(...args){
        const value=await offer.apply(this,args);
        const sdp=value.sdp.split('\r\n').map(line=>line.includes('profile-level-id=42e01f')?line.replace('profile-level-id=42e01f','profile-level-id=42e0'+test.level)+(test.maxFs?';max-fs='+test.maxFs+';max-mbps=12000':''):line).join('\r\n');
        return {type:value.type,sdp};
      };
      const answer=RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription=async function(value){window.codecAnswer=value.sdp;return await answer.call(this,value);};
    },test);
    try {
      await page.locator('#connect').click();
      await page.waitForFunction(()=>window.diagnostic.decodedFrames>8,null,{timeout:12000});
      const measured=await page.evaluate(async()=>({width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,fmtp:window.codecAnswer.split('\r\n').filter(x=>x.startsWith('a=fmtp:')),stats:await window.harness.stats(),state:window.diagnostic.error}));
      if(measured.state)throw new Error(measured.state);
      if(test.width&&(measured.width!==test.width||measured.height!==test.height))throw new Error('Wrong geometry '+JSON.stringify({test,measured}));
      if(test.maxFs&&Math.ceil(measured.width/16)*Math.ceil(measured.height/16)>test.maxFs)throw new Error('Receiver max-fs exceeded '+JSON.stringify(measured));
      results.push({test,...measured});
    } catch(error){throw new Error(error.message+' '+JSON.stringify(await page.evaluate(()=>window.diagnostic)));}
    finally{await page.locator('#stop').click();}
  }
  await page.reload();return {ok:true,results};
}
