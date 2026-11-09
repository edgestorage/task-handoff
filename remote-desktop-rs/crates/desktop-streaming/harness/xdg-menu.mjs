/**
 * bcap script
 * @description Open the private desktop's maintained XDG application menu through Tint2.
 * @type act
 * @tags remote-desktop, xdg, acceptance
 * @param {object} input
 * @match http://127.0.0.1:*
 */
export default async function(input) {
  if(await page.title()!=='G1 native desktop harness') throw new Error('Wrong harness');
  await page.bringToFront();
  if(await page.evaluate(()=>window.diagnostic.inputEpoch===null)) await page.locator('#resume').click();
  await page.waitForFunction(()=>window.diagnostic.inputEpoch!==null);
  const before = await page.evaluate(()=>window.diagnostic.decodedFrames);
  await page.locator('#video').click({position:{x:15,y:527}});
  await page.waitForFunction(n=>window.diagnostic.decodedFrames>n,before);
  await page.screenshot({path:'/tmp/g1-xdg-menu.png'});
  return {ok:true,state:await page.evaluate(()=>window.diagnostic)};
}
