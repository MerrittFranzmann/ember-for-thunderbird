const pause=()=>new Promise(r=>setTimeout(r,100));
const wait=async(predicate,label)=>{await pause();const start=Date.now();while(!predicate()){if(Date.now()-start>20000)throw new Error(`Timed out: ${label}`);await pause();}};
const pref=await messenger.storage.local.get('timeBucketExpanded');
const accounts=[...document.querySelectorAll('[data-mailbox="inbox"] .account-item')];
accounts[0].click(); await wait(()=>!document.querySelector('.mini-spin')&&!!document.querySelector('.bucket-toggle'),'inbox buckets');
const viewport=document.querySelector('.viewport');viewport.scrollTop=0;await pause();
const total=document.querySelector('.list-head .n').textContent;
if(document.querySelector('.row .star'))throw new Error('Pinned message appeared in normal inbox');
for(const expanded of [...document.querySelectorAll('.bucket-toggle[aria-expanded="true"]')]){expanded.click();await pause();}
const first=document.querySelector('.bucket-toggle');const firstLabel=first.textContent.trim();
if(first.getAttribute('aria-expanded')==='false'){first.click();await pause();}
first.click();await pause();
const collapsed={headers:[...document.querySelectorAll('.bucket-toggle')].map(b=>b.textContent.trim()),rows:document.querySelectorAll('.row').length,total:document.querySelector('.list-head .n').textContent};
if(collapsed.rows!==0||collapsed.total!==total)throw new Error('Collapsing changed totals or left rows');
const month=[...document.querySelectorAll('.bucket-toggle')].find(b=>b.textContent.includes('This month'));
if(!month)throw new Error('Month bucket missing');month.click();await wait(()=>!!document.querySelector('.row'),'month messages');
const expanded={label:month.textContent.trim(),rows:document.querySelectorAll('.row').length,total:document.querySelector('.list-head .n').textContent};
if(expanded.total!==total)throw new Error('Expanding changed total');
[...document.querySelectorAll('.category-filter')].find(b=>b.textContent==='Pinned').click();
await wait(()=>!document.querySelector('.mini-spin')&&document.querySelector('.list-head h1').textContent.startsWith('Pinned'),'pinned category');
const pinned={title:document.querySelector('.list-head h1').textContent,rows:document.querySelectorAll('.row').length,pins:document.querySelectorAll('.row .star').length};
if(!pinned.rows||pinned.rows!==pinned.pins)throw new Error('Pinned category contains unpinned rows or is empty');
// Pins are mostly older mail: every section starts open, and sidebar Pins shares the Pinned tab's setting.
const pinSections=()=>[...document.querySelectorAll('.bucket-toggle')].map(b=>({label:b.textContent.trim(),open:b.getAttribute('aria-expanded')}));
pinned.sections=pinSections();
if(pinned.sections.length<2||pinned.sections.some(s=>s.open!=='true'))throw new Error(`Pinned sections not all open: ${JSON.stringify(pinned.sections)}`);
// The Smart Inbox's Pinned tab and sidebar Pins list the same mail (every account's pins).
document.querySelector('[data-mailbox="inbox"] .item.parent').click();await wait(()=>!document.querySelector('.mini-spin')&&document.querySelector('.list-head h1').textContent==='Smart Inbox','smart inbox');
[...document.querySelectorAll('.category-filter')].find(b=>b.textContent==='Pinned').click();
await wait(()=>!document.querySelector('.mini-spin')&&document.querySelector('.list-head h1').textContent.startsWith('Pinned'),'smart pinned');
const lastPinSection=[...document.querySelectorAll('.bucket-toggle')].pop();const lastPinLabel=lastPinSection.textContent.trim();lastPinSection.click();await pause();
document.querySelector('[data-mailbox="pins"] .item.parent').click();
await wait(()=>!document.querySelector('.mini-spin')&&document.querySelector('.list-head h1').textContent.startsWith('Pin'),'sidebar pins');
pinned.sidebar=pinSections();
const shared=pinned.sidebar.find(s=>s.label===lastPinLabel)?.open;
[...document.querySelectorAll('.bucket-toggle')].find(b=>b.textContent.trim()===lastPinLabel)?.click();await pause();
if(shared!=='false')throw new Error('Sidebar Pins did not share the Pinned tab sections');
accounts[0].click();await wait(()=>!document.querySelector('.mini-spin')&&!!document.querySelector('.bucket-toggle'),'inbox again');
document.querySelector('button[aria-label="Back to inbox"]')?.click();await pause();viewport.scrollTop=0;await pause();
const remembered=[...document.querySelectorAll('.bucket-toggle')].map(b=>({label:b.textContent.trim(),open:b.getAttribute('aria-expanded')}));
if(remembered.find(b=>b.label===firstLabel)?.open!=='false')throw new Error('Bucket expansion not remembered');
// Leave a compact, populated view for the screenshot.
return {collapsed,expanded,pinned,remembered,priorPreferences:pref.timeBucketExpanded||{}};
