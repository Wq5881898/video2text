// Learning-regression branch: never masquerades as a fresh blind test.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './config.mjs';
import {readJson,writeJson} from './pipeline.mjs';
import {modelTool,digest,digestFile} from './model-client.mjs';
import {requireSeal,seal,assertExactCoverage,assertSourceIdentity,workers} from './holdout-protocol.mjs';
import {applyLocalChanges} from './visual-review.mjs';
import {semanticContracts,semanticRiskIssues,SEMANTIC_REPAIR_PROMPT,SEMANTIC_REPAIR_TOOL,validateRepairProposal,applyApprovedRepairs} from './semantic-repair.mjs';
import {criticalTranslationIssues} from './translation-critical-checks.mjs';
const APP=fileURLToPath(new URL('./',import.meta.url));
const [phase,argument]=process.argv.slice(2);if(!phase||!argument)throw Error('Usage: node repair-runner.mjs <prepare|propose|apply> <new-branch-directory>');
const dir=path.resolve(argument),read=n=>readJson(path.join(dir,n)),write=(n,v)=>writeJson(path.join(dir,n),v),log=v=>console.log(JSON.stringify({phase,...v}));
process.loadEnvFile(path.join(APP,'.env'));const config=loadConfig(APP);
async function assertParents(manifest){for(const m of manifest.parents)for(const file of m.originalFiles)if(await digestFile(file.path)!==file.sha256)throw Error('Sealed parent changed: '+file.path);}
async function prepare(){
 if(await read('manifest.json')){await assertParents(await read('manifest.json'));return;}
 const intake=await read('intake.json');if(!Array.isArray(intake?.parents)||!intake.parents.length)throw Error('intake.parents required');
 const parents=[];
 for(const spec of intake.parents){
  const parent=path.resolve(spec.dir),source=(await requireSeal(parent,'source-final')).value,minimax=(await requireSeal(parent,'minimax-final')).value;
  const plan=await readJson(path.join(parent,'semantic-plan.json'));assertSourceIdentity(source.rows,minimax.rows);
  const sourcePatches=spec.sourcePatches??[];
  if(sourcePatches.some(p=>!source.rows.some(r=>r.id===p.id)||!p.reason||!p.evidence?.length))throw Error('Source patches need original IDs and explicit evidence');
  const revisedSource=source.rows.map(r=>({...r,yue:applyLocalChanges(r.yue,sourcePatches.filter(p=>p.id===r.id)),revisionSourceChanges:sourcePatches.filter(p=>p.id===r.id),sourceReviewed:false,humanReviewed:false}));
  const revised=minimax.rows.map((r,i)=>({...r,yue:revisedSource[i].yue}));
  const cases=spec.cases.map(c=>{
   const group=plan.find(p=>p.id===c.groupId);if(!group||!c.requirement?.trim())throw Error('Case needs a whole semantic group and source-grounded requirement');
   const targetRows=group.sourceIds.map(id=>revised.find(r=>r.id===id));
   const contracts=[...semanticContracts(targetRows),{id:'review-'+c.groupId,type:'coordinator-source-review',sourceIds:group.sourceIds,sourceQuote:targetRows.map(r=>r.yue).join(' '),requirement:c.requirement}];
   return{id:c.groupId,title:group.title,targetRows,contracts,requirement:c.requirement,verifiedSourceFacts:c.verifiedSourceFacts??[],sourceUnresolved:c.sourceUnresolved??[]};
  });
  if(new Set(cases.map(c=>c.id)).size!==cases.length)throw Error('Duplicate case');
  const sub=path.join(dir,spec.tag);await fs.mkdir(sub,{recursive:true});
  await writeJson(path.join(sub,'prepared.json'),{tag:spec.tag,parent,filename:source.filename,duration:source.duration,sourceBefore:source.rows,sourceRows:revisedSource,beforeRows:minimax.rows,rows:revised,cases,sourcePatches,unresolved:spec.unresolved??[],baselineKnownToCoordinator:true,baselineSuppliedToRepairModel:false});
  const originalFiles=[];for(const name of ['source-final.json','minimax-final.json','independent-final.json','chinese-final.json','frozen.json','reference-reveal.json']){const f=path.join(parent,name);try{originalFiles.push({path:f,sha256:await digestFile(f)});}catch(e){if(e.code!=='ENOENT')throw e;}}
  parents.push({tag:spec.tag,parent,originalFiles,rows:source.rows.length,cases:cases.length});
 }
 const manifest={at:new Date().toISOString(),kind:'Source-grounded correction and learned-sample regression after references have been seen; not blind',baselineKnownToCoordinator:true,baselineSuppliedToRepairModel:false,model:config.translation.model,endpoint:config.translation.baseUrl,credentialFingerprint:digest(config.translation.apiKey),semanticPolicy:await readJson(path.join(APP,'semantic-preservation-policy.json')),parents};
 await write('manifest.json',manifest);log({prepared:parents.map(p=>({tag:p.tag,rows:p.rows,cases:p.cases}))});
}
async function propose(refine=false){
 const manifest=await read('manifest.json');if(!manifest)throw Error('Prepare first');await assertParents(manifest);
 if(manifest.model!==config.translation.model||manifest.endpoint!==config.translation.baseUrl||manifest.credentialFingerprint!==digest(config.translation.apiKey))throw Error('Model configuration changed');
 const tasks=[];
 for(const parent of manifest.parents){const prepared=await read(parent.tag+'/prepared.json'),feedback=await read(parent.tag+'/feedback.json')??[];for(const c of prepared.cases)if(!refine||feedback.some(f=>f.caseId===c.id))tasks.push({parent,c,prepared,feedback:feedback.find(f=>f.caseId===c.id)});}
 await workers(tasks,async({parent,c,prepared,feedback})=>{
  const suffix=refine?'-r2':'',output=parent.tag+'/proposal-'+c.id+suffix+'.json';if(await read(output))return;
  const input={targetRows:c.targetRows.map(({id,yue,en})=>({id,yue,en})),contracts:c.contracts,verifiedSourceFacts:c.verifiedSourceFacts,sourceUnresolved:c.sourceUnresolved,semanticPolicy:manifest.semanticPolicy,baselineIncluded:false,rawAsrIncluded:false,olderOcrIncluded:false};
  if(refine){if(!feedback?.reason)throw Error('Explicit review feedback required');input.previousUnacceptedProposal=await read(parent.tag+'/proposal-'+c.id+'.json');input.sourceReviewFeedback=feedback.reason;input.originalEnglishIsStillTarget=true;}
  const result=await modelTool(path.join(dir,parent.tag),'repair-'+c.id+suffix,config.translation,{prompt:SEMANTIC_REPAIR_PROMPT,input,tool:SEMANTIC_REPAIR_TOOL,validate:p=>validateRepairProposal(p,c.targetRows,c.contracts)});
  await write(output,result);log({tag:parent.tag,group:c.id,patches:result.patches.length,unresolved:result.unresolved.length});
 },2);
}
async function apply(){
 const manifest=await read('manifest.json');if(!manifest)throw Error('Prepare first');await assertParents(manifest);
 for(const parent of manifest.parents){
  const sub=path.join(dir,parent.tag);if(await read(parent.tag+'/revised-final-seal.json')){await requireSeal(sub,'revised-final');continue;}
  const prepared=await read(parent.tag+'/prepared.json'),allDecisions=await read(parent.tag+'/decisions.json');if(!Array.isArray(allDecisions))throw Error('Explicit per-patch decisions required');
  const results=[];let rows=structuredClone(prepared.rows);
  for(const c of prepared.cases){const decisions=allDecisions.filter(d=>d.caseId===c.id);const round=decisions.some(d=>d.round==='review')?'review':decisions.some(d=>d.round===2)?2:1;if(decisions.some(d=>d.round&&d.round!==round))throw Error('Cannot mix proposals from different rounds');const proposal=await read(parent.tag+'/proposal-'+c.id+(round==='review'?'-review':round===2?'-r2':'')+'.json');if(!proposal)throw Error('Missing proposal');const tagged={...proposal,patches:proposal.patches.map(p=>({...p,producer:p.producer??(round==='review'?'coordinator-source-adjudication':manifest.model)}))};const result=applyApprovedRepairs(c.targetRows,tagged,decisions,c.contracts);results.push({id:c.id,proposalRound:round,...result,unresolved:[...c.sourceUnresolved,...proposal.unresolved]});const byId=new Map(result.rows.map(r=>[r.id,r]));rows=rows.map(r=>byId.get(r.id)??r);}
  assertExactCoverage(prepared.rows,rows);assertSourceIdentity(prepared.rows,rows);
  const source={filename:prepared.filename,duration:prepared.duration,rows:prepared.sourceRows,sourcePatches:prepared.sourcePatches,wholeFilmAccepted:false,kind:'Source-reviewed learning branch; not human audio verified'};
  await seal(sub,'source-revised',source);
  await seal(sub,'revised-final',{filename:prepared.filename,duration:prepared.duration,rows,kind:'MiniMax exact-span proposals explicitly adjudicated against source; learned regression, not blind',model:manifest.model,repairs:results.flatMap(r=>r.accepted),sourcePatches:prepared.sourcePatches,sourceUnresolved:prepared.unresolved,baselineIncludedInRequests:false,wholeFilmAccepted:false});
  await write(parent.tag+'/results.json',{cases:results,beforeIssues:criticalTranslationIssues(prepared.rows),afterIssues:criticalTranslationIssues(rows),beforeNarrowIssues:semanticRiskIssues(prepared.rows),afterNarrowIssues:semanticRiskIssues(rows),sourceUnresolved:prepared.unresolved,wholeFilmAccepted:false});
  log({tag:parent.tag,rows:rows.length,accepted:results.flatMap(r=>r.accepted).length,held:results.flatMap(r=>r.held).length,knownRiskBefore:semanticRiskIssues(prepared.rows).length,knownRiskAfter:semanticRiskIssues(rows).length});
 }
}
const phases={prepare,propose,'propose-refine':()=>propose(true),apply};if(!phases[phase])throw Error('Unknown phase');await phases[phase]();
