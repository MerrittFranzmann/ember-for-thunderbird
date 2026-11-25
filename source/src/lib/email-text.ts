// Standardised email text, following Ember's body parser: ordinary text (paragraphs, divs,
// spans, lists, signatures) loses the sender's font, size, line height and neutral colours, so
// it renders in the reader's typography; complex elements (tables, coloured or image-backed
// blocks) are kept exactly as designed. Bold, italics, links, lists, heading sizes and
// intentional (chromatic) colours survive.

const TEXT_TAGS = new Set(["P", "DIV", "SPAN", "FONT", "A", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "LI", "UL", "OL", "DL", "DT", "DD", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "CENTER", "ADDRESS", "ARTICLE", "SECTION", "HEADER", "FOOTER", "MAIN", "SMALL", "BIG", "CITE", "Q", "INS", "DEL", "ABBR", "LABEL"]);

/** Applied after the email's own styles; marked text inherits the reader typography. */
export const STANDARD_TEXT_CSS =
  "[data-spark-text]{font-family:inherit!important;line-height:inherit!important;}" +
  "[data-spark-text]:not(h1,h2,h3,h4,h5,h6,small,sub,sup){font-size:inherit!important;}" +
  "[data-spark-text]:not(a):not([data-spark-keep-color]){color:inherit!important;}" +
  "body[data-spark-text-body]{font-family:system-ui,-apple-system,BlinkMacSystemFont,\"Helvetica Neue\",Helvetica,Arial,sans-serif!important;font-size:14px!important;line-height:1.57!important;}";

const NEUTRAL_NAMES = new Set(["black", "white", "gray", "grey", "silver", "dimgray", "dimgrey", "darkgray", "darkgrey", "lightgray", "lightgrey", "gainsboro", "whitesmoke", "windowtext", "inherit", "initial", "currentcolor", "automatic"]);

/** True for colours a sender chose deliberately (red, brand blue…), false for black/grey text. */
export function isChromatic(value: string | null | undefined): boolean {
  const v = (value || "").trim().toLowerCase().replace(/\s*!important$/, "");
  if (!v) return false;
  let rgb: number[] | null = null;
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const fn = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (fn) rgb = [+fn[1], +fn[2], +fn[3]];
    else return !NEUTRAL_NAMES.has(v);
  }
  return Math.max(...rgb) - Math.min(...rgb) >= 40;
}

function isDesigned(el: Element): boolean {
  if (el.tagName === "TABLE") return true;
  const style = (el.getAttribute("style") || "").toLowerCase();
  if (/background(-image)?\s*:[^;]*url\(/.test(style) || el.hasAttribute("background")) return true;
  const bg = el.getAttribute("bgcolor") || style.match(/background(?:-color)?\s*:\s*([^;]+)/)?.[1];
  return !!bg && !/^\s*(transparent|none|#fff(fff)?|white|rgba?\(\s*255[,\s]+255[,\s]+255[^)]*\)|inherit|initial)\s*$/.test(bg);
}

/** Mark ordinary text for standard typography. Returns how many elements were marked. */
export function standardizeText(doc: Document): number {
  const body = doc.body;
  if (!body) return 0;
  const designed = new Map<Element, boolean>();
  const insideDesign = (el: Element): boolean => {
    let cached = designed.get(el);
    if (cached === undefined) {
      cached = isDesigned(el) || (!!el.parentElement && el.parentElement !== body && insideDesign(el.parentElement));
      designed.set(el, cached);
    }
    return cached;
  };
  let marked = 0;
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (!TEXT_TAGS.has(el.tagName) || insideDesign(el)) continue;
    el.setAttribute("data-spark-text", "");
    const color = (el.getAttribute("style") || "").match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1] || el.getAttribute("color");
    if (isChromatic(color)) el.setAttribute("data-spark-keep-color", "");
    marked++;
  }
  // Conversational mail also drops the body-level font; designed mail (text mostly in tables) keeps it.
  const total = (body.textContent || "").replace(/\s+/g, "").length;
  const inTables = Array.from(body.querySelectorAll("table")).filter((t) => !t.parentElement?.closest("table")).reduce((n, t) => n + (t.textContent || "").replace(/\s+/g, "").length, 0);
  if (!total || inTables / total < 0.5) body.setAttribute("data-spark-text-body", "");
  return marked;
}
