/**
 * bcap script
 * @description Verify a peer advertising a small SCTP message size cannot enable clipboard while video and input remain usable.
 * @type act
 * @tags remote-desktop, sctp, acceptance
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();
  await page.locator('#stop').click();
  await page.evaluate(()=>{
    window.smallSctpAck=null;
    const createChannel=RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel=function(...args){
      const channel=createChannel.apply(this,args);
      if(args[0]==='control')channel.addEventListener('message',event=>{
        const message=JSON.parse(event.data);
        if(message.type==='clipboard.enabled')window.smallSctpAck=message.payload;
      });
      return channel;
    };
    const original=RTCPeerConnection.prototype.createOffer;
    RTCPeerConnection.prototype.createOffer=async function(...args){
      const offer=await original.apply(this,args);
      return {type:offer.type,sdp:offer.sdp.replace(/a=max-message-size:[0-9]+/g,'a=max-message-size:1024')};
    };
  });
  try {
    await page.locator('#connect').click();
    await page.waitForFunction(()=>window.diagnostic.snapshot?.phase==='active'&&window.diagnostic.decodedFrames>5&&window.diagnostic.channels.length===4,null,{timeout:10000});
    // Direct harness send bypasses its own UI capability check to exercise
    // the component's negotiated SCTP boundary independently.
    await page.evaluate(()=>window.harness.send('control','clipboard.enable',{enabled:true}));
    await page.waitForFunction(()=>window.smallSctpAck!==null,null,{timeout:4000});
    if(await page.evaluate(()=>window.smallSctpAck.enabled))throw new Error('Component accepted small SCTP clipboard');
    const disabled=await page.evaluate(()=>!window.diagnostic.clipboardEnabled&&!document.querySelector('#clipboard').checked);
    if(!disabled)throw new Error('Small SCTP peer enabled clipboard');
    await page.locator('#resume').click();
    await page.waitForFunction(()=>window.diagnostic.inputEpoch!==null);
    const state=await page.evaluate(()=>structuredClone(window.diagnostic));
    if(state.error)throw new Error(state.error);
    return {ok:true,advertisedMaxMessageSize:1024,clipboardEnabled:state.clipboardEnabled,inputEpoch:state.inputEpoch,decodedFrames:state.decodedFrames};
  } catch(error) {
    throw new Error(error.message+' '+JSON.stringify(await page.evaluate(()=>window.diagnostic)));
  } finally {
    // Navigation restores the native browser prototype as well as closing
    // this disposable viewer. No patch survives the test.
    await page.locator('#stop').click();
    await page.reload();
  }
}
