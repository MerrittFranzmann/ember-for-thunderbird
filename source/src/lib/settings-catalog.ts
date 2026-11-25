// Every setting in the Settings window (Settings.svelte): its section, title and description, and words to
// find it by. The window draws each one's control; search matches these texts. Pure; unit-tested
// (test/settings-catalog.test.ts).

export type SectionId = "general" | "inboxes" | "reading" | "sending" | "focus" | "security" | "calendar" | "accounts" | "ai" | "window" | "storage" | "updates" | "shortcuts" | "troubleshooting";

export interface Section { id: SectionId; label: string; icon: string }

export const SECTIONS: Section[] = [
  { id: "general", label: "General", icon: "gear" },
  { id: "inboxes", label: "Inboxes", icon: "inbox" },
  { id: "reading", label: "Reading", icon: "mailOpen" },
  { id: "sending", label: "Sending", icon: "send" },
  { id: "focus", label: "Focus", icon: "moon" },
  { id: "security", label: "Security", icon: "lock" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "accounts", label: "Accounts", icon: "people" },
  { id: "ai", label: "AI", icon: "smart" },
  { id: "window", label: "Window", icon: "window" },
  { id: "storage", label: "Saved mail", icon: "database" },
  { id: "updates", label: "Updates", icon: "refresh" },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: "keyboard" },
  { id: "troubleshooting", label: "Troubleshooting", icon: "gauge" },
];

/** What a setting needs from this Thunderbird (Ember's Experiments, newer APIs); shown only when present. */
export type Need = "calendar" | "sparkOnly" | "updates" | "clef" | "agents" | "backgroundSend" | "network" | "lock" | "scan";

export interface SettingItem { id: string; section: SectionId; title: string; text?: string; keywords?: string; needs?: Need }

