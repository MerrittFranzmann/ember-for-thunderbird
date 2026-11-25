const pause = () => new Promise(r => setTimeout(r, 100));
const wait = async (predicate, label, timeout = 22000) => { await pause(); const start = Date.now(); while (!predicate()) { if (Date.now()-start > timeout) throw new Error(`Timed out: ${label}`); await pause(); } };
const library = () => [...document.querySelectorAll('.sidebar .item')].find(b=>b.querySelector('.label')?.textContent === 'Attachments');
library().click();
await wait(()=>!document.querySelector('.mini-spin') && !!document.querySelector('.approved input'),'initial attachment index');
const box=document.querySelector('.approved input'); const before=box.checked; box.checked=false; box.dispatchEvent(new Event('change',{bubbles:true}));
await wait(()=>document.querySelectorAll('.file').length>=86,'populated attachment cache');
const initial=document.querySelectorAll('.file').length;
const original=messenger.messages.query; const delayed=[];
let calls=0; let progress; let stopped;
try {
  Object.defineProperty(messenger.messages,'query',{configurable:true,value:async(options)=>{
    if (!options.attachment) return original(options);
    calls++; return new Promise((resolve,reject)=>delayed.push({options,resolve,reject}));
  }});
  document.querySelector('.list-head button[aria-label="Refresh"]').click();
  await wait(()=>!!document.querySelector('.mini-spin'),'delayed attachment refresh');
  progress={files:document.querySelectorAll('.file').length,status:document.querySelector('.summary').textContent.trim()};
  if(progress.files!==initial) throw new Error('Cached attachment list disappeared during query');
  [...document.querySelectorAll('button')].find(b=>b.textContent==='Stop scan').click();
  await wait(()=>!document.querySelector('.mini-spin'),'stop finding files');
  stopped={files:document.querySelectorAll('.file').length,notice:document.body.innerText.includes('Scan stopped.')};
  if(stopped.files!==initial||!stopped.notice) throw new Error('Stopping lost cached files');
} finally {
  Object.defineProperty(messenger.messages, 'query', { configurable: true, writable: true, value: original }); // Restore the resolved function: re-installing the original lazy getter breaks the API in this page.
  await Promise.all(delayed.map(async({options,resolve,reject})=>{try{resolve(await original(options));}catch(e){reject(e);}}));
}
[...document.querySelectorAll('button')].find(b=>b.textContent==='Resume scan').click();
await wait(()=>!document.querySelector('.mini-spin') && document.querySelectorAll('.file').length>=86,'resume attachment refresh');
const recovered=document.querySelectorAll('.file').length;
const restored=document.querySelector('.approved input');restored.checked=before;restored.dispatchEvent(new Event('change',{bubbles:true}));
return {progress,stopped,recovered,delayedQueries:calls};
