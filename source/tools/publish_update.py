#!/usr/bin/env python3
"""Publish an Ember release.

Public release (the default): every installed Ember picks it up within an hour.
  1. Signs it: latest.json carries the XPI's SHA-256 and an ECDSA P-256 signature made with the publisher's key
     (KEY, outside the project and Dropbox). The sparkUpdate Experiment installs only what that key signed.
  2. Creates the GitHub release v<version> in REPO (public) with ember-<version>.xpi and latest.json, the public
     notes as its text. The repo's source/ folder is brought up to date too (tools/export_source.py: the project
     minus private files, checked for personal details first). The repo's README (release/README.md: the install page) and PRIVACY.md
     are kept current. Installed copies read releases/latest/download/latest.json.
  3. Also writes the old-style feed to the local folder Spark 0.1.x read (LEGACY), so the publisher's own copy
     from before Ember moves over; later versions read GitHub.
  4. Commits the project and tags it v<version> (one commit per release, local only).

It needs a build that passed the live tests (tools/suite.py keeps results per build), or --untested REASON
(the targeted tests that ran) — the user prefers targeted tests for small changes.

Test feeds: --folder DIR writes only an old-style local feed there (no signing, GitHub or commit).

Usage:
  publish_update.py [XPI] --notes changes-and-testing.md --public-notes whats-new.md [--untested REASON]
  publish_update.py [XPI] --folder DIR [--notes NOTES]
XPI defaults to thunderbird-spark-<manifest version>.xpi in the project root.
"""
import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import suite
import export_source

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADDON_ID = "thunderbird-spark@merrittfranzmann"
REPO = "MerrittFranzmann/ember-for-thunderbird"
RELEASES = f"https://github.com/{REPO}/releases/"
KEY = os.path.expanduser("~/Library/Application Support/Ember Release/signing-key.pem")
LEGACY = os.path.expanduser("~/Library/Application Support/Spark for Thunderbird/Updates")
README = os.path.join(PROJECT, "release", "README.md")


def run(*cmd, **kw):
    result = subprocess.run(cmd, capture_output=True, text=kw.pop("text", True), **kw)
    if result.returncode:
        raise SystemExit(f"{' '.join(cmd[:3])} failed: {(result.stderr or result.stdout or '').strip()}")
    return result.stdout


def signed_text(version, sha256):
    return f"ember-update\n{version}\n{sha256}"


def der_to_raw(der):
    """An ASN.1 ECDSA signature (openssl) as the raw r‖s WebCrypto checks."""
    assert der[0] == 0x30
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    parts = []
    for _ in range(2):
        assert der[i] == 0x02
        length = der[i + 1]
        value = der[i + 2:i + 2 + length].lstrip(b"\0")
        parts.append(value.rjust(32, b"\0"))
        i += 2 + length
    return parts[0] + parts[1]


def sign(version, sha256):
    if not os.path.exists(KEY):
        raise SystemExit(f"No signing key at {KEY}: releases can't be signed (installed copies would refuse them).")
    with tempfile.TemporaryDirectory() as tmp:
        message = os.path.join(tmp, "message")
        open(message, "w").write(signed_text(version, sha256))
        der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", KEY, message], capture_output=True, check=True).stdout
        # Check it with the public key the extension carries before anything is published.
        public = os.path.join(tmp, "public.der")
        open(public, "wb").write(base64.b64decode(extension_key()))
        signature = os.path.join(tmp, "signature")
        open(signature, "wb").write(der)
        check = subprocess.run(["openssl", "dgst", "-sha256", "-verify", public, "-keyform", "DER", "-signature", signature, message], capture_output=True, text=True)
        if check.returncode:
            raise SystemExit("The signing key doesn't match the public key in the update Experiment: not published.")
    return base64.b64encode(der_to_raw(der)).decode()


def extension_key():
    source = open(os.path.join(PROJECT, "public", "experiments", "update", "implementation.js")).read()
    marker = 'const EMBER_PUBLIC_KEY = "'
    return source[source.index(marker) + len(marker):].split('"', 1)[0]


