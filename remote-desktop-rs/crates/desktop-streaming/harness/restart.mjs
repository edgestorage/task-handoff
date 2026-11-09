/**
 * bcap script
 * @description Verify serialized repeated negotiation and ICE restart preserve the peer and invalidate input.
 * @type act
 * @tags remote-desktop, ice, acceptance
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  await page.bringToFront();
  await page.locator('#connect').click();
  await page.waitForFunction(()=>window.diagnostic.snapshot?.phase==='active'&&window.diagnostic.decodedFrames>5&&window.diagnostic.negotiations>=1);
  const initial = await page.evaluate(()=>structuredClone(window.diagnostic));
  await page.locator('#resume').click();
  await page.waitForFunction(()=>window.diagnostic.inputEpoch!==null);
  const firstEpoch = await page.evaluate(()=>window.diagnostic.inputEpoch);
  for(let i=0;i<3;i++) await page.locator('#renegotiate').click();
  await page.waitForFunction(n=>window.diagnostic.negotiations>=n+3, initial.negotiations, {timeout:12000});
  await page.waitForFunction(()=>window.diagnostic.inputEpoch===null);
  await page.locator('#resume').click();
  await page.waitForFunction(old=>window.diagnostic.inputEpoch!==null&&window.diagnostic.inputEpoch>old,firstEpoch);
  const before = await page.evaluate(()=>structuredClone(window.diagnostic));
  for(let i=0;i<2;i++) await page.locator('#restart').click();
  await page.waitForFunction(n=>window.diagnostic.negotiations>=n+2, before.negotiations,{timeout:15000});
  await page.waitForFunction(n=>window.diagnostic.decodedFrames>n+5&&window.diagnostic.transport==='connected'&&window.diagnostic.inputEpoch===null,before.decodedFrames,{timeout:10000});
  const final = await page.evaluate(()=>structuredClone(window.diagnostic));
  if(final.error||final.snapshot.viewerSessionId!==initial.snapshot.viewerSessionId) throw new Error('Restart changed peer or failed');
  await page.locator('#resume').click();
  await page.waitForFunction(old=>window.diagnostic.inputEpoch!==null&&window.diagnostic.inputEpoch>old,before.inputEpoch);
  await page.locator('#video').press('a');
  return {ok:true,url:page.url(),initialNegotiations:initial.negotiations,finalNegotiations:final.negotiations,firstEpoch,finalEpoch:await page.evaluate(()=>window.diagnostic.inputEpoch),stats:await page.evaluate(()=>window.harness.stats())};
}
