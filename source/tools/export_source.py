#!/usr/bin/env python3
"""Ember's public source: the project's files minus the maintainer's private ones, checked before anything leaves.

The public repository (REPO in publish_update.py) keeps the install page at its root and the source in source/,
with LICENSE at both. Its history starts fresh: the project's own git history (with its working notes) stays local.

Checks, and nothing is written or pushed if one fails:
  - no file that looks like a private key, token or API key;
  - no absolute home-folder paths;
  - none of the words in PRIVATE_WORDS (one regular expression per line, case-insensitive). That list lives
    outside the project, beside the signing key, so it's never published itself; without it nothing is exported.

  export_source.py --out DIR      write the public source to DIR (a new or empty folder)
  export_source.py --push         update source/ (and LICENSE) in the public repository, one commit
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "MerrittFranzmann/ember-for-thunderbird"
PRIVATE_WORDS = os.path.expanduser("~/Library/Application Support/Ember Release/private-words.txt")

# The maintainer's own material: working notes, experiments, design notes and the install page (already the
# public repo's root).
EXCLUDE_PREFIXES = ("CLAUDE_HANDOFF.md", "slim/", "docs/", "release/", ".claude/")
EXCLUDE_SUFFIXES = (".xpi", ".pyc", ".DS_Store")

SECRETS = [
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"\bghp_[A-Za-z0-9]{30,}", r"\bgithub_pat_[A-Za-z0-9_]{20,}", r"\bgho_[A-Za-z0-9]{30,}",
    r"\bsk-[A-Za-z0-9_-]{20,}", r"\bAKIA[0-9A-Z]{16}\b", r"\bAIza[0-9A-Za-z_-]{30,}", r"\bxox[abp]-[A-Za-z0-9-]{10,}",
    r"/Users/[A-Za-z0-9._-]+/", r"/home/[A-Za-z0-9._-]+/",
]


def project_files():
    out = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=PROJECT,
                         capture_output=True, text=True, check=True).stdout
    files = []
    for name in sorted(set(filter(None, out.split("\0")))):
        if name.startswith(EXCLUDE_PREFIXES) or name.endswith(EXCLUDE_SUFFIXES) or "/__pycache__/" in f"/{name}":
            continue
        if os.path.isfile(os.path.join(PROJECT, name)):
            files.append(name)
    return files


def patterns():
    if not os.path.exists(PRIVATE_WORDS):
        raise SystemExit(f"No private word list at {PRIVATE_WORDS}: not exported (it's what keeps personal details out).")
    words = [line.strip() for line in open(PRIVATE_WORDS) if line.strip() and not line.startswith("#")]
    return [(re.compile(p), "secret or home path") for p in SECRETS] + [(re.compile(w, re.I), "private word") for w in words]


def check(files):
    rules = patterns()
    problems = []
    for name in files:
        data = open(os.path.join(PROJECT, name), "rb").read()
        if b"\0" in data[:8192]:
            continue  # images and other binaries
        text = data.decode("utf-8", "replace")
        for number, line in enumerate(text.splitlines(), 1):
            for rule, kind in rules:
                if rule.search(line):
                    # The finding is named by file, line and kind only: the matched text may be the private thing.
                    problems.append(f"{name}:{number}: {kind}")
    return problems


def export(out):
    files = project_files()
    problems = check(files)
    if problems:
        raise SystemExit("Not exported; private details found:\n  " + "\n  ".join(problems[:50]))
    if os.path.exists(out) and os.listdir(out):
        raise SystemExit(f"{out} isn't empty.")
    for name in files:
        target = os.path.join(out, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(PROJECT, name), target)
    return files


def run(*cmd, cwd=None):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f"{' '.join(cmd[:3])} failed: {(result.stderr or result.stdout).strip()}")
    return result.stdout


def push():
    version = json.load(open(os.path.join(PROJECT, "public", "manifest.json")))["version"]
    with tempfile.TemporaryDirectory() as tmp:
        staged = os.path.join(tmp, "staged")
        files = export(staged)
        clone = os.path.join(tmp, "repo")
        # Over HTTPS with gh's own sign-in (gh may be set to SSH, which needs a key this Mac may not have).
        auth = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
        run("git", *auth, "clone", "-q", "--depth", "1", f"https://github.com/{REPO}.git", clone)
        source = os.path.join(clone, "source")
        shutil.rmtree(source, ignore_errors=True)
        shutil.copytree(staged, source)
        shutil.copy2(os.path.join(PROJECT, "LICENSE"), os.path.join(clone, "LICENSE"))
        run("git", "add", "-A", "source", "LICENSE", cwd=clone)
        if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=clone).returncode == 0:
            print(f"The public source already matches Ember {version}.")
            return
        run("git", "-c", "user.name=MerrittFranzmann", "-c", "user.email=65863741+MerrittFranzmann@users.noreply.github.com",
            "commit", "-q", "-m", f"Source for Ember {version}", cwd=clone)
        run("git", *auth, "push", "-q", "origin", "HEAD", cwd=clone)
    print(f"Published the source for Ember {version} ({len(files)} files): https://github.com/{REPO}/tree/main/source")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    parser.add_argument("--push", action="store_true")
    args = parser.parse_args()
    if args.push:
        push()
    elif args.out:
        files = export(args.out)
        print(f"Exported {len(files)} files to {args.out}")
    else:
        parser.error("--out DIR or --push")


if __name__ == "__main__":
    sys.exit(main())
