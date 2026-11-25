import { describe, expect, it } from "vitest";
import source from "../public/experiments/links/implementation.js?raw";

// The Experiment is a plain script Thunderbird loads; evaluate it with a stub ExtensionAPI base.
const module = { exports: {} as any };
new Function("module", "ExtensionCommon", source).call({}, module, { ExtensionAPI: class {} });
const { linkVerdict, linkTitle, LINK_CHECK_HOSTS } = module.exports;

describe("who can open a shared link (as a visitor who isn't signed in)", () => {
  it("reads Google's answers: the file, 401 for restricted, 404 for none", () => {
    expect(linkVerdict(200, "https://docs.google.com/document/d/1G26/edit?usp=sharing", "Google Docs Syllabus")).toBe("public");
    expect(linkVerdict(401, "https://docs.google.com/document/d/1abc/edit", "")).toBe("signin");
    expect(linkVerdict(200, "https://accounts.google.com/v3/signin/identifier?continue=x", "Sign in - Google Accounts")).toBe("signin");
    expect(linkVerdict(200, "https://docs.google.com/document/d/1abc/edit", "Google Docs: Sign-in")).toBe("signin");
    expect(linkVerdict(404, "https://docs.google.com/document/d/1abc/edit", "Page Not Found")).toBe("missing");
  });
  it("reads Microsoft's: its sign-in page for organization-only links, the file for anyone links", () => {
    expect(linkVerdict(200, "https://login.microsoftonline.com/common/oauth2/authorize?client_id=x", "Sign in to your account")).toBe("signin");
    expect(linkVerdict(200, "https://login.live.com/login.srf?wa=wsignin1.0", "OneDrive")).toBe("signin");
    expect(linkVerdict(200, "https://northwind.sharepoint.com/:w:/r/sites/Team/_layouts/15/Doc.aspx?sourcedoc=x", "Q3 plan.docx")).toBe("public");
    expect(linkVerdict(404, "https://northwind.sharepoint.com/:w:/s/Team/Eabc", "")).toBe("missing");
  });
  it("reads Dropbox's error page as missing, its login as sign-in, and knows nothing on other answers", () => {
    expect(linkVerdict(200, "https://www.dropbox.com/s/abc/report.pdf?dl=0", "Dropbox - Error - Simplify your life")).toBe("missing");
    expect(linkVerdict(200, "https://www.dropbox.com/login?cont=x", "Dropbox")).toBe("signin");
    expect(linkVerdict(200, "https://www.dropbox.com/scl/fi/abc/report.pdf", "report.pdf")).toBe("public");
    expect(linkVerdict(503, "https://docs.google.com/document/d/1abc/edit", "")).toBe("unknown");
    expect(linkVerdict(0, "", "")).toBe("unknown");
  });
  it("keeps the file's name from the page title", () => {
    expect(linkTitle("Q3 plan &amp; budget - Google Docs")).toBe("Q3 plan & budget");
    expect(linkTitle("2020-10-30_EF09-Intro - Google Slides")).toBe("2020-10-30_EF09-Intro");
    expect(linkTitle("report.pdf")).toBe("report.pdf");
  });
  it("visits only the file services it knows", () => {
    for (const host of ["docs.google.com", "drive.google.com", "northwind.sharepoint.com", "northwind-my.sharepoint.com", "1drv.ms", "onedrive.live.com", "www.dropbox.com"]) expect(LINK_CHECK_HOSTS.test(host)).toBe(true);
    for (const host of ["example.com", "docs.google.com.evil.test", "sharepoint.com.evil.test", "localhost"]) expect(LINK_CHECK_HOSTS.test(host)).toBe(false);
  });
});
