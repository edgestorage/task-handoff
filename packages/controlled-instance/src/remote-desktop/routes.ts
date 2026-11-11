/** Trusted instance boundary only. The general proxy rejects this endpoint
 * family; G4's dedicated node-agent operations will supply resolved principals.
 * Never mount an unrestricted IPC command endpoint or forward media here. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import WebSocket from "ws";
import {
  DesktopIceConfigSchema,
  DesktopCaptureSelectionSchema,
  DesktopSignalSchema,
  REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL,
  REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL,
} from "@task-handoff/protocol/remote-desktop";
import type { DesktopService } from "./service";
import type { ComponentEvent } from "./component-host";
const Owner=z.object({actorId:z.string().min(1).max(4096),deviceSessionId:z.string().min(1).max(4096)}).strict();
const Base=z.object({requestId:z.string().min(1).refine(value=>Buffer.byteLength(value,"utf8")<=128),owner:Owner}).strict();
const Session=Base.extend({viewerSessionId:z.string().min(1).max(4096)});
const Attach=Session.extend({captureSelection:DesktopCaptureSelectionSchema,attachToken:z.string().min(1).max(4096)});
const Body=Base.extend({captureSelection:DesktopCaptureSelectionSchema});
const SignedSignal=z.union([
  DesktopSignalSchema,
  z.object({type:z.literal("configureIce"),requestId:z.string().min(1).refine(value=>Buffer.byteLength(value,"utf8")<=128),...DesktopIceConfigSchema.shape}).strict(),
]);
function respondError(reply:FastifyReply,error:unknown){
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:"REMOTE_DESKTOP_INVALID_REQUEST",message:"Invalid remote desktop request."}});
  const code=error instanceof Error && /^REMOTE_DESKTOP_[A-Z_]+$/.test(error.message)?error.message:"REMOTE_DESKTOP_COMPONENT_UNAVAILABLE";
  return reply.code(409).send({error:{code,message:"Remote desktop operation failed."}});
}
export function registerDesktopRoutes(app:FastifyInstance,service:DesktopService,credential:()=>string|undefined){
  const boundary={config:{taskHandoffAuth:"node-agent" as const},preHandler:async(request:FastifyRequest,reply:FastifyReply)=>{
    reply.header("Cache-Control","no-store");
    const expected=credential();const match=/^Bearer (.+)$/.exec(request.headers.authorization||"");
    const actual=Buffer.from(match?.[1]||"");const secret=Buffer.from(expected||"");
    if(!expected||actual.length!==secret.length||!timingSafeEqual(actual,secret))return reply.code(403).send({error:{code:"REMOTE_DESKTOP_UNAUTHORIZED",message:"A trusted instance credential is required."}});
  },logLevel:"silent" as const};
  app.post("/api/internal/remote-desktop/preflight",boundary,async()=>({data:await service.reconcile()}));
  app.get("/api/internal/remote-desktop/settings",boundary,async()=>({data:service.settings.get()}));
  app.put("/api/internal/remote-desktop/settings",boundary,async(request,reply)=>{
    try{return {data:await service.setEnabled(z.object({enabled:z.boolean()}).strict().parse(request.body).enabled)};}catch(error){return respondError(reply,error);}
  });
  for(const [route,type,schema]of [
    ["sources","listSources",Base],["reserve","reserve",Body],
    ["takeover","takeover",Session.extend({captureSelection:DesktopCaptureSelectionSchema})],
    ["force-stop","forceStop",z.object({requestId:z.string().min(1).refine(value=>Buffer.byteLength(value,"utf8")<=128),viewerSessionId:z.string().min(1).max(4096)}).strict()],["snapshot","snapshot",Session],["stop","stop",Session],
  ]as const){
    app.post(`/api/internal/remote-desktop/${route}`,{...boundary,bodyLimit:16*1024},async(request,reply)=>{
      try{const{requestId,...fields}=schema.parse(request.body);const result=await service.request(requestId,{type,...fields});
        if(result.type==="error")return reply.code(409).send({error:{code:result.code,message:"Remote desktop operation failed."}});
        return {data:result};
      }catch(error){return respondError(reply,error);}
    });
  }
  app.get("/api/internal/remote-desktop/attach",{...boundary,websocket:true},(socket)=>{
    let binding:z.infer<typeof Session>|undefined;
    let closed=false,queued=0,ready=false,attached=false,lastRevision=-1;
    let bootId:string|undefined;
    let buffered:ComponentEvent[]=[];
    let rateStart=performance.now(),messages=0;
    let chain=Promise.resolve();
    const send=(value:unknown)=>{
      if(closed||socket.readyState!==socket.OPEN)return;
      if(socket.bufferedAmount>1024*1024){socket.close(1013,"Remote desktop signaling backlog exceeded.");return;}
      socket.send(JSON.stringify(value));
    };
    const event=(event:ComponentEvent)=>{
      if(!binding||event.snapshot.viewerSessionId!==binding.viewerSessionId||(bootId&&event.bootId!==bootId))return;
      if(!ready){if(buffered.length>=128)socket.close(1013,"Snapshot required.");else buffered.push(event);return;}
      if(event.snapshot.sessionRevision<=lastRevision)return;
      lastRevision=event.snapshot.sessionRevision;send({type:"snapshot",snapshot:event.snapshot});
      if(event.snapshot.phase==="stopped"||event.snapshot.phase==="failed")socket.close(1000,"Remote desktop session ended.");
    };
    const cleanup=()=>{
      if(closed)return;closed=true;clearTimeout(attachDeadline);buffered=[];
      service.off("session",event);service.off("changed",changed);
      // Queue behind a pending attach/offer, so a late success is still closed.
      chain.finally(async()=>{if(attached&&binding)await service.request(randomBytes(16).toString("hex"),{type:"signalClosed",owner:binding.owner,viewerSessionId:binding.viewerSessionId},bootId).catch(()=>undefined);}).catch(()=>undefined);
    };
    const changed=()=>{if(binding&&!service.componentRunning())socket.close(1011,"Remote desktop component unavailable.");};
    const attachDeadline=setTimeout(()=>socket.close(1008,"Attach deadline exceeded."),20_000);
    service.on("session",event);service.on("changed",changed);
    socket.on("close",cleanup);socket.on("error",cleanup);
    socket.on("message",(data,isBinary)=>{
      if(closed)return;
      const now=performance.now();if(now-rateStart>=1000){rateStart=now;messages=0;}
      if(isBinary||(Array.isArray(data)?data.reduce((bytes,chunk)=>bytes+chunk.byteLength,0):data.byteLength)>1024*1024||++messages>64||++queued>8){socket.close(1008,"Invalid signaling message or limit exceeded.");return;}
      chain=chain.then(async()=>{
        if(closed)return;
        const raw:unknown=JSON.parse(data.toString());
        if(!binding){
          const{requestId,...fields}=Attach.parse(raw);
          // Binding is installed before forwarding so negotiating events have a
          // bounded snapshot buffer; it contains no attach token.
          binding={requestId,owner:fields.owner,viewerSessionId:fields.viewerSessionId};
          const result=await service.request(requestId,{type:"attach",...fields});
          if(result.type!=="snapshot")throw new Error("REMOTE_DESKTOP_ATTACH_INVALID");
          attached=true;bootId=String(result.bootId);
          clearTimeout(attachDeadline);
          const snapshot=result.snapshot as ComponentEvent["snapshot"];
          lastRevision=snapshot.sessionRevision;ready=true;send({type:"snapshot",snapshot});
          for(const item of buffered)event(item);buffered=[];
        }else{
          const input=SignedSignal.parse(raw);
          if(input.type==="acknowledged"||input.type==="iceRestarted"||input.type==="stop")return;
          const{requestId,...command}=input;
          const result=await service.request(requestId,{...command,owner:binding.owner,viewerSessionId:binding.viewerSessionId},bootId);
          send({requestId,...result});
        }
      }).catch(()=>{socket.close(1008,"Remote desktop signaling failed.");}).finally(()=>{queued--;});
    });
  });
  app.get("/api/internal/remote-desktop/fallback/:role",{...boundary,websocket:true},(socket,request)=>{
    const role=z.enum(["media","control"]).safeParse((request.params as {role?:string}).role);
    const expected=role.success?(role.data==="media"?REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL:REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL):"";
    const protocol=String(request.headers["sec-websocket-protocol"]??"").trim();
    if(!role.success||protocol!==expected){socket.close(1008,"REMOTE_DESKTOP_FALLBACK_PROTOCOL");return;}
    let upstream:WebSocket|undefined;
    let opening:ReturnType<typeof setTimeout>|undefined;
    let closed=false;
    const pending:Array<{data:WebSocket.RawData;binary:boolean}>=[];let pendingBytes=0;
    const limit=role.data==="media"?64*1024:128*1024;
    const end=()=>{if(closed)return;closed=true;if(opening!==undefined)clearTimeout(opening);pending.length=0;upstream?.close();};
    socket.on("close",end);socket.on("error",end);
    socket.on("message",(data,binary)=>{
      if(closed)return;
      const size=Array.isArray(data)?data.reduce((total,chunk)=>total+chunk.byteLength,0):data.byteLength;
      if(size>limit){socket.close(1009,"Remote desktop fallback frame too large.");end();return;}
      if(upstream?.readyState===WebSocket.OPEN){upstream.send(data,{binary});return;}
      pendingBytes+=size;
      if(pending.length>=64||pendingBytes>256*1024){socket.close(1013,"Remote desktop fallback backlog exceeded.");end();return;}
      pending.push({data,binary});
    });
    void (async()=>{
      const endpoint=await service.fallbackEndpoint();
      if(closed)return;
      if(!endpoint){socket.close(1011,"REMOTE_DESKTOP_FALLBACK_UNAVAILABLE");return;}
      const url=new URL(`/fallback/${role.data}?token=${encodeURIComponent(endpoint.token)}`,endpoint.url);
      upstream=new WebSocket(url,expected,{perMessageDeflate:false,maxPayload:limit});
      opening=setTimeout(()=>{if(closed)return;socket.close(1011,"REMOTE_DESKTOP_FALLBACK_UPSTREAM_UNAVAILABLE");end();},10_000);
      upstream.on("open",()=>{
        if(opening!==undefined)clearTimeout(opening);opening=undefined;
        if(closed||!upstream){upstream?.close();return;}
        for(const frame of pending.splice(0))upstream.send(frame.data,{binary:frame.binary});
        pendingBytes=0;
      });
      upstream.on("message",(data,binary)=>{
        if(closed)return;
        if(socket.bufferedAmount>256*1024){socket.close(1013,"Remote desktop fallback backpressure.");end();return;}
        socket.send(data,{binary});
      });
      upstream.on("close",()=>{if(!closed)socket.close(1000,"Remote desktop fallback ended.");});
      upstream.on("error",()=>{if(!closed){socket.close(1011,"REMOTE_DESKTOP_FALLBACK_UPSTREAM_UNAVAILABLE");end();}});
    })().catch(()=>{socket.close(1011,"REMOTE_DESKTOP_FALLBACK_UPSTREAM_UNAVAILABLE");end();});
  });
}
