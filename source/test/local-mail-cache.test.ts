import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMailCache, cachedAPI, hasOnlyInlineText, keepMessage, messageKey } from "../src/lib/local-mail-cache";
import type { MessageHeader, MessagePart } from "../src/lib/types";
const caches: LocalMailCache[] = [];
const header = (id: number, props: Partial<MessageHeader> = {}): MessageHeader => ({ id, date: new Date(), author: "ada@example.org", subject: "Plan", recipients: [], ccList: [], bccList: [], headerMessageId: `message-${id}@example.org`, size: 10, tags: [], flagged: false, folder: { id: "inbox", accountId: "work", name: "Inbox", path: "/Inbox" }, ...props });
const full = { contentType: "message/rfc822", headers: { references: ["<parent@example.org>"] }, parts: [{ contentType: "text/plain", body: "Cached reading" }, {contentType:"application/pdf",name:"plan.pdf",partName:"1.2",size:42}] };
const files = [{ name: "plan.pdf", partName: "1.2", contentType: "application/pdf", size: 42 }];
function backend(messages: MessageHeader[] = []) {
  return { messages: { query: vi.fn(async (_options: any) => ({ id: null, messages })), continueList: vi.fn(), getFull: vi.fn(async (_id?:number) => full), listAttachments: vi.fn(async () => files), getHeaders: vi.fn(), update: vi.fn(async () => {}), archive: vi.fn(async () => {}), getAttachmentFile: vi.fn(async () => "file"), openAttachment: vi.fn() }, compose: { beginReply: vi.fn(async () => ({})), beginNew: vi.fn(async () => ({})) }, messageDisplay: { open: vi.fn(async () => ({})) } };
}
function create(native: any, name = crypto.randomUUID()) { const cache = new LocalMailCache(native, name); caches.push(cache); return cache; }
afterEach(() => { for (const cache of caches) cache.close(); caches.length = 0; vi.restoreAllMocks(); });
describe("persistent mail cache", () => {
  it("reports only changed and removed headers since a tab's revision", async () => {
    const cache = create(backend()); await cache.init();
    const date = new Date(); const at = (id: number) => header(id, { date });
    cache.register([at(1), at(2), at(3)]);
    const first = cache.changesSince(-1);
    expect(first.reset).toBe(true); expect(first.headers).toHaveLength(3);
    expect(cache.changesSince(first.revision, first.epoch)).toMatchObject({ reset: false, headers: [], removed: [] });
    cache.register([at(1), at(2)]); // unchanged values are not changes
    expect(cache.changesSince(first.revision, first.epoch).headers).toHaveLength(0);
    cache.changed(at(2), { read: true });
    cache.remove([at(3)]);
    const delta = cache.changesSince(first.revision, first.epoch);
    expect(delta.reset).toBe(false);
    expect(delta.headers.map((h) => h.subject)).toEqual(["Plan"]);
    expect(delta.headers[0].read).toBe(true);
    expect(delta.removed).toEqual([messageKey(at(3))]);
    expect(cache.changesSince(delta.revision, "another-owner").reset).toBe(true);
  });
  it("pages snapshots newest first and pages changes with removed keys split out", async () => {
    const cache = create(backend()); await cache.init();
    const day = 86400000;
    cache.register([header(1, { date: new Date(Date.now() - 3 * day) }), header(2, { date: new Date() }), header(3, { date: new Date(Date.now() - day) })]);
    const snap = cache.snapshotKeys();
    expect(cache.headersFor(snap.keys).map((h) => h.id)).toEqual([2, 3, 1]);
    cache.changed(header(3, { date: new Date(Date.now() - day) }), { read: true });
    cache.remove([header(1, { date: new Date(Date.now() - 3 * day) })]);
    const changed = cache.changedKeys(snap.revision, snap.epoch);
    expect(changed.reset).toBe(false);
    const split = cache.splitKeys(changed.keys);
    expect(split.headers.map((h) => h.id)).toEqual([3]); expect(split.removed).toHaveLength(1);
  });
  it("retains exactly recent mail and pins at any age", () => {
    const old = header(1, { date: new Date(Date.now()-91*86400000) });
    expect(keepMessage(old)).toBe(false);
    expect(keepMessage({ ...old, flagged:true })).toBe(true);
    expect(keepMessage(header(2, { date: new Date(Date.now()-90*86400000) }),Date.now())).toBe(true);
    expect(messageKey(header(1))).not.toBe(messageKey(header(1, {folder:{id:"sent",name:"Sent",path:"/Sent"}})));
  });
  it("restores lists, body and attachment metadata from a fresh instance without contacting mail", async () => {
    const name = crypto.randomUUID(); const native = backend(); const first = create(native,name); await first.init();
    first.register([header(12)]); await first.fetch("bodies",12); await first.fetch("files",12); await first.flush(); first.close();
    const offline = backend(); offline.messages.query.mockRejectedValue(new Error("offline"));
    const next = create(offline,name); await next.init(); const cached = next.all()[0]; const api = cachedAPI(offline,next);
    expect(cached.id).toBeLessThan(0); expect(cached.date).toBeInstanceOf(Date);
    expect(await api.messages.getFull(cached.id)).toEqual(full);
    expect(await api.messages.getHeaders(cached.id)).toEqual(full.headers);
    expect(await api.messages.listAttachments(cached.id)).toEqual(files);
    expect(await next.attachmentIndex()).toEqual([{message:cached,files}]);
    expect(offline.messages.query).not.toHaveBeenCalled(); expect(offline.messages.getFull).not.toHaveBeenCalled();
  });
  it("keeps each saved email's shared links, and finds them in emails saved before links were kept", async () => {
    const name = crypto.randomUUID(); const native = backend();
    const linked: any = { contentType: "text/html", headers: {}, body: '<p>Cut: <a href="https://f.io/Cut1">rough cut</a></p>' };
    native.messages.getFull.mockImplementation((async (id?: number) => id === 13 ? linked : full) as any);
    const first = create(native, name); await first.init();
    first.register([header(12), header(13)]); await first.fetch("bodies", 12); await first.fetch("bodies", 13); await first.flush();
    expect((await first.linkIndex()).map((r) => [r.message.subject, r.links.map((l) => l.url)])).toEqual([["Plan", ["https://f.io/Cut1"]]]);
    // An older cache: bodies saved without links. Reading them once fills the links in.
    const db: IDBDatabase = (first as any).db;
    await new Promise<void>((resolve) => { const t = db.transaction("links", "readwrite"); t.objectStore("links").clear(); t.oncomplete = () => resolve(); });
    first.close();
    const next = create(backend(), name); await next.init();
    expect((await next.linkIndex()).map((r) => r.links[0].text)).toEqual(["rough cut"]);
    expect((await next.linkIndex())).toHaveLength(1);
  });
  it("resolves a restored email to its new ID before updates, attachment access, replies and invitation responses", async () => {
    const name=crypto.randomUUID(); const original=header(12); const first=create(backend(),name); await first.init(); first.register([original]); await first.flush(); first.close();
    const native=backend([{...original,id:999}]); const next=create(native,name); await next.init(); const id=next.all()[0].id; const api=cachedAPI(native,next);
    await api.messages.update(id,{flagged:true}); await api.messages.archive([id]); await api.messages.getAttachmentFile(id,"1.2"); await api.compose.beginReply(id,"replyToSender"); await api.messageDisplay.open({messageId:id,location:"tab"});
    expect(native.messages.update).toHaveBeenCalledWith(999,{flagged:true}); expect(native.messages.archive).toHaveBeenCalledWith([999]); expect(native.messages.getAttachmentFile).toHaveBeenCalledWith(999,"1.2"); expect(native.compose.beginReply).toHaveBeenCalledWith(999,"replyToSender"); expect(native.messageDisplay.open).toHaveBeenCalledWith({messageId:999,location:"tab"});
    expect(native.messages.query).toHaveBeenCalledTimes(1);
  });
  it("archives a saved email by its Thunderbird ID and reports failures under Ember's ID", async () => {
    const name=crypto.randomUUID(); const original=header(12); const first=create(backend(),name); await first.init(); first.register([original]); await first.flush(); first.close();
    const native:any=backend([{...original,id:999}]); native.sparkArchive={archive:vi.fn(async (ids:number[])=>({failed:ids.map((id)=>({id,error:"the mail server didn't accept the move"}))}))};
    const next=create(native,name); await next.init(); const id=next.all()[0].id; const api=cachedAPI(native,next);
    expect(await api.sparkArchive.archive([id])).toEqual({failed:[{id,error:"the mail server didn't accept the move"}]});
    expect(native.sparkArchive.archive).toHaveBeenCalledWith([999]);
    native.messages.query.mockResolvedValue({id:null,messages:[{...original,id:33},{...original,id:34}]});
    const ambiguous=create(native,crypto.randomUUID()); await ambiguous.init(); ambiguous.register([{...original,id:-5}]);
    const unsafe=await cachedAPI(native,ambiguous).sparkArchive.archive([-5]);
    expect(unsafe.failed[0].error).toMatch(/safely/);
  });
  it("refuses to mutate an ambiguous or missing original, even when another message reused its old numeric ID", async () => {
    const name=crypto.randomUUID(); const original=header(12); const first=create(backend(),name); await first.init(); first.register([original]); await first.flush(); first.close();
    const native=backend([header(12,{subject:"Different message"})]); const next=create(native,name); await next.init(); const api=cachedAPI(native,next); const id=next.all()[0].id;
    await expect(api.messages.update(id,{read:true})).rejects.toThrow("safely"); expect(native.messages.update).not.toHaveBeenCalled();
    native.messages.query.mockResolvedValue({id:null,messages:[{...original,id:33},{...original,id:34}]});
    await expect(api.messages.archive([id])).rejects.toThrow("safely"); expect(native.messages.archive).not.toHaveBeenCalled();
  });
  it("warms the full 90-day range plus older pins, deduplicates pages and survives a reopening", async () => {
    const recent=header(1); const oldPin=header(2,{date:new Date("2020-01-01"),flagged:true}); const old=header(3,{date:new Date("2020-01-01")});
    const native=backend(); native.messages.query.mockImplementation(async(options:any)=>({id:null,messages:options.flagged?[recent,oldPin]:[recent,old]}));
    const name=crypto.randomUUID(); const first=create(native,name); await first.warm();
    expect(first.status).toMatchObject({phase:"ready",total:2,done:2,failed:0,saved:2}); expect(native.messages.getFull).toHaveBeenCalledTimes(2); expect(native.messages.listAttachments).toHaveBeenCalledTimes(2);
    first.close(); const next=create(native,name); await next.init(); expect(next.all().map((m)=>m.headerMessageId).sort()).toEqual([recent.headerMessageId,oldPin.headerMessageId]);
    await next.warm(); expect(native.messages.getFull).toHaveBeenCalledTimes(2);
  });
  it("removes old unpinned mail, persists read changes, and ignores stale pages after deletion", async () => {
    const native=backend(); const name=crypto.randomUUID(); const cache=create(native,name); await cache.init(); const pin=header(1,{flagged:true,date:new Date("2020-01-01")}); const recent=header(2);
    cache.register([pin,recent]); await cache.fetch("bodies",1); cache.changed(pin,{flagged:false}); cache.changed(recent,{read:true}); cache.register([{...recent,read:false}]);
    cache.remove([recent]); cache.register([recent]); await cache.flush(); expect(cache.all()).toEqual([]); expect(await cache.body(1)).toBeUndefined();
    cache.register([recent],true); await cache.flush(); expect(cache.all()[0].read).toBe(true);
    cache.close(); const next=create(native,name); await next.init(); expect(next.all()).toHaveLength(1); expect(next.all()[0].read).toBe(true);
  });
  it("keeps cached data on an offline index failure and exposes a retryable error", async () => {
    const native=backend(); const cache=create(native); await cache.init(); cache.register([header(1)]); await cache.fetch("bodies",1);
    native.messages.query.mockRejectedValueOnce(new Error("offline")); await cache.warm();
    expect(cache.status.phase).toBe("error"); expect(cache.status.error).toBe("offline"); expect(cache.all()).toHaveLength(1); expect(await cache.body(1)).toEqual(full);
  });
  it("shares body work between the reader and background fill and reports unavailable mail", async () => {
    const native=backend(); const cache=create(native); await cache.init(); cache.register([header(1)]);
    await Promise.all([cache.fetch("bodies",1),cache.fetch("bodies",1)]); expect(native.messages.getFull).toHaveBeenCalledTimes(1);
    native.messages.query.mockResolvedValue({id:null,messages:[header(2),header(3),header(4),header(5)]}); native.messages.getFull.mockRejectedValue(new Error("offline")); await cache.warm();
    expect(cache.status.phase).toBe("error"); expect(cache.status.failed).toBe(4); expect(native.messages.getFull.mock.calls.length).toBeGreaterThanOrEqual(4); expect(native.messages.getFull.mock.calls.length).toBeLessThanOrEqual(5);
  });
  it("does not report a completed cache when disk writes fail", async () => {
    const native=backend([header(1)]); const cache=create(native); await cache.init();
    const db=(cache as any).db as IDBDatabase;
    vi.spyOn(db,"transaction").mockImplementation((...args:any[])=>{ throw new Error("Disk full"); });
    cache.register([header(1)]); await cache.flush(); expect(cache.status.phase).toBe("error"); expect(cache.status.error).toContain("Disk full");
  });
  it("prunes aged unpinned bodies when reopening but retains old pins", async () => {
    const name=crypto.randomUUID(); const native=backend(); const cache=create(native,name); await cache.init();
    cache.register([header(1,{date:new Date(Date.now()-89*86400000)}),header(2,{date:new Date("2020-01-01"),flagged:true})]); await cache.fetch("bodies",1); await cache.flush(); cache.close();
    const originalNow=Date.now; vi.spyOn(Date,"now").mockReturnValue(originalNow()+2*86400000);
    try { const next=create(native,name); await next.init(); await next.flush(); expect(next.all().map(m=>m.headerMessageId)).toEqual(["message-2@example.org"]); }
    finally { vi.restoreAllMocks(); }
  });

  it("batches a page of headers and avoids rewriting unchanged headers with new session IDs", async () => {
    const native=backend(); const cache=create(native); await cache.init(); const db=(cache as any).db as IDBDatabase;
    const transactions=vi.spyOn(db,"transaction"); const headers=Array.from({length:100},(_,index)=>header(index+1));
    cache.register(headers); await cache.flush();
    expect(transactions.mock.calls.filter(([store,mode])=>store==="headers"&&mode==="readwrite")).toHaveLength(1);
    cache.register(headers.map(message=>({...message,id:message.id+1000}))); await cache.flush();
    expect(transactions.mock.calls.filter(([store,mode])=>store==="headers"&&mode==="readwrite")).toHaveLength(1);
  });
  it("after reopening, rewrites a header only when it really changed", async () => {
    // The on-disk form is serialized lazily on first comparison, not for every header at start-up.
    const name=crypto.randomUUID(); const message=header(1); const first=create(backend(),name); await first.init(); first.register([message]); await first.flush(); first.close();
    const next=create(backend(),name); await next.init(); const transactions=vi.spyOn((next as any).db as IDBDatabase,"transaction");
    const writes=()=>transactions.mock.calls.filter(([store,mode])=>store==="headers"&&mode==="readwrite").length;
    next.register([{...message,id:500}]); await next.flush(); expect(writes()).toBe(0);
    next.register([{...message,id:500,read:true}]); await next.flush(); expect(writes()).toBe(1);
    next.close(); const third=create(backend(),name); await third.init(); expect(third.all()[0].read).toBe(true);
  });
  it("skips payload reads and native fetches for completed records after reopening", async () => {
    const name=crypto.randomUUID(); const message=header(1); const native=backend([message]); const first=create(native,name); await first.warm(); first.close();
    const next=create(native,name); await next.init(); const transactions=vi.spyOn((next as any).db as IDBDatabase,"transaction");
    await next.warm(); expect(next.status).toMatchObject({phase:"ready",done:1,total:1});
    expect(native.messages.getFull).toHaveBeenCalledTimes(1); expect(native.messages.listAttachments).toHaveBeenCalledTimes(1);
    expect(transactions.mock.calls).toHaveLength(0);
  });
  it("does not reparse attachment-free text mail, but keeps real attachments and uncertain MIME on the native path", async () => {
    const message=header(1); const native=backend([message]); native.messages.getFull.mockResolvedValue({contentType:"message/rfc822",headers:{},parts:[{contentType:"text/plain",body:"Hello"}]} as any);
    const cache=create(native); await cache.warm(); expect(native.messages.listAttachments).not.toHaveBeenCalled(); expect(await cache.files(1)).toEqual([]);
    expect(hasOnlyInlineText({contentType:"multipart/alternative",parts:[{contentType:"text/plain",body:""},{contentType:"text/html",body:"<p>Hello</p>"}]})).toBe(true);
    const uncertain: MessagePart[] = [
      {contentType:"text/plain",body:"notes",name:"notes.txt"},
      {contentType:"text/plain",body:"notes",headers:{"Content-Disposition":["attachment"]}},
      {contentType:"text/plain",body:"notes",headers:{"content-type":["text/plain; name*=UTF-8''notes.txt"]}},
      {contentType:"text/calendar",body:"BEGIN:VCALENDAR"},
      {contentType:"image/png",headers:{"content-id":["<logo>"]}},
      {contentType:"message/rfc822"},
      {contentType:"text/plain"},
      {contentType:"multipart/mixed",parts:[{contentType:"message/rfc822",parts:[{contentType:"text/plain",body:"forwarded"}]}]},
    ];
    for(const part of uncertain)expect(hasOnlyInlineText(part)).toBe(false);
  });
  it("limits background work, shares capacity across accounts and pauses new work for reading", async () => {
    const messages=Array.from({length:8},(_,i)=>header(i+1,{folder:{id:i<4?"inbox":"personal",accountId:i<4?"work":"personal",name:"Inbox",path:"/Inbox"}}));
    const native=backend(messages); let active=0; let peak=0; const perAccount=new Map<string,number>(); const peaks=new Map<string,number>(); const gates:(()=>void)[]=[]; let blocked=true;
    native.messages.getFull.mockImplementation(async(id?:number)=>{
      const account=messages.find(m=>m.id===id)!.folder!.accountId!; active++;peak=Math.max(peak,active);perAccount.set(account,(perAccount.get(account)||0)+1);peaks.set(account,Math.max(peaks.get(account)||0,perAccount.get(account)!));
      if(blocked)await new Promise<void>(resolve=>gates.push(resolve));
      active--;perAccount.set(account,perAccount.get(account)!-1);return full;
    });
    const cache=create(native); const firstHold=cache.hold(); const fill=cache.warm();
    const wait=async(predicate:()=>boolean)=>{const deadline=Date.now()+1000;while(!predicate()){if(Date.now()>deadline)throw new Error("Worker did not progress");await new Promise(r=>setTimeout(r,2));}};
    await wait(()=>cache.status.phase==="bodies");expect(native.messages.getFull).not.toHaveBeenCalled();firstHold();
    await wait(()=>gates.length===3); const hold=cache.hold();blocked=false;gates.forEach(release=>release());await wait(()=>cache.status.done===3);await new Promise(r=>setTimeout(r,5));
    expect(native.messages.getFull).toHaveBeenCalledTimes(3);hold();await fill;
    expect(peak).toBe(3);expect(peaks.size).toBe(2); expect([...peaks.values()].every(peak=>peak<=2)).toBe(true);expect(cache.status).toMatchObject({phase:"ready",done:8,failed:0});
  });
  it("lists messages with real file attachments from cached metadata, without a native attachment query", async () => {
    const native = backend([]); const cache = create(native); await cache.init();
    const date = new Date(); const withFile = header(1, { date }), inlineOnly = header(2, { date });
    cache.register([withFile, inlineOnly]);
    await cache.save("files", 1, [{ name: "plan.pdf", partName: "1.2", contentType: "application/pdf", size: 42 }]);
    await cache.save("files", 2, [{ name: "logo.png", partName: "1.2", contentType: "image/png", size: 9, contentId: "<logo>" }]);
    expect(await cache.attachmentKeys()).toEqual([messageKey(withFile)]);
    await cache.save("files", 2, [{ name: "budget.xlsx", partName: "1.3", contentType: "application/vnd.ms-excel", size: 9, contentDisposition: "attachment" }]);
    expect((await cache.attachmentKeys()).sort()).toEqual([messageKey(withFile), messageKey(inlineOnly)].sort());
    cache.remove([withFile]);
    expect(await cache.attachmentKeys()).toEqual([messageKey(inlineOnly)]);
    expect(native.messages.query).not.toHaveBeenCalled();
  });
  it("completes known headers without re-querying every folder", async () => {
    const native = backend([]); const cache = create(native); await cache.init();
    cache.register([header(7)], true);
    await cache.warm({ inventory: false });
    expect(native.messages.query).not.toHaveBeenCalled();
    expect(native.messages.getFull).toHaveBeenCalledWith(7);
    expect(cache.status).toMatchObject({ phase: "ready", done: 1 });
  });
  it("defers background inventories while the user is active and abandons them on new activity", async () => {
    const native = backend([]); const cache = create(native); await cache.init();
    native.messages.query.mockResolvedValue({ id: "list-1" as any, messages: [header(1)] });
    native.messages.continueList.mockImplementation(async () => { release = cache.hold(); return { id: "list-2", messages: [header(2)] }; });
    (native.messages as any).abortList = vi.fn();
    let release = cache.hold();
    const pass = cache.warm({ inventory: true, whenIdle: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(native.messages.query).not.toHaveBeenCalled();
    release();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000); // idle long enough
    await pass;
    expect(native.messages.query).toHaveBeenCalledOnce();
    expect((native.messages as any).abortList).toHaveBeenCalledWith("list-2");
    expect(native.messages.getFull).not.toHaveBeenCalled();
    expect(cache.lastInventoryAt).toBe(0); // incomplete: nothing pruned, retried later
    expect(cache.status.lastInventoryAt).toBeUndefined();
    release();
  });
  it("puts the newest week and pins before the remaining backlog", async () => {
    const messages=[header(1,{date:new Date(Date.now()-60*86400000)}),header(2,{date:new Date("2020-01-01"),flagged:true}),header(3,{date:new Date(Date.now()-86400000)}),header(4,{date:new Date()})];
    const native=backend(messages);const cache=create(native);await cache.warm();
    expect(native.messages.getFull.mock.calls.map(([id])=>id)).toEqual([4,3,2,1]);
    expect(cache.status.lastInventoryAt).toBe(cache.lastInventoryAt); expect(cache.lastInventoryAt).toBeGreaterThan(0);
  });

});
