import { describe, expect, it } from "vitest";
import { foldSearch, searchDocument, searchTerms, matchesSearchHeader, matchesSearchText } from "../src/lib/mail-search";
import type { MessageHeader } from "../src/lib/types";
const header = { id: 1, date: new Date(2026,9,26,13), author: "Adá <ada@example.org>", subject: "Board review", recipients: ["me@work.org"], ccList: [], bccList: [], read: false, flagged:false, headerMessageId:"one",size:1,tags:[],folder: {id:"inbox",accountId:"work",name:"Inbox",path:"/Inbox"} } as MessageHeader;
describe("saved-mail search", () => {
  it("normalizes accents and case, supports word prefixes and quoted phrases", () => {
    expect(foldSearch("  CAFÉ  Budget ")).toBe("cafe budget");
    expect(searchTerms("ada@example.org board-review")).toEqual(["ada","example","org","board","review"]);
    expect(matchesSearchText("Budget approval for the café board review", "CAFÉ budg")).toBe(true);
    expect(matchesSearchText("Budget approval for board later review", '"board review"')).toBe(false);
    expect(matchesSearchText("Budget approval for board review", '"board review" budg')).toBe(true);
  });
  it("indexes readable body and real filenames without attachment bodies or inline filenames", () => {
    const doc=searchDocument(header,{contentType:"message/rfc822",parts:[{contentType:"text/plain",body:"glacier quartz"},{contentType:"text/plain",name:"notes.txt",body:"secret attachment body"}]},[{name:"budget.pdf",contentType:"application/pdf",size:1,partName:"1.2"},{name:"inline-logo.png",contentId:"logo",contentType:"image/png",size:1,partName:"1.3"}]);
    expect(doc.text).toContain("glacier quartz");expect(doc.text).toContain("budget.pdf");expect(doc.text).not.toContain("secret attachment body");expect(doc.text).not.toContain("inline-logo");expect(doc.hasAttachments).toBe(true);
  });
  it("uses local inclusive date bounds, sender, unread and account filters", () => {
    expect(matchesSearchHeader(header,{sender:"ADA@EXAMPLE",after:"2026-10-26",before:"2026-10-26",unread:true,accountId:"work"})).toBe(true);
    for(const filters of [{sender:"other"},{after:"2026-10-27"},{before:"2026-10-25"},{accountId:"personal"}])expect(matchesSearchHeader(header,filters)).toBe(false);
    expect(matchesSearchHeader({...header,read:true},{unread:true})).toBe(false);
    expect(matchesSearchHeader({...header,junk:true},{})).toBe(false);
  });
});