def local_feed(folder, xpi, version, notes):
    """The old-style feed: the XPI beside a latest.json, written last (atomically)."""
    os.makedirs(folder, exist_ok=True)
    xpi_name = f"thunderbird-spark-{version}.xpi"
    notes_name = f"whats-new-{version}.md" if notes else None
    shutil.copyfile(xpi, os.path.join(folder, xpi_name))
    if notes:
        shutil.copyfile(notes, os.path.join(folder, notes_name))
    digest = hashlib.sha256(open(os.path.join(folder, xpi_name), "rb").read()).hexdigest()
    feed = {"version": version, "xpi": xpi_name, "sha256": digest}
    if notes_name:
        feed["notes"] = notes_name
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".latest-", suffix=".json")
    with os.fdopen(fd, "w") as out:
        json.dump(feed, out, indent=2)
    os.chmod(tmp, 0o644)
    os.replace(tmp, os.path.join(folder, "latest.json"))
    for name in os.listdir(folder):
        if (name.startswith("thunderbird-spark-") and name.endswith(".xpi") and name != xpi_name) or \
           (name.startswith("whats-new-") and name.endswith(".md") and name != notes_name):
            os.remove(os.path.join(folder, name))


def ensure_repo():
    """The public builds-only repo, with the install page as its README."""
    if subprocess.run(["gh", "repo", "view", REPO], capture_output=True).returncode:
        run("gh", "repo", "create", REPO, "--public", "--description",
            "Ember: a fast, focused mail app inside Thunderbird for Mac. Installable builds and automatic updates.")
    base = os.path.dirname(README)
    shots = sorted(f"screenshots/{f}" for f in os.listdir(os.path.join(base, "screenshots")) if f.endswith(".png")) if os.path.isdir(os.path.join(base, "screenshots")) else []
    # The tour video (an animated WebP that plays on the page, and the MP4 it links to).
    shots += sorted(f"media/{f}" for f in os.listdir(os.path.join(base, "media")) if f.endswith((".webp", ".mp4"))) if os.path.isdir(os.path.join(base, "media")) else []
    # Pictures first, so the page never points at one that isn't there yet.
    for name in [*shots, "ember.svg", "PRIVACY.md", "README.md"]:
        put_file(name, open(os.path.join(base, name), "rb").read())


def put_file(name, data):
    """A file of the public repo, updated only when it changed."""
    # A file that's there must be updated with its current sha; a failed lookup is asked again before assuming it's new.
    for attempt in range(3):
        current = subprocess.run(["gh", "api", f"repos/{REPO}/contents/{name}"], capture_output=True, text=True)
        if current.returncode == 0 or "Not Found" in (current.stdout + current.stderr):
            break
    found = json.loads(current.stdout) if current.returncode == 0 else {}
    if found.get("sha") and base64.b64decode(found.get("content", "")) == data:
        return
    body = {"message": f"Update {name}", "content": base64.b64encode(data).decode()}
    if found.get("sha"):
        body["sha"] = found["sha"]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as out:
        json.dump(body, out)
    try:
        try:
            run("gh", "api", "-X", "PUT", f"repos/{REPO}/contents/{name}", "--input", out.name)
        except SystemExit as error:
            raise SystemExit(f"Couldn't update {name} on GitHub: {error}")
    finally:
        os.remove(out.name)


def page_only():
    """Update just the install page (README, icon, screenshots) without a release."""
    ensure_repo()
    print(f"Updated the install page: https://github.com/{REPO}")


