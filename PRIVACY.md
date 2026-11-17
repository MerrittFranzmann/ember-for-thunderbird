# Ember and your privacy

Ember is a mail app that runs inside Thunderbird on your Mac. Here is exactly what it keeps, what it sends, and to whom.

**In short:** your email stays on your Mac and with your own mail provider. Ember has no account, no server of its own and no analytics. Nobody, including Ember's publisher, sees your mail, your contacts or how you use the app. Ember only connects to something else when a feature needs it, and the features that send any part of your email somewhere new are off until you turn them on with your own account.

## What Ember keeps on your Mac

Everything below is stored in your Thunderbird profile, on your Mac only:

- **A copy of your recent mail:** the last 90 days, plus everything you've pinned. Lists and emails open instantly and search works offline because of it. Attachments aren't copied; they download from your mail server when you open them.
- **Your settings**, including any keys you enter for optional services (VirusTotal, Cloudflare).
- **What Ember has worked out about your mail:** inbox sections, pins, notes, trips from travel emails, and your answers to invitations.
- **Agent Activity:** if you let AI agents use Ember, a log of what they searched, read, marked and drafted (30 days by default; you can change or clear this).
- **A list of recent errors** (the last 50), for troubleshooting. It never leaves your Mac unless you copy it or let an AI agent read it.

Removing Ember (Add-ons and Themes → Ember for Thunderbird → Remove) deletes all of this. If you turned on AI agents, a small connector file also stays in `~/Library/Application Support/Ember`, and you can delete that folder.

## What Ember connects to

### Always

| What it connects to | Why | What it sends |
|---|---|---|
| Your mail and calendar providers (Gmail, Microsoft 365, iCloud, your company's Exchange server…) | To read, send and sync your mail and calendar | What any mail app sends. Thunderbird does this with the accounts you set up in it. For Exchange calendars, Ember talks to your Exchange server directly, with Thunderbird's sign-in. |
| GitHub (this page) | To check for updates, about once an hour | An ordinary download request for the latest version number. GitHub sees your IP address, as with any download. Nothing about you or your mail is sent. |

### On by default; you can turn these off

| Feature | What it connects to | What it sends |
|---|---|---|
| **Remote images** (Settings → Reading) | The servers that host images in your emails | An ordinary image request when you open the email. Senders can use this to tell that you opened their email, and roughly where you are. Turn off **Always load remote images** to block remote images and tracking pixels. |
| **Shared-link check** (Settings → Sending) | Google Drive, OneDrive/SharePoint or Dropbox, only for links of theirs in an email you're writing | The link, without signing you in, to see whether your recipients will be able to open it. |
| **Unsubscribe** | The mailing list's unsubscribe address | An unsubscribe request, only when you click Unsubscribe. |

### Off until you turn them on, with your own account

| Feature | What it connects to | What it sends |
|---|---|---|
| **AI sorting** (Settings → AI) | Cloudflare Workers AI, on your own Cloudflare account | For each Inbox email, once: its sender, subject, a few header signals (for example, whether it came from a mailing list) and its first 600 characters. It also sends the subjects and sender domains of mail you've marked as spam or not spam. |
| **Trips** (with AI sorting on) | The same Cloudflare account | For travel emails that don't include machine-readable booking details: up to 6,000 characters of the email, once. Booking details that the email does include are read on your Mac. |
| **VirusTotal attachment checks** (Settings → Security) | VirusTotal, with your own key | Each attachment's fingerprint (its SHA-256 hash), never the file itself. A file is uploaded only if you choose **Upload** for that file. VirusTotal shares uploaded files with security companies. |
| **AI agents** (Settings → AI) | Programs running as you on this Mac, such as Claude Code | Whatever the agent asks for: it can search and read your saved mail, see your calendar, mark emails, write drafts and hold time on your calendar, but never send. Agents connect only from your Mac. Each one names itself, and you can block it. Agent Activity shows everything they did. Each agent's own provider handles what the agent sends onward, under that provider's privacy terms. |

Ember sends nothing else. There is no crash reporting, no usage tracking and no advertising.

## Locking

**Lock Ember with Touch ID** (Settings → Security) uses macOS's own Touch ID and password check. Ember never sees your fingerprint or your Mac's password; macOS only tells it whether you unlocked. To recognise networks you've marked as trusted (and for Focus's work networks), Ember asks your Mac for the address of the network's router and keeps only a scrambled fingerprint of it. It doesn't read your Wi-Fi name or your location, and the fingerprint stays on your Mac.

## Updates are signed

Ember installs an update only if Ember's publisher signed it, and only after checking that the downloaded file is the one that was signed. A changed or substituted download is refused.

## Questions

Open an [issue](https://github.com/MerrittFranzmann/ember-for-thunderbird/issues). Ember is an independent project and isn't affiliated with Mozilla (Thunderbird), Readdle (Spark), Google, Microsoft, Cloudflare or VirusTotal.
