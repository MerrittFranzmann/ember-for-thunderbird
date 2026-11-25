import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/api", () => ({ api: {} }));
import { sharedLinkKind, sharedLinks } from "../src/lib/shared-links";

describe("shared-file links in an email", () => {
  it("recognises Google Drive, SharePoint/OneDrive and Dropbox files, nothing else", () => {
    expect(sharedLinkKind("https://docs.google.com/spreadsheets/d/1abcDEF/edit#gid=0")).toEqual({ service: "Google Drive", kind: "Google Sheet" });
    expect(sharedLinkKind("https://drive.google.com/drive/folders/1abc")).toEqual({ service: "Google Drive", kind: "Drive folder" });
    expect(sharedLinkKind("https://northwind.sharepoint.com/:x:/s/Finance/EabcXYZ?e=1")).toEqual({ service: "SharePoint", tenant: "northwind", kind: "Excel file" });
    expect(sharedLinkKind("https://northwind-my.sharepoint.com/:b:/p/alex/EabcXYZ")).toEqual({ service: "SharePoint", tenant: "northwind", kind: "PDF" });
    expect(sharedLinkKind("https://1drv.ms/w/s!AbCdEf")).toEqual({ service: "OneDrive", kind: "OneDrive file" });
    expect(sharedLinkKind("https://www.dropbox.com/scl/fi/abc/report.pdf?rlkey=x&dl=0")).toEqual({ service: "Dropbox", kind: "Dropbox file" });
    for (const url of ["https://docs.google.com/", "https://google.com/docs", "https://northwind.sharepoint.com/", "http://docs.google.com/document/d/1abc", "https://www.dropbox.com/home", "https://example.com/doc"]) expect(sharedLinkKind(url)).toBeNull();
  });
  it("finds linked and pasted ones once, named by their link text when it says something", () => {
    const html = `<div>Here's <a href="https://docs.google.com/document/d/1abc/edit?usp=sharing">the Q3 plan</a> and
      <a href="https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fnorthwind.sharepoint.com%2F%3Aw%3A%2Fs%2FTeam%2FEabc&amp;data=x">https://northwind.sharepoint.com/:w:/s/Team/Eabc</a>.
      Also https://www.dropbox.com/s/xyz/budget.xlsx?dl=0, and again <a href="https://docs.google.com/document/d/1abc/edit?usp=sharing">here</a>.
      <a href="https://example.com/x">not a file</a></div>`;
    expect(sharedLinks(html)).toEqual([
      { url: "https://docs.google.com/document/d/1abc/edit?usp=sharing", label: "“the Q3 plan”", service: "Google Drive" },
      { url: "https://northwind.sharepoint.com/:w:/s/Team/Eabc", label: "a Word file", service: "SharePoint", tenant: "northwind" },
      { url: "https://www.dropbox.com/s/xyz/budget.xlsx?dl=0", label: "a Dropbox file", service: "Dropbox" },
    ]);
    expect(sharedLinks("<p>No links here</p>")).toEqual([]);
  });
});
