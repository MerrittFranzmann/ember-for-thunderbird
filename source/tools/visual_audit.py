#!/usr/bin/env python3
"""Screenshot Ember's main states in light and dark for visual review. Isolated profile only.

  visual_audit.py OUT_DIR [--only NAME,NAME] [--width 1440 --height 900]

Each state is set up by JS inside the Ember page, then the page is captured at 1x. The Ember window is
resized for the run and restored afterwards.
"""
import argparse, base64, json, os, time
import spark

PRELUDE = r"""
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 6000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await pause(40); } return true; };
const closeAll = async () => {
  for (const sel of ['.sheet button[aria-label="Discard"]', '.settings-scrim', '.context-menu']) { const el = document.querySelector(sel); if (el && sel === '.settings-scrim') el.dispatchEvent(new MouseEvent('click', { bubbles: true })); else el?.click?.(); }
  document.querySelector('button[aria-label="Close attachment preview"]')?.click();
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // dismisses menus
  document.querySelector('.pop[aria-label="Move to folder"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.querySelector('.history-panel button[aria-label^="Close"]')?.click();
  const filters = document.querySelector('.search-filter-button[aria-expanded="true"]'); if (filters) filters.click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await pause(150);
};
const sidebar = (label) => [...document.querySelectorAll('.sidebar .item')].find((b) => b.querySelector('.label')?.textContent.trim() === label);
const openSubject = async (text) => {
  const input = document.querySelector('input[aria-label^="Search mail"]');
  input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await wait(() => document.querySelector('.list-head h1')?.textContent.startsWith('Search') && !document.querySelector('.list-head .mini-spin') && [...document.querySelectorAll('.row .subject')].some((n) => n.textContent.includes(text)));
  await pause(150);
  [...document.querySelectorAll('.row')].find((r) => r.querySelector('.subject')?.textContent.includes(text))?.click();
  await wait(() => document.querySelector('.thread'));
  await pause(900);
};
const home = async () => { await closeAll(); sidebar('Inbox')?.click(); await pause(500); };
"""

STATES = {
    'inbox': "await home(); return 1;",
    'newsletter': "await home(); await openSubject('Perf newsletter 01'); return 1;",
    'thread': "await home(); await openSubject('Spark smoke quoted history'); document.querySelectorAll('.msg-head, .collapsed').forEach((h) => h.click?.()); await pause(600); return 1;",
    'invitation': "await home(); await openSubject('Spark smoke calendar invitation'); return 1;",
    'formatting': "await home(); await openSubject('Format: Outlook agenda'); return 1;",
    'attachments-mail': "await home(); await openSubject('Spark smoke attachment previews'); return 1;",
    'composer': "await home(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true })); await pause(500); return 1;",
    'reply': "await home(); await openSubject('Spark smoke quoted history'); [...document.querySelectorAll('.reply-bar button')][0]?.click(); await pause(1500); return 1;",
    'settings': "await home(); document.querySelector('.sidebar .foot .icon-btn')?.click(); await pause(500); return 1;",
    'settings-window': "await home(); document.querySelector('.sidebar .foot .icon-btn')?.click(); await pause(500); document.querySelector('section[aria-label=Window]')?.scrollIntoView({ block: 'center' }); await pause(300); return 1;",
    'settings-end': "await home(); document.querySelector('.sidebar .foot .icon-btn')?.click(); await pause(500); const p = document.querySelector('.panel'); if (p) p.scrollTop = p.scrollHeight; await pause(300); return 1;",
    'library': "await home(); sidebar('Attachments')?.click(); await wait(() => document.querySelector('.file')); await pause(500); return 1;",
    'pinned': "await home(); [...document.querySelectorAll('.category-filter')].find((b) => b.textContent.trim() === 'Pinned')?.click(); await pause(600); return 1;",
    'search': "await home(); const i = document.querySelector('input[aria-label^=\"Search mail\"]'); i.value = 'invoice'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await pause(1200); return 1;",
    'empty-search': "await home(); const i = document.querySelector('input[aria-label^=\"Search mail\"]'); i.value = 'zzqqxx nothing'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await pause(1200); return 1;",
    'context-menu': "await home(); const r = document.querySelector('.row'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 120, clientY: b.top + 30 })); await pause(300); return 1;",
    'move-picker': "await home(); document.querySelector('.row')?.click(); await pause(700); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true })); await pause(500); return 1;",
    'history-panel': "await home(); await openSubject('Spark smoke quoted history'); [...document.querySelectorAll('.history-link')].find((b) => b.textContent.includes('Show quoted text'))?.click(); await pause(900); return 1;",
    'preview': "await home(); await openSubject('Spark smoke attachment previews'); [...document.querySelectorAll('.att-main')].find((b) => b.textContent.includes('.png'))?.click(); await pause(1500); return 1;",
    'filters': "await home(); window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })); await pause(200); document.querySelector('.search-filter-button')?.click(); await pause(300); return 1;",
    'toast': "await home(); document.querySelector('.row')?.click(); await pause(600); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true })); await pause(300); return 1;",
    'newsletter-adapt': "await home(); await openSubject('Format: coloured newsletter'); return 1;",
    'gmail-styled': "await home(); await openSubject('Format: styled Gmail reply'); return 1;",
    'heavy': "await home(); await openSubject('Heavy newsletter 01'); return 1;",
    'pins-view': "await home(); sidebar('Pins')?.click(); await pause(800); return 1;",
    'sent-view': "await home(); sidebar('Sent')?.click(); await pause(900); return 1;",
    'drafts-view': "await home(); sidebar('Drafts')?.click(); await pause(900); return 1;",
    'trash-view': "await home(); sidebar('Trash')?.click(); await pause(900); return 1;",
    'edge-list': "await home(); const i = document.querySelector('input[aria-label^=\"Search mail\"]'); i.value = 'Edge'; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await pause(1200); return 1;",
    'edge-long-subject': "await home(); await openSubject('A very long subject line'); return 1;",
    'edge-rtl': "await home(); await openSubject('Edge: right-to-left'); return 1;",
    'edge-url': "await home(); await openSubject('Edge: unbroken URL'); return 1;",
    'edge-table': "await home(); await openSubject('Edge: fixed 1200px'); return 1;",
    'edge-recipients': "await home(); await openSubject('Edge: thirty recipients'); return 1;",
    'edge-attachments': "await home(); await openSubject('Edge: twelve attachments'); return 1;",
    'edge-sender': "await home(); await openSubject('Edge: long sender name'); return 1;",
    'reply-all-many': "await home(); await openSubject('Edge: thirty recipients'); [...document.querySelectorAll('.reply-bar button')][1]?.click(); await pause(1800); return 1;",
    'cat-people': "await home(); [...document.querySelectorAll('.category-filter')].find((b) => b.textContent.trim() === 'People')?.click(); await pause(900); return 1;",
    'cat-notifications': "await home(); [...document.querySelectorAll('.category-filter')].find((b) => b.textContent.trim() === 'Notifications')?.click(); await pause(900); return 1;",
    'more-folders': "await home(); const m = [...document.querySelectorAll('.sidebar .item.more')][0]; if (m?.getAttribute('aria-expanded') === 'false') m.click(); await pause(300); return 1;",
}