def github_release(xpi, version, public_notes):
    digest = hashlib.sha256(open(xpi, "rb").read()).hexdigest()
    feed = {"version": version, "url": f"{RELEASES}download/v{version}/ember-{version}.xpi", "sha256": digest,
            "signature": sign(version, digest), "notes": f"{RELEASES}tag/v{version}"}
    ensure_repo()
    with tempfile.TemporaryDirectory() as tmp:
        asset = os.path.join(tmp, f"ember-{version}.xpi")
        shutil.copyfile(xpi, asset)
        latest = os.path.join(tmp, "latest.json")
        json.dump(feed, open(latest, "w"), indent=2)
        run("gh", "release", "create", f"v{version}", asset, latest, "--repo", REPO, "--title", f"Ember {version}",
            "--notes-file", public_notes, "--latest")
    # What every installed Ember will read now.
    served = subprocess.run(["curl", "-fsSL", f"{RELEASES}latest/download/latest.json"], capture_output=True, text=True)
    if served.returncode or json.loads(served.stdout).get("version") != version:
        print(f"Warning: GitHub doesn't serve {version} as the latest release yet: {served.stdout[:200] or served.stderr[:200]}")
    return feed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("xpi", nargs="?")
    parser.add_argument("--notes", help="the full notes (changes and testing), kept in the commit and the old local feed")
    parser.add_argument("--public-notes", help="the public release notes (Markdown) shown on GitHub and by What's new")
    parser.add_argument("--folder", help="write only an old-style local feed here (tests)")
    parser.add_argument("--page-only", action="store_true", help="update only the repo's install page (README, icon, screenshots)")
    parser.add_argument("--untested", metavar="REASON", help="publish a build that hasn't passed the full live suite (say which tests ran)")
    args = parser.parse_args()
    if args.page_only:
        return page_only()

    version = json.load(open(os.path.join(PROJECT, "public", "manifest.json")))["version"]
    xpi = args.xpi or os.path.join(PROJECT, f"thunderbird-spark-{version}.xpi")
    with zipfile.ZipFile(xpi) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        if "mcp/ember-mcp.mjs" not in archive.namelist():
            raise SystemExit(f"{xpi} lacks mcp/ember-mcp.mjs (run npm run package)")
    if manifest["browser_specific_settings"]["gecko"]["id"] != ADDON_ID:
        raise SystemExit(f"{xpi} isn't Ember")
    version = manifest["version"]

    if args.folder:
        local_feed(args.folder, xpi, version, args.notes)
        print(f"Wrote a test feed for Ember {version} to {args.folder}")
        return

    if not args.public_notes:
        raise SystemExit("A public release needs --public-notes (what users see on GitHub and in What's new).")
    if not args.untested:
        need = suite.missing(suite.build_id(xpi))
        if need:
            raise SystemExit(f"Not published: this build of Ember {version} hasn't passed the live suite ("
                             + ", ".join(f"{t}: {why}" for t, why in need)
                             + "). Run the tests for what changed, then publish with --untested \"targeted: …\".")
    tested = f"Tested: {args.untested}" if args.untested else suite.summary(suite.build_id(xpi))

    github_release(xpi, version, args.public_notes)
    print(f"Published Ember {version}: {RELEASES}tag/v{version}")
    if os.path.isdir(LEGACY):
        local_feed(LEGACY, xpi, version, args.public_notes)
    commit_release(version, args.notes, tested)
    try:
        export_source.push()
    except SystemExit as error:
        print(f"Published, but the public source wasn't updated: {error}")


def commit_release(version, notes, tested):
    """Commit the project as released and tag it (git history is the record of what each version contained)."""
    def git(*args):
        return subprocess.run(["git", *args], cwd=PROJECT, capture_output=True, text=True)
    if git("rev-parse", "--git-dir").returncode:
        return
    title = f"Ember {version}"
    if notes:
        first = open(notes).readline().strip().lstrip("#").strip()
        if first.startswith(title):
            title = first
    git("add", "-A")
    if git("diff", "--cached", "--quiet").returncode:
        result = git("commit", "-q", "-m", f"{title}\n\n{tested}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")
        if result.returncode:
            print(f"Published, but the commit failed: {result.stderr.strip()}")
            return
    tag = git("tag", f"v{version}")
    print(f"Committed {title}" + ("" if tag.returncode == 0 else f" (tag v{version} not set: {tag.stderr.strip()})"))


if __name__ == "__main__":
    main()
