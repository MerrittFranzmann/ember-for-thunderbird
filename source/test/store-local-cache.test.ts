import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageHeader } from "../src/lib/types";
const mock = vi.hoisted(() => ({ headers: [] as MessageHeader[], files: [] as any[], list: vi.fn(), query: vi.fn(), search: vi.fn(), set: vi.fn(async () => {}), get: vi.fn(async () => ({})), folderInfo: vi.fn(), storageListeners: [] as any[] }));
vi.mock("../src/lib/api", async (original) => ({ ...await original<object>(), api: { storage: { local: { set: mock.set, get: mock.get }, onChanged: { addListener: (l: any) => mock.storageListeners.push(l) } }, folders: { getFolderInfo: mock.folderInfo }, messages: { query: mock.query, abortList: vi.fn() } }, listFolder: mock.list, mailCache: { all: () => mock.headers, attachmentIndex: async () => mock.files, changed: vi.fn(), search: (...args: any[]) => mock.search(...args) } }));
import { Store } from "../src/lib/store.svelte";
const folder={id:"work-inbox",accountId:"work",name:"Inbox",path:"/Inbox",specialUse:["inbox"]};
const header=(id:number, props:Partial<MessageHeader>={}):MessageHeader=>({id,date:new Date(),author:"ada@example.org",subject:`Mail ${id}`,recipients:[],ccList:[],bccList:[],headerMessageId:`cache-${id}`,size:10,tags:[],flagged:false,folder,...props});
const view={kind:"mailbox",role:"inbox",accountId:"work"} as const;
afterEach(()=>{mock.headers=[];mock.files=[];mock.storageListeners.length=0;vi.clearAllMocks();mock.get.mockResolvedValue({});mock.folderInfo.mockReset();vi.clearAllTimers();vi.useRealTimers();});
describe("instant restored lists and pinned category",()=>{
  it("shows disk headers immediately while refreshing and retains them on backend failure",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); mock.headers=[header(-1)];
    let reject!:(error:Error)=>void; mock.list.mockReturnValue(new Promise((_,r)=>reject=r)); const refresh=store.setView(view);
    expect(store.hasLoadedView).toBe(true); expect(store.get(-1)?.subject).toBe("Mail -1"); expect(store.loading).toBe(true);
    reject(new Error("offline")); await refresh; expect(store.get(-1)).toBeDefined(); expect(store.error).toBe("offline");
  });
  it("shows the cached attachment library before finding messages completes",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); const message=header(-1); mock.headers=[message]; mock.files=[{message,files:[{name:"plan.pdf",partName:"1.2",size:42,contentType:"application/pdf"}]}];
    let reject!:(error:Error)=>void; mock.query.mockReturnValue(new Promise((_,r)=>reject=r)); const refresh=store.setView({kind:"attachments"});
    await new Promise(r=>setTimeout(r,0)); expect(store.attachments[0].attachment.name).toBe("plan.pdf"); expect(store.hasLoadedView).toBe(true); expect(store.loading).toBe(true);
    reject(new Error("offline")); await refresh; expect(store.attachments).toHaveLength(1);
  });
  it("lists attachments from a complete cache without Thunderbird's slow attachment search, unless refreshed",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); const message=header(-1); mock.headers=[message]; mock.files=[{message,files:[{name:"plan.pdf",partName:"1.2",size:42,contentType:"application/pdf"}]}];
    store.cacheStatus={...store.cacheStatus,phase:"ready"};
    await store.setView({kind:"attachments"});
    expect(store.attachments.map(a=>a.attachment.name)).toEqual(["plan.pdf"]); expect(mock.query).not.toHaveBeenCalled();
    mock.query.mockResolvedValue({id:null,messages:[]}); await store.refresh();
    expect(mock.query).toHaveBeenCalledWith(expect.objectContaining({attachment:true}));
  });
  it("opens Pins from a complete cache without Thunderbird's folder-wide flagged search, unless refreshed",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); mock.headers=[header(-1,{flagged:true}),header(-2),header(-3,{flagged:true,date:new Date("2020-01-01")})];
    store.cacheStatus={...store.cacheStatus,phase:"ready"};
    await store.setView({kind:"pinned"});
    expect(store.listConversations.map(c=>c.latest.id).sort((a,b)=>a-b)).toEqual([-3,-1]); expect(mock.query).not.toHaveBeenCalled();
    mock.query.mockResolvedValue({id:null,messages:[]}); await store.refresh();
    expect(mock.query).toHaveBeenCalledWith(expect.objectContaining({flagged:true}));
  });
  it("keeps serving Pins and files from the cache while a later pass runs or after the user interrupted one",async()=>{
    // Before: only phase "ready" counted, so every 30-minute pass (and an interrupted one, back to
    // "idle") sent the Pinned tab to Thunderbird's folder-wide search, which stalls the click.
    const store=new Store(); store.folderById.set(folder.id,folder); const message=header(-1,{flagged:true}); mock.headers=[message,header(-2)];
    mock.files=[{message,files:[{name:"plan.pdf",partName:"1.2",size:42,contentType:"application/pdf"}]}];
    for (const phase of ["idle","index","bodies","error"] as const) {
      store.cacheStatus={...store.cacheStatus,phase,lastInventoryAt:Date.now()-60000,lastCompletedAt:Date.now()-120000};
      await store.setView({kind:"category",cat:"newsletter"}); await store.openCategory("pinned");
      expect(store.listConversations.map(c=>c.latest.id)).toEqual([-1]);
      await store.setView({kind:"attachments"}); expect(store.attachments.map(a=>a.attachment.name)).toEqual(["plan.pdf"]);
    }
    expect(mock.query).not.toHaveBeenCalled();
    // Never inventoried (first run), or paused: Thunderbird answers.
    for (const status of [{phase:"index" as const},{phase:"paused" as const,lastInventoryAt:Date.now()}]) {
      mock.query.mockClear(); mock.query.mockResolvedValue({id:null,messages:[]});
      const fresh=new Store(); fresh.folderById.set(folder.id,folder); fresh.cacheStatus={total:0,done:0,failed:0,saved:0,...status};
      await fresh.openCategory("pinned");
      expect(mock.query).toHaveBeenCalledWith(expect.objectContaining({flagged:true}));
    }
  });
  it("refreshes a conversation's attachment icon in place when only its attachment flag changes",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); const m=header(-1); mock.headers=[m];
    store.cacheStatus={phase:"idle",total:0,done:0,failed:0,saved:1,lastInventoryAt:Date.now()};
    mock.query.mockResolvedValue({id:null,messages:[]});
    await store.setView(view); await store.reload();
    store.meta.onChange=(g,t)=>(store as any).metaChanged(g,t); // wired in init(), which these tests skip
    store.meta.put(m,{cat:"people",refs:[],hasAtt:false,lvl:"h"}); await new Promise(r=>setTimeout(r,200));
    expect(store.conversations[0].hasAttachment).toBe(false);
    const groupRev=(store as any).metaGroupRev, readRev=store.readRev;
    store.meta.put(m,{cat:"people",refs:[],hasAtt:true,lvl:"f"}); await new Promise(r=>setTimeout(r,200)); // opening it found a file
    expect((store as any).metaGroupRev).toBe(groupRev); // no regroup
    expect(store.readRev).toBe(readRev+1); // rows refresh
    expect((store as any).lastConversations[0].hasAttachment).toBe(true);
  });
  it("keeps the last grouping while Ember is hidden and regroups once when it's shown",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); mock.headers=[header(-1)];
    store.cacheStatus={phase:"idle",total:0,done:0,failed:0,saved:1,lastInventoryAt:Date.now()};
    mock.query.mockResolvedValue({id:null,messages:[]});
    await store.setView(view); await store.reload();
    expect(store.listConversations.map(c=>c.latest.id)).toEqual([-1]);
    store.shown=false;
    (store as any).add([header(-2,{subject:"Arrived while minimized"})]);
    expect(store.listConversations.map(c=>c.latest.id)).toEqual([-1]); // not regrouped for nobody
    store.shown=true;
    expect(store.listConversations.map(c=>c.latest.id).sort((a,b)=>a-b)).toEqual([-2,-1]);
  });
  it("skips the last-three-days walk of a folder whose counts haven't changed since it was last covered",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); mock.headers=[header(-1)];
    store.cacheStatus={phase:"idle",total:0,done:0,failed:0,saved:1,lastInventoryAt:Date.now()};
    // The background's last inventory saw 120 emails, 3 unread; Thunderbird still has exactly that.
    mock.get.mockResolvedValue({cacheFolderMarks:{marks:{[folder.id]:"120:3:0"}}});
    mock.folderInfo.mockResolvedValue({totalMessageCount:120,unreadMessageCount:3,newMessageCount:0});
    mock.query.mockResolvedValue({id:null,messages:[]});
    await store.setView(view); await store.reload(); await new Promise(r=>setTimeout(r,10));
    expect(mock.folderInfo).toHaveBeenCalledWith(folder.id);
    expect(mock.query).not.toHaveBeenCalled();
    // New mail since: the counts differ, so the folder is walked (once more within the throttle only if they change again).
    (store as any).recentChecks.clear();
    mock.folderInfo.mockResolvedValue({totalMessageCount:121,unreadMessageCount:4,newMessageCount:1});
    await store.reload();
    await vi.waitFor(()=>expect(mock.query).toHaveBeenCalledWith({folderId:folder.id,fromDate:expect.any(Date)}));
    (store as any).recentChecks.clear(); mock.query.mockClear();
    await store.reload(); await new Promise(r=>setTimeout(r,10));
    expect(mock.query).not.toHaveBeenCalled(); // the walk recorded 121:4:1
  });
  it("walks a folder that lost mail even when its counts are back where they were (a draft replaced by a new one)",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); mock.headers=[header(-1)];
    store.cacheStatus={phase:"idle",total:0,done:0,failed:0,saved:1,lastInventoryAt:Date.now()};
    mock.get.mockResolvedValue({cacheFolderMarks:{marks:{[folder.id]:"120:3:0"}}});
    mock.folderInfo.mockResolvedValue({totalMessageCount:120,unreadMessageCount:3,newMessageCount:0});
    mock.query.mockResolvedValue({id:null,messages:[]});
    await store.setView(view); await store.reload(); await new Promise(r=>setTimeout(r,10));
    expect(mock.query).not.toHaveBeenCalled();
    // One email deleted, another saved: still 120:3:0, and the last check ran just now.
    (store as any).noteRemoved([header(-1)]);
    const fresh=header(5,{subject:"New draft"}); mock.query.mockResolvedValue({id:null,messages:[fresh]});
    await store.reload();
    await vi.waitFor(()=>expect(store.get(5)?.subject).toBe("New draft"));
    // Once walked, equal counts are trusted again.
    (store as any).recentChecks.clear(); mock.query.mockClear();
    await store.reload(); await new Promise(r=>setTimeout(r,10));
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("counts a later background inventory as covering its folders",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); mock.headers=[header(-1)];
    store.cacheStatus={phase:"idle",total:0,done:0,failed:0,saved:1,lastInventoryAt:Date.now()};
    mock.get.mockResolvedValue({cacheFolderMarks:{marks:{[folder.id]:"120:3:0"}}});
    mock.folderInfo.mockResolvedValue({totalMessageCount:120,unreadMessageCount:3,newMessageCount:0});
    mock.query.mockResolvedValue({id:null,messages:[]});
    await store.setView(view); await store.reload(); await new Promise(r=>setTimeout(r,10));
    expect(mock.query).not.toHaveBeenCalled();
    // New mail arrived (announced) and the background's half-hourly inventory has re-listed the folder since.
    mock.folderInfo.mockResolvedValue({totalMessageCount:121,unreadMessageCount:4,newMessageCount:1});
    for (const listener of mock.storageListeners) listener({cacheFolderMarks:{newValue:{marks:{[folder.id]:"121:4:1"}}}},"local");
    (store as any).recentChecks.clear();
    await store.reload(); await new Promise(r=>setTimeout(r,10));
    expect(mock.query).not.toHaveBeenCalled(); // no walk: the inventory covered it at these counts
  });
  it("serves inbox views from a finished cache; Thunderbird lists the folder only for older mail (once) or on Refresh",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); const recent=header(-1), old=header(5,{date:new Date("2020-02-02"),headerMessageId:"old-5"});
    mock.headers=[recent]; store.cacheStatus={phase:"idle",total:0,done:0,failed:0,saved:1,lastInventoryAt:Date.now()};
    // The cache path still asks for the last three days of each folder (unannounced mail), never the whole folder.
    const unannounced=header(7,{headerMessageId:"new-7"});
    // Like the real (cache-wrapped) API, what Thunderbird lists is registered in the cache.
    mock.query.mockImplementation(async(q:any)=>{ if(q.toDate) return {id:null,messages:[old]}; if(!mock.headers.includes(unannounced)) mock.headers=[...mock.headers,unannounced]; return {id:null,messages:[unannounced]}; });
    await store.setView(view); await store.reload();
    expect(mock.list).not.toHaveBeenCalled();
    await vi.waitFor(()=>expect(mock.query).toHaveBeenCalledWith({folderId:folder.id,fromDate:expect.any(Date)}));
    expect(Date.now()-+mock.query.mock.calls[0][0].fromDate).toBeLessThanOrEqual(3*86400000+1000);
    await vi.waitFor(()=>expect(store.listConversations.map(c=>c.latest.id).sort((a,b)=>a-b)).toEqual([-1,7]));
    expect(store.items.at(-1)).toEqual({type:"older",key:"older"});
    // That check walks the whole folder in Thunderbird, so revisits within a few minutes skip it.
    mock.query.mockClear(); await store.reload(); expect(mock.query).not.toHaveBeenCalled();
    // Older mail: only what the cache doesn't keep, via a date search (not a listing of the whole folder).
    mock.query.mockClear(); await store.loadOlder();
    expect(mock.list).not.toHaveBeenCalled(); expect(mock.query).toHaveBeenCalledWith({folderId:folder.id,toDate:expect.any(Date)});
    expect(Date.now()-+mock.query.mock.calls[0][0].toDate).toBeGreaterThanOrEqual(90*86400000-1000);
    expect(store.listConversations.map(c=>c.latest.id).sort((a,b)=>a-b)).toEqual([-1,5,7]);
    expect(store.items.some(i=>i.type==="older")).toBe(false);
    mock.query.mockClear(); await store.reload(); // e.g. after new mail: cache again, older mail carried over
    expect(mock.query).not.toHaveBeenCalled();
    expect(store.listConversations.map(c=>c.latest.id).sort((a,b)=>a-b)).toEqual([-1,5,7]);
    mock.list.mockClear(); await store.refresh(); expect(mock.list).toHaveBeenCalledOnce(); expect(store.listFromCache).toBe(false);
  });
  it("marks read without regrouping: the conversation's unread count and list row update in place",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder);
    const update=vi.fn(async()=>{}); (await import("../src/lib/api")).api.messages.update=update;
    mock.list.mockResolvedValue({id:null,messages:[header(1,{read:false}),header(2,{read:false,subject:"Other"})]});
    await store.setView(view);
    const before=store.listConversations.find(c=>c.latest.id===1)!; expect(before.unread).toBe(1);
    // Outside a component Svelte re-derives on each read, so check the store's counters instead:
    // a read change bumps readRev (rows refresh) and leaves rev (the regroup trigger) alone.
    const rev0=(store as any).rev, readRev0=store.readRev;
    await store.setRead([before],true);
    expect(update).toHaveBeenCalledWith(1,{read:true});
    expect((store as any).rev).toBe(rev0); expect(store.readRev).toBe(readRev0+1);
    const row=store.items.find(i=>i.type==="conv"&&i.conv.latest.id===1) as any;
    expect(row.conv.unread).toBe(0); expect(store.listConversations.find(c=>c.latest.id===2)!.unread).toBe(1);
  });
  it("keeps pins out of inbox filters and counts, scoped Pinned has only this account's pins",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); const regular=header(1), pin=header(2,{flagged:true}), otherPin=header(3,{flagged:true,folder:{...folder,id:"personal-inbox",accountId:"personal"}});
    mock.list.mockResolvedValue({id:null,messages:[regular,pin]}); mock.query.mockResolvedValue({id:null,messages:[pin,otherPin]}); await store.setView(view);
    expect(store.listConversations.map(c=>c.latest.id)).toEqual([1]); expect(store.displayedConversationCount).toBe(1);
    await store.openCategory("pinned"); expect(store.view).toEqual({kind:"category",cat:"pinned",accountId:"work"}); expect(store.listConversations.map(c=>c.latest.id)).toEqual([2]);
    await store.backToInbox(); expect(store.listConversations.map(c=>c.latest.id)).toEqual([1]);
  });
  it("archiving the last conversation of Today opens the next one, even in a collapsed section",async()=>{
    vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date(2026,9,29,14)); const store=new Store(); store.folderById.set(folder.id,folder);
    (await import("../src/lib/api")).api.messages.archive=vi.fn(async()=>{});
    mock.list.mockResolvedValue({id:null,messages:[header(1,{subject:"Today mail"}),header(2,{subject:"Older mail",date:new Date(2026,9,27,10)})]}); await store.setView(view);
    expect(store.navOrder.map(c=>c.latest.id)).toEqual([1]); // "This week" is collapsed
    store.select(store.navOrder[0].key);
    await store.archive([store.selected!]);
    expect(store.selected?.latest.id).toBe(2); expect(store.readerOpen).toBe(true);
  });
  it("a draft's conversation acts on the draft alone, not on the emails it answers shown beside it",async()=>{
    const store=new Store(); const drafts={...folder,id:"work-drafts",name:"Drafts",path:"/Drafts",specialUse:["drafts"]};
    store.folderById.set(folder.id,folder); store.folderById.set(drafts.id,drafts);
    const draft=header(1,{folder:drafts,subject:"Re: Plan"}), answered=header(2,{subject:"Plan"});
    (store as any).dataset=new Map([[1,draft]]); (store as any).related.set(2,answered);
    const conv={key:"cache-1",ids:[1],latest:draft,count:1,unread:0,flagged:false,hasAttachment:false,cat:"people",senders:[]} as any;
    (store as any).relatedIds.set(conv.key,[1,2]);
    expect((store as any).idsOf(conv)).toEqual([1]);
    // Any other conversation still acts on its whole thread.
    (store as any).dataset=new Map([[2,answered]]); const inbox={...conv,key:"cache-2",ids:[2],latest:answered};
    (store as any).relatedIds.set(inbox.key,[2,1]);
    expect((store as any).idsOf(inbox)).toEqual([2,1]);
  });
  it("lists each draft on its own row in Drafts, even two replies in one thread",async()=>{
    const store=new Store(); const drafts={...folder,id:"work-drafts",name:"Drafts",path:"/Drafts",specialUse:["drafts"]};
    store.folderById.set(drafts.id,drafts);
    const a=header(1,{folder:drafts,subject:"Plan",references:["<plan@example.org>"]} as any), b=header(2,{folder:drafts,subject:"Plan",references:["<plan@example.org>"]} as any);
    mock.list.mockResolvedValue({id:null,messages:[a,b]}); await store.setView({kind:"folder",folderId:drafts.id});
    expect(store.listConversations.map(c=>c.ids)).toEqual(expect.arrayContaining([[1],[2]]));
    expect(store.listConversations).toHaveLength(2);
  });
  it("titles a nicknamed inbox with just its nickname, and other views with the nickname",async()=>{
    const store=new Store(); (store as any).accounts=[{account:{id:"work",name:"alex@northwind.example",identities:[]},primary:[],others:[]}];
    store.settings.accountNicknames={work:"Northwind"};
    store.view={kind:"mailbox",role:"inbox",accountId:"work"}; expect(store.viewTitle).toBe("Northwind");
    store.view={kind:"mailbox",role:"sent",accountId:"work"}; expect(store.viewTitle).toBe("Sent — Northwind");
    store.settings.accountNicknames={};
    store.view={kind:"mailbox",role:"inbox",accountId:"work"}; expect(store.viewTitle).toBe("Inbox — alex@northwind.example");
  });
  it("Ctrl+Z undoes the last pin or read change, newest first, but not the automatic mark-as-read",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder);
    const update=vi.fn(async()=>{}); (await import("../src/lib/api")).api.messages.update=update;
    mock.list.mockResolvedValue({id:null,messages:[header(1,{read:false}),header(2,{read:true})]}); await store.setView({kind:"mailbox",role:"inbox",accountId:"work"});
    const conv=(id:number)=>store.listConversations.find(c=>c.latest.id===id)!;
    await store.setRead([conv(1)],true); // the reader's automatic mark-as-read: not undoable
    await store.toggleRead([conv(2)]); // user: mark as unread
    await store.toggleStar([conv(2)]); // user: pin
    expect(store.get(2)).toMatchObject({read:false,flagged:true});
    await store.undo(); expect(store.get(2)?.flagged).toBe(false); expect(store.get(2)?.read).toBe(false);
    await store.undo(); expect(store.get(2)?.read).toBe(true);
    const toasts=store.toasts.length; await store.undo();
    expect(store.get(1)?.read).toBe(true); expect(store.toasts.at(-1)?.text).toBe("Nothing to undo"); expect(store.toasts.length).toBe(toasts+1);
  });
  it("search of all mail shows saved matches at once, then lists each email once with Thunderbird's copy",async()=>{
    const store=new Store(); store.folderById.set(folder.id,folder); const date=new Date();
    const savedCopy=header(-5,{date,headerMessageId:"shared",subject:"Venue"}), onlySaved=header(-6,{date,headerMessageId:"saved-only",subject:"Catering"});
    mock.search.mockResolvedValue({messages:[savedCopy,onlySaved],indexed:2,cached:2});
    let finish!:(page:any)=>void; const answer=new Promise(resolve=>{finish=resolve;}); mock.query.mockImplementation(()=>answer); // every case variant
    const loading=store.setView({kind:"search",query:"venue",scope:"all"});
    await vi.waitFor(()=>expect(store.listConversations.map(c=>c.latest.id).sort((a,b)=>a-b)).toEqual([-6,-5])); // before Thunderbird answers
    finish({id:null,messages:[header(5,{date,headerMessageId:"shared",subject:"Venue"}),header(7,{date,headerMessageId:"old",subject:"Old venue"})]});
    await loading;
    expect(store.listConversations.map(c=>c.latest.id).sort((a,b)=>a-b)).toEqual([-6,5,7]);
  });
  it("toggles time buckets without changing totals and remembers expansion separately for each inbox",async()=>{
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026,9,29,14)); const store=new Store(); store.folderById.set(folder.id,folder);
    mock.list.mockResolvedValue({id:null,messages:[header(1),header(2,{date:new Date(2026,9,27,10)})]}); await store.setView(view);
    expect(store.items.filter(i=>i.type==="bucket").map(i=>i.label)).toEqual(["Today","This week"]); expect(store.navOrder).toHaveLength(1);
    await store.toggleTimeBucket("week",true); expect(store.navOrder).toHaveLength(2); await store.toggleTimeBucket("day",false); expect(store.navOrder).toHaveLength(1); expect(store.displayedConversationCount).toBe(2);
    expect(mock.set).toHaveBeenCalledWith({timeBucketExpanded:expect.objectContaining({"mailbox:inbox:work:day":false,"mailbox:inbox:work:week":true})});
    await store.setView({kind:"folder",folderId:"other"}); expect(store.navOrder[0].latest.id).toBe(1);
    await store.setView(view); expect(store.navOrder[0].latest.id).toBe(2);
  });
});
