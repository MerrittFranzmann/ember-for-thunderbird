#!/usr/bin/env python3
"""Exercise the built extension in the isolated fixture profile on port 2831.

Run npm run build, tools/spark.py launch, tools/spark.py reload and
tools/seed_feature_fixtures.py first.
Optional --output-dir writes JSON results and a screenshot there.
Never sends mail or launches/saves attachment files.
"""
import argparse
import json
import shutil
import tempfile
from pathlib import Path
import subprocess
import spark
import run_probe

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    bundle = ROOT / 'dist/body-test.js'
    try:
        # Use the project's existing bundler; the test module is never packaged.
        subprocess.run(['node', '--input-type=module', '-e',
            'import {rolldown} from "rolldown"; const b=await rolldown({input:"src/lib/body.ts"}); '
            'await b.write({file:"dist/body-test.js",format:"es"}); await b.close();'], cwd=ROOT, check=True)
        subprocess.run(['node', '--input-type=module', '-e',
            'import {rolldown} from "rolldown"; const b=await rolldown({input:"tools/smoke/cache-probe.ts"}); '
            'await b.write({file:"dist/cache-test.js",format:"es"}); await b.close();'], cwd=ROOT, check=True)
        client = spark.connect()
        ready = spark.run_in_app(client, "for(let n=0;n<400;n++){if(document.querySelector('[data-mailbox=\"inbox\"]')&&!document.querySelector('.mini-spin'))return true;await new Promise(r=>setTimeout(r,50));}throw new Error('Ember did not finish opening');")
        if ready is not True:
            raise RuntimeError(f'App startup: {ready}')
        results = {}
        for name in ('navigation', 'reader', 'features', 'calendar', 'search-all', 'attachment-recovery', 'attachments', 'rich', 'html', 'time-buckets', 'pins-copies', 'save-attachment', 'local-cache'):
            if name == 'save-attachment':
                # Saved files go to a throwaway folder, never the real ~/Downloads.
                downloads = Path(tempfile.mkdtemp(prefix='spark-save-'))
                client.execute("Services.prefs.setStringPref('browser.download.dir', %s); Services.prefs.setIntPref('browser.download.folderList', 2); return true;" % json.dumps(str(downloads)))
            # run_probe has no 30 s Marionette script limit (the features suite takes ~35 s).
            probe = run_probe.run(client, ROOT / f'tools/smoke/{name}.js', timeout=300)
            if name == 'save-attachment':
                client.execute("Services.prefs.clearUserPref('browser.download.dir'); Services.prefs.clearUserPref('browser.download.folderList'); return true;")
                shutil.rmtree(downloads, ignore_errors=True)
            result = probe['value'] if probe['ok'] else 'ERROR: ' + probe['error']
            if isinstance(result, str) and result.startswith('ERROR:'):
                raise RuntimeError(f'{name}: {result}')
            results[name] = result
            if name == 'features':
                native = client.execute("const t=document.getElementById('tabmail').tabInfo.find(t=>t.mode.name==='mailMessageTab'&&t.title.includes('Spark smoke calendar'));const d=t?.chromeBrowser?.contentDocument;return {accept:!!d?.getElementById('imipAcceptButton'),tentative:!!d?.getElementById('imipTentativeButton'),decline:!!d?.getElementById('imipDeclineButton')};")
                results['native-invitation-controls'] = native
                # Close it: Thunderbird restores every message tab at start-up (49 had piled up, ~2 s each launch).
                client.execute("const tm=document.getElementById('tabmail');for(const t of tm.tabInfo.filter(t=>t.mode.name==='mailMessageTab'))tm.closeTab(t);return true;")
                if not all(native.values()):
                    raise RuntimeError('Native invitation controls not found; enable the test calendar with tools/seed_feature_fixtures.py')
                spark.run_in_app(client, "return true;")
                client.execute("const tm=document.getElementById('tabmail');const t=tm.tabInfo.find(t=>(t.browser||t.chromeBrowser)?.currentURI?.spec?.includes('/app.html'));if(t)tm.switchToTab(t);return true;")
            if args.output_dir and name == 'time-buckets':
                spark.app_shot(client, str(args.output_dir / 'time-buckets.png'))
            if args.output_dir and name == 'navigation':
                args.output_dir.mkdir(parents=True, exist_ok=True)
                spark.app_shot(client, str(args.output_dir / 'sidebar-and-inbox.png'))
            if args.output_dir and name == 'reader':
                args.output_dir.mkdir(parents=True, exist_ok=True)
                spark.run_in_app(client, "document.querySelector('.sheet button[aria-label=\"Discard\"]')?.click(); await new Promise(r => setTimeout(r, 100)); [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discard')?.click(); return true;")
                spark.app_shot(client, str(args.output_dir / 'conversation.png'))
            if args.output_dir and name == 'attachments':
                # Capture the populated library, then restore its saved filtering preference.
                original = spark.run_in_app(client, "const box=document.querySelector('.approved input'); const before=box.checked; box.checked=false; box.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,100)); return before;")
                try:
                    spark.app_shot(client, str(args.output_dir / 'attachments.png'))
                finally:
                    spark.run_in_app(client, "const box=document.querySelector('.approved input'); box.checked=" + json.dumps(original) + "; box.dispatchEvent(new Event('change',{bubbles:true})); return true;")
        if args.output_dir:
            args.output_dir.mkdir(parents=True, exist_ok=True)
            (args.output_dir / 'thunderbird-smoke-results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps(results, indent=2))
    finally:
        bundle.unlink(missing_ok=True)
        (ROOT / "dist/cache-test.js").unlink(missing_ok=True)


if __name__ == '__main__':
    main()