export const SETTINGS: SettingItem[] = [
  { id: "theme", section: "general", title: "Appearance", text: "Light, dark, or follow your Mac.", keywords: "theme dark mode light mode colours" },
  { id: "openOnStartup", section: "general", title: "Open Ember on startup", text: "Open Ember when Thunderbird starts.", keywords: "launch login" },
  { id: "autoMarkRead", section: "general", title: "Mark as read when opened", text: "After about a second.", keywords: "unread seen" },
  { id: "groupConversations", section: "general", title: "Group conversations", text: "Show the emails of a conversation together (by their references and subject).", keywords: "threads threading" },

  { id: "inboxAccounts", section: "inboxes", title: "Work and Personal", text: "Work accounts' mail goes to the Work inbox and every other account's to Personal, each sorted into its own groups. This is the same list as Focus's work accounts.", keywords: "split separate two inboxes work personal accounts smart inbox" },
  { id: "workGroups", section: "inboxes", title: "Work groups", text: "Rename, reorder or hide groups. A hidden group's mail still shows under All.", keywords: "sections categories tabs team outside tools receipts announcements" },
  { id: "personalGroups", section: "inboxes", title: "Personal groups", text: "Rename, reorder or hide groups. A hidden group's mail still shows under All.", keywords: "sections categories tabs people plans purchases money accounts newsletters promotions" },
  { id: "senderGroups", section: "inboxes", title: "Sender rules", text: "Senders you've placed yourself, from an email's Details (⋯) → Always put this sender in. Rules come before AI sorting.", keywords: "always put sender group move rule filter" },
  { id: "spamSenders", section: "inboxes", title: "Spam senders", text: "Senders you marked as spam (right-click an email → Mark as spam). Their new mail goes straight to Spam. Remove one to let its mail back into your Inbox; Not spam on one of their emails does the same.", keywords: "spam junk block blocked senders filter" },
  { id: "inboxImportant", section: "inboxes", title: "What's important", text: "With AI sorting on, Clef marks an email important by what you write here for each inbox.", keywords: "important priority ai clef matters", needs: "clef" },
  { id: "showAllInboxes", section: "inboxes", title: "Also show All inboxes", text: "An inbox with every account's mail, with the usual sections (People, Calendar, Updates, Newsletters).", keywords: "combined unified merged all accounts" },

  { id: "quotedHistoryMode", section: "reading", title: "Quoted history", text: "How earlier replies quoted in an email are shown.", keywords: "quotes replies thread history" },
  { id: "standardizeEmailText", section: "reading", title: "Standardise email text", text: "Like Ember: ordinary text uses one font, size and colour. Newsletters and tables keep their design.", keywords: "font size typography" },
  { id: "emailDarkMode", section: "reading", title: "Emails in dark mode", text: "Ember recolours most emails to match dark mode; designed emails stay on white.", keywords: "dark theme colours" },
  { id: "loadRemoteImages", section: "reading", title: "Always load remote images", text: "Load images automatically. Turn off to block remote images and tracking pixels.", keywords: "privacy tracking pixels pictures" },

  { id: "undoSend", section: "sending", title: "Undo send", text: "Sent emails wait this long in Ember's outbox before they go, so you can take them back (Undo, or ⌘Z). They're sent even if Ember is closed.", keywords: "delay cancel unsend outbox recall" },
  { id: "sendLater", section: "sending", title: "Send later", text: "In the composer, the clock next to Send schedules an email: later today, tomorrow, Monday or any time. It waits in the outbox above your inbox, where you can edit it or send it now. Thunderbird must be running at that time.", keywords: "schedule scheduled delay outbox" },
  { id: "checkRecipients", section: "sending", title: "Check recipients before sending", text: "Ember asks first when an email goes to a domain you've never emailed (or looks like a typo), adds someone to a conversation they weren't in, or replies to everyone in a big thread.", keywords: "before you send typo domain reply all warning" },
  { id: "checkLinks", section: "sending", title: "Check shared links before sending", text: "For Google Drive, OneDrive, SharePoint and Dropbox links, Ember asks the service (without signing in) whether the file opens for anyone with the link, and warns when some recipients may not be able to open it.", keywords: "before you send access permission google docs" },
  { id: "checkAttachments", section: "sending", title: "Check attachments before sending", text: "Ember asks first when the email says something is attached (\"I've attached…\", \"see the spreadsheet\") but nothing is, or not that kind of file, and when an attached file looks older than one already in the conversation (budget v2 when v3 was sent).", keywords: "before you send forgot attachment version file missing" },
  { id: "backgroundSend", section: "sending", title: "Send new messages without windows", text: "New messages send in the background. Needs Thunderbird's one-time approval; no email is sent when enabling it.", keywords: "permission compose window", needs: "backgroundSend" },
  { id: "minimizeCompose", section: "sending", title: "Minimize Thunderbird's compose window", text: "Replies and forwards go through Thunderbird's composer to keep threading and attachments. Minimize it while it sends.", keywords: "compose window reply forward" },
  { id: "signatures", section: "sending", title: "Signatures", text: "Choose a signature per email from the composer's Signature menu. To add one, write it in an email (Signature → Edit signature in this email), then Signature → Save as new signature.", keywords: "sign-off footer" },

  { id: "workHours", section: "focus", title: "Work hours", text: "Your work days and hours. Quiet hours and work mail follow them.", keywords: "schedule days time office" },
  { id: "quietHours", section: "focus", title: "Quiet hours", text: "While quiet, new email notifies you only when it's from the people or about the subjects you let through. Meeting reminders still come. The moon button next to Settings turns quiet on or off for now.", keywords: "do not disturb notifications silence mute night weekend" },
  { id: "letThrough", section: "focus", title: "Let through", text: "Email from these people (addresses, names, or @domain) or with these words in the subject always notifies, and shows even when work mail is hidden.", keywords: "exceptions vip allow important people subjects" },
  { id: "workAccounts", section: "focus", title: "Work accounts", text: "Their mail is work mail: it's in the Work inbox (Settings → Inboxes), which is dimmed when you're off work (below); the Inbox of all accounts hides it, except what you let through.", keywords: "hide personal account mailboxes" },
  { id: "workNetworks", section: "focus", title: "Work networks", text: "On these networks, work mail always shows. Ember knows a network by its router (macOS doesn't share Wi-Fi names without location access), so add each one while you're on it.", keywords: "wi-fi wifi office location ethernet", needs: "network" },
  { id: "workMailRule", section: "focus", title: "Show work mail", text: "When work accounts show in the Inbox. Otherwise (at home in the evening or at the weekend) only your other accounts show.", keywords: "hide work home weekend" },

  { id: "lockEnabled", section: "security", title: "Lock Ember with Touch ID", text: "Ember covers your mail until you unlock it with Touch ID, or your Mac's password. Turning the lock on or off asks for Touch ID too.", keywords: "password security privacy protect hide fingerprint biometric", needs: "lock" },
  { id: "lockAfter", section: "security", title: "Lock when you're away", text: "After this long without using your Mac (keyboard, mouse or trackpad).", keywords: "idle timeout inactive minutes auto", needs: "lock" },
  { id: "lockOnSleep", section: "security", title: "Lock when your Mac sleeps or its screen locks", text: "Closing the lid, the screen saver's lock, or locking the screen from the menu.", keywords: "lid sleep screen saver", needs: "lock" },
  { id: "lockOnStart", section: "security", title: "Lock when Thunderbird starts", text: "Not when Ember updates itself.", keywords: "launch open startup", needs: "lock" },
  { id: "lockTrustedNetworks", section: "security", title: "Don't lock on these networks", text: "At home, say. On these networks Ember doesn't lock when you're away or your screen locks, and the lock from your Mac waking or Thunderbird starting comes off by itself. Add each one while you're on it.", keywords: "home trusted wi-fi wifi network location", needs: "lock" },
  { id: "virusTotalKey", section: "security", title: "Check attachments with VirusTotal", text: "Ember sends each attachment's fingerprint (its SHA-256 hash), never the file, to VirusTotal and shows what its virus scanners found beside the file. A flagged file asks before it opens. Uses your own free VirusTotal API key (virustotal.com → sign in → your name → API key); a free key allows 4 checks a minute and 500 a day.", keywords: "virus malware scan antivirus security attachment hash api key", needs: "scan" },
  { id: "virusTotalAuto", section: "security", title: "Check attachments when an email opens", text: "Otherwise, check a file with the shield next to it.", keywords: "virus scan automatic", needs: "scan" },
  { id: "virusTotalUpload", section: "security", title: "Uploading a file to VirusTotal", text: "For a file VirusTotal hasn't seen, its shield offers to upload it for scanning. VirusTotal shares uploaded files with security companies and its paying customers, so Ember never uploads by itself, and you shouldn't upload anything confidential.", keywords: "virus upload share privacy", needs: "scan" },
  { id: "lockNow", section: "security", title: "Lock now", text: "Locking Ember yourself works on any network. In Ember, press ⌘L or the lock next to Settings.", keywords: "lock now shortcut", needs: "lock" },
  { id: "meetingReminder", section: "calendar", title: "Meeting reminders", text: "A notification before each meeting on your Exchange calendars. Click it to join the call.", keywords: "notification alert outlook exchange", needs: "calendar" },
  { id: "meetingBrief", section: "calendar", title: "Before your meeting", text: "Ten minutes before a meeting, a notification with your recent email with the people in it. Each meeting in Today opens that email too.", keywords: "brief attendees notification", needs: "calendar" },

  { id: "addAccount", section: "accounts", title: "Add an email account", text: "Opens Thunderbird's account setup. Gmail, Outlook and Microsoft 365, iCloud, Exchange and most providers set themselves up from your address.", keywords: "new account gmail outlook exchange imap icloud sign in", needs: "sparkOnly" },
  { id: "accountNicknames", section: "accounts", title: "Inbox nicknames", text: "Shown instead of each account's address: in the sidebar's Inbox list, as the inbox's title, and wherever Ember names the account. Leave empty to show the address.", keywords: "account name label colour" },

  { id: "aiSort", section: "ai", title: "Sort with AI (Cloudflare Clef)", text: "Reads each Inbox email to file it under People, Calendar, Updates, Newsletters or Receipts (receipts, invoices, bills and expenses), and marks what needs a reply, what's important, receipts and promotions. Also spots spam: mail it's sure of goes to Spam (recent mail, never from people you've written to), and mail it's unsure of asks “Looks like spam?”. Sends each email's sender, subject, a few header signals and its first 600 characters to Cloudflare, once, along with the subjects and sender domains of mail you've marked as spam or not spam (so Clef can spot more like them); nothing else. Uses your own Cloudflare account.", keywords: "clef cloudflare classify categories token account id model spam junk", needs: "clef" },
  { id: "travel", section: "ai", title: "Trips from travel email", text: "Flights, hotels, cars, trains and booked events in your email become trips: a row above the inbox before you go, what matters right now while you travel (your flight, then the hotel, then the next meeting), local and home times, and a notification when a gate, time or booking changes. Booking details an email marks up are read on this Mac; for the rest, with AI sorting on, the email's text (up to 6,000 characters, travel emails only) goes to Workers AI on your Cloudflare account, once.", keywords: "travel trip flight hotel itinerary gate boarding check-in time zone" },
  { id: "foldTripMail", section: "ai", title: "Fold a coming trip's email into its row", text: "Two weeks before a trip, its confirmations leave the Smart Inbox list and wait in the trip's row above it.", keywords: "travel trip confirmations hide group" },
  { id: "agentAccess", section: "ai", title: "Let AI agents use Ember (MCP)", text: "An agent such as Claude Code or Codex can find and read your saved mail, mark emails as needs reply, important or top, show you an email in Ember, and write reply drafts into your Drafts folder for you to review. It gives you links to the emails it mentions. It can't send anything, or move or delete your mail. Only programs running as you on this Mac can connect.", keywords: "mcp claude chatgpt codex agent server socket", needs: "agents" },
  { id: "agentAlert", section: "ai", title: "Tell me when a new agent uses Ember", text: "The first time a program Ember hasn't seen before uses it, Ember says so, and you can block it.", keywords: "mcp agent new alert notify security block", needs: "agents" },
  { id: "agentsSeen", section: "ai", title: "Agents that have used Ember", text: "Each program names itself when it connects. A blocked one gets an error for everything it asks.", keywords: "mcp agent block unblock claude codex cursor list", needs: "agents" },
  { id: "agentActivityDays", section: "ai", title: "Agent Activity", text: "What agents searched, read, marked and drafted, in the sidebar's Agent Activity. Kept on this Mac only.", keywords: "mcp agent activity log history clear keep days", needs: "agents" },
  { id: "emailLinks", section: "ai", title: "Links to emails", text: "Links that open an email in Ember: AI agents give them to you for the emails they mention, and right-click → Copy link makes one. They work on this Mac while Thunderbird is running; Thunderbird answers them on this Mac only, and nothing about your mail is shared.", keywords: "link url open email mcp claude chatgpt codex copy share" },

  { id: "windowMode", section: "window", title: "Open Ember in its own window", text: "No Thunderbird toolbars, tabs or address bar. Ctrl Shift S switches between Ember and Thunderbird.", keywords: "tab popup" },
  { id: "sparkOnly", section: "window", title: "Ember only", text: "Thunderbird keeps syncing and sending in the background, but its own window stays hidden. Closing Ember keeps it in the Dock.", keywords: "hide thunderbird dock", needs: "sparkOnly" },
  { id: "dockIcon", section: "window", title: "Ember's icon in the Dock", text: "Shows Ember's icon in the Dock and the app switcher while Ember is open, instead of Thunderbird's.", keywords: "dock icon app switcher logo", needs: "sparkOnly" },
  { id: "lightenThunderbird", section: "window", title: "Lighten Thunderbird", text: "Turns off Thunderbird features Ember doesn't use: its own search index, chat and start page. Turning this off restores them.", keywords: "memory performance chat index", needs: "sparkOnly" },
  { id: "switchToThunderbird", section: "window", title: "Switch to Thunderbird", text: "Show Thunderbird's own window.", keywords: "classic" },

  { id: "cache", section: "storage", title: "Local mail cache", text: "Saves the last 90 days of mail, all pins, and attachment lists while Thunderbird is running, even when Ember is closed. Files download when opened.", keywords: "offline cache storage index refresh pause" },

  { id: "autoUpdate", section: "updates", title: "Install updates automatically", text: "New versions of Ember (signed releases from GitHub) install while you're not using Ember (never while you're writing or an email is about to be sent). Ember reopens as it was.", keywords: "version upgrade check", needs: "updates" },

  { id: "shortcuts", section: "shortcuts", title: "Keyboard shortcuts", keywords: "keys hotkeys" },

  { id: "perfRecorder", section: "troubleshooting", title: "Performance recorder", text: "Keeps the last 5 minutes of timings (no subjects, addresses or email content). Right after a freeze, press Ctrl Shift L to keep a report (the last 8 are kept).", keywords: "slow freeze report export debug" },
  { id: "about", section: "troubleshooting", title: "About", text: "Ember and Thunderbird versions.", keywords: "version" },
];

