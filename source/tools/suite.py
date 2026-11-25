#!/usr/bin/env python3
"""Which Ember builds passed the live feature suite (slim/feature_tests.sh), so publish_update.py can refuse an
untested one. A build is known by its contents (build_id: the files inside the XPI, not the zip's bytes, which
change with every `npm run package`), so a rebuild of the same code keeps its results and any code change needs
a new run. Results are kept per build and per test: a test re-run on its own (after a flaky failure) counts.

  suite.py tests                     the full suite's tests, one per line
  suite.py installed                 build_id of the Ember installed in the test profile (or nothing)
  suite.py record TEST PASS|FAIL     note a result for the installed build
  suite.py status [XPI]              what the build still needs (exit 1 until every test passed)
"""
import hashlib, json, os, sys, time, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "slim", "suite-results.json")
PROFILE = os.environ.get("SPARK_PROFILE", "/private/tmp/claude-503/sparkprof")
ADDON_ID = "thunderbird-spark@merrittfranzmann"
TESTS = ["settings_window", "focus", "trips", "links_senders", "attachment_check", "send_review", "outbox", "send_flow",
         "ai_sort", "agent_mcp", "exchange_calendar", "exchange_response", "rsvp_flow", "meeting_brief", "reminders",
         "agenda_days", "followup_click", "new_features", "inboxes", "lock", "virustotal", "archive", "sidebar_width", "mailbox_menu", "right_click", "spam", "mail_links", "agent_activity", "calendar_page", "calendar_edit", "agent_calendar", "shared_calendars", "google_calendar", "silent_arrival", "junk_guess", "fresh_install", "update_flow"]


def build_id(xpi):
    digest = hashlib.sha256()
    with zipfile.ZipFile(xpi) as archive:
        for name in sorted(n for n in archive.namelist() if not n.endswith("/")):
            digest.update(name.encode() + b"\0" + hashlib.sha256(archive.read(name)).digest())
    return digest.hexdigest()


def version_of(xpi):
    with zipfile.ZipFile(xpi) as archive:
        return json.loads(archive.read("manifest.json"))["version"]


def installed():
    xpi = os.path.join(PROFILE, "extensions", ADDON_ID + ".xpi")
    return build_id(xpi) if os.path.exists(xpi) else None


def load():
    try:
        return json.load(open(RESULTS))
    except (OSError, ValueError):
        return {}


def record(test, verdict, build=None):
    build = build or installed()
    if not build:
        raise SystemExit("Ember isn't installed in the test profile")
    results = load()
    entry = results.setdefault(build, {"version": version_of(os.path.join(PROFILE, "extensions", ADDON_ID + ".xpi")), "tests": {}})
    test_entry = entry["tests"].setdefault(test, {"passed": 0, "failed": 0})
    test_entry["passed" if verdict == "PASS" else "failed"] += 1
    test_entry["last"] = verdict
    test_entry["at"] = time.strftime("%Y-%m-%d %H:%M")
    tmp = RESULTS + ".tmp"
    with open(tmp, "w") as out:
        json.dump(results, out, indent=1)
    os.replace(tmp, RESULTS)


def missing(build):
    """Tests the build hasn't passed yet: [(test, why)]."""
    tests = load().get(build, {}).get("tests", {})
    return [(t, "failed" if t in tests else "not run") for t in TESTS if tests.get(t, {}).get("last") != "PASS"]


def summary(build):
    tests = load().get(build, {}).get("tests", {})
    flaky = [f"{t} ({e['failed']} failed run{'s' if e['failed'] > 1 else ''})" for t, e in tests.items() if t in TESTS and e["failed"] and e["last"] == "PASS"]
    return f"all {len(TESTS)} live tests passed" + (f"; passed on a re-run: {', '.join(flaky)}" if flaky else "")


def main(argv):
    command = argv[0] if argv else "status"
    if command == "tests":
        print("\n".join(TESTS))
    elif command == "installed":
        print(installed() or "")
    elif command == "record":
        record(argv[1], argv[2])
    elif command == "status":
        xpi = argv[1] if len(argv) > 1 else os.path.join(ROOT, "thunderbird-spark-%s.xpi" % json.load(open(os.path.join(ROOT, "public", "manifest.json")))["version"])
        build = build_id(xpi)
        need = missing(build)
        if need:
            print(f"{os.path.basename(xpi)} hasn't passed the live suite: " + ", ".join(f"{t} ({why})" for t, why in need))
            return 1
        print(f"{os.path.basename(xpi)}: {summary(build)}")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
