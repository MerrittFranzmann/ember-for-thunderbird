import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {CacheService} from "../src/lib/cache-service";
import {messageKey,type LocalMailCache} from "../src/lib/local-mail-cache";
import type {MessageHeader} from "../src/lib/types";
const instances:CacheService[]=[];
function setup(paused=false,saved:any={}){
 const cache:any={status:{phase:"idle",total:0,done:0,failed:0,saved:0,accounts:{work:{total:3,done:1,failed:0}}},init:vi.fn(async()=>{}),warm:vi.fn(async()=>{}),setPaused:vi.fn((value:boolean)=>cache.status.phase=value?"paused":"idle"),all:vi.fn(()=>[]),changesSince:vi.fn(()=>({epoch:"e",revision:0,reset:true,headers:[],removed:[]})),header:vi.fn(),idForKey:vi.fn(),register:vi.fn(),changed:vi.fn(),removeKeys:vi.fn(),close:vi.fn(),flush:vi.fn(async()=>{}),hold:vi.fn(()=>release),resolve:vi.fn(async(id:number)=>id),body:vi.fn(),files:vi.fn(),fetch:vi.fn(),search:vi.fn(async()=>({messages:[],indexed:0,cached:0})),clearFailures:vi.fn()};
 const release=vi.fn();const native:any={accounts:{list:vi.fn(async()=>[{id:"work",name:"Work mail"}])},runtime:{sendMessage:vi.fn(async()=>{})},storage:{local:{get:vi.fn(async()=>({cachePaused:paused,...saved})),set:vi.fn(async()=>{})}}};const service=new CacheService(native,cache as LocalMailCache);instances.push(service);return{service,cache,native,release};
}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{instances.forEach(service=>service.close());instances.length=0;vi.clearAllTimers();vi.useRealTimers();});
describe("background cache owner",()=>{
 it("returns body and cached file metadata together without starting attachment discovery",async()=>{
  const {service,cache}=setup();cache.fetch.mockResolvedValue({body:"First paint"});cache.files.mockResolvedValue(undefined);
  const response=await service.request({command:"message",ref:{id:42}});
  expect(response).toEqual({ok:true,value:{full:{body:"First paint"},atts:undefined}});
  expect(cache.fetch).toHaveBeenCalledExactlyOnceWith("bodies",42,[]);expect(cache.files).toHaveBeenCalledExactlyOnceWith(42);
 });
 it("starts without an app tab and publishes named per-account progress",async()=>{
  const {service,cache,native}=setup();await service.start();await vi.advanceTimersByTimeAsync(501);expect(cache.warm).toHaveBeenCalledOnce();
  const snapshot=await service.request({command:"snapshot"});expect(snapshot.value.status.accounts.work.name).toBe("Work mail");expect(native.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({cacheStatus:expect.any(Object)}));
 });
 it("runs a full inventory at most every 30 minutes; mail events only complete pending bodies",async()=>{
  const {service,cache}=setup();cache.lastInventoryAt=Date.now();
  service.tick();await vi.advanceTimersByTimeAsync(501);expect(cache.warm).toHaveBeenLastCalledWith({inventory:false,whenIdle:true});
  await service.received({id:null,messages:[]} as any);await vi.advanceTimersByTimeAsync(501);expect(cache.warm).toHaveBeenLastCalledWith({inventory:false});
  cache.lastInventoryAt=Date.now()-31*60000;service.tick();await vi.advanceTimersByTimeAsync(501);expect(cache.warm).toHaveBeenLastCalledWith({inventory:true,whenIdle:true});
  await service.request({command:"refresh"});await vi.advanceTimersByTimeAsync(501);expect(cache.warm).toHaveBeenLastCalledWith({inventory:true});
 });
 it("offers saved mail since a time only while the cache is current",async()=>{
  const{service,cache}=setup();const now=Date.now();
  cache.all.mockReturnValue([{id:1,date:new Date(now-1000)},{id:2,date:new Date(now-3*86400000)}]);
  cache.lastInventoryAt=now-60000;expect((await service.recentMail(now-86400000))?.map(m=>m.id)).toEqual([1]);
  cache.lastInventoryAt=now-3*3600000;expect(await service.recentMail(now-86400000)).toBeNull();
  cache.lastInventoryAt=now;cache.status.phase="paused";expect(await service.recentMail(now-86400000)).toBeNull();
 });
 it("doesn't trust a saved inventory when the database came back empty (cleared or evicted)",async()=>{
  const{service,cache}=setup(false,{cacheStatus:{phase:"ready",total:5,done:5,failed:0,saved:5,lastInventoryAt:Date.now()-60000,lastCompletedAt:Date.now()-60000}});
  cache.empty=true;
  await service.request({command:"snapshot"});
  expect(cache.status.lastInventoryAt).toBeUndefined(); expect(cache.status.lastCompletedAt).toBeUndefined(); // views ask Thunderbird meanwhile
  expect(cache.lastInventoryAt||0).toBe(0); // so start() runs an inventory now
 });
 it("restores the last finished inventory, which lets views keep using the cache after a restart",async()=>{
  const{service,cache}=setup(false,{cacheStatus:{phase:"bodies",total:5,done:2,failed:0,saved:5,lastInventoryAt:1234,lastCompletedAt:1000}});
  await service.request({command:"snapshot"});expect(cache.status).toMatchObject({phase:"idle",lastInventoryAt:1234,lastCompletedAt:1000});
 });
 it("serves the snapshot in pages from one fixed key list",async()=>{
  const{service,cache}=setup();const keys=["a","b","c","d","e"];
  cache.snapshotKeys=vi.fn(()=>({keys,epoch:"e",revision:4}));cache.headersFor=vi.fn((ks:string[])=>ks.map(k=>({headerMessageId:k})));
  const first=await service.request({command:"snapshot",offset:0,limit:2,token:"t"});
  expect(first.value).toMatchObject({epoch:"e",revision:4,next:2,headers:[{headerMessageId:"a"},{headerMessageId:"b"}]});
  const second=await service.request({command:"snapshot",offset:2,limit:2,token:"t"});const last=await service.request({command:"snapshot",offset:4,limit:2,token:"t"});
  expect(second.value.next).toBe(4);expect(last.value).toMatchObject({next:null,headers:[{headerMessageId:"e"}]});expect(cache.snapshotKeys).toHaveBeenCalledOnce();
 });
 it("serves changes in pages, splitting current headers from removed keys",async()=>{
  const{service,cache}=setup();
  cache.changedKeys=vi.fn(()=>({keys:["a","gone","c"],epoch:"e",revision:7,reset:false}));
  cache.splitKeys=vi.fn((ks:string[])=>({headers:ks.filter(k=>k!=="gone").map(k=>({headerMessageId:k})),removed:ks.filter(k=>k==="gone")}));
  const first=await service.request({command:"changes",since:2,epoch:"e",offset:0,limit:2,token:"t"});
  expect(first.value).toMatchObject({revision:7,reset:false,next:2,headers:[{headerMessageId:"a"}],removed:["gone"]});
  const last=await service.request({command:"changes",since:2,epoch:"e",offset:2,limit:2,token:"t"});
  expect(last.value).toMatchObject({next:null,headers:[{headerMessageId:"c"}],removed:[]});expect(cache.changedKeys).toHaveBeenCalledOnce();
 });
 it("reports an expired paging session instead of re-slicing a new key list",async()=>{
  const{service,cache}=setup(); cache.snapshotKeys=vi.fn(()=>({keys:["a","b"],epoch:"e",revision:1}));
  const r=await service.request({command:"snapshot",offset:400,limit:400,token:"unknown"});
  expect(r.value).toEqual({expired:true}); expect(cache.snapshotKeys).not.toHaveBeenCalled();
 });
 it("restores pause, persists resume, and schedules remaining work",async()=>{
  const{service,cache,native}=setup(true);await service.request({command:"snapshot"});expect(cache.setPaused).toHaveBeenCalledWith(true);
  await service.request({command:"pause",paused:false});expect(native.storage.local.set).toHaveBeenCalledWith({cachePaused:false});await vi.advanceTimersByTimeAsync(501);expect(cache.warm).toHaveBeenCalledOnce();
 });
 it("releases reader priority if its tab disconnects",async()=>{
  const{service,cache,release}=setup();let disconnect!:()=>void;service.reader({onDisconnect:{addListener:(listener:()=>void)=>disconnect=listener}});await service.request({command:"snapshot"});expect(cache.hold).toHaveBeenCalledOnce();disconnect();expect(release).toHaveBeenCalledOnce();
 });
 it("translates tab-local negative handles by stable key before reading or changing cached state",async()=>{
  const {service,cache}=setup();const header={id:-1,date:new Date(),author:"Ada",subject:"One",size:1,headerMessageId:"one",folder:{id:"inbox"}} as MessageHeader;
  const key=messageKey(header);cache.idForKey.mockReturnValue(-37);cache.header.mockReturnValue({...header,id:-37});cache.resolve.mockResolvedValue(700);
  expect((await service.request({command:"resolve",ref:{key}})).value).toBe(700);expect(cache.resolve).toHaveBeenCalledWith(-37);
  cache.body.mockResolvedValue({headers:{subject:["One"]}});expect((await service.request({command:"headers",ref:{key}})).value).toEqual({subject:["One"]});expect(cache.body).toHaveBeenCalledWith(-37);
  await service.request({command:"changed",message:header,changes:{read:true}});expect(cache.changed).toHaveBeenCalledWith({...header,id:-37},{read:true});
  await service.request({command:"remove",messages:[header]});expect(cache.removeKeys).toHaveBeenCalledWith([key]);
 });
 it("rejects unknown/missing handles and never treats a client's negative ID as an owner ID",async()=>{
  const{service,cache}=setup();expect((await service.request({command:"resolve",ref:{id:-1,key:"missing"}})).ok).toBe(false);expect(cache.resolve).not.toHaveBeenCalled();expect((await service.request({command:"arbitrary"})).ok).toBe(false);
 });
});