SET_THEME = """await home(); document.querySelector('.sidebar .foot .icon-btn')?.click(); await pause(300);
[...document.querySelectorAll('button[role=radio]')].find((b) => b.textContent.trim() === %s)?.click(); await pause(300); await closeAll(); return 1;"""

SHOT = r"""
const ex = __sparkBrowser();
const b = ex.browser; // remote page: measure the browser element
const bmp = await b.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, b.clientWidth, b.clientHeight), 1, 'white');
const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); c.width = bmp.width; c.height = bmp.height;
c.getContext('2d').drawImage(bmp, 0, 0); return c.toDataURL('image/png').split(',')[1];
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('out')
    parser.add_argument('--only')
    parser.add_argument('--width', type=int, default=1440)
    parser.add_argument('--height', type=int, default=900)
    parser.add_argument('--themes', default='light,dark')
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    m = spark.connect()
    resize = spark.FIND_APP_BROWSER + "const ex=__sparkBrowser(); const w=ex.window||window; const prev=[w.outerWidth,w.outerHeight]; if (%s) w.resizeTo(%s); return prev;"
    previous = m.execute(resize % ('true', f'{args.width},{args.height}'))
    time.sleep(1)
    names = args.only.split(',') if args.only else list(STATES)
    try:
        for theme in args.themes.split(','):
            # Ember's own theme setting (Settings → Appearance), so emails render for it too.
            spark.run_in_app(m, PRELUDE + SET_THEME % json.dumps(theme.capitalize()))
            for name in names:
                result = spark.run_in_app(m, PRELUDE + STATES[name])
                time.sleep(0.3)
                data = spark.chrome_async(m, spark.FIND_APP_BROWSER + SHOT)
                path = os.path.join(args.out, f'{name}-{theme}.png')
                open(path, 'wb').write(base64.b64decode(data))
                print(path, result if result != 1 else '')
    finally:
        spark.run_in_app(m, PRELUDE + SET_THEME % json.dumps('Auto'))
        m.execute(resize % ('true', f'{previous[0]},{previous[1]}'))


if __name__ == '__main__':
    main()
