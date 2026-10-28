import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedVideoFile, sourceMediaDuration, mediaWorkTimeoutMs, MEDIA_UPLOAD_LIMITS } from '../public/media-policy.mjs';
import { inventoryTimes } from '../visual-inventory.mjs';
import { chunkPlan } from '../workflow-v2.mjs';

test('large supported video selection has no 512 MB ceiling while empty/unsupported files remain invalid',()=>{
  assert.deepEqual(MEDIA_UPLOAD_LIMITS,{maxBytes:null,maxMinutes:null});
  for(const size of [512*1024*1024+1,12*1024**3,Number.MAX_SAFE_INTEGER])assert.equal(isSupportedVideoFile({name:'Original.MP4',size}),true);
  assert.equal(isSupportedVideoFile({name:'empty.mp4',size:0}),false);
  assert.equal(isSupportedVideoFile({name:'not-video.exe',size:100}),false);
  assert.equal(isSupportedVideoFile({name:'broken.mp4',size:NaN}),false);
});
test('31-minute and multi-hour audio-bearing media are accepted without accepting invalid media',()=>{
  for(const duration of [1800.1,1860,7200,86400])assert.equal(sourceMediaDuration({format:{duration:String(duration)},streams:[{codec_type:'audio'}]}),duration);
  for(const duration of [0,-1,NaN,Infinity])assert.throws(()=>sourceMediaDuration({format:{duration},streams:[{codec_type:'audio'}]}));
  assert.throws(()=>sourceMediaDuration({format:{duration:8000},streams:[{codec_type:'video'}]}));
  assert.equal(mediaWorkTimeoutMs(7200),7200000);
});
test('long-video frame inventory does not recursively overflow or truncate periodic coverage at 240 frames',()=>{
  for(const duration of [7200,86400]){
    const periodic=inventoryTimes(duration),scenes=inventoryTimes(duration,[2,17,32]);
    assert.equal(periodic.length,Math.ceil(duration/15));assert.deepEqual(scenes,periodic);
    assert.equal(periodic[0],0);assert.equal(periodic.at(-1),duration-15);
  }
});
test('unrestricted source length still obeys provider request chunk boundaries and covers every second',()=>{
  const duration=7200.25,chunks=chunkPlan(duration,[],{maxSeconds:120,pauseWindow:30});
  assert.equal(chunks[0].offset,0);assert.equal(chunks.at(-1).offset+chunks.at(-1).duration,duration);
  assert.ok(chunks.every((c,i)=>c.duration>0&&c.duration<=120&&(!i||c.offset===chunks[i-1].offset+chunks[i-1].duration)));
});
