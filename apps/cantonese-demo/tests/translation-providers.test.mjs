import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chatEndpoint,chatBody,consumeChat,parseCompletion,recordedChat} from '../translation-providers.mjs';
test('chat adapter preserves private paths, uses provider-specific supported thinking and excludes reference text',()=>{
 assert.equal(chatEndpoint('https://example.test/api/paas/v4/'),'https://example.test/api/paas/v4/chat/completions');
 assert.throws(()=>chatEndpoint('https://user:secret@example.test/v1'));
 const b=chatBody({provider:'glm',model:'glm-5.3-flash'},'translate',{targetRows:[{id:'a',yue:'净新高'}],referenceIncluded:false},{type:'object'});
 assert.deepEqual(b.thinking,{type:'enabled'});assert.equal(b.reasoning_effort,'low');
 assert.equal(JSON.parse(b.messages[1].content).targetRows[0].yue,'净新高');
 assert.ok(!chatBody({provider:'qwen',model:'private'},'t',{},{}).thinking);
});
test('stream parsing preserves UTF-8 content, discards reasoning text, and rejects truncated completions',async()=>{
 const s='data: '+JSON.stringify({model:'server-model',choices:[{delta:{reasoning_content:'private reasoning',content:'中'}}]})+'\n\n'+'data: '+JSON.stringify({choices:[{delta:{content:'文'},finish_reason:'stop'}],usage:{total_tokens:5}})+'\n\ndata: [DONE]\n\n';
 const bytes=new TextEncoder().encode(s);
 const r=await consumeChat(new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=2)c.enqueue(bytes.slice(i,i+2));c.close()}})));
 assert.equal(r.text,'中文');assert.equal(r.serverModel,'server-model');assert.ok(r.reasoningChars>0);assert.ok(!JSON.stringify(r).includes('private reasoning'));
 await assert.rejects(()=>consumeChat(new Response('data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:'length'}]})+'\n\n')),/Incomplete/);
 assert.deepEqual(parseCompletion('```json\n{"translations":[]}\n```'),{translations:[]});
});
test('stream request reuses successful responses and never silently retries unknown outcomes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'provider-cache-'));let calls=0;
 const config={provider:'qwen',model:'private',baseUrl:'https://example.test/v1',apiKey:'not-a-real-key'},body=chatBody(config,'t',{},{}),fetchImpl=async()=>{calls++;return new Response(JSON.stringify({model:'private',choices:[{message:{content:'{"translations":[]}'},finish_reason:'stop'}]}))};
 try{
  await recordedChat(dir,'good',config,body,{fetchImpl});await recordedChat(dir,'good',config,body,{fetchImpl});assert.equal(calls,1);
  await assert.rejects(()=>recordedChat(dir,'unknown',config,body,{fetchImpl:async()=>{calls++;throw Error('network')}}),/unknown/);
  await assert.rejects(()=>recordedChat(dir,'unknown',config,body,{fetchImpl}),/unknown/);assert.equal(calls,2);
  assert.ok(!(await fs.readFile(path.join(dir,'requests/good-0-input.json'),'utf8')).includes(config.apiKey));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