export const SHORTCUTS: [string, string][] = [
  ["E", "Done (archive)"],
  ["# / ⌫", "Delete"],
  ["R", "Reply"],
  ["A", "Reply all"],
  ["F", "Forward"],
  ["S", "Pin / unpin"],
  ["U", "Toggle read"],
  ["M", "Move to folder"],
  ["⌘Z / ⌃Z", "Undo the last action (also Undo send)"],
  ["J / K", "Next / previous"],
  ["⌃N / C", "New message"],
  ["/", "Search"],
  ["Esc", "Back / close"],
  ["⌘ ↵", "Send"],
  ["⌘ ,", "Settings"],
  ["⌘1 / ⌘2", "First / second inbox"],
  ["⌘3", "Calendar"],
  ["⌘4", "Attachments"],
  ["⌘ L", "Lock Ember (with the lock on)"],
  ["⌃ ⇧ L", "Save performance report"],
  ["⌃ ⇧ S", "Switch between Ember and Thunderbird"],
];

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);
const label = (id: SectionId) => SECTIONS.find((s) => s.id === id)?.label || "";

/** Shortcuts matching every word of a query (by key or what it does). */
export function matchingShortcuts(query: string): [string, string][] {
  const want = words(query);
  return SHORTCUTS.filter(([key, what]) => want.every((w) => `${key} ${what}`.toLowerCase().includes(w)));
}

/** Settings matching every word of a query (title, description, keywords, section), in window order; those
 *  whose title matches come first within a section. Keyboard shortcuts match by their keys and actions too. */
export function searchSettings(query: string, items: SettingItem[] = SETTINGS): SettingItem[] {
  const want = words(query);
  if (!want.length) return [];
  const hits = items.filter((item) => {
    const text = `${item.title} ${item.text || ""} ${item.keywords || ""} ${label(item.section)}`.toLowerCase();
    return want.every((w) => text.includes(w)) || (item.id === "shortcuts" && matchingShortcuts(query).length > 0);
  });
  const order = (item: SettingItem) => SECTIONS.findIndex((s) => s.id === item.section) * 2 + (want.every((w) => item.title.toLowerCase().includes(w)) ? 0 : 1);
  return hits.map((item, i) => ({ item, i })).sort((a, b) => order(a.item) - order(b.item) || a.i - b.i).map((x) => x.item);
}
