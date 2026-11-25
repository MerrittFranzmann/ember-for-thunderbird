// Test-only benchmark. Independent databases leave the user's real cache intact.
const {LocalMailCache:Baseline}=await import(messenger.runtime.getURL('baseline-cache-test.js'));
const {LocalMailCache:Optimized,messageKey}=await import(messenger.runtime.getURL('cache-test.js'));
let page=await messenger.messages.query({fromDate:new Date(Date.now()-90*86400000)});const all=[];
while(page){all.push(...page.messages);if(!page.id)break;page=await messenger.messages.continueList(page.id);}
all.sort((a,b)=>+new Date(b.date)-+new Date(a.date));
const count=200;const step=all.length/count;const sample=Array.from({length:count},(_,i)=>all[Math.floor(i*step)]);
const runs=[];let reference;
for(const [label,Class] of [['baseline',Baseline],['optimized',Optimized],['optimized',Optimized],['baseline',Baseline]]){
 const name=`spark-cache-benchmark-${crypto.randomUUID()}`;let bodyCalls=0,attachmentCalls=0,active=0,maxActive=0;
 const track=async(work)=>{active++;maxActive=Math.max(active,maxActive);try{return await work();}finally{active--;}};
 const backend={messages:{query:async options=>({id:null,messages:options.flagged?sample.filter(m=>m.flagged):sample}),getFull:async id=>{bodyCalls++;return track(()=>messenger.messages.getFull(id));},listAttachments:async id=>{attachmentCalls++;return track(()=>messenger.messages.listAttachments(id));}}};
 const cache=new Class(backend,name);const start=performance.now();
 try{
  await cache.warm();const firstFillMs=Math.round(performance.now()-start);
  if(cache.status.phase!=='ready'||cache.status.done!==count)throw new Error(`${label} did not finish: ${JSON.stringify(cache.status)}`);
  const files=await cache.attachmentIndex();
  const signature=files.map(({message,files})=>[messageKey(message),files.map(file=>({name:file.name,partName:file.partName,size:file.size,contentType:file.contentType,contentId:file.contentId})).sort((a,b)=>a.partName.localeCompare(b.partName))]).sort((a,b)=>a[0].localeCompare(b[0]));
  const value=JSON.stringify(signature);if(reference!==undefined&&reference!==value)throw new Error('Optimized attachment index differs from native baseline');reference=value;
  const refreshStart=performance.now();await cache.warm();const completedRefreshMs=Math.round(performance.now()-refreshStart);
  runs.push({label,messages:count,firstFillMs,completedRefreshMs,bodyCalls,attachmentCalls,maxActive,attachmentListsMatch:true});
 }finally{cache.close();await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Benchmark DB still open'));});}
}
const average=label=>{const values=runs.filter(run=>run.label===label);return {firstFillMs:Math.round(values.reduce((sum,r)=>sum+r.firstFillMs,0)/values.length),completedRefreshMs:Math.round(values.reduce((sum,r)=>sum+r.completedRefreshMs,0)/values.length)};};
const baseline=average('baseline'),optimized=average('optimized');
return {sample:count,fixtureAccounts:[...new Set(sample.map(m=>m.folder.accountId))],runs,baseline,optimized,speedup:Number((baseline.firstFillMs/optimized.firstFillMs).toFixed(2))};
