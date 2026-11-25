#!/usr/bin/env bash
# Cold start of the isolated test Thunderbird (port 2831) WITHOUT a Marionette session (a session focuses
# Thunderbird's main window, which shows it), then list the windows macOS has on screen.
#   tools/coldstart_os.sh [seconds-to-wait]   (Ember must already be installed permanently)
set -euo pipefail
PROFILE=/private/tmp/claude-503/sparkprof
WAIT="${1:-12}"
cd "$(dirname "$0")"
python3 -c "import spark; spark.connect().execute('Services.startup.quit(Ci.nsIAppStartup.eForceQuit); return 1')" >/dev/null 2>&1 || true
for _ in $(seq 60); do pgrep -f "MacOS/thunderbird -profile $PROFILE" >/dev/null || break; sleep 0.5; done
/Applications/Thunderbird.app/Contents/MacOS/thunderbird -profile "$PROFILE" -no-remote --marionette -remote-allow-system-access >> /private/tmp/claude-503/spark-tb.log 2>&1 &
sleep "$WAIT"
PID=$(pgrep -f "MacOS/thunderbird -profile $PROFILE" | head -1)
SWIFT="${TMPDIR:-/tmp}/spark-onscreen.swift"
cat > "$SWIFT" <<'SW'
import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid {
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  if (b["Height"] as? Double ?? 0) < 100 { continue }
  print("on screen:", w[kCGWindowName as String] ?? "(no title)", b["Width"] ?? "", "x", b["Height"] ?? "")
}
SW
echo "after ${WAIT}s:"; swift "$SWIFT" "$PID"
