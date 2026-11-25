import {describe,expect,it,vi} from "vitest";
import {CacheClient} from "../src/lib/cache-client";
import {messageKey} from "../src/lib/local-mail-cache";
import type {MessageHeader} from "../src/lib/types";
const header=(id:number,name:string):MessageHeader=>({id,date:new Date(),author:"Ada",subject:name,size:1,headerMessageId:name,recipients:[],ccList:[],bccList:[],tags:[],flagged:false,folder:{id:"inbox",name:"Inbox",path:"/Inbox"}});
function setup(){const rows=[header(-99,"first"),header(-1,"second")];let snapshot=rows;const listeners:((changes:any,area:string)=>void)[]=[];const disconnect=vi.fn();const native:any={runtime:{connect:vi.fn(()=>({disconnect})),onMessage:{addListener:vi.fn()},sendMessage:vi.fn(async(message:any)=>({ok:true,value:message.command==="snapshot"?{headers:snapshot,status:{phase:"ready",total:2,done:2,failed:0,saved:2}}:message.command==="resolve"?500:undefined}))},storage:{onChanged:{addListener:(listener:any)=>listeners.push(listener)}}};return{client:new CacheClient(native),native,rows,listeners,disconnect,setRows:(next:MessageHeader[])=>snapshot=next};}
describe("cache clients",()=>{
 it("shares foreground and preview body requests, then reuses bundled cached attachment metadata",async()=>{
  const {client,native}=setup();await client.init();const id=client.all()[0].id;
  const full={body:"Already fetched for a preview"};const atts=[{name:"agenda.pdf",partName:"1.2"}];
  native.runtime.sendMessage.mockImplementation(async(message:any)=>({ok:true,value:message.command==="message"?{full,atts}:undefined}));
  const [a,b]=await Promise.all([client.fetch("bodies",id),client.fetch("bodies",id)]);
  expect(a).toEqual(full);expect(b).toEqual(full);expect(await client.body(id)).toEqual(full);expect(await client.fetch("files",id)).toEqual(atts);
  expect(native.runtime.sendMessage.mock.calls.filter(([message]:any[])=>message.command==="message")).toHaveLength(1);
  expect(native.runtime.sendMessage.mock.calls.some(([message]:any[])=>message.command==="fetch")).toBe(false);
 });
 it("doesn't let a stale list page or a late change bring back mail just moved away; a revive does",async()=>{
  const {client}=setup();await client.init();
  const moved={...header(7,"moved"),read:false};client.register([moved],true);expect(client.all().some(m=>m.headerMessageId==="moved")).toBe(true);
  client.remove([moved]);
  client.register([moved]); // a list page fetched before the move
  client.changed(moved,{read:true}); // the end of a long mark-all-read batch
  expect(client.all().some(m=>m.headerMessageId==="moved")).toBe(false);
  client.register([moved],true); // moved back (Undo) or copied back
  expect(client.all().some(m=>m.headerMessageId==="moved")).toBe(true);
 });
 it("answers searches with its own header copies, fetching only headers it doesn't have",async()=>{
  const {client,native,rows}=setup();await client.init();
  const extra=header(-5,"not yet synced");
  native.runtime.sendMessage.mockImplementation(async(message:any)=>({ok:true,value:message.command==="search"?{keys:[messageKey(rows[1]),messageKey(extra)],indexed:2,cached:3}:message.command==="headersFor"?[extra]:undefined}));
  const result=await client.search("plan");
  expect(result.messages.map(m=>m.headerMessageId)).toEqual(["second","not yet synced"]);
  expect(result.messages[0]).toBe(client.current(messageKey(rows[1])));
  expect(native.runtime.sendMessage.mock.calls.find(([m]:any[])=>m.command==="headersFor")[0].keys).toEqual([messageKey(extra)]);
 });
 it("does not let an old in-flight result repopulate memory after retry invalidation",async()=>{
  const {client,native}=setup();await client.init();const id=client.all()[0].id;
  let finish!:(value:any)=>void;native.runtime.sendMessage.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
  const previous=client.fetch("bodies",id);client.forget(id);
  native.runtime.sendMessage.mockImplementation(async()=>({ok:true,value:{full:{body:"New"},atts:[]}}));
  expect(await client.fetch("bodies",id)).toEqual({body:"New"});finish({ok:true,value:{full:{body:"Old"},atts:[]}});await previous;
  expect(await client.body(id)).toEqual({body:"New"});
 });
 it("retains its own handles across owner reorder/restart and sends keys for cached actions",async()=>{
  const{client,native,rows,setRows}=setup();await client.init();const first=client.all()[0];expect(first.id).toBe(-1);setRows([{...rows[1],id:-5},{...rows[0],id:-2}]);await client.refresh();expect(client.all().find(message=>message.subject==="first")?.id).toBe(-1);
  expect(await client.resolve(first.id)).toBe(500);expect(native.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({command:"resolve",ref:{key:messageKey(first)}}));
 });
 it("pages the first snapshot (short tasks) and applies changes made while paging",async()=>{
  const{client,native}=setup();const status={phase:"ready",total:3,done:3,failed:0,saved:3};
  const rows=Array.from({length:900},(_,i)=>header(-(i+1),`m${i}`));
  native.runtime.sendMessage.mockImplementation(async(message:any)=>({ok:true,value:message.command==="snapshot"
    ?{epoch:"e1",revision:7,reset:true,headers:rows.slice(message.offset,message.offset+message.limit),removed:[],next:message.offset+message.limit<rows.length?message.offset+message.limit:null,status}
    :message.command==="changes"?{epoch:"e1",revision:9,reset:false,headers:[{...rows[5],flagged:true}],removed:[messageKey(rows[0])],status}:undefined}));
  let partialSize=0; client.onPartial=()=>{ partialSize=client.all().length; };
  await client.init();
  expect(partialSize).toBe(400); // the first (newest) page was usable before the rest arrived
  const pages=native.runtime.sendMessage.mock.calls.filter(([m]:any)=>m.command==="snapshot").map(([m]:any)=>m.offset);
  expect(pages).toEqual([0,400]) // first page small, later pages larger;
  expect(native.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({command:"changes",since:7,epoch:"e1"}));
  expect(client.all()).toHaveLength(899); expect(client.all().find(m=>m.subject==="m5")?.flagged).toBe(true); expect(client.all().some(m=>m.subject==="m0")).toBe(false);
  await client.refresh(); expect(native.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({command:"changes",since:9}));
 });
 it("pages a large catch-up of changes after the first snapshot",async()=>{
  const{client,native}=setup();const status={phase:"ready",total:3,done:3,failed:0,saved:3};
  const rows=Array.from({length:10},(_,i)=>header(-(i+1),`m${i}`)); const changed=Array.from({length:900},(_,i)=>header(-(i+100),`n${i}`));
  let arrived=false; // the big change set appears after start-up
  native.runtime.sendMessage.mockImplementation(async(message:any)=>({ok:true,value:message.command==="snapshot"
    ?{epoch:"e1",revision:3,reset:true,headers:rows,removed:[],next:null,status}
    :message.command==="changes"?(!arrived?{epoch:"e1",revision:3,reset:false,headers:[],removed:[],next:null,status}
      :{epoch:"e1",revision:9,reset:false,headers:changed.slice(message.offset,message.offset+message.limit),removed:message.offset===0?[messageKey(rows[0])]:[],next:message.offset+message.limit<changed.length?message.offset+message.limit:null,status}):undefined}));
  await client.init(); native.runtime.sendMessage.mockClear(); arrived=true;
  await client.refresh();
  const pages=native.runtime.sendMessage.mock.calls.filter(([m]:any)=>m.command==="changes").map(([m]:any)=>m.offset);
  expect(pages).toEqual([0,400]) // first page small, later pages larger; expect(client.all()).toHaveLength(909); expect(client.all().some(m=>m.subject==="m0")).toBe(false);
 });
 it("keeps its version (and header objects) for read changes, so conversation indexes stay valid",async()=>{
  const{client}=setup();await client.init();
  const before=client.all().find(m=>m.subject==="second")!; const v=client.version;
  client.changed(before,{read:true});
  expect(client.version).toBe(v); expect(client.all().find(m=>m.subject==="second")).toBe(before); expect(before.read).toBe(true);
  client.changed(before,{flagged:true});
  expect(client.version).toBe(v+1);
 });
 it("runs a refresh requested during another once more, and restarts an expired paging session",async()=>{
  const{client,native}=setup();const status={phase:"ready",total:1,done:1,failed:0,saved:1};
  let changesCalls=0, expireOnce=true;
  native.runtime.sendMessage.mockImplementation(async(message:any)=>{
    if(message.command==="snapshot"){ if(message.offset>0&&expireOnce){expireOnce=false;return{ok:true,value:{expired:true}};} return{ok:true,value:{epoch:"e1",revision:1,reset:true,headers:message.offset===0?[header(-1,"a")]:[header(-2,"b")],removed:[],next:message.offset===0?1:null,status}}; }
    if(message.command==="changes"){ changesCalls++; await new Promise(r=>setTimeout(r,5)); return{ok:true,value:{epoch:"e1",revision:1+changesCalls,reset:false,headers:[],removed:[],next:null,status}}; }
    return{ok:true,value:undefined};
  });
  await client.init();
  expect(client.all().map(m=>m.subject).sort()).toEqual(["a","b"]); // restarted after the expired page
  changesCalls=0;
  const first=client.refresh(); const second=client.refresh();
  await Promise.all([first,second]);
  expect(changesCalls).toBe(2);
 });
 it("syncs only changed headers after the first snapshot",async()=>{
  const{client,native,rows}=setup();const status={phase:"ready",total:2,done:2,failed:0,saved:2};
  native.runtime.sendMessage.mockImplementation(async(message:any)=>({ok:true,value:message.command==="snapshot"?{epoch:"e1",revision:2,reset:true,headers:rows,removed:[],status}:message.command==="changes"?{epoch:"e1",revision:3,reset:false,headers:[{...rows[1],flagged:true}],removed:[messageKey(rows[0])],status}:undefined}));
  await client.init();expect(client.all()).toHaveLength(2);const id=client.all().find(m=>m.subject==="second")!.id;
  await client.refresh();
  expect(native.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({command:"changes",since:2,epoch:"e1"}));
  expect(client.all().map(m=>[m.subject,m.flagged,m.id])).toEqual([["second",true,id]]);
 });
 it("sends list pages to the background only when headers are new or changed",async()=>{
  const{client,native}=setup();await client.init();
  const live=[header(41,"alpha"),header(42,"beta")];
  const registers=()=>native.runtime.sendMessage.mock.calls.filter(([m]:any[])=>m.command==="register").map(([m]:any[])=>m.messages.map((x:any)=>x.id));
  client.register(live);client.register(live);await new Promise(r=>setTimeout(r,0));
  expect(registers()).toEqual([[41,42]]);
  client.register([{...live[0],read:true},live[1]]);await new Promise(r=>setTimeout(r,0));
  expect(registers()).toEqual([[41,42],[41]]);
 });
 it("receives progress without owning a fill and disconnects foreground priority once",async()=>{
  const{client,native,listeners,disconnect}=setup();await client.init();const changed=vi.fn();client.onChange=changed;listeners[0]({cacheStatus:{newValue:{phase:"paused",saved:2}}},"local");expect(changed).toHaveBeenCalledWith({phase:"paused",saved:2});
  const release=client.hold();release();release();await Promise.resolve();await Promise.resolve();expect(disconnect).toHaveBeenCalledOnce();expect(native.runtime.sendMessage.mock.calls.some(([message]:any[])=>message.command==="refresh")).toBe(false);
 });
});
