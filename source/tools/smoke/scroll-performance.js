// Paste into Ember's page console, then run __sparkScrollProbe.run() with the app visible.
const entry=document.querySelector('script[type=module]').src,source=await(await fetch(entry)).text();
const shared=source.match(/["'](\.\/(?:SettingsPanel|Icon)-[^"']+\.js)["']/)?.[1];
const mod=await import(new URL(shared,entry).href);
const store=Object.values(mod).find(v=>v&&typeof v==='object'&&'folderById'in v&&'selectedKey'in v);
const cache=Object.values(mod).find(v=>v&&typeof v==='object'&&typeof v.getCachedHeaders==='function'&&typeof v.fetch==='function');
const v=document.querySelector('.viewport');
const p=window.__sparkScrollProbe={store,cache,records:[],original:{top:v.scrollTop,key:store.selectedKey,open:store.readerOpen,auto:store.settings.autoMarkRead,prefs:JSON.parse(JSON.stringify(store.settings.timeBucketExpanded))}};
p.run=async()=>{
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 p.running=true;store.settings.autoMarkRead=false;
 const prefix=store.view.kind==='smart'?'smart':store.view.kind==='mailbox'?`mailbox:${store.view.role}:${store.view.accountId||'all'}`:store.view.kind==='folder'?`folder:${store.view.folderId}`:null;
 try{
  if(!prefix)throw new Error('Use Smart Inbox or a mailbox for the scroll comparison');
  store.settings.timeBucketExpanded={...p.original.prefs,...Object.fromEntries(store.items.filter(i=>i.type==='bucket').map(i=>[`${prefix}:${i.bucketId}`,true]))};
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  for(let trial=0;trial<2;trial++){
   const frames=[],events=[];let changes=0,requests=0;
   const oldChange=store.meta.onChange,oldRequest=store.requestVisible;
   store.meta.onChange=(...args)=>{changes++;return oldChange(...args);};
   store.requestVisible=function(...args){requests++;return oldRequest.apply(this,args);};
   try{
    const startTop=Math.max(0,Math.min(p.original.top,v.scrollHeight-v.clientHeight));v.scrollTop=startTop;await sleep(100);
    const distance=Math.min(7000,v.scrollHeight-v.clientHeight-startTop);
    if(distance<1000)throw new Error('Not enough scrollable mail');
    const started=performance.now();let last=started;
    const scroll=()=>events.push({at:performance.now()-started,top:v.scrollTop});v.addEventListener('scroll',scroll);
    try{await new Promise(resolve=>{const step=now=>{frames.push(now-last);last=now;const progress=Math.min((now-started)/5000,1);v.scrollTop=startTop+Math.round(distance*(progress<.5?progress*2:(1-progress)*2));if(progress<1)requestAnimationFrame(step);else resolve();};requestAnimationFrame(step);});await sleep(200);}finally{v.removeEventListener('scroll',scroll);}
    const sorted=frames.slice(1).sort((a,b)=>a-b);
    p.records.push({trial,version:messenger.runtime.getManifest().version,durationMs:performance.now()-started,distancePx:distance,frames:sorted.length,p50FrameMs:sorted[Math.floor(sorted.length*.5)],p95FrameMs:sorted[Math.floor(sorted.length*.95)],maxFrameMs:Math.max(...sorted),framesOver33ms:sorted.filter(t=>t>33.4).length,metadataNotifications:changes,previewRequests:requests,scrollEvents:events.length,renderedRows:document.querySelectorAll('.row').length});
   }finally{store.meta.onChange=oldChange;store.requestVisible=oldRequest;}
  }
  const key=p.original.key||store.listConversations[0]?.key;
  if(key){store.select(key,false);await sleep(200);v.scrollTop=Math.min(v.scrollHeight-v.clientHeight,v.scrollTop+1500);await sleep(100);const before=v.scrollTop;store.meta.onChange();await sleep(200);p.jump={before,after:v.scrollTop,movedPx:v.scrollTop-before,trigger:'one metadata notification'};}
 }catch(e){p.error=String(e);}finally{store.settings.autoMarkRead=p.original.auto;store.select(p.original.key,p.original.open);store.settings.timeBucketExpanded=p.original.prefs;await sleep(100);v.scrollTop=p.original.top;p.running=false;}
};
console.log('SCROLL_READY '+JSON.stringify({version:messenger.runtime.getManifest().version,items:store.items.length,conversations:store.conversations.length,height:v.clientHeight,scrollHeight:v.scrollHeight,originalTop:v.scrollTop}));
