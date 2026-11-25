// Dark mode for email bodies, following Ember's rules:
//  - "native": the email declares dark support (color-scheme / supported-color-schemes) and
//    styles itself; it only needs the dark canvas.
//  - "paper": designed emails that manage their own colours (prefers-color-scheme rules,
//    Outlook/Word markup, a few known templates) stay on white.
//  - "adapt": everything else is recoloured. Text that lacks 4.5:1 contrast against the dark
//    canvas gets its CIELAB lightness remapped into the light range (hue kept); backgrounds
//    that would then lack contrast with their text are remapped into the dark range.

export type DarkStyle = "native" | "paper" | "adapt";
export interface RGB { r: number; g: number; b: number }

/** Classify from the original email document (before sanitizing removes its metas). */
export function darkStyleOf(doc: Document): DarkStyle {
  const metaDark = ["supported-color-schemes", "color-scheme"].some((name) => /dark/i.test(doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content") || ""));
  const css = Array.from(doc.querySelectorAll("style"), (s) => s.textContent || "").join("\n");
  const cssDark = /(?:^|[;{\s])(?:supported-)?color-scheme\s*:[^;}]*dark/i.test(css);
  if (metaDark || cssDark) return "native";
  const ownSchemes = /prefers-color-scheme/i.test(css);
  const office = !!doc.querySelector('meta[http-equiv="X-UA-Compatible" i]');
  const template = !!doc.querySelector('img[src*="ssl-images-amazon"], #aapl-desktop, #aapl-mobile');
  return ownSchemes || office || template ? "paper" : "adapt";
}

export function parseColor(value: string): (RGB & { a: number }) | null {
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a: alpha };
}

function channel(v: number) { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
function luminance(c: RGB) { return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b); }
export function contrast(a: RGB, b: RGB) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// sRGB <-> CIELAB (D65).
const WHITE = { x: 95.047, y: 100, z: 108.883 };
function toLab(c: RGB) {
  const [r, g, b] = [channel(c.r), channel(c.g), channel(c.b)];
  const xyz = { x: (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) * 100, y: (0.2126729 * r + 0.7151522 * g + 0.072175 * b) * 100, z: (0.0193339 * r + 0.119192 * g + 0.9503041 * b) * 100 };
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(xyz.x / WHITE.x), f(xyz.y / WHITE.y), f(xyz.z / WHITE.z)];
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
function fromLab(lab: { l: number; a: number; b: number }): RGB {
  const fy = (lab.l + 16) / 116, fx = lab.a / 500 + fy, fz = fy - lab.b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const [x, y, z] = [inv(fx) * WHITE.x / 100, inv(fy) * WHITE.y / 100, inv(fz) * WHITE.z / 100];
  const gamma = (v: number) => 255 * Math.min(1, Math.max(0, v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v));
  return { r: Math.round(gamma(3.2404542 * x - 1.5371385 * y - 0.4985314 * z)), g: Math.round(gamma(-0.969266 * x + 1.8760108 * y + 0.041556 * z)), b: Math.round(gamma(0.0556434 * x - 0.2040259 * y + 1.0572252 * z)) };
}

/**
 * Remap a colour's lightness for the dark canvas, keeping its hue. `against` decides the
 * direction: next to a light colour it moves into the dark band [canvas, 50], next to a dark
 * colour into the light band [50 + canvas, 100]. Lightness is first scaled into
 * [canvas, 100] and folded around the band boundary, so ordering is preserved.
 */
export function remap(color: RGB, against: RGB, canvas: RGB): RGB {
  const floor = toLab(canvas).l, lab = toLab(color);
  const lightFloor = 50 + floor, middle = (lightFloor + 50) / 2;
  let l = lab.l * ((100 - floor) / 100) + floor;
  if (toLab(against).l > middle) {
    l = Math.min(l, 2 * middle - l);
    l = ((l - floor) * (50 - floor)) / (middle - floor) + floor;
  } else {
    l = Math.max(l, 2 * middle - l);
    l = 100 - ((100 - l) * (100 - lightFloor)) / (100 - middle);
  }
  return fromLab({ l, a: lab.a, b: lab.b });
}

const css = (c: RGB) => `rgb(${c.r},${c.g},${c.b})`;
const SKIP = new Set(["IMG", "PICTURE", "VIDEO", "SVG", "CANVAS", "IFRAME", "OBJECT", "STYLE", "SCRIPT", "HEAD", "META", "LINK", "TITLE"]);

/** Recolour a rendered email document for a dark canvas ("adapt"). Returns the elements changed. */
export function adaptToDark(doc: Document, canvas: RGB): number {
  const view = doc.defaultView;
  if (!view || !doc.body) return 0;
  const cache = new Map<string, RGB & { a: number }>();
  const read = (value: string) => { let c = cache.get(value); if (!c) { c = parseColor(value) || { r: 0, g: 0, b: 0, a: 0 }; cache.set(value, c); } return c; };
  const rules: string[] = [];
  const adaptedBg = new Map<Element, RGB>();
  let changed = 0, n = 0;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode as Element | null; el; el = walker.nextNode() as Element | null) {
    if (SKIP.has(el.tagName.toUpperCase())) continue;
    const style = view.getComputedStyle(el);
    // The colour this element is painted on: its own (adapted) background or the nearest ancestor's.
    let behind = canvas;
    for (let p = el.parentElement; p; p = p.parentElement) { const bg = adaptedBg.get(p); if (bg) { behind = bg; break; } }
    let text: RGB = read(style.color);
    const textOk = contrast(text, behind) >= 4.5 && contrast(text, canvas) >= 4.5;
    if (!textOk) text = remap(text, canvas, canvas);
    const ownBg = read(style.backgroundColor);
    let bg: RGB | undefined;
    if (ownBg.a > 0) {
      bg = contrast(ownBg, text) >= 4.5 && contrast(ownBg, canvas) < 4.5 ? ownBg : remap(ownBg, text, canvas);
      adaptedBg.set(el, bg);
    }
    const declarations = (textOk ? "" : `color:${css(text)}!important;`) + (bg && bg !== ownBg ? `background-color:${css(bg)}!important;` : "");
    if (declarations) {
      const id = `${n++}`;
      el.setAttribute("data-spark-dark", id);
      rules.push(`[data-spark-dark="${id}"]{${declarations}}`);
      changed++;
    }
  }
  const sheet = doc.createElement("style");
  sheet.setAttribute("data-spark-dark-sheet", "");
  sheet.textContent = `html{background:${css(canvas)}!important;}` + rules.join("");
  (doc.head || doc.documentElement).append(sheet);
  return changed;
}

/** Canvas and base colours for "native" dark emails; inserted first so the email's own rules win. */
export function nativeDarkCss(canvas: RGB): string {
  return `html{background:${css(canvas)};color:#dee3eb;}a{color:#439fff;}`;
}
