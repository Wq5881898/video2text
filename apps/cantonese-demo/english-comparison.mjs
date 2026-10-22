// Comparison layout never duplicates a subtitle to fill adjacent paragraphs.
export function mergeCrossingEnglishTopics(topicParagraphs,definitions) {
  const boundaries=new Set();
  const allIds=new Set(topicParagraphs.flatMap(topic=>topic.rowIds));
  for(const id of allIds){const owners=topicParagraphs.map((topic,index)=>topic.rowIds.includes(id)?index:-1).filter(index=>index>=0);
    for(let index=owners[0];index<owners.at(-1);index++)boundaries.add(index);
  }
  const topics=[],refs=[];
  for(let index=0;index<topicParagraphs.length;){
    const first=index;while(boundaries.has(index))index++;const last=index,selected=topicParagraphs.slice(first,last+1);
    topics.push({title:selected.map(topic=>topic.title).join('；'),start:selected[0].start,end:selected.at(-1).end,
      rowIds:[...new Set(selected.flatMap(topic=>topic.rowIds))],reviewedText:selected.map(topic=>topic.reviewedText).join(' '),
      originalTopics:selected.map(topic=>topic.index)});
    refs.push({from:definitions[first].from,to:definitions[last].to});index++;
  }
  return{topics,definitions:refs};
}

export function groupEnglishComparison(reference,definitions,translatedRows,topicParagraphs) {
  if(definitions.length!==topicParagraphs.length)throw new Error('English topic count mismatch');
  let next=1;
  const groups=topicParagraphs.map((topic,index)=>{
    const definition=definitions[index];
    if(definition.from!==next||definition.to<definition.from)throw new Error('English reference gap or overlap');
    const records=reference.slice(definition.from-1,definition.to).map((row,offset)=>({...row,key:`reference-en-${String(definition.from+offset).padStart(4,'0')}`}));
    if(!records.length)throw new Error('Empty English reference topic');next=definition.to+1;
    return{id:`en-${String(index+1).padStart(4,'0')}`,index:index+1,title:topic.title,start:topic.start,end:topic.end,
      reference:records,rows:[],contextLinks:[],sourceYue:topic.reviewedText,originalTopics:topic.originalTopics??[index+1]};
  });
  if(next!==reference.length+1)throw new Error('English reference tail missing');
  const ownership=translatedRows.map(row=>{
    const matches=topicParagraphs.map((topic,index)=>topic.rowIds.includes(row.id)?index:-1).filter(index=>index>=0);
    if(!matches.length)throw new Error('Unplaced English row');
    // Put a crossing cue at the topic with the largest actual time overlap.
    const owner=[...matches].sort((a,b)=>Math.max(0,Math.min(row.end,topicParagraphs[b].end)-Math.max(row.start,topicParagraphs[b].start))-
      Math.max(0,Math.min(row.end,topicParagraphs[a].end)-Math.max(row.start,topicParagraphs[a].start))||a-b)[0];
    return{row,owner,matches};
  });
  let previous=-1;
  for(const {row,owner,matches}of ownership){
    if(owner<previous)throw new Error('English layout reordered source');previous=owner;groups[owner].rows.push(row);
    for(const other of matches.filter(index=>index!==owner))groups[other].contextLinks.push({rowId:row.id,ownerGroup:owner+1,start:row.start,end:row.end});
  }
  for(const group of groups){group.baselineText=group.reference.map(row=>row.text).join(' ');group.englishText=group.rows.map(row=>row.en).join(' ');}
  const allRefs=groups.flatMap(group=>group.reference),allRows=groups.flatMap(group=>group.rows);
  if(allRefs.length!==reference.length||allRows.length!==translatedRows.length||new Set(allRefs.map(row=>row.key)).size!==reference.length||new Set(allRows.map(row=>row.id)).size!==translatedRows.length)throw new Error('Missing or duplicate English primary record');
  if(allRows.some((row,index)=>row.id!==translatedRows[index].id||row.en!==translatedRows[index].en))throw new Error('English body or order changed');
  return{groups,audit:{passed:true,referenceRecords:allRefs.length,translatedRows:allRows.length,paragraphs:groups.length,
    missing:0,duplicated:0,sourceOrderPreserved:true,contextLinks:groups.reduce((n,group)=>n+group.contextLinks.length,0),
    note:'跨话题字幕正文仅在一个主段显示，其余段仅给跳转链接。人工基线无结束时间，未评分精确同步。'}};
}

export function englishTokens(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[’‘]/gu,"'").match(/[a-z]+(?:'[a-z]+)?|\d+(?:[.,]\d+)*/gu)??[];
}

export function editDistance(left,right) {
  let row=Array.from({length:right.length+1},(_,i)=>i);
  for(let i=0;i<left.length;i++){
    const next=[i+1];for(let j=0;j<right.length;j++)next.push(Math.min(next[j]+1,row[j+1]+1,row[j]+Number(left[i]!==right[j])));row=next;
  }
  return row[right.length];
}
