#!/usr/bin/env bash
# Build an isolated Thunderbird test profile for Ember development.
#
#   [SCALE=15] tools/setup_test_profile.sh [--fixtures-only]
#
# - Copies ~/Library/thunderbird-design-dev (read-only source) to $PROFILE
#   (default /private/tmp/claude-503/sparkprof), minus locks and caches.
# - Moves Marionette to port 2831 so it never collides with the user's
#   instance (2828) or the design-dev instance (2829).
# - Adds a POP3 "Work (test)" account (never connects: no login at startup,
#   no mail checks) with an identity whose SMTP server is a local sink on
#   127.0.0.1:2525 (tools/smtp_sink.py), so sending can be verified end to end.
# - Generates ~300 fixture messages (scripts/make_fixtures.py) into the
#   account's mbox folders and Local Folders/Inbox, deleting stale .msf files.
#
# Thunderbird for this profile must NOT be running.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$HOME/Library/thunderbird-design-dev"
PROFILE="${PROFILE:-/private/tmp/claude-503/sparkprof}"

if pgrep -f -- "-profile $PROFILE" >/dev/null; then
  echo "Thunderbird is running on $PROFILE — quit it first." >&2; exit 1
fi

if [[ "${1:-}" != "--fixtures-only" ]]; then
  mkdir -p "$PROFILE"
  rsync -a --delete --exclude lock --exclude .parentlock --exclude cache2 \
    --exclude MarionetteActivePort "$SRC/" "$PROFILE/"
  sed -i '' 's/user_pref("marionette.port", 2829);/user_pref("marionette.port", 2831);/' "$PROFILE/user.js" "$PROFILE/prefs.js"
  cat >> "$PROFILE/user.js" <<'EOF'
// ---- Ember test additions ----
user_pref("marionette.port", 2831);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.spark.agentSocket", "/private/tmp/claude-503/spark-agent-testprofile.sock"); // never the real Ember's socket
user_pref("extensions.spark.mailLinkPort", 47392); // never the real Ember's link port
user_pref("extensions.spark.mailLinkActivate", false); // a link click never brings the test Thunderbird to the front
user_pref("extensions.spark.updateFeed", "off"); // never Ember's public releases
user_pref("extensions.experiments.enabled", true); // Ember's calendar Experiment (public/experiments/calendar)
user_pref("mail.accountmanager.accounts", "account2,account1");
user_pref("mail.accountmanager.defaultaccount", "account2");
user_pref("mail.account.account2.server", "server2");
user_pref("mail.account.account2.identities", "id1");
user_pref("mail.server.server2.type", "pop3");
user_pref("mail.server.server2.hostname", "127.0.0.1");
user_pref("mail.server.server2.port", 1110);
user_pref("mail.server.server2.userName", "merritt");
user_pref("mail.server.server2.name", "Work (test)");
user_pref("mail.server.server2.directory-rel", "[ProfD]Mail/spark-work");
user_pref("mail.server.server2.login_at_startup", false);
user_pref("mail.server.server2.check_new_mail", false);
user_pref("mail.server.server2.download_on_biff", false);
user_pref("mail.server.server2.deferred_to_account", "");
user_pref("mail.server.server2.storeContractID", "@mozilla.org/msgstore/berkeleystore;1");
user_pref("mail.identity.id1.fullName", "Merritt Franzmann");
user_pref("mail.identity.id1.useremail", "merritt@spark.test");
user_pref("mail.identity.id1.smtpServer", "smtp1");
user_pref("mail.identity.id1.valid", true);
user_pref("mail.identity.id1.htmlSigText", "<b>Merritt Franzmann</b><br>Northwind · Creative");
user_pref("mail.identity.id1.htmlSigFormat", true);
user_pref("mail.identity.id1.fcc_folder", "mailbox://merritt@127.0.0.1/Sent");
user_pref("mail.identity.id1.draft_folder", "mailbox://merritt@127.0.0.1/Drafts");
user_pref("mail.identity.id1.archive_folder", "mailbox://merritt@127.0.0.1/Archives");
user_pref("mail.identity.id1.archive_granularity", 0);
user_pref("mail.smtpservers", "smtp1");
user_pref("mail.smtp.defaultserver", "smtp1");
user_pref("mail.smtpserver.smtp1.hostname", "127.0.0.1");
user_pref("mail.smtpserver.smtp1.port", 2525);
user_pref("mail.smtpserver.smtp1.authMethod", 1);
user_pref("mail.smtpserver.smtp1.try_ssl", 0);
user_pref("mail.smtpserver.smtp1.username", "");
user_pref("mail.smtpserver.smtp1.description", "Local sink");
EOF
fi

FX=/private/tmp/claude-503/spark-fixtures
rm -rf "$FX"
python3 scripts/make_fixtures.py "$FX" ${SCALE:+--scale $SCALE}
WORK="$PROFILE/Mail/spark-work"
LOCAL="$PROFILE/Mail/Local Folders"
mkdir -p "$WORK"
for f in Inbox Sent Drafts Archives Projects Receipts; do
  cp "$FX/work/$f" "$WORK/$f"; rm -f "$WORK/$f.msf"
done
: > "$WORK/Trash"; rm -f "$WORK/Trash.msf"
cp "$FX/local/Inbox" "$LOCAL/Inbox"; rm -f "$LOCAL/Inbox.msf"
rm -f "$PROFILE/folderCache.json" "$PROFILE/global-messages-db.sqlite"
echo "Profile ready at $PROFILE"
