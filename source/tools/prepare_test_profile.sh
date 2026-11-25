#!/bin/zsh
# Make the running test Thunderbird (port 2831, /private/tmp/claude-503/sparkprof) ready for the live feature
# tests: folder summaries, every seeded fixture (each seed skips what's there), the test agent socket, a usual
# Ember window, and the add-on version being tested (installed to stay, not temporarily). Safe to run again.
#   tools/prepare_test_profile.sh            then: slim/feature_tests.sh OUT_DIR
# A missing or empty profile is rebuilt first with: SCALE=5 tools/setup_test_profile.sh && python3 tools/spark.py launch
cd "$(dirname "$0")" || exit 1
set -e
VERSION=$(python3 -c "import json;print(json.load(open('../public/manifest.json'))['version'])")
XPI="../thunderbird-spark-$VERSION.xpi"
[[ -f $XPI ]] || { echo "Build $XPI first: npm run package"; exit 1; }
python3 ../slim/reparse.py
python3 seed_feature_fixtures.py > /dev/null
python3 seed_long_thread.py > /dev/null
python3 seed_cache_fixtures.py --preview > /dev/null
python3 - "$PWD/$XPI" <<'EOF'
import sys, time, spark, suite
m = spark.connect()
try:
    m.execute("Services.prefs.setStringPref('extensions.spark.agentSocket', '/private/tmp/claude-503/spark-agent-testprofile.sock'); return 1;")
    # Updates: never Ember's public releases on GitHub (update tests use a local release folder).
    m.execute("Services.prefs.setStringPref('extensions.spark.updateFeed', 'off'); return 1;")
    # Links to emails: never the real Ember's port, and a click never brings the test Thunderbird to the front.
    m.execute("Services.prefs.setIntPref('extensions.spark.mailLinkPort', 47392); Services.prefs.setBoolPref('extensions.spark.mailLinkActivate', false); return 1;")
    # A different build, even of the same version (a fix rebuilt before release), is installed too.
    if suite.installed() != suite.build_id(sys.argv[1]):
        # Over the installed one, as an update does (uninstalling would clear Ember's data).
        m._cmd("Addon:Install", {"path": sys.argv[1], "temporary": False})
        time.sleep(6)
    # Ember's window at a usual size, restored (a minimized Ember keeps its lists' grouping until shown).
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { if (w.windowState === w.STATE_MINIMIZED) w.restore(); if (w.outerWidth <= 240) w.resizeTo(1100, 800); } return 1;")
finally:
    spark._end_session(m)
EOF
grep -q agentSocket /private/tmp/claude-503/sparkprof/user.js 2>/dev/null || \
  echo 'user_pref("extensions.spark.agentSocket", "/private/tmp/claude-503/spark-agent-testprofile.sock"); // never the real Ember'"'"'s socket' >> /private/tmp/claude-503/sparkprof/user.js
grep -q mailLinkPort /private/tmp/claude-503/sparkprof/user.js 2>/dev/null || \
  printf '%s\n' 'user_pref("extensions.spark.mailLinkPort", 47392); // never the real Ember'"'"'s link port' 'user_pref("extensions.spark.mailLinkActivate", false);' >> /private/tmp/claude-503/sparkprof/user.js
grep -q updateFeed /private/tmp/claude-503/sparkprof/user.js 2>/dev/null || \
  echo 'user_pref("extensions.spark.updateFeed", "off"); // never Ember'"'"'s public releases' >> /private/tmp/claude-503/sparkprof/user.js
python3 check_fixtures.py
