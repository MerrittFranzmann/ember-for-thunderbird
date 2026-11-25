const {LocalMailCache,messageKey}=await import(messenger.runtime.getURL('cache-test.js'));
let bodyCalls=0,attachmentCalls=0;
const native={messages:{query:options=>messenger.messages.query(options),continueList:id=>messenger.messages.continueList(id),getFull:async id=>{bodyCalls++;return messenger.messages.getFull(id);},listAttachments:async id=>{attachmentCalls++;return messenger.messages.listAttachments(id);}}};
const name=`spark-cache-speed-full-${crypto.randomUUID()}`;const cache=new LocalMailCache(native,name);const start=performance.now();
try{
 await cache.warm();const firstFillMs=Math.round(performance.now()-start);if(cache.status.phase!=='ready')throw new Error(JSON.stringify(cache.status));
 const saved=new Map((await cache.attachmentIndex()).map(({message,files})=>[messageKey(message),files]));
 const candidates=new Map();
 for(const query of [{attachment:true,fromDate:new Date(Date.now()-90*86400000)},{attachment:true,flagged:true}]){
  let page=await messenger.messages.query(query);while(page){for(const message of page.messages)candidates.set(messageKey(message),message);if(!page.id)break;page=await messenger.messages.continueList(page.id);}
 }
 const signature=files=>JSON.stringify(files.map(({name,partName,size,contentType,contentId})=>({name,partName,size,contentType,contentId})).sort((a,b)=>a.partName.localeCompare(b.partName)));
 const mismatches=[];let compared=0;
 for(const [key,message] of candidates){const files=await messenger.messages.listAttachments(message.id);if(signature(saved.get(key)||[])!==signature(files))mismatches.push({id:message.id,subject:message.subject});compared++;}
 if(mismatches.length)throw new Error('Attachment mismatch: '+JSON.stringify(mismatches));
 const refreshStart=performance.now();await cache.warm();const refreshMs=Math.round(performance.now()-refreshStart);
 return {messages:cache.status.total,firstFillMs,completedRefreshMs:refreshMs,bodyCalls,attachmentCalls,nativeAttachmentMessagesCompared:compared,attachmentMismatches:mismatches.length,pinned:cache.all().filter(m=>m.flagged).length};
}finally{cache.close();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});}
