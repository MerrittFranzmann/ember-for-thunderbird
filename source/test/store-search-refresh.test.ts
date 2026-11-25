import {describe,expect,it,vi} from "vitest";
import type {CacheStatus} from "../src/lib/local-mail-cache";
const cache=vi.hoisted(()=>({init:vi.fn(async()=>{}),onChange:undefined as undefined|((status:CacheStatus)=>void),search:vi.fn(async()=>({messages:[] as any[],indexed:0,cached:1}))}));
vi.mock("../src/lib/api",async(original)=>({...await original<object>(),mailCache:cache}));
import {Store} from "../src/lib/store.svelte";
describe("search during cache fill",()=>{
 it("refreshes local results when indexing completes",async()=>{
  const store=new Store();await store.connectCache();store.ready=true;await store.setView({kind:"search",query:"quartz"});expect(store.listConversations).toHaveLength(0);
  cache.search.mockResolvedValueOnce({messages:[{id:1,date:new Date(),author:"Ada <ada@example.org>",subject:"Quartz",headerMessageId:"quartz",size:1,recipients:[],ccList:[],bccList:[],tags:[],flagged:false}],indexed:1,cached:1});
  cache.onChange!({phase:"bodies",total:1,done:0,saved:1,failed:0});cache.onChange!({phase:"ready",total:1,done:1,saved:1,failed:0});
  await vi.waitFor(()=>expect(store.listConversations).toHaveLength(1));expect(store.searchCoverage.indexed).toBe(1);
 });
 it("does not turn a background index update into an all-mail network search",async()=>{
  const store=new Store();await store.connectCache();store.ready=true;store.view={kind:"search",query:"quartz",scope:"all"};const reload=vi.spyOn(store,"reload");cache.onChange!({phase:"ready",total:1,done:1,saved:1,failed:0});expect(reload).not.toHaveBeenCalled();
 });
});
