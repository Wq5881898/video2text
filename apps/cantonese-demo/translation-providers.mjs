// Text-only provider adapter for approved Cantonese -> English comparisons.
// No references, account credentials or previous English belong in input.
import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson} from './pipeline.mjs';
import {digest} from './model-client.mjs';
import {providerIdentity,classifyProviderFailure,assertProviderAvailable,recordProviderFailure,recordProviderSuccess} from './provider-runtime.mjs';
class ProviderPayloadError extends Error {
 constructor(payload,outputStarted=false){super('Provider returned an explicit error');this.payload=payload;this.outputStarted=outputStarted;}
}
function errorPayload(raw){try{return JSON.parse(raw);}catch{return {error:{message:raw}};}}
export function chatEndpoint(baseUrl){
 const u=new URL(baseUrl);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Invalid provider URL');
 return u.href.replace(/\/$/u,'')+'/chat/completions';
}
export function chatBody(config,prompt,input,schema){
 const body={model:config.model,stream:true,max_tokens:8192,temperature:0,messages:[
  {role:'system',content:prompt+'\nReturn only a complete JSON object matching this JSON schema. No Markdown or commentary outside JSON. Schema: '+JSON.stringify(schema)},
  {role:'user',content:JSON.stringify(input)}
 ]};
 if(config.provider==='minimax'){body.thinking={type:'disabled'};body.reasoning_split=true;}
 if(config.provider==='glm'){body.thinking={type:'enabled'};body.reasoning_effort='low';}
 return body;
}
// Reads SSE incrementally so private Qwen services can send data before their
// reverse-proxy timeout. A premature stream end is never accepted as success.
export async function consumeChat(response){
 if(!response.body)throw Error('Missing response body');
 const started=performance.now(),reader=response.body.getReader(),decoder=new TextDecoder(),chunks=[];
 let buffer='',raw='',sse=false,done=false,finish=null,model=null,usage=null,firstContentMs=null,reasoningChars=0;
 const content=[];
 function event(line){
  if(!line.startsWith('data:'))return;
  sse=true;const value=line.slice(5).trim();if(!value)return;if(value==='[DONE]'){done=true;return;}
  const p=JSON.parse(value);if(classifyProviderFailure(200,p))throw new ProviderPayloadError(p,content.length>0);
  model=p.model??model;usage=p.usage??usage;
  const c=p.choices?.[0];if(!c)return;
  const delta=c.delta??{};
  if(typeof delta.content==='string'){if(firstContentMs===null&&delta.content)firstContentMs=performance.now()-started;content.push(delta.content);chunks.push(delta.content);}
  reasoningChars+=typeof delta.reasoning_content==='string'?delta.reasoning_content.length:0;
  if(c.finish_reason!==null&&c.finish_reason!==undefined)finish=c.finish_reason;
 }
 while(true){
  const r=await reader.read();if(r.done)break;
  const s=decoder.decode(r.value,{stream:true});raw+=s;buffer+=s;
  let n;while((n=buffer.indexOf('\n'))>=0){event(buffer.slice(0,n).replace(/\r$/u,''));buffer=buffer.slice(n+1);}
 }
 buffer+=decoder.decode();if(buffer.trim())event(buffer.replace(/\r$/u,''));
 if(!sse){
  const p=JSON.parse(raw);if(classifyProviderFailure(200,p))throw new ProviderPayloadError(p);
  const c=p.choices?.[0];if(!c)throw Error('Missing completion');
  content.push(typeof c.message?.content==='string'?c.message.content:'');finish=c.finish_reason;model=p.model;usage=p.usage;
 }
 if(finish!=='stop')throw Error('Incomplete completion: '+finish);
 const text=content.join('');if(!text.trim())throw Error('Empty completion');
 return {text,contentChunks:chunks,finishReason:finish,serverModel:model,usage,streaming:sse,doneMarker:done,firstContentMs,reasoningChars,reasoningContentStored:false};
}
export function parseCompletion(text){
 const fence=text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
 return JSON.parse(fence?fence[1]:text.trim());
}
export async function recordedChat(dir,key,config,body,{fetchImpl=globalThis.fetch,timeout=240000,runtime={}}={}){
 if(!/^[a-zA-Z0-9_-]+$/u.test(key))throw Error('Invalid request key');
 const folder=path.join(dir,'requests');await fs.mkdir(folder,{recursive:true});
 const url=chatEndpoint(config.baseUrl),fingerprint=digest({url,body,credential:digest(config.apiKey)});
 const serviceId=providerIdentity({url,apiKey:config.apiKey,model:config.model});let lastFailure=null;
 for(let attempt=0;attempt<10000;attempt++){
  const file=path.join(folder,key+'-'+attempt),intent=await readJson(file+'-intent.json'),cached=await readJson(file+'-response.json');
  if(intent&&intent.fingerprint!==fingerprint)throw Error('Request cache differs from frozen configuration');
  if(cached?.ok)return cached.result;
  if(cached){
   const failure=classifyProviderFailure(cached.status,errorPayload(cached.error??''));
   if(!cached.retryable&&!failure?.delayMs)throw await recordProviderFailure(serviceId,cached.status,errorPayload(cached.error??''),runtime);
   lastFailure=cached;continue;
  }
  if(intent)throw Error('Previous request outcome unknown; not automatically resending');
  const state=await assertProviderAvailable(serviceId,runtime);
  const priorFailure=lastFailure&&classifyProviderFailure(lastFailure.status,errorPayload(lastFailure.error??''));
  if(!state.checkedAt&&priorFailure&&Date.parse(lastFailure.at)+priorFailure.delayMs>(runtime.now?.()??Date.now()))throw await recordProviderFailure(serviceId,lastFailure.status,errorPayload(lastFailure.error??''),runtime);
  await writeJson(file+'-intent.json',{at:new Date().toISOString(),url,model:config.model,fingerprint,attempt});
  await writeJson(file+'-input.json',body);
  const t=performance.now();let response;
  try{response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+config.apiKey,'content-type':'application/json',Accept:'text/event-stream'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});}
  catch(e){throw Error('Provider request outcome unknown; not automatically resending: '+e.name);}
  if(!response.ok){
   const raw=(await response.text()).replaceAll(config.apiKey,'[REDACTED]'),classified=classifyProviderFailure(response.status,errorPayload(raw)),retryable=classified.retryable;
   await writeJson(file+'-response.json',{at:new Date().toISOString(),ok:false,status:response.status,error:raw.slice(0,1500),retryable,elapsedMs:performance.now()-t});
   throw await recordProviderFailure(serviceId,response.status,errorPayload(raw),{...runtime,retryAfter:response.headers.get('retry-after')});
  }
  let result;
  try{result=await consumeChat(response);}
  catch(e){
   if(e instanceof ProviderPayloadError){
    const failure=await recordProviderFailure(serviceId,response.status,e.payload,runtime);
    if(!e.outputStarted){
     await writeJson(file+'-response.json',{at:new Date().toISOString(),ok:false,status:response.status,error:JSON.stringify(e.payload).replaceAll(config.apiKey,'[REDACTED]'),retryable:classifyProviderFailure(response.status,e.payload).retryable});
     throw failure;
    }
   }
   // HTTP 200 alone is not a completed request. Persist outcome uncertainty
   // explicitly, and do not silently spend again after truncated streams.
   await writeJson(file+'-interrupted.json',{at:new Date().toISOString(),error:e.message,status:response.status});
   throw Error('Completion interrupted or incomplete; not automatically resending: '+e.message);
  }
  result.text=result.text.replaceAll(config.apiKey,'[REDACTED]');result.elapsedMs=performance.now()-t;
  await writeJson(file+'-response.json',{at:new Date().toISOString(),ok:true,status:response.status,result});
  await recordProviderSuccess(serviceId,runtime);
  return result;
 }
 throw Error('Provider retry limit reached');
}
