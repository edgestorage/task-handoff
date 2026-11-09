/** Internal transport ownership, shared by all generic instance proxy modes.
 * Dedicated managed transports own private endpoints; no caller header can
 * change this classification. This is not an independently versioned wire API. */
export type InstanceEndpointAccess = "generic" | "remote-desktop-private" | "invalid";
export function instanceEndpointAccess(input: string): InstanceEndpointAccess {
  try {
    if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\") || /%25/i.test(input)) return "invalid";
    const url=new URL(input,"http://instance.invalid");
    if(url.origin!=="http://instance.invalid" || url.hash)return "invalid";
    const segments=decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if(segments.some(segment=>segment==="."||segment===".."))return "invalid";
    const family=["api","internal","remote-desktop"];
    return family.every((part,index)=>segments[index]===part) ? "remote-desktop-private" : "generic";
  }catch{return "invalid";}
}
