const pause=()=>new Promise(r=>setTimeout(r,70));
const wait=async(predicate,label)=>{await pause();const start=Date.now();while(!predicate()){if(Date.now()-start>20000)throw new Error('Timed out: '+label+' '+document.querySelector('.attachment-preview')?.innerText);await pause();}};
[...document.querySelectorAll('.sidebar .item')].find(b=>b.querySelector('.label')?.textContent==='Attachments').click();
await wait(()=>!!document.querySelector('.approved input')&&!document.querySelector('.mini-spin'),'attachment library');
const before=await messenger.storage.local.get(['attachmentApprovedOnly','attachmentFileType','attachmentGroupBy']);
const setSelect=async(label,value)=>{const select=document.querySelector(`select[aria-label="${label}"]`);select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));await pause();};
let result;
try{
 const approved=document.querySelector('.approved input');approved.checked=false;approved.dispatchEvent(new Event('change',{bubbles:true}));
 await setSelect('Attachment file type','all');await setSelect('Group attachments','none');
 const query=document.querySelector('input[aria-label="Search attachments"]');query.value='spark-preview';query.dispatchEvent(new Event('input',{bubbles:true}));await wait(()=>document.querySelectorAll('.file').length===2,'two preview files');
 await setSelect('Group attachments','sender');await wait(()=>document.querySelectorAll('.file-group-heading').length===1,'sender group');const sender=document.querySelector('.file-group-heading').textContent;
 await setSelect('Group attachments','conversation');await wait(()=>document.querySelector('.file-group-heading')?.textContent.includes('Spark smoke attachment previews'),'conversation group');const conversation=document.querySelector('.file-group-heading').textContent;
 await setSelect('Attachment file type','pdf');await wait(()=>document.querySelectorAll('.file').length===1,'PDF filter');document.querySelector('button[aria-label="Preview spark-preview.pdf"]').click();
 await wait(()=>document.querySelector('.page-count')?.textContent==='Page 1 of 2'&&document.querySelector('.preview-content')?.getAttribute('aria-busy')==='false','PDF first page');
 const firstCanvas=document.querySelector('.attachment-preview canvas');const pdf={pages:2,width:firstCanvas.width,height:firstCanvas.height};
 document.querySelector('button[aria-label="Next PDF page"]').click();await wait(()=>document.querySelector('.page-count')?.textContent==='Page 2 of 2'&&document.querySelector('.preview-content')?.getAttribute('aria-busy')==='false','second PDF page');
 document.querySelector('button[aria-label="Zoom in"]').click();await wait(()=>document.querySelector('.preview-toolbar')?.textContent.includes('125%')&&document.querySelector('.preview-content')?.getAttribute('aria-busy')==='false','PDF zoom');pdf.zoom='125%';
 document.querySelector('button[aria-label="Close attachment preview"]').dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true}));if(document.querySelector('.sheet'))throw new Error('Preview leaked mail shortcuts');
 document.querySelector('button[aria-label="Close attachment preview"]').click();await pause();
 await setSelect('Attachment file type','image');await wait(()=>document.querySelectorAll('.file').length===1,'image filter');document.querySelector('button[aria-label="Preview spark-preview.png"]').click();await wait(()=>document.querySelector('.preview-image')?.naturalWidth===320,'image preview');
 const image={width:document.querySelector('.preview-image').naturalWidth,height:document.querySelector('.preview-image').naturalHeight};document.querySelector('button[aria-label="Close attachment preview"]').click();
 result={sender,conversation,fileFilters:true,pdf,image,shortcutsContained:true};
}finally{
 document.querySelector('button[aria-label="Close attachment preview"]')?.click();
 await setSelect('Attachment file type',before.attachmentFileType||'all');await setSelect('Group attachments',before.attachmentGroupBy||'none');const box=document.querySelector('.approved input');box.checked=before.attachmentApprovedOnly??true;box.dispatchEvent(new Event('change',{bubbles:true}));
}
return result;
