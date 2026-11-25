import { describe, expect, it } from "vitest";
import { downloadName } from "../src/lib/attachment-actions";

describe("downloadName", () => {
  it("keeps ordinary names", () => {
    expect(downloadName("Q3 report (final).xlsx")).toBe("Q3 report (final).xlsx");
    expect(downloadName("résumé – 2026.pdf")).toBe("résumé – 2026.pdf");
  });
  it("removes what the download manager rejects", () => {
    expect(downloadName("a/b\\c:d*e?f\"g<h>i|j.txt")).toBe("a_b_c_d_e_f_g_h_i_j.txt");
    expect(downloadName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(downloadName(".hidden")).toBe("hidden");
    expect(downloadName("line\nbreak.txt")).toBe("line_break.txt");
  });
  it("falls back when nothing is left", () => {
    expect(downloadName(undefined)).toBe("attachment");
    expect(downloadName("...")).toBe("attachment");
  });
});
