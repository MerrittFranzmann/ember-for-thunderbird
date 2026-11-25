import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMailCache, messageKey } from "../src/lib/local-mail-cache";
import type { MessageHeader, MessagePart } from "../src/lib/types";
const caches: LocalMailCache[]=[];
const message=(id:number,changes:Partial<MessageHeader>={}):MessageHeader=>({id,date:new Date(),author:"Ada <ada@example.org>",subject:`Message ${id}`,headerMessageId:`search-${id}@example.org`,flagged:false,read:false,recipients:[],ccList:[],bccList:[],size:10,tags:[],folder:{id:"inbox",accountId:"work",name:"Inbox",path:"/Inbox"},...changes});
const body=(text:string):MessagePart=>({contentType:"message/rfc822",parts:[{contentType:"text/plain",body:text}]});
function backend(headers:MessageHeader[]){return {messages:{query:vi.fn(async(options:any)=>({id:null,messages:options.flagged?headers.filter(m=>m.flagged):headers})),getFull:vi.fn(async(id:number)=>body(id===1?"Glacier café quartz budget review":"Budget planning for review")),listAttachments:vi.fn(async()=>[])}};}
function create(native:any,name=crypto.randomUUID()){const cache=new LocalMailCache(native,name);caches.push(cache);return cache;}
afterEach(()=>{caches.forEach(cache=>cache.close());caches.length=0;vi.restoreAllMocks();});
describe("persistent offline index",()=>{
  it("finds body text and prefixes without any mail API while offline after reopening",async()=>{
    const headers=[message(1),message(2)];const native=backend(headers);const name=crypto.randomUUID();const cache=create(native,name);await cache.warm();cache.close();
    native.messages.query.mockRejectedValue(new Error("offline"));native.messages.getFull.mockRejectedValue(new Error("offline"));native.messages.query.mockClear();native.messages.getFull.mockClear();
    const next=create(native,name);await next.init();const result=await next.search('CAFÉ glac');expect(result.messages.map(m=>m.headerMessageId)).toEqual([headers[0].headerMessageId]);expect(result.indexed).toBe(2);expect(result.messages[0].id).toBeLessThan(0);
    expect((await next.search('"budget review"')).messages).toHaveLength(1);expect((await next.search('"planning review"')).messages).toHaveLength(0);
    expect(native.messages.query).not.toHaveBeenCalled();expect(native.messages.getFull).not.toHaveBeenCalled();
  });
  it("migrates v1 bodies/files in place and builds the index without re-downloading",async()=>{
    const name=crypto.randomUUID();const header=message(1);const {id,...persisted}=header;const key=messageKey(header);
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>["headers","bodies","files"].forEach(store=>r.result.createObjectStore(store));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction(["headers","bodies","files"],"readwrite");tx.objectStore("headers").put(persisted,key);tx.objectStore("bodies").put(body("migration sapphire"),key);tx.objectStore("files").put([],key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
    const native=backend([header]);const cache=create(native,name);await cache.init();expect((await cache.search("Message")).messages).toHaveLength(1);await cache.warm();expect((await cache.search("sapphire")).messages).toHaveLength(1);expect(native.messages.getFull).not.toHaveBeenCalled();expect(native.messages.listAttachments).not.toHaveBeenCalled();
  });
  it("matches filenames, excludes inline resources from has-files, and reflects live read/deletes",async()=>{
    const headers=[message(1),message(2)];const native=backend(headers);native.messages.getFull.mockImplementation(async(id)=>({...body("test"),parts:[{contentType:"text/plain",body:"test"},{contentType:id===1?"application/pdf":"image/png",name:id===1?"budget.pdf":"inline.png"}]}));
    native.messages.listAttachments.mockImplementation(async(id?:number)=>(id===1?[{name:"budget.pdf",contentType:"application/pdf",size:1,partName:"1.2"}]:[{name:"inline.png",contentType:"image/png",contentId:"logo",size:1,partName:"1.2"}]) as any);
    const cache=create(native);await cache.warm();expect((await cache.search("budget.pdf",{hasAttachments:true})).messages).toHaveLength(1);expect((await cache.search("",{hasAttachments:true})).messages.map(m=>m.id)).toEqual([1]);
    cache.changed(headers[0],{read:true});expect((await cache.search("budget",{unread:true})).messages).toHaveLength(0);cache.remove([headers[0]]);await cache.flush();expect((await cache.search("budget")).messages).toHaveLength(0);
  });
  it("pauses without starting requests and resumes remaining work",async()=>{
    const native=backend([message(1)]);const cache=create(native);cache.setPaused(true);await cache.warm();expect(cache.status.phase).toBe("paused");expect(native.messages.query).not.toHaveBeenCalled();cache.setPaused(false);await cache.warm();expect(cache.status).toMatchObject({phase:"ready",done:1,accounts:{work:{total:1,done:1,failed:0}}});
  });
});
