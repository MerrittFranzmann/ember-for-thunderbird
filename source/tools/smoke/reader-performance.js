// Actual Thunderbird UI timings. Optional delays are explicitly identified fault scenarios.
const config=globalThis.__readerBenchmarkConfig||{};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(predicate,label,timeout=30000)=>{const start=performance.now();while(!predicate()){if(performance.now()-start>timeout)throw new Error(`Timed out: ${label}`);await pause(5);}};
await wait(()=>document.querySelectorAll('[data-mailbox="inbox"] .account-item').length>=2&&!document.querySelector('.mini-spin'),'app ready');
const entry=document.querySelector('script[type="module"]').src;const source=await(await fetch(entry)).text();const path=source.match(/["'](\.\/(?:SettingsPanel|Icon)-[^"']+\.js)["']/)?.[1];if(!path)throw new Error('Shared app module missing');
const module=await import(new URL(path,entry).href);const store=Object.values(module).find(v=>v&&typeof v==='object'&&'folderById'in v&&'selectedKey'in v);if(!store)throw new Error('Store export missing');
const client=Object.values(module).find(v=>v&&typeof v==='object'&&typeof v.getCachedHeaders==='function'&&typeof v.fetch==='function');if(!client)throw new Error('Cache client export missing');
const calls=[];const measures=[];const restore=[];
function patch(object,name,wrap){const descriptor=Object.getOwnPropertyDescriptor(object,name);const original=object[name];Object.defineProperty(object,name,{configurable:true,value:wrap(original)});restore.push(()=>{if(descriptor)Object.defineProperty(object,name,{configurable:true,writable:true,value:original});else delete object[name];});} // resolved function: re-installing a lazy API getter breaks the API in this page
patch(client,'call',original=>async function(name,args={}){const start=performance.now();if(name==='fetch'&&args.store==='files'&&config.metadataDelayMs)await pause(config.metadataDelayMs);try{return await original.call(this,name,args);}finally{calls.push({kind:'rpc',name,store:args.store,ms:performance.now()-start,at:start});}});
if(config.inlineDelayMs)patch(messenger.messages,'getAttachmentFile',original=>async(...args)=>{await pause(config.inlineDelayMs);return original(...args);});
for(const name of ['cachedRelatedMessages','relatedMessages'])patch(store,name,original=>function(...args){const start=performance.now();const result=original.apply(this,args);measures.push({name,stage:'sync',ms:performance.now()-start,at:start});if(result?.then)return result.finally(()=>measures.push({name,stage:'total',ms:performance.now()-start,at:start}));return result;});
const readyFrames=new WeakSet();const loaded=event=>{if(event.target?.classList?.contains('display'))readyFrames.add(event.target);};document.addEventListener('load',loaded,true);
let drift=0,last=performance.now();const interval=setInterval(()=>{const now=performance.now();drift=Math.max(drift,now-last-10);last=now;},10);
const records=[];
try{
 const input=(window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
 const subjects=config.subjects||['Ember background cache check 01','Ember background cache check 02','Reading pane layout review','Spark smoke quoted history','New logo lockup (inline image)'];
 for(const subject of subjects){
  input.value=subject;input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>!document.querySelector('.mini-spin')&&[...document.querySelectorAll('.row .subject')].some(n=>n.textContent===subject),subject);
  let row;
  for(let repeat=0;repeat<(config.repeats||2);repeat++){
   if(document.querySelector('button[aria-label="Close conversation"]')){document.querySelector('button[aria-label="Close conversation"]').click();await pause(40);}
   await wait(()=>{row=[...document.querySelectorAll('.row')].find(n=>n.textContent.includes(subject));return row&&!document.querySelector('.mini-spin');},'clickable row');
   const callStart=calls.length,measureStart=measures.length;drift=0;last=performance.now();const start=performance.now();row.click();const clickHandlerMs=performance.now()-start;
   await wait(()=>!!document.querySelector('.msg.expanded'),'message shell');const shellMs=performance.now()-start;
   await wait(()=>{const card=[...document.querySelectorAll('.msg.expanded')].at(-1);return card&&(!card.querySelector('.skeleton'))&&(card.querySelector('.plain')?.textContent.trim()||readyFrames.has(card.querySelector('.display')));},'readable body');
   const bodyMs=performance.now()-start;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const paintedMs=performance.now()-start;
   await wait(()=>(()=>{const t=document.querySelector('.thread');return t?.dataset.relatedBusy!==undefined?t.dataset.relatedBusy==='false':t?.getAttribute('aria-busy')==='false';})(),'related messages');const settledMs=performance.now()-start;
   const frame=document.querySelector('.msg.expanded .display');let inlineReadyMs=null;
   if(subject.includes('inline image')){await wait(()=>document.querySelector('.msg.expanded .display')?.contentDocument?.querySelector('img[src^="data:image/"]'),'inline image');inlineReadyMs=performance.now()-start;}
   records.push({subject,repeat,clickHandlerMs,shellMs,bodyMs,paintedMs,settledMs,inlineReadyMs,eventLoopStallMs:drift,messageCount:document.querySelectorAll('.thread .msg').length,calls:calls.slice(callStart).map(call=>({...call,at:call.at-start})),work:measures.slice(measureStart).map(item=>({...item,at:item.at-start}))});
  }
 }
 return {version:messenger.runtime.getManifest().version,cacheMessages:(await messenger.runtime.sendMessage({type:'spark:cache',command:'snapshot'})).value.headers.length,config,records};
}finally{clearInterval(interval);document.removeEventListener('load',loaded,true);restore.reverse().forEach(fn=>fn());}
