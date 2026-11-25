// Run in the actual page realm (as a temporary external module), never ship it.
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,label)=>{const until=performance.now()+20000;while(!fn()){if(performance.now()>until)throw new Error('Timed out: '+label);await pause(10);}};
await wait(()=>document.querySelector('.viewport')&&!document.querySelector('.mini-spin'),'app');
const entry=document.querySelector('script[type=module]').src,source=await(await fetch(entry)).text();
const shared=source.match(/["'](\.\/(?:SettingsPanel|Icon)-[^"']+\.js)["']/)?.[1];
const mod=await import(new URL(shared,entry).href),store=Object.values(mod).find(v=>v&&typeof v==='object'&&'folderById'in v&&'selectedKey'in v);
const original={view:JSON.parse(JSON.stringify(store.view)),key:store.selectedKey,open:store.readerOpen,auto:store.settings.autoMarkRead,prefs:JSON.parse(JSON.stringify(store.settings.timeBucketExpanded)),top:document.querySelector('.viewport').scrollTop};
let restoreRequest;
try{
 store.settings.autoMarkRead=false;
 const account=store.accounts.find(a=>a.account.identities?.length)?.account.id;
 await store.setView({kind:'mailbox',role:'inbox',accountId:account});
 const prefix=`mailbox:inbox:${account}`;
 store.settings.timeBucketExpanded={...original.prefs,...Object.fromEntries(store.items.filter(i=>i.type==='bucket').map(i=>[`${prefix}:${i.bucketId}`,true]))};
 await pause(250);const viewport=document.querySelector('.viewport');
 if(viewport.scrollHeight<6000)throw new Error('Not enough fixture mail for scrolling checks');
 store.select(store.listConversations[0].key,false);await pause(100);
 viewport.scrollTop=3000;await pause(250);
 const before=viewport.scrollTop,conversations=store.conversations,items=store.items;
 store.meta.onChange(false);await pause(100);
 const snippetUpdate={before,after:viewport.scrollTop,sameConversations:store.conversations===conversations,sameItems:store.items===items};
 if(before!==viewport.scrollTop||!snippetUpdate.sameConversations||!snippetUpdate.sameItems)throw new Error('Preview update rebuilt or moved the list');
 store.meta.onChange(true);await pause(100);
 const classificationUpdate={before,after:viewport.scrollTop};
 if(before!==viewport.scrollTop)throw new Error('Grouping update pulled the list back');
 const holdsBefore=store.meta.holds;let requested=0,largestPreviewBatch=0;
 const request=store.requestVisible;store.requestVisible=function(convs){requested++;largestPreviewBatch=Math.max(largestPreviewBatch,convs.length);return request.call(this,convs);};restoreRequest=()=>{store.requestVisible=request;};
 const start=performance.now();await new Promise(resolve=>{const step=now=>{viewport.scrollTop=3000+Math.min(4000,(now-start)*3);if(now-start<1200)requestAnimationFrame(step);else resolve();};requestAnimationFrame(step);});
 const during={requested,paused:store.meta.holds>holdsBefore,renderedRows:document.querySelectorAll('.row').length};
 if(requested!==0||!during.paused||during.renderedRows>40)throw new Error('Scrolling started offscreen previews or mounted too many rows');
 await wait(()=>!viewport.classList.contains('scrolling')&&requested>0,'idle previews');
 const idle={requested,largestPreviewBatch,holds:store.meta.holds,holdsBefore};
 if(idle.holds!==holdsBefore||largestPreviewBatch>Math.ceil(viewport.clientHeight/86)+2)throw new Error('Priority was not released or previews included overscan');
 store.move(1);await pause(100);
 const selected=document.querySelector('.row.selected'),listRect=viewport.getBoundingClientRect(),rect=selected?.getBoundingClientRect();
 const keyboardReveal=!!rect&&rect.top>=listRect.top-1&&rect.bottom<=listRect.bottom+1;
 if(!keyboardReveal)throw new Error('Keyboard navigation did not reveal selected row');
 restoreRequest();restoreRequest=undefined;
 return {version:messenger.runtime.getManifest().version,snippetUpdate,classificationUpdate,during,idle,keyboardReveal};
}finally{
 restoreRequest?.();store.settings.timeBucketExpanded=original.prefs;await store.setView(original.view);store.settings.autoMarkRead=original.auto;store.select(original.key,original.open);await pause(100);document.querySelector('.viewport').scrollTop=original.top;
}
