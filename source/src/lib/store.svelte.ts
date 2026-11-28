// App state + data layer. Thunderbird remains the source of truth: we keep a
// session cache of MessageHeaders for the current view, derive conversations
// from it, and reflect live changes through the messages/folders events.

import { api, mailCache, abortList, env, initEnv, listFolder, drain } from "./api";
import { MetaCache } from "./meta";
import { classify, quickClassify } from "./classify";
import { distinctCopies, groupConversations, messageId, relatedConversation } from "./threading";
import { displayName, emailOf, normSubject } from "./format";
import { briefView, type MeetingBrief } from "./meeting-brief";
import { aiCategory, aiGroup, aiKey, aiSignal, aiSpam, type AiAnswers, type AiGroups, type AiSignal } from "./ai-sort";
import { keepLinks, mailLink, readKept } from "./mail-links";
import { emptyFeedback, markedNotSpam, markedSpam, readFeedback, unmarkedSpam, SPAM_ASK, type SpamFeedback } from "./spam";
import { buildTrips, currentTrips, type Booking, type Trip } from "./trips";
import type { TravelStatus } from "./travel-service";
import { calendarSubject } from "./classify";
import { applyMarks, markOf, restoreMarks, topOf, type AgentMarks, type MarkChange } from "./agent-marks";
import { addEntry, agentLook, readLog, replacedDrafts, reviewItems, seenAgent, type ActivityEntry, type AgentRegistry, type DraftState, type HoldState, type ReviewItem } from "./agent-activity";
import { CATEGORY_LABEL } from "./inbox";
import type { AiSortStatus } from "./ai-sorter";
import { attachmentCutoff, collectAttachments, excludedAttachmentFolders, isReceivedAttachmentMessage, isFileAttachment, normalizeDomain, senderDomain, type ReceivedAttachment } from "./attachments";
import type { FileKind, FileGrouping } from "./attachment-library";
import { libraryLinks, type LinkGrouping, type LinkService, type ReceivedLink } from "./link-library";
import { ignoredSenders, isBulk, parseUnsubscribe, writtenTo, type SenderSummary, type Unsubscribe } from "./ignored-senders";
import { matchesSearchHeader, type SearchFilters } from "./mail-search";
import { keepMessage, messageKey, type CacheStatus } from "./local-mail-cache";
import { perf } from "./perf-recorder";
import { errorLog } from "./error-log";
import { INBOX_DEFAULTS, INBOX_LABEL, groupDef, groupsOf, inboxOf, ruleGroup, workDomains, type InboxSettings } from "./inboxes";
import { groupTimeBuckets } from "./time-buckets";
import { categoryParent, scopedCategory } from "./inbox";
import { withDeadline } from "./async";
import { datasetKey, navigationKey, ViewCache } from "./view-cache";
import { parseRefs } from "./meta";
import type { UpdateStatus } from "./update-service";
import type { FollowUp } from "./follow-ups";
import { FOCUS_DEFAULTS, letThrough, type FocusSettings, type FocusState } from "./focus";
import { LOCK_DEFAULTS, type LockSettings } from "./lock";
import { again, cameBack, defer, failureText, forget, prune, remember, RETRY_EVERY_MS, settle, waiting, type ArchiveIntents } from "./archive-intents";
import type {
  Category,
  InboxCategory,
  InboxId,
  Conversation,
  MailAccount,
  MailFolder,
  MailIdentity,
  MessageHeader,
  MessageId,
  MessageList,
  View,
} from "./types";

export interface Settings extends FocusSettings, LockSettings {
  openOnStartup: boolean;
  autoMarkRead: boolean;
  markReadDelay: number;
  theme: "system" | "light" | "dark";
  minimizeCompose: boolean;
  groupConversations: boolean;
  loadRemoteImages: boolean;
  attachmentApprovedOnly: boolean;
  approvedAttachmentDomains: string[];
  sidebarExpanded: Record<string, boolean>;
  /** The sidebar's width in pixels, dragged by its edge (sidebar-width.ts). */
  sidebarWidth: number;
  quotedHistoryMode: "panel" | "jump";
  /** Meeting reminders: minutes before, 0 off, -1 as set in Outlook. */
  meetingReminder: number;
  timeBucketExpanded: Record<string, boolean>;
  attachmentFileType: FileKind | "all";
  attachmentGroupBy: FileGrouping;
  /** Attachments: the files or the links tab, and the links' service filter and grouping. */
  attachmentTab: "files" | "links";
  linkService: LinkService | "all";
  linkGroupBy: LinkGrouping;
  /** Senders you ignore: senders kept off the list, and unsubscribes done (address → when). */
  keptSenders: string[];
  unsubscribedSenders: Record<string, number>;
  /** Trips from travel mail; a coming trip's mail folded into its row above the inbox; home's time zone
   *  (kept up to date while not travelling, for "home" times on a trip). */
  travel: boolean;
  foldTripMail: boolean;
  homeTimeZone: string;
  perfRecorder: boolean;
  windowMode: boolean;
  /** Ember-only mode: Thunderbird's own window stays hidden (window mode only). */
  sparkOnly: boolean;
  /** Turn off Thunderbird features Ember doesn't use (global search index, chat, start page). */
  lightenThunderbird: boolean;
  /** Ember's icon in the Dock instead of Thunderbird's, in Ember-only mode. */
  dockIcon: boolean;
  /** Dark mode for email bodies: recolour like Spark, or keep every email on white. */
  emailDarkMode: "adapt" | "paper";
  /** Re-set the sender's fonts, sizes and neutral colours on ordinary text (Ember's body parser). */
  standardizeEmailText: boolean;
  /** The last folders mail was moved to (newest first), offered first in Move to… */
  recentMoveFolders: string[];
  /** Install new versions from the release folder when Ember isn't in use (update-service.ts). */
  autoUpdate: boolean;
  /** Signatures saved in Ember, chosen per email in the composer (besides Thunderbird's own per address). */
  signatures: SavedSignature[];
  /** Nicknames shown instead of each account's address (by account id). */
  accountNicknames: Record<string, string>;
  /** Before sending: new outside domains and likely typos, people new to a conversation, big reply-alls. */
  checkRecipients: boolean;
  /** Before sending: shared-file links (Google Drive, OneDrive, SharePoint, Dropbox) recipients can't open. */
  checkLinks: boolean;
  /** Before sending: a file the email mentions but lacks, or an older version than the conversation's. */
  checkAttachments: boolean;
  /** Ten minutes before a meeting: a notification with recent email from the people in it. */
  meetingBrief: boolean;
  /** AI sorting with Cloudflare's Clef (ai-sort.ts): the user's own account ID and API token. */
  aiSort: boolean;
  clefAccount: string;
  clefToken: string;
  clefModel: "clef" | "clef-flash";
  /** AI agents may use Ember through its MCP server (a local socket; agent-bridge.ts). */
  agentAccess: boolean;
  /** Links that open an email (mail-links.ts): Thunderbird answers them on this Mac. */
  emailLinks: boolean;
  /** Agent Activity: say so when an agent Ember hasn't seen before uses it, and how many days are kept. */
  agentAlert: boolean;
  agentActivityDays: number;
  /** The Calendar page: the view it opens in, and calendars (account ids) the user unticked. */
  calendarMode: "day" | "week" | "month" | "year";
  calendarHidden: string[];
  /** Other calendars (shared and extra ones, by key) the user ticked, and people's calendars they added. */
  calendarShown: string[];
  calendarPeople: { accountId: string; email: string; name: string }[];
  /** Mail accounts whose "Connect calendars" the user put away (or that have none to find). */
  calendarConnectHidden: string[];
  /** Undo send: seconds a sent email waits in Ember's outbox before it goes (0: right away). */
  undoSend: number;
  /** Work and Personal inboxes (inboxes.ts): groups' order/names/hidden, sender rules, what's important. */
  inboxGroups: InboxSettings["inboxGroups"];
  senderGroups: InboxSettings["senderGroups"];
  inboxImportant: InboxSettings["inboxImportant"];
  /** Also list the inbox of every account together (with the base sections). */
  showAllInboxes: boolean;
  /** The Work/Personal inbox last opened (Ember opens on it). */
  lastInbox: InboxId | "";
  /** VirusTotal (virustotal.ts): the user's own API key, and checking attachments when an email opens. */
  virusTotalKey: string;
  virusTotalAuto: boolean;
}

export interface SavedSignature { id: string; name: string; html: string }

const PERF_REPORTS = 8;
/** Cache-served folder views re-check a folder's last three days with Thunderbird at most this often. */
const RECENT_CHECK_MS = 5 * 60_000;
/** How often the listed folders' counts are compared while Ember is in front (mail that arrived unannounced). */
const POLL_MS = 60_000;
/** Waits before trying an archive the server refused again (an Exchange hiccup usually passes in seconds). */
const ARCHIVE_RETRY_MS = [4000, 15000];
/** One archive try, at most: the Experiment gives up on a move after 90 s, and finding Thunderbird's id for a
 * saved email (the background cache) has no limit of its own. A try that never answered once left every later
 * retry waiting behind it (2026-11-12). */
const ARCHIVE_TRY_MS = 120_000;
/** A folder's counts, "total:unread:new" (as the cache's inventory records them); "" when unavailable. */
async function folderMark(id: string): Promise<string> {
  try { const info = await api.folders.getFolderInfo(id); return info ? `${info.totalMessageCount}:${info.unreadMessageCount}:${info.newMessageCount ?? 0}` : ""; }
  catch { return ""; }
}

const DEFAULT_SETTINGS: Settings = {
  openOnStartup: false,
  autoMarkRead: true,
  markReadDelay: 1200,
  theme: "system",
  minimizeCompose: true,
  groupConversations: true,
  loadRemoteImages: true,
  attachmentApprovedOnly: true,
  approvedAttachmentDomains: [],
  sidebarExpanded: { inbox: true },
  sidebarWidth: 232,
  quotedHistoryMode: "jump",
  meetingReminder: 5,
  timeBucketExpanded: {},
  attachmentFileType: "all",
  perfRecorder: true,
  windowMode: true,
  sparkOnly: true,
  lightenThunderbird: true,
  dockIcon: true,
  emailDarkMode: "adapt",
  standardizeEmailText: true,
  attachmentGroupBy: "none",
  attachmentTab: "files",
  linkService: "all",
  linkGroupBy: "none",
  keptSenders: [],
  unsubscribedSenders: {},
  travel: true,
  foldTripMail: true,
  homeTimeZone: "",
  recentMoveFolders: [],
  autoUpdate: true,
  signatures: [],
  accountNicknames: {},
  checkRecipients: true,
  checkLinks: true,
  checkAttachments: true,
  meetingBrief: true,
  aiSort: false,
  clefAccount: "",
  clefToken: "",
  clefModel: "clef-flash",
  agentAccess: false,
  emailLinks: true,
  agentAlert: true,
  agentActivityDays: 30,
  calendarMode: "week",
  calendarHidden: [],
  calendarShown: [],
  calendarPeople: [],
  calendarConnectHidden: [],
  undoSend: 120,
  ...INBOX_DEFAULTS,
  showAllInboxes: false,
  lastInbox: "",
  virusTotalKey: "",
  virusTotalAuto: true,
  ...FOCUS_DEFAULTS,
  ...LOCK_DEFAULTS,
};

export interface Toast {
  id: number;
  text: string;
  kind?: "info" | "error" | "success";
  action?: { label: string; run: () => void };
  timeout?: number;
}

export type ListItem =
  | { type: "bucket"; key: string; bucketId: string; label: string; count: number; expanded: boolean }
  | { type: "header"; key: string; label: string; count?: number }
  | { type: "card"; key: string; cat: Category; convs: Conversation[]; unread: number; total: number }
  | { type: "conv"; key: string; conv: Conversation }
  | { type: "older"; key: string };

export interface FolderNode {
  folder: MailFolder;
  depth: number;
  role: string | null; // inbox/drafts/sent/archives/trash/junk/outbox/templates or null
}

export interface AccountNode {
  account: MailAccount;
  primary: FolderNode[];
  others: FolderNode[];
}

const ROLE_ORDER = ["inbox", "drafts", "sent", "archives", "templates", "junk", "trash", "outbox"];

function roleOf(f: MailFolder): string | null {
  const su = f.specialUse || [];
  for (const r of ROLE_ORDER) if (su.includes(r)) return r;
  return null;
}

export class Store {
  // ---- reactive UI state ----
  ready = $state(false);
  cacheStatus = $state<CacheStatus>({ phase: "idle", total: 0, done: 0, failed: 0, saved: 0 });
  retryLocalCache() { return mailCache.warm(); }
  /** True when Ember runs in its own window rather than a Thunderbird tab. */
  inWindow = $state(false);
  /** In window mode an Ember tab (e.g. from the Spaces button) hands over to the Ember window. */
  async placeWindow() {
    try {
      const current = await api.windows.getCurrent();
      this.inWindow = current.type === "popup";
      if (this.settings.windowMode && current.type === "normal") await api.runtime.sendMessage({ type: "spark:open" });
    } catch { /* stays where it is */ }
  }
  switchToThunderbird() { return api.runtime.sendMessage({ type: "spark:toggle" }).catch(() => {}); }
  /** Remember the Ember window's size and position for the next time it opens. */
  trackWindowBounds(): () => void {
    let saved = "";
    const save = () => {
      if (!this.inWindow || document.visibilityState !== "visible") return;
      if (outerWidth <= 240 && outerHeight <= 180) return; // the hidden Thunderbird window's size, never one to keep
      const bounds = { left: screenX, top: screenY, width: outerWidth, height: outerHeight };
      const text = JSON.stringify(bounds);
      if (text !== saved) { saved = text; void api.storage.local.set({ sparkWindowBounds: bounds }).catch(() => {}); }
    };
    // Polled (windows have no move event), but only while Ember is visible; hiding saves once.
    let timer: ReturnType<typeof setInterval> | undefined;
    const watch = () => {
      clearInterval(timer); timer = undefined;
      if (document.visibilityState === "visible") timer = setInterval(save, 2000); else save();
    };
    watch();
    document.addEventListener("visibilitychange", watch);
    addEventListener("pagehide", save);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", watch); removeEventListener("pagehide", save); };
  }

  perfReports = $state(0);
  /** Keep the last few minutes of timings inside Ember (no dialog), up to PERF_REPORTS reports. */
  async savePerformanceReport(trigger: "shortcut" | "button") {
    if (!this.settings.perfRecorder) { this.toast({ text: "Turn on the performance recorder in Settings first.", kind: "info" }); return; }
    perf.record("report", { trigger });
    let background: import("./perf-recorder").PerfEntry[] = [];
    try { const response = await api.runtime.sendMessage({ type: "spark:cache", command: "perf" }); if (response?.ok) background = response.value; } catch { /* report the page alone */ }
    const report = perf.report({
      version: api.runtime.getManifest().version, thunderbird: this.tbVersion, trigger,
      window: { width: innerWidth, height: innerHeight, devicePixelRatio, screen: [screen.width, screen.height] },
      view: this.view.kind, loadedMessages: this.dataset.size, conversations: this.conversations.length, listRows: this.items.length,
      readerOpen: this.readerOpen, threadMessages: document.querySelectorAll(".thread .msg").length, frames: document.querySelectorAll("iframe").length, domNodes: document.getElementsByTagName("*").length,
      cache: { phase: this.cacheStatus.phase, saved: this.cacheStatus.saved, failed: this.cacheStatus.failed, failures: this.cacheStatus.failures },
      settings: { loadRemoteImages: this.settings.loadRemoteImages, groupConversations: this.settings.groupConversations, autoMarkRead: this.settings.autoMarkRead, theme: this.settings.theme },
      accounts: this.accounts.map((node) => node.account.type),
      errors: (await errorLog.read()).slice(0, 20),
    }, background);
    try {
      const { perfReports = [] } = await api.storage.local.get("perfReports");
      const reports = [...perfReports, JSON.stringify(report)].slice(-PERF_REPORTS);
      await api.storage.local.set({ perfReports: reports });
      this.perfReports = reports.length;
      this.toast({ text: `Performance report saved (${reports.length} kept). Export it from Settings to send it.`, kind: "success" });
    } catch (error: any) { this.toast({ text: `Couldn't save the performance report: ${error?.message || error}`, kind: "error" }); }
  }

  /** One JSON file with every kept report (the browser asks where to save it). */
  async exportPerformanceReports() {
    const { perfReports = [] } = await api.storage.local.get("perfReports");
    if (!perfReports.length) { this.toast({ text: "No performance reports yet. Press Ctrl+Shift+L right after a freeze.", kind: "info" }); return; }
    const name = `spark-performance-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
    const url = URL.createObjectURL(new Blob([`[${perfReports.join(",")}]`], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async clearPerformanceReports() { await api.storage.local.remove("perfReports"); this.perfReports = 0; }

  async countPerformanceReports() { try { this.perfReports = ((await api.storage.local.get("perfReports")).perfReports || []).length; } catch { /* unavailable */ } }

  async pauseLocalCache(paused: boolean) { try { await mailCache.setPaused(paused); } catch (error: any) { this.toast({ text: error.message, kind: "error" }); } }
  async connectCache() {
    mailCache.onChange = (status) => {
      const previous = this.cacheStatus.phase;
      this.cacheStatus = { ...status };
      // A body pass finished (also with a few emails left to retry): saved-mail searches may have more now.
      if ((status.phase === "ready" && previous !== "ready") || (status.phase === "error" && previous === "bodies")) {
        this.viewCache.markSearchDirty();
        if (this.ready && !this.loading && this.view.kind === "search" && this.view.scope !== "all") void this.reload();
      }
      // An inventory just finished: it may have found mail no event announced. A list built from the
      // cache picks it up (cheap: cache plus recent days), after the client has the new headers.
      if (previous === "index" && status.phase !== "index" && this.ready && this.cacheServed && !this.loading) {
        void Promise.resolve((mailCache as any).refresh?.()).then(() => { if (this.cacheServed && !this.loading) return this.reload(); }).catch(() => {});
      }
    };
    await mailCache.init();
  }
  searchFilters = $state<SearchFilters>({});
  searchCoverage = $state({ indexed: 0, cached: 0 });
  async searchMail(query: string, scope: "local" | "all" = "local") {
    const view: View = { kind: "search", query: query.trim(), scope, filters: { ...this.searchFilters } };
    if (datasetKey(view) === datasetKey(this.view)) await this.reload(); else await this.setView(view);
  }
  tbVersion = $state(0);
  accounts = $state<AccountNode[]>([]);
  /** Whether Thunderbird's accounts have been read (so "no mail account" means none, not "not yet"). */
  accountsKnown = $state(false);
  /** A mail account (not only Local Folders): without one, Ember shows its welcome. */
  get hasMailAccount() { return this.accounts.some((node) => node.account.type !== "none"); }
  identities = $state<MailIdentity[]>([]);
  unread = $state<Record<string, number>>({});
  view = $state<View>({ kind: "smart" });
  loading = $state(false);
  hasLoadedView = $state(false);
  refreshing = $derived(this.loading && this.hasLoadedView);
  private refreshConversationCount = $state<number | null>(null);
  displayedConversationCount = $derived(this.refreshing && this.refreshConversationCount !== null ? this.refreshConversationCount : this.countForView());
  loadedCount = $state(0);
  rev = $state(0);
  metaRev = $state(0);
  private metaGroupRev = $state(0);
  /** Changes only with categories or threading references: the related-conversation index doesn't read
   *  attachment flags, which opening an email often corrects (it was rebuilt, ~35 ms, on the next open). */
  private metaThreadRev = 0;
  private clockNow = $state(Date.now());
  readerRev = $state(0);
  selectedKey = $state<string | null>(null);
  readerOpen = $state(false);
  toasts = $state<Toast[]>([]);
  settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  /** The background's last look at the release folder (update-service.ts). */
  updateStatus = $state<UpdateStatus | null>(null);
  /** Sent emails waiting for a reply (follow-up-service.ts), by Message-ID. */
  followUps = $state<Record<string, FollowUp>>({});
  dueFollowUps = $derived(Object.values(this.followUps).filter((f) => f.state === "due").sort((a, b) => a.dueAt - b.dueAt));
  searchText = $state("");
  focusSearch = $state(0);
  error = $state<string | null>(null);
  attachments = $state<ReceivedAttachment[]>([]);
  attachmentFailures = $state(0);
  attachmentsScanned = $state(0);
  attachmentPhase = $state<"query" | "files" | "done">("done");
  attachmentDeferred = $state(0);
  attachmentStopped = $state(false);
  /** Attachments → Links: shared-file and review links in received saved mail (loadLinks). */
  links = $state.raw<ReceivedLink[]>([]);
  linksPhase = $state<"idle" | "loading" | "done" | "error">("idle");
  linksError = $state("");
  private attachmentAbort: AbortController | null = null;
  private attachmentRequests = new Map<number, Promise<import("./types").MessageAttachment[]>>();
  private attachmentMetadata = new Map<number, import("./types").MessageAttachment[]>();
  private selectedId = $state<number | null>(null);
  private related = new Map<number, MessageHeader>();
  private relatedIds = new Map<string, number[]>();
  private forgetRelated(messages: MessageHeader[]) {
    const keys = new Set(messages.map(messageKey));
    for (const [id, header] of this.related) if (keys.has(messageKey(header))) this.related.delete(id);
  }
  private attachmentRefreshNeeded = false;
  private attachmentRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- non-reactive caches ----
  meta = new MetaCache();
  me = new Set<string>();
  // Address-only categories by sender: regrouping asks for every email's category (~8 ms per pass at
  // 13k emails when each parsed the address and ran two regexes). Cleared when `me` is rebuilt.
  private quickCategories = new Map<string, Category>();
  folderById = new Map<string, MailFolder>();
  private dataset = new Map<MessageId, MessageHeader>();
  private viewCache = new ViewCache();
  private scrollPositions = new Map<string, number>();
  private pendingLoad: { token: number; headers: Map<MessageId, MessageHeader>; changes: Map<MessageId, MessageHeader | null> } | null = null;
  private hidden = new Set<MessageId>();
  /** What the user archived, by Message-ID, for a few days (archive-intents.ts): one that comes back is archived again. */
  private archiveIntents: ArchiveIntents = {};
  private attachmentIds = new Set<MessageId>();
  private viewFolders = new Set<string>();
  private loadToken = 0;
  /** Thunderbird lists still being paged (one id per list); finished lists need no abort. */
  private listIds = new Set<string>();
  private bumpTimer: any = null;
  private recentMoves = new Map<string, { header: MessageHeader; at: number }>();
  /** recentMoves' key: the Message-ID within an account (one email in two accounts is two copies to put back). */
  private moveKey(m: MessageHeader) { return `${m.folder?.accountId || ""}|${m.headerMessageId}`; }
  private toastSeq = 0;
  private recipientsSeen = new Map<string, { name: string; count: number; last: number }>();

  // ---- derived ----
  // Regrouping depends on the view only for Pins and searches; switching between other views or inbox tabs
  // (All / People / Updates…) of the same data must not regroup every message (20-40 ms).
  private pinnedView = $derived(this.view.kind === "pinned" || (this.view.kind === "category" && this.view.cat === "pinned"));
  private searchView = $derived(this.view.kind === "search");
  /** Drafts: each draft is a row of its own (two replies in one thread are two drafts to open). */
  private draftsView = $derived((this.view.kind === "mailbox" && this.view.role === "drafts") || (this.view.kind === "folder" && this.roleOfFolder(this.view.folderId) === "drafts"));
  /** False while Ember is minimized or hidden: lists keep their last grouping until it's shown again. */
  shown = $state(typeof document === "undefined" || document.visibilityState !== "hidden");
  private lastConversations: Conversation[] | null = null;
  conversations = $derived.by(() => {
    // New mail while minimized would regroup the list for nobody (20-40 ms an email); it regroups once
    // when Ember is shown. (Opening a message from a notification marks Ember shown first.)
    if (!this.shown && this.lastConversations) return this.lastConversations;
    this.rev;
    this.metaGroupRev;
    const pinned = this.pinnedView;
    let msgs: MessageHeader[] = [];
    for (const m of this.dataset.values()) {
      if (this.hidden.has(m.id)) continue;
      if (pinned && !this.inView(m)) continue;
      msgs.push(m);
    }
    // Pins and searches span folders, where Gmail's label copies (All Mail, Starred…) of one email meet.
    if (pinned || this.searchView) msgs = distinctCopies(msgs);
    return this.lastConversations = perf.measure("spark.regroup", () => groupConversations(msgs, {
      me: this.me,
      meta: (m) => this.meta.get(m),
      category: (m) => this.categoryOf(m),
      hasAttachment: (m) => this.attachmentIds.has(m.id) || !!this.meta.get(m)?.hasAtt,
      enabled: this.settings.groupConversations && !this.draftsView,
    }), { messages: msgs.length });
  });

  // ================= trips (trips.ts; bookings read by the background's TravelService) =================

  travelBookings = $state.raw<Booking[]>([]);
  travelStatus = $state<TravelStatus | null>(null);
  /** Minute clock for what's "now" on a trip. `clockOffset` (storage, never set by Ember itself) shifts it, so a
   *  demo or test can show a trip's moments (tools/demo_trip.py). */
  clock = $state(Date.now());
  private clockOffset = 0;
  get homeTz() { return this.settings.homeTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone; }
  trips = $derived<Trip[]>(this.settings.travel ? currentTrips(buildTrips(this.travelBookings, this.clock, this.homeTz), this.clock) : []);
  private foldedKey = "";
  private foldedSet = new Set<string>();
  /** Message-IDs folded into their trip: trips under way, or starting within two weeks. (The same set object
   *  while unchanged, so the minute clock doesn't refilter the list.) */
  get foldedTripMail(): Set<string> {
    const mids = this.settings.foldTripMail ? this.trips.filter((t) => t.phase === "now" || (t.phase === "upcoming" && t.start.at - this.clock < 14 * 86400000)).flatMap((t) => t.mids) : [];
    const key = mids.join("|");
    if (key !== this.foldedKey) { this.foldedKey = key; this.foldedSet = new Set(mids); }
    return this.foldedSet;
  }
  private takeTravel(bookings: unknown) {
    this.travelBookings = Array.isArray(bookings) ? bookings : [];
    // Home is where this Mac is while no trip is under way.
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (here && this.settings.homeTimeZone !== here && !this.trips.some((t) => t.phase === "now")) void this.setSetting("homeTimeZone", here).catch(() => {});
  }
  /** A trip notification was clicked (TravelService): that trip. */
  private async takeTripRequest(request?: { id: string; at: number }) {
    if (!request || Date.now() - request.at > 30000) return;
    await api.storage.local.remove("sparkOpenTrip").catch(() => {});
    this.shown = true;
    await this.setView({ kind: "trip", id: request.id });
  }
  /** A booking's email: in the trip view's list when it's there (the reader opens beside it), else where it lives. */
  async openTripEmail(mid: string) {
    const here = this.conversations.find((c) => c.ids.some((id) => { const m = this.get(id); return !!m && aiKey(m) === mid; }));
    if (here) { this.select(here.key, true); return; }
    const saved = mailCache.all().find((m) => aiKey(m) === mid);
    const id = saved?.id ?? (await Promise.resolve(api.messages.query({ headerMessageId: mid })).catch(() => null) as any)?.messages?.[0]?.id;
    if (id !== undefined) await this.openMessage(id);
    else this.toast({ text: "That email isn't in Thunderbird any more.", kind: "info" });
  }
  /** The trip view's emails: saved ones at once, older ones (booked months ago) from Thunderbird. */
  private loadTripView(id: string) {
    this.cancelLoad();
    this.error = null;
    const trip = this.trips.find((t) => t.id === id);
    const mids = new Set(trip?.mids || []);
    const saved = mailCache.all().filter((m) => mids.has(aiKey(m)));
    this.dataset = new Map(saved.map((m) => [m.id, m])); this.viewFolders = new Set(); this.attachmentIds = new Set();
    this.loadedCount = saved.length; this.hasLoadedView = true; this.loading = false; this.rev++;
    const missing = [...mids].filter((mid) => !saved.some((m) => aiKey(m) === mid));
    const token = this.loadToken;
    if (missing.length) void Promise.all(missing.map((mid) => Promise.resolve(api.messages.query({ headerMessageId: mid })).then((page: any) => page?.messages?.[0]).catch(() => null))).then((found) => {
      const headers = found.filter(Boolean) as MessageHeader[];
      if (token === this.loadToken && headers.length && this.view.kind === "trip" && this.view.id === id) this.add(headers);
    });
  }

  /** Focus (focus.ts, worked out by the background): quiet now, and work accounts hidden now. */
  focusState = $state<FocusState | null>(null);
  hiddenAccounts = $derived(new Set(this.focusState?.hiddenAccounts || []));

  /** Whether a conversation is only mail of hidden work accounts that isn't let through. */
  private hiddenByFocus(conversation: Conversation): boolean {
    return conversation.ids.every((id) => { const m = this.get(id); return !m || (this.hiddenAccounts.has(m.folder?.accountId || "") && !letThrough(this.settings, m)); });
  }

  listConversations = $derived.by(() => {
    const view = this.view;
    const pinned = view.kind === "pinned" || (view.kind === "category" && view.cat === "pinned");
    this.aiRev;
    const hasMarks = Object.keys(this.agentMarks).length > 0;
    const filter = view.kind === "category" ? this.signalFilter : "";
    // Work mail hidden by Focus: out of the all-account inbox views (an account's own inbox still shows it).
    // (Opening the Work inbox itself shows its mail, as an account's own inbox does.)
    const focusHides = this.hiddenAccounts.size > 0 && this.isInboxView() && !("accountId" in view && view.accountId) && view.kind !== "folder" && this.viewInbox(view) !== "work";
    const inbox = this.viewInbox(view);
    this.settings.senderGroups; this.settings.inboxGroups;
    // A coming trip's mail is folded into its row above the inbox (TripStrip).
    const folded = this.foldedTripMail;
    const tripFolds = folded.size > 0 && this.isInboxView() && view.kind !== "category";
    return this.conversations.filter((conversation) => {
      if (focusHides && this.hiddenByFocus(conversation)) return false;
      if (tripFolds && conversation.ids.every((id) => { const m = this.get(id); return !!m && folded.has(aiKey(m)); })) return false;
      if (pinned) return conversation.flagged && (!inbox || this.inboxOfAccount(conversation.latest.folder?.accountId) === inbox);
      // Pinned mail lives in Pins, except what was asked to the top of the inbox.
      if (this.isInboxView() && conversation.flagged && !(hasMarks && this.isTop(conversation))) return false;
      if (view.kind === "category" && (inbox ? this.conversationGroup(conversation, inbox) : conversation.cat) !== view.cat) return false;
      if (!filter) return true;
      return filter === "reading" ? !this.aiSignalOf(conversation, "promotion") : this.aiSignalOf(conversation, filter);
    });
  });

  /** Bumped when only read state changed: rows refresh without regrouping every conversation. */
  readRev = $state(0);
  private conversationOf = $derived.by(() => {
    const map = new Map<MessageId, Conversation>();
    for (const c of this.conversations) for (const id of c.ids) map.set(id, c);
    return map;
  });
  /** Read flags changed on these messages: recount just their conversations (regrouping ~16k
   *  conversations costs 60+ ms per mark-as-read). False when a message isn't grouped yet. */
  private patchUnread(ids: MessageId[]): boolean {
    const touched = new Set<Conversation>();
    for (const id of ids) { const c = this.conversationOf.get(id); if (!c) return false; touched.add(c); }
    for (const c of touched) c.unread = c.ids.reduce((n, id) => n + (this.get(id)?.read === false ? 1 : 0), 0);
    this.readRev++;
    return true;
  }

  private metaChanged(groupingChanged: boolean, threadingChanged: boolean) {
    this.metaRev++;
    if (threadingChanged) { this.metaThreadRev++; this.metaGroupRev++; }
    else if (groupingChanged && !this.patchAttachmentFlags()) this.metaGroupRev++;
  }
  /** Only attachment flags changed (opening an email often corrects one): refresh the conversations' clip
   *  icons in place instead of regrouping every message (20-40 ms at 13k). False before the first grouping. */
  private patchAttachmentFlags(): boolean {
    const convs = this.lastConversations;
    if (!convs) return false;
    for (const c of convs) c.hasAttachment = c.ids.some((id) => { const m = this.get(id); return this.attachmentIds.has(id) || (!!m && !!this.meta.get(m)?.hasAtt); });
    this.readRev++;
    return true;
  }

  /** Independent of read state, so a mark-as-read doesn't re-sort every conversation. */
  private buckets = $derived.by(() => perf.measure("spark.date-groups", () => groupTimeBuckets(this.listConversations, new Date(this.clockNow))));

  /** Where a list's open/closed date sections are saved. Sidebar Pins and the inbox's Pinned tab list
   *  the same mail, so they share one setting. */
  private bucketPrefix(): string {
    return this.isPinnedView() ? `pins:${datasetKey(this.view)}` : navigationKey(this.view);
  }

  items = $derived.by((): ListItem[] => {
    this.readRev;
    const buckets = this.buckets;
    const prefix = this.bucketPrefix();
    // Pins are mostly older mail: every section starts open (elsewhere only the newest one does).
    const pins = this.isPinnedView();
    const older: ListItem[] = this.olderAvailable ? [{ type: "older", key: "older" }] : [];
    // Marked "top" (by an agent or the user): above the date groups in the inbox, in date order.
    this.aiRev;
    const topView = this.isInboxView() && this.view.kind !== "category" && Object.keys(this.agentMarks).length > 0;
    const top = topView ? buckets.flatMap((bucket) => bucket.conversations.filter((conv) => this.isTop(conv))) : [];
    const onTop = new Set(top.map((conv) => conv.key));
    const head: ListItem[] = top.length ? [{ type: "header", key: "top", label: "Top", count: top.length }, ...top.map((conv): ListItem => ({ type: "conv", key: conv.key, conv }))] : [];
    // The first date group (Today, usually) opens by default, even below an "Upcoming" one (a future-dated email).
    const firstDated = Math.max(0, buckets.findIndex((bucket) => bucket.id !== "future"));
    return head.concat(buckets.flatMap((bucket, index): ListItem[] => {
      const conversations = onTop.size ? bucket.conversations.filter((conv) => !onTop.has(conv.key)) : bucket.conversations;
      if (!conversations.length && onTop.size) return [];
      const expanded = this.settings.timeBucketExpanded[`${prefix}:${bucket.id}`] ?? (pins || index === firstDated || bucket.id === "future");
      return [
        { type: "bucket", key: `bucket:${bucket.id}`, bucketId: bucket.id, label: bucket.label, count: conversations.length, expanded },
        ...(expanded ? conversations.map((conv): ListItem => ({ type: "conv", key: conv.key, conv })) : []),
      ];
    }), older);
  });

  async toggleTimeBucket(bucketId: string, expanded: boolean) {
    const key = `${this.bucketPrefix()}:${bucketId}`;
    const value = { ...this.settings.timeBucketExpanded, [key]: expanded };
    this.settings.timeBucketExpanded = value;
    try { await api.storage.local.set({ timeBucketExpanded: value }); }
    catch { this.toast({ text: "Couldn't save time-bucket preferences.", kind: "error" }); }
  }

  /** Conversations in list order (for j/k navigation). */
  navOrder = $derived.by(() => this.items.filter((i) => i.type === "conv").map((i) => (i as any).conv as Conversation));

  selected = $derived.by(() => {
    const k = this.selectedKey;
    if (!k) return null;
    return this.conversations.find((c) => c.key === k) || this.conversations.find((c) => this.selectedId !== null && c.ids.includes(this.selectedId)) || null;
  });

  smartUnread = $derived.by(() => {
    let n = 0;
    for (const a of this.accounts) for (const f of a.primary) if (f.role === "inbox") n += this.unread[f.folder.id] || 0;
    return n;
  });

  /** An account's nickname (Settings → Inbox nicknames), else its name in Thunderbird. */
  accountName(accountId: string | undefined): string {
    const nickname = accountId ? this.settings.accountNicknames[accountId]?.trim() : "";
    return nickname || this.accounts.find((a) => a.account.id === accountId)?.account.name || "";
  }

  viewTitle = $derived.by(() => {
    const v = this.view;
    if (v.kind === "smart") return v.inbox && this.split ? INBOX_LABEL[v.inbox] : "Smart Inbox";
    if (v.kind === "pinned") {
      const account = v.accountId && this.accounts.find((a) => a.account.id === v.accountId);
      return account ? `Pins — ${this.accountName(v.accountId)}` : "Pins";
    }
    if (v.kind === "mailbox") {
      const label = { inbox: "Inbox", sent: "Sent", drafts: "Drafts", trash: "Trash", archives: "Archive", junk: "Spam" }[v.role];
      const account = v.accountId && this.accounts.find((a) => a.account.id === v.accountId);
      // A nicknamed inbox is just its nickname ("Work"), not "Inbox — work@…".
      if (account && v.role === "inbox" && this.settings.accountNicknames[v.accountId!]?.trim()) return this.accountName(v.accountId);
      return account ? `${label} — ${this.accountName(v.accountId)}` : label;
    }
    if (v.kind === "attachments") return "Attachments";
    if (v.kind === "senders") return "Senders you ignore";
    if (v.kind === "activity") return "Agent Activity";
    if (v.kind === "calendar") return "Calendar";
    if (v.kind === "trip") { const trip = this.trips.find((t) => t.id === v.id); return trip ? `${trip.city} trip` : "Trip"; }
    if (v.kind === "category") {
      const label = this.sectionLabel(v.cat, v);
      const account = v.accountId && this.accounts.find((a) => a.account.id === v.accountId);
      const folder = v.folderId && this.folderById.get(v.folderId);
      return `${label}${account ? ` — ${this.accountName(v.accountId)}` : folder ? ` — ${folder.name}` : v.inbox && this.split ? ` — ${INBOX_LABEL[v.inbox]}` : ""}`;
    }
    if (v.kind === "search") return v.meeting ? v.meeting.subject : v.query ? `Search: ${v.query}` : "Search mail";
    const f = this.folderById.get(v.folderId);
    if (!f) return "Folder";
    const acct = this.accounts.find((a) => a.account.id === f.accountId);
    return this.accounts.length > 1 && acct ? `${f.name} — ${this.accountName(f.accountId)}` : f.name;
  });

  // ================= init =================

  async init() {
    // Relative times and date groups follow the clock, but not while hidden (they'd re-sort for nobody).
    setInterval(() => { if (this.shown) this.clockNow = Date.now(); }, 60000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
      this.shown = document.visibilityState !== "hidden";
      if (this.shown) this.clockNow = Date.now();
    });
    // Independent start-up work runs together; the first view needs all of it.
    const mark = (name: string) => () => performance.mark(`spark:${name}`); // start-up timeline (performance marks)
    mark("init")();
    const version = initEnv().then((v) => { this.tbVersion = v; }).then(mark("env"));
    const settings = this.loadSettings().then(() => perf.setEnabled(this.settings.perfRecorder, () => api.windows.getCurrent())).then(mark("settings"));
    // The first view needs only the newest page of the cache; the rest streams in (then lists reload).
    let partial!: () => void;
    const firstPage = new Promise<void>((resolve) => { partial = resolve; });
    (mailCache as { onPartial?: () => void }).onPartial = () => { mark("cache-first-page")(); partial(); };
    const full = this.connectCache().then(mark("cache"));
    // All of it arrived: a view drawn from the first page reloads (restarting a load still in flight).
    full.then(() => {
      partial(); if (this.cacheStreaming) { this.cacheStreaming = false; this.viewCache.markDirty(); if (this.ready) void this.reload(); }
      this.warmRelatedSoon(); // when idle, so the first email opened doesn't group all saved mail first (~30 ms at 13k)
    }, () => {
      // Saved mail unavailable: start anyway (lists come from Thunderbird); a list drawn from the first page reloads.
      const partialList = this.cacheStreaming; this.cacheStreaming = false; partial();
      if (partialList && this.ready) void this.reload();
    });
    const cache = Promise.race([firstPage, full.catch(() => {})]).then(() => { this.cacheStreaming = !this.cacheDone; });
    full.then(() => { this.cacheDone = true; }, () => { this.cacheDone = true; });
    this.meta.onChange = (groupingChanged = true, threadingChanged = groupingChanged) => this.metaChanged(groupingChanged, threadingChanged);
    const meta = this.meta.init().then(() => { mailCache.onBody = (message, full) => this.meta.prime(message, full); }).then(mark("meta"));
    // Last session's account list draws the sidebar and first view at once; Thunderbird's own list
    // (slow at start-up, while its main thread is busy) replaces it when it arrives.
    const accounts = this.loadSavedAccounts().then((saved) => {
      const fresh = this.loadAccounts({ unread: "later" });
      return saved ? (void fresh.catch(() => {}), undefined) : fresh;
    }).then(mark("accounts"));
    const intents = Promise.resolve(api.storage.local.get?.("archiveIntents"))
      .then((saved: any) => { this.archiveIntents = prune({ ...(saved?.archiveIntents || {}), ...this.archiveIntents }, Date.now()); })
      .catch(() => {});
    await Promise.all([version, settings, cache, meta, accounts, intents]);
    this.meta.me = this.me;
    this.listen();
    // Mail Thunderbird adds without announcing it (its Exchange support reports no new mail, so neither the
    // new-mail event nor a folder-count change reaches Ember) would stay off the list until a reload: while
    // Ember is in front, the listed folders' counts are compared every minute and when it comes forward.
    setInterval(() => void this.pollListedFolders(), POLL_MS);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void this.pollListedFolders(); });
    setInterval(() => void this.retryWaitingArchives(), RETRY_EVERY_MS);
    // Thunderbird suspends an idle background after ~30 s. Each wake-up then cost the next new email
    // a cache reload (1.5 s before its preview) and this page a full re-transfer of every saved
    // header, and listeners such as "open this notification in Ember" were gone. While Ember is
    // open (always, in Ember-only mode) it keeps the background awake.
    setInterval(() => { void Promise.resolve(api.runtime.sendMessage?.({ type: "spark:keepalive" })).catch(() => {}); }, 20000);
    this.ready = true;
    void this.placeWindow();
    // CacheService owns ongoing fills even with no app tabs open.
    await this.setView(this.homeView());
    mark("first-view")();
    api.storage.onChanged?.addListener((changes: any, area: string) => {
      if (area !== "local") return;
      if (changes.sparkOpenMessage?.newValue) void this.takeOpenRequest(changes.sparkOpenMessage.newValue);
      if (changes.sparkOpenBrief?.newValue) void this.takeBriefRequest(changes.sparkOpenBrief.newValue);
      if (changes.aiCategories) this.takeAiAnswers(changes.aiCategories.newValue);
      if (changes.aiGroups) this.takeAiGroups(changes.aiGroups.newValue);
      if (changes.agentMarks) this.takeMarks(changes.agentMarks.newValue);
      if (changes.agentActivity && !this.writingActivity) { this.agentActivity = readLog(changes.agentActivity.newValue); this.queueDraftCheck(); }
      if (changes.agentRegistry && !this.writingRegistry) this.agentRegistry = changes.agentRegistry.newValue || null;
      if (changes.agentReviewDismissed) this.activityDismissed = new Set(changes.agentReviewDismissed.newValue || []);
      if (changes.agentHoldStates) this.agentHoldStates = changes.agentHoldStates.newValue || {};
      if (changes.spamFeedback) this.spamFeedback = readFeedback(changes.spamFeedback.newValue);
      if (changes.spamMoved?.newValue) this.takeSpamMoved(changes.spamMoved.newValue);
      if (changes.aiSortStatus) this.aiSortStatus = changes.aiSortStatus.newValue || null;
      if (changes.travelBookings) this.takeTravel(changes.travelBookings.newValue);
      if (changes.clockOffset) { this.clockOffset = Number(changes.clockOffset.newValue) || 0; this.clock = Date.now() + this.clockOffset; }
      if (changes.sparkOpenTrip?.newValue) void this.takeTripRequest(changes.sparkOpenTrip.newValue);
    });
    setInterval(() => { this.clock = Date.now() + this.clockOffset; }, 60000);
    void Promise.resolve(api.storage.local.get?.(["sparkOpenMessage", "sparkOpenBrief", "aiCategories", "aiGroups", "aiSortStatus", "agentMarks", "travelBookings", "sparkOpenTrip", "clockOffset", "spamFeedback", "agentActivity", "agentRegistry", "agentReviewDismissed", "agentHoldStates"])).then((s: any) => {
      this.agentHoldStates = s?.agentHoldStates || {};
      this.agentActivity = readLog(s?.agentActivity);
      this.agentRegistry = s?.agentRegistry || null;
      this.activityDismissed = new Set(s?.agentReviewDismissed || []);
      this.queueDraftCheck();
      this.spamFeedback = readFeedback(s?.spamFeedback);
      this.clockOffset = Number(s?.clockOffset) || 0; this.clock = Date.now() + this.clockOffset;
      if (s?.agentMarks) this.takeMarks(s.agentMarks);
      this.takeTravel(s?.travelBookings);
      void this.takeOpenRequest(s?.sparkOpenMessage); void this.takeBriefRequest(s?.sparkOpenBrief); void this.takeTripRequest(s?.sparkOpenTrip);
      if (s?.aiCategories) this.takeAiAnswers(s.aiCategories);
      if (s?.aiGroups) this.takeAiGroups(s.aiGroups);
      this.aiSortStatus = s?.aiSortStatus || null;
    }).catch(() => {});
    void this.announceUpdate().catch(() => {});
    // AI agents (MCP): answer their requests from this window, and open the socket if Settings allow.
    void this.syncAgents();
  }

  /** AI agents (MCP) are answered from the Ember window: open or close the socket to match Settings, and
   *  say how it went (storage `agentStatus`, shown in the Settings window). */
  private async syncAgents() {
    const status = await import("./agent-bridge").then((bridge) => bridge.syncAgentBridge()).catch((error: any) => ({ error: error?.message || String(error) }));
    this.agentSocket = status;
    // The plain value: storage can't copy the reactive one this.agentSocket now holds.
    void Promise.resolve(api.storage.local.set({ agentStatus: status ?? null })).catch(() => {});
  }

  async loadSettings() {
    try {
      const s = await api.storage.local.get({ ...DEFAULT_SETTINGS, updateStatus: null, followUps: {}, aiSortStatus: null, agentStatus: null, focusState: null, travelStatus: null, mailLinkStatus: null });
      const { updateStatus, followUps, aiSortStatus, agentStatus, focusState, travelStatus, mailLinkStatus, ...settings } = s;
      this.mailLinkStatus = mailLinkStatus;
      this.focusState = focusState;
      this.travelStatus = travelStatus;
      this.settings = { ...DEFAULT_SETTINGS, ...settings };
      this.updateStatus = updateStatus;
      this.followUps = followUps || {};
      this.aiSortStatus = aiSortStatus;
      if (!this.ready) this.agentSocket = agentStatus;
    } catch {
      /* defaults */
    }
    if (!this.watchingUpdates) {
      this.watchingUpdates = true;
      api.storage.onChanged?.addListener((changes: any, area: string) => {
        if (area !== "local") return;
        if (changes.updateStatus) this.updateStatus = changes.updateStatus.newValue ?? null;
        if (changes.followUps) this.followUps = changes.followUps.newValue ?? {};
        if (changes.aiSortStatus) this.aiSortStatus = changes.aiSortStatus.newValue || null;
        if (changes.focusState) this.focusState = changes.focusState.newValue || null;
        if (changes.travelStatus) this.travelStatus = changes.travelStatus.newValue || null;
        if (changes.mailLinkStatus) this.mailLinkStatus = changes.mailLinkStatus.newValue || null;
        if (changes.agentStatus && !this.ready) this.agentSocket = changes.agentStatus.newValue ?? null;
        // Settings changed in another Ember page (the Settings window, or Ember itself).
        for (const key of Object.keys(changes)) {
          if (!(key in DEFAULT_SETTINGS) || changes[key].newValue === undefined) continue;
          const k = key as keyof Settings, v = changes[key].newValue;
          if (JSON.stringify(this.settings[k]) !== JSON.stringify(v)) void this.applySetting(k, v, false);
        }
      });
    }
  }
  private watchingUpdates = false;

  // ================= memory =================

  /** Ember has been hidden for a while: let go of what's quick to load again (bodies, images, other
   *  views). The open view and anything on screen stay as they are. */
  trimMemory() {
    this.viewCache.keepOnly(this.view);
    (mailCache as { trimMemory?: () => void }).trimMemory?.();
    perf.record("note", { text: "memory trimmed (hidden)" });
  }

  // ================= follow-up reminders =================

  /** Open the sent email of a follow-up reminder. */
  async openFollowUp(f: FollowUp) {
    // Saved mail first (the sent email usually is): Thunderbird's Message-ID search walks every folder.
    const message = mailCache.all().find((m) => m.headerMessageId && messageId(m.headerMessageId) === messageId(f.mid))
      ?? (await api.messages.query({ headerMessageId: f.mid }).catch(() => null))?.messages?.[0];
    if (message) await this.openMessage(message.id);
    else this.toast({ text: "Couldn't find that sent email. It may have been deleted.", kind: "error" });
  }
  async cancelFollowUp(mid: string) {
    try { await api.runtime.sendMessage({ type: "spark:follow-up", cancel: mid }); }
    catch (error: any) { this.toast({ text: `Couldn't remove the reminder: ${error?.message || error}`, kind: "error" }); }
  }

  // ================= updates =================

  async checkForUpdate() {
    try { this.updateStatus = await api.runtime.sendMessage({ type: "spark:update", install: "never" }); }
    catch (error: any) { this.toast({ text: `Couldn't check for updates: ${error?.message || error}`, kind: "error" }); }
  }
  /** Install now; Ember restarts as the new version (this page closes). */
  async installUpdate() {
    if (this.updateStatus) this.updateStatus = { ...this.updateStatus, installing: true, error: undefined };
    try {
      const status = await api.runtime.sendMessage({ type: "spark:update", install: "now" });
      this.updateStatus = status;
      if (status?.error) this.toast({ text: `Couldn't update Ember: ${status.error}`, kind: "error", timeout: 8000 });
    } catch (error: any) { this.toast({ text: `Couldn't update Ember: ${error?.message || error}`, kind: "error" }); }
  }
  /** First start of a new version: say so, with its notes. */
  private async announceUpdate() {
    const version = api.runtime.getManifest().version;
    const { sparkVersion, updateFolder } = await api.storage.local.get({ sparkVersion: "", updateFolder: "" });
    if (sparkVersion === version) return;
    await api.storage.local.set({ sparkVersion: version });
    if (!sparkVersion) return;
    const notes = env.hasUpdates ? { label: "What's new", run: () => { void api.sparkUpdate.openNotes(updateFolder || undefined).catch(() => {}); } } : undefined;
    // Updates install while Ember is minimized or in the background: say so once it's on screen.
    if (document.visibilityState !== "visible") await new Promise((resolve) => document.addEventListener("visibilitychange", function shown() {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", shown);
      resolve(null);
    }));
    this.toast({ text: `Ember updated to ${version}`, kind: "success", timeout: 12000, action: notes });
  }

  /** Thunderbird's account setup, to add an email account (its window shows for it). */
  async addAccount() {
    try {
      if (typeof api.sparkWindow?.openAccountSetup !== "function") throw new Error("this Thunderbird can't open it from Ember");
      await api.sparkWindow.openAccountSetup();
    } catch (error: any) {
      this.toast({ text: `Couldn't open Thunderbird's account setup: ${error?.message || error}. In Thunderbird: Settings → Account Settings → Account Actions → Add Mail Account.`, kind: "error", timeout: 12000 });
    }
  }

  async setSetting<K extends keyof Settings>(k: K, v: Settings[K]) {
    // First, so this page doesn't take its own change for another page's; put back if it isn't saved.
    const before = this.settings[k];
    this.settings[k] = v;
    try { await api.storage.local.set({ [k]: v }); }
    catch (error) { this.settings[k] = before; throw error; }
    await this.applySetting(k, v, true);
  }

  /** A setting's new value, from this page (`own`) or another one (the Settings window). */
  private async applySetting<K extends keyof Settings>(k: K, v: Settings[K], own: boolean) {
    this.settings[k] = v;
    if (k === "groupConversations") this.rev++;
    if (k === "aiSort") this.metaGroupRev++;
    // Only the Ember window answers agents.
    if (k === "agentAccess" && this.ready) await this.syncAgents();
    if (k === "perfRecorder" && this.ready) perf.setEnabled(!!v, () => api.windows.getCurrent());
    if (k === "windowMode") {
      // Move Ember to match: the background opens the window (closing tabs) or a tab.
      if (own) await api.runtime.sendMessage({ type: "spark:open" });
      if (!v && this.inWindow) window.close();
    }
  }

  /** Thunderbird's accounts without their folders' counts (the Settings window's nicknames). */
  async loadAccountList() {
    try { this.applyAccounts(await api.accounts.list(false)); } catch { /* none shown */ }
  }

  /** Draw from the account list saved last time (true when there was one). */
  private async loadSavedAccounts(): Promise<boolean> {
    try {
      const { accountsSnapshot } = await api.storage.local.get("accountsSnapshot");
      if (!Array.isArray(accountsSnapshot) || !accountsSnapshot.length) return false;
      this.applyAccounts(accountsSnapshot);
      return true;
    } catch { return false; }
  }

  /** Thunderbird's account list. `unread: "later"` doesn't wait for every folder's unread count (one
   *  request each; over a hundred with several accounts) before returning. */
  async loadAccounts({ unread = "now" }: { unread?: "now" | "later" } = {}) {
    const accounts: MailAccount[] = await api.accounts.list(true);
    const before = this.folderSignature();
    this.applyAccounts(accounts);
    this.accountsKnown = true;
    void Promise.resolve(api.storage.local.set({ accountsSnapshot: accounts })).catch(() => {});
    // Something changed since the list was drawn (a new account or folder; also the very first account, when
    // there were no folders before): load again.
    if (before !== this.folderSignature() && this.ready) void this.reload();
    if (unread === "later") void this.refreshUnread().catch(() => {});
    else await this.refreshUnread();
  }

  private folderSignature(): string {
    return Array.from(this.folderById.keys()).sort().join("\n");
  }

  private applyAccounts(accounts: MailAccount[]) {
    const nodes: AccountNode[] = [];
    const ids: MailIdentity[] = [];
    this.folderById.clear();
    this.me.clear();
    this.quickCategories.clear();
    for (const a of accounts) {
      for (const idn of a.identities || []) {
        ids.push(idn);
        if (idn.email) this.me.add(idn.email.toLowerCase());
      }
      const roots = a.folders ?? a.rootFolder?.subFolders ?? [];
      const flat: FolderNode[] = [];
      const walk = (fs: MailFolder[], depth: number) => {
        for (const f of fs) {
          if (!f.accountId) f.accountId = a.id;
          this.folderById.set(f.id, f);
          flat.push({ folder: f, depth, role: roleOf(f) });
          if (f.subFolders?.length) walk(f.subFolders, depth + 1);
        }
      };
      walk(roots, 0);
      const primary = flat
        .filter((n) => n.role && n.role !== "outbox" && n.role !== "templates")
        .sort((x, y) => ROLE_ORDER.indexOf(x.role!) - ROLE_ORDER.indexOf(y.role!));
      const others = flat.filter((n) => !primary.includes(n));
      nodes.push({ account: a, primary, others });
    }
    // Accounts with identities (real mail accounts) first; Local Folders last.
    nodes.sort((x, y) => (y.account.identities?.length ? 1 : 0) - (x.account.identities?.length ? 1 : 0));
    this.viewCache.markDirty();
    this.accounts = nodes;
    this.identities = ids;
  }

  async refreshUnread() {
    const out: Record<string, number> = {};
    await Promise.all(
      Array.from(this.folderById.values()).map(async (f) => {
        try {
          const info = await api.folders.getFolderInfo(f.id);
          out[f.id] = info.unreadMessageCount || 0;
          if (typeof info.totalMessageCount === "number" && !this.folderTotals.has(f.id)) this.folderTotals.set(f.id, info.totalMessageCount);
        } catch {
          /* virtual/unavailable */
        }
      }),
    );
    this.unread = out;
  }

  /** Every account's inbox, or only the Work or Personal accounts'. */
  inboxFolders(inbox?: InboxId): MailFolder[] {
    const out: MailFolder[] = [];
    for (const a of this.accounts) if (!inbox || this.inboxOfAccount(a.account.id) === inbox) for (const f of a.primary) if (f.role === "inbox") out.push(f.folder);
    return out;
  }

  /** Clef's answers (ai-sort.ts), by Message-ID; used when AI sorting is on and Clef was sure enough. */
  private aiAnswers: AiAnswers = {};
  private aiRegroupTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped when Clef's answers change (rows redraw their signal badges). */
  aiRev = $state(0);
  /** A signal filter inside a section: People → Needs reply / Important, Updates → Receipts,
   *  Newsletters → Reading / Promotions. "" for all. Reset when the view changes. */
  signalFilter = $state<"" | AiSignal | "reading">("");
  /** Whether a signal applies to an email: a mark (agent or user) decides, else Clef (when AI sorting is on). */
  messageSignal(m: MessageHeader, signal: AiSignal): boolean {
    if (signal === "reply" || signal === "important") {
      const marked = markOf(this.agentMarks, m)?.[signal];
      if (marked !== undefined) return marked;
    }
    return this.settings.aiSort && aiSignal(this.aiAnswers, m, signal);
  }
  /** Whether a signal applies to a conversation (judged by its newest email). */
  aiSignalOf(c: Conversation, signal: AiSignal): boolean {
    if (signal === "reply" && (c.cat !== "people" && !markOf(this.agentMarks, c.latest)?.reply || this.me.has(emailOf(c.latest.author)))) return false;
    return this.messageSignal(c.latest, signal);
  }

  /** Marks from an agent (MCP) or the user: needs reply, important, top. */
  agentMarks: AgentMarks = {};
  private takeMarks(marks: AgentMarks | undefined) { this.agentMarks = marks || {}; this.aiRev++; }
  /** Whether a conversation sits at the top of the inbox. */
  isTop(c: Conversation): boolean {
    const messages = c.ids.map((id) => this.get(id)).filter(Boolean) as MessageHeader[];
    return topOf(this.agentMarks, messages.length ? messages : [c.latest], this.me.has(emailOf(c.latest.author)));
  }
  hasMarks() { this.aiRev; return Object.keys(this.agentMarks).length > 0; }
  /** The Message-ID of a reply draft an agent wrote for a conversation (until the user has replied). */
  agentDraftOf(c: Conversation): string | null {
    if (this.me.has(emailOf(c.latest.author))) return null;
    for (const id of c.ids) { const m = this.get(id); const draft = m && markOf(this.agentMarks, m)?.draft; if (draft) return draft; }
    return markOf(this.agentMarks, c.latest)?.draft || null;
  }
  /** Forget a draft link (the draft was sent or deleted). */
  clearAgentDraft(c: Conversation) {
    const ids = c.ids.map((id) => this.get(id)?.headerMessageId).filter(Boolean) as string[];
    return this.setMarks(ids.length ? ids : [c.latest.headerMessageId], { draft: null }, "user");
  }
  // ================= agent activity (agent-activity.ts) =================

  /** What agents did, newest first (storage agentActivity), and the agents Ember has seen (agentRegistry). */
  agentActivity = $state<ActivityEntry[]>([]);
  agentRegistry = $state<AgentRegistry | null>(null);
  activityDismissed = $state<Set<string>>(new Set());
  /** Agents' reply drafts: still in Drafts, sent, or gone (checked when Agent Activity opens or the log changes). */
  agentDraftStates = $state<Record<string, DraftState>>({});
  private writingActivity = false;
  private writingRegistry = false;
  private activityTimer: ReturnType<typeof setTimeout> | undefined;
  private activitySeq = 0;

  /** One answered agent request, kept (one storage write for a burst of them). */
  logAgent(entry: ActivityEntry | null) {
    if (!entry) return;
    this.agentActivity = addEntry(this.agentActivity, { ...entry, id: entry.id + "-" + (this.activitySeq++).toString(36) }, Date.now(), this.settings.agentActivityDays);
    clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => this.saveActivity(), 400);
    if (entry.kind === "draft" || entry.kind === "mark") this.queueDraftCheck();
  }
  private async saveActivity() {
    this.writingActivity = true;
    try { await api.storage.local.set({ agentActivity: $state.snapshot(this.agentActivity) }); } catch { /* full storage: kept in memory */ } finally { this.writingActivity = false; }
  }
  /** An agent's request arrived: remember the agent; a new one is announced (Settings → AI agents). */
  agentSeen(agent: string, title?: string) {
    const { registry, isNew } = seenAgent(this.agentRegistry, agent, Date.now(), title);
    this.agentRegistry = registry;
    this.writingRegistry = true;
    void Promise.resolve(api.storage.local.set({ agentRegistry: $state.snapshot(registry) })).catch(() => {}).finally(() => { this.writingRegistry = false; });
    if (isNew && this.settings.agentAlert) this.toast({ text: `A new agent, ${agentLook(agent, title).name}, is using Ember`, kind: "info", timeout: 10000, action: { label: "Review", run: () => this.setView({ kind: "activity" }) } });
  }
  agentBlocked(agent: string) { return !!this.agentRegistry?.agents?.[agent]?.blocked; }
  /** Block or unblock an agent, or acknowledge a new one. */
  async setAgent(agent: string, change: { blocked?: boolean; alert?: boolean }) {
    const fresh = (await api.storage.local.get({ agentRegistry: null })).agentRegistry || this.agentRegistry;
    if (!fresh?.agents?.[agent]) return;
    const registry: AgentRegistry = { ...fresh, agents: { ...fresh.agents, [agent]: { ...fresh.agents[agent], ...change } } };
    if (change.alert === false) delete registry.agents[agent].alert;
    this.agentRegistry = registry;
    await api.storage.local.set({ agentRegistry: registry });
  }
  /** Undo an agent's mark: the emails' marks as they were before. */
  async undoAgentMark(entry: ActivityEntry) {
    if (entry.kind !== "mark" || !entry.before || entry.undone) return;
    const next = restoreMarks(this.agentMarks, entry.before);
    this.takeMarks(next);
    await api.storage.local.set({ agentMarks: next });
    this.agentActivity = this.agentActivity.map((e) => (e.id === entry.id ? { ...e, undone: true } : e));
    await this.saveActivity();
  }
  /** What the user decided about each agent's calendar hold (by activity entry id); none yet means held. */
  agentHoldStates = $state<Record<string, HoldState>>({});
  agentHoldState(e: ActivityEntry): HoldState | undefined { return e.kind === "hold" && e.hold ? this.agentHoldStates[e.id] || "held" : undefined; }
  /** An agent's hold: invite the people it suggested (Exchange sends the invitation), keep it as is, or remove it. */
  async decideHold(e: ActivityEntry, decision: "invite" | "keep" | "remove") {
    const hold = e.hold;
    if (!hold) return;
    const name = hold.subject || "the hold";
    try {
      if (decision === "invite") {
        // A plain copy: Thunderbird's side can't read the page's live (proxied) objects.
        const attendees = $state.snapshot(hold.invite).map((p) => ({ name: p.name || "", email: p.email }));
        await api.sparkCalendar.updateEvent(hold.accountId, hold.itemId, { attendees, freeBusy: "Busy" }, { send: true });
        this.toast({ text: `Invited ${hold.invite.map((p) => p.name || p.email).join(", ")} to “${name}”`, kind: "success" });
      } else if (decision === "remove") {
        await api.sparkCalendar.deleteEvent(hold.accountId, hold.itemId, {});
        this.toast({ text: `Removed the hold “${name}” from your calendar`, kind: "success" });
      } else this.toast({ text: `Kept “${name}” as a hold. Nobody was invited.`, kind: "success" });
    } catch (error: any) {
      this.toast({ text: `Couldn't change the hold “${name}”: ${error?.message || error}`, kind: "error" });
      return;
    }
    this.agentHoldStates = { ...this.agentHoldStates, [e.id]: decision === "invite" ? "invited" : decision === "keep" ? "kept" : "removed" };
    await Promise.resolve(api.storage.local.set({ agentHoldStates: $state.snapshot(this.agentHoldStates) })).catch(() => {});
    window.dispatchEvent(new Event("spark:calendar-changed"));
  }
  dismissReview(entryId: string) {
    this.activityDismissed = new Set([...this.activityDismissed, entryId]);
    void Promise.resolve(api.storage.local.set({ agentReviewDismissed: [...this.activityDismissed].slice(-500) })).catch(() => {});
  }
  async clearAgentActivity() {
    this.agentActivity = [];
    this.agentDraftStates = {};
    this.agentHoldStates = {};
    await api.storage.local.set({ agentActivity: [], agentReviewDismissed: [], agentHoldStates: {} });
  }
  /** What agents left for the user (To review; the sidebar's count). */
  get agentReview(): ReviewItem[] {
    this.aiRev;
    return reviewItems(this.agentActivity, {
      dismissed: this.activityDismissed,
      draftState: (e) => this.agentDraftState(e),
      onTop: (id) => !!markOf(this.agentMarks, { headerMessageId: id })?.top,
      holdState: (e) => this.agentHoldState(e),
    });
  }
  agentDraftState(e: ActivityEntry): DraftState | undefined {
    if (e.kind !== "draft" || !e.draft) return undefined;
    if (replacedDrafts(this.agentActivity).has(e.id)) return "replaced";
    return this.agentDraftStates[e.id];
  }
  private draftCheckTimer: ReturnType<typeof setTimeout> | undefined;
  private queueDraftCheck() { clearTimeout(this.draftCheckTimer); this.draftCheckTimer = setTimeout(() => void this.checkAgentDrafts(), 1500); }
  /** Each agent draft: still in Drafts (waiting), sent (the user's reply is in Sent), or discarded. */
  async checkAgentDrafts() {
    const replaced = replacedDrafts(this.agentActivity);
    const drafts = this.agentActivity.filter((e) => e.kind === "draft" && e.draft && !e.error && !replaced.has(e.id));
    if (!drafts.length) return;
    const sent = mailCache.all().filter((m) => this.roleOfFolder(m.folder?.id) === "sent");
    const states: Record<string, DraftState> = { ...this.agentDraftStates };
    for (const e of drafts) {
      const found = await Promise.resolve(api.messages.query({ headerMessageId: e.draft })).catch(() => null) as any;
      if (found?.messages?.some((m: MessageHeader) => this.roleOfFolder(m.folder?.id) === "drafts")) { states[e.id] = "waiting"; continue; }
      const subject = normSubject(e.emails?.[0]?.subject);
      const replied = sent.some((m) => +new Date(m.date) >= e.at - 60000 && !!subject && normSubject(m.subject) === subject);
      states[e.id] = replied ? "sent" : "discarded";
    }
    this.agentDraftStates = states;
  }
  /** Open an email an agent named (by Message-ID). */
  openEmailById(mid: string) { return this.openTripEmail(mid); }
  /** Open an agent's reply draft in the composer, or say it's gone. */
  async openAgentDraftId(draftId: string) {
    const found = await Promise.resolve(api.messages.query({ headerMessageId: draftId })).catch(() => null) as any;
    const draft = found?.messages?.find((m: MessageHeader) => this.roleOfFolder(m.folder?.id) === "drafts");
    if (draft) { const { composer } = await import("./compose.svelte"); return composer.openDraft(draft.id); }
    this.toast({ text: "That reply draft was sent or deleted.", kind: "info" });
    void this.checkAgentDrafts();
  }

  /** Change marks on emails (by Message-ID) and save them. */
  async setMarks(ids: string[], change: MarkChange, by: "agent" | "user" = "user") {
    const next = applyMarks(this.agentMarks, ids, change, by);
    this.takeMarks(next);
    await api.storage.local.set({ agentMarks: next });
    return next;
  }
  /** "Remove from top" for a conversation (all its emails). */
  removeFromTop(c: Conversation) {
    const ids = c.ids.map((id) => this.get(id)?.headerMessageId).filter(Boolean) as string[];
    return this.setMarks(ids.length ? ids : [c.latest.headerMessageId], { top: false }, "user");
  }
  moveToTop(c: Conversation) { return this.setMarks([c.latest.headerMessageId], { top: true }, "user"); }
  /** Clef's group answers for Work/Personal inboxes (ai-sort.ts), by Message-ID. */
  private aiGroups: AiGroups = {};
  private takeAiGroups(groups: AiGroups | undefined) { this.takeAiAnswers(this.aiAnswers, groups || {}); }
  private takeAiAnswers(answers: AiAnswers | undefined, groups = this.aiGroups) {
    this.aiGroups = groups;
    this.aiAnswers = answers || {};
    this.aiRev++;
    // Answers arrive 25 at a time while Clef sorts the mailbox: regroup once they settle.
    clearTimeout(this.aiRegroupTimer);
    this.aiRegroupTimer = setTimeout(() => { if (this.settings.aiSort) this.metaGroupRev++; }, 1500);
  }

  categoryOf(m: MessageHeader): Category {
    if (this.settings.aiSort && !this.me.has(emailOf(m.author))) {
      // Receipts, invoices and bills Clef recognises have their own section, whatever else it called them.
      if (aiSignal(this.aiAnswers, m, "receipt")) return "receipt";
      const ai = aiCategory(this.aiAnswers, m);
      if (ai) return ai;
    }
    // Meeting mail by its subject, also for emails classified before Calendar existed.
    if (calendarSubject(m.subject) && !this.me.has(emailOf(m.author))) return "calendar";
    const cat = this.meta.get(m)?.cat;
    if (cat) return cat;
    let quick = this.quickCategories.get(m.author);
    if (!quick) {
      if (this.quickCategories.size > 20000) this.quickCategories.clear();
      this.quickCategories.set(m.author, quick = quickClassify(m.author, this.me));
    }
    return quick;
  }

  // ================= Work and Personal inboxes (inboxes.ts) =================

  /** Whether mail is split into Work and Personal: some account is a work account, and some other has an inbox. */
  split = $derived.by(() => {
    const work = this.settings.workAccounts;
    if (!work.length) return false;
    const withInbox = this.accounts.filter((a) => a.primary.some((f) => f.role === "inbox")).map((a) => a.account.id);
    return withInbox.some((id) => work.includes(id)) && withInbox.some((id) => !work.includes(id));
  });
  /** The inbox an account's mail is in (null: one inbox for everything). */
  inboxOfAccount(accountId: string | undefined): InboxId | null { return this.split ? inboxOf(accountId, this.settings.workAccounts) : null; }
  /** Domains of the work accounts' own addresses: mail from them goes to Team. */
  private workDomains = $derived(workDomains(this.accounts.filter((a) => this.settings.workAccounts.includes(a.account.id)).flatMap((a) => (a.account.identities || []).map((i) => i.email || ""))));

  /** An email's group in its inbox: the user's sender rule, else Clef's group when sure, else the rules. Without
   *  Work/Personal inboxes, its base section (categoryOf). */
  groupOf(m: MessageHeader, inbox = this.inboxOfAccount(m.folder?.accountId)): string {
    if (!inbox) return this.categoryOf(m);
    const email = emailOf(m.author);
    const rule = this.settings.senderGroups[inbox]?.[email];
    if (rule && groupDef(inbox, rule)) return rule;
    if (this.settings.aiSort && !this.me.has(email)) { const ai = aiGroup(this.aiGroups, m, inbox); if (ai) return ai; }
    return ruleGroup(inbox, { base: this.categoryOf(m), internal: this.workDomains.has(email.split("@")[1] || ""), promotion: this.messageSignal(m, "promotion"), subject: m.subject || "" });
  }
  /** A conversation's group: its newest email from someone else of its kind (a person, when any is). */
  conversationGroup(c: Conversation, inbox?: InboxId | null): string {
    let rep = c.latest;
    if (c.cat === "people") {
      for (const id of c.ids) { const m = this.get(id); if (m && !this.me.has(emailOf(m.author)) && this.categoryOf(m) === "people") { rep = m; break; } }
    }
    return this.groupOf(rep, inbox ?? this.inboxOfAccount(rep.folder?.accountId));
  }
  /** The Work/Personal inbox a view shows (its own, its account's, or its folder's); null for others. */
  viewInbox(view: View = this.view): InboxId | null {
    if (!this.split) return null;
    if ((view.kind === "smart" || view.kind === "category") && view.inbox) return view.inbox;
    if (view.kind === "category" || (view.kind === "mailbox" && view.role === "inbox")) {
      const accountId = view.accountId || (view.kind === "category" && view.folderId ? this.folderById.get(view.folderId)?.accountId : undefined);
      return accountId ? this.inboxOfAccount(accountId) : null;
    }
    if (view.kind === "folder" && this.roleOfFolder(view.folderId) === "inbox") return this.inboxOfAccount(this.folderById.get(view.folderId)?.accountId);
    return null;
  }
  /** The tabs above an inbox: its groups (Work/Personal) or the base sections, then Pinned. */
  inboxTabs = $derived.by((): { id: string; label: string; kind: string }[] => {
    const inbox = this.viewInbox(this.view);
    const tabs = inbox
      ? groupsOf(inbox, this.settings).filter((g) => !g.hidden).map((g) => ({ id: g.id, label: g.label, kind: g.kind }))
      : (["people", "calendar", "notification", "newsletter", ...(this.settings.aiSort ? ["receipt"] : [])] as Category[]).map((cat) => ({ id: cat, label: CATEGORY_LABEL[cat], kind: cat === "notification" ? "updates" : cat }));
    return [...tabs, { id: "pinned", label: CATEGORY_LABEL.pinned, kind: "pinned" }];
  });
  /** A section's or group's name in a view. */
  sectionLabel(cat: string, view: View = this.view): string {
    const inbox = this.viewInbox(view);
    if (inbox && cat !== "pinned") return groupsOf(inbox, this.settings).find((g) => g.id === cat)?.label || cat;
    return CATEGORY_LABEL[cat as InboxCategory] || cat;
  }
  /** Where Ember opens: the Work/Personal inbox last used (Personal while Focus hides work mail), else the inbox. */
  homeView(): View {
    if (!this.split) return { kind: "smart" };
    return { kind: "smart", inbox: this.settings.lastInbox || (this.hiddenAccounts.size ? "personal" : "work") };
  }
  /** "Always put this sender in…" (null: Ember decides again). */
  async setSenderGroup(inbox: InboxId, email: string, group: string | null) {
    const own = { ...(this.settings.senderGroups[inbox] || {}) };
    if (group) own[email.toLowerCase()] = group; else delete own[email.toLowerCase()];
    await this.setSetting("senderGroups", { ...this.settings.senderGroups, [inbox]: own });
    this.aiRev++;
  }

  roleOfFolder(id: string | undefined): string | null {
    if (!id) return null;
    const f = this.folderById.get(id);
    return f ? roleOf(f) : null;
  }

  // ================= views / loading =================

  private bump() {
    if (this.bumpTimer) return;
    this.bumpTimer = setTimeout(() => {
      this.bumpTimer = null;
      this.meta.notifyPending();
      this.rev++;
      this.loadedCount = this.dataset.size;
    }, 60);
  }

  // ---- Thunderbird's junk filter guesses ----
  /** Inbox mail Thunderbird's adaptive junk filter marked junk by itself (by messageKey). Thunderbird's own window
   *  keeps such mail in the Inbox with a junk mark; so does Ember, asking "Looks like spam?". Only the user's
   *  verdict, a filter rule, the server's flag or a Spam folder hide mail. (A filter trained on spam alone marked
   *  every new email of the user's work inbox junk, and Ember hid them all.) */
  private junkGuesses = new Set<string>();
  private junkAsked = new Set<string>();
  private junkPending: MessageHeader[] = [];
  private junkTimer: ReturnType<typeof setTimeout> | undefined;
  isJunkGuess(m: MessageHeader): boolean { return !!m.junk && this.junkGuesses.has(messageKey(m)); }
  /** Junk-marked mail kept off a list (unless it turns out to be only the filter's guess). */
  private hiddenJunk(m: MessageHeader): boolean { return !!m.junk && !this.junkGuesses.has(messageKey(m)); }
  /** Ask Thunderbird, a moment later and in one go, which of these junk-marked Inbox emails are the filter's guesses;
   *  those join the list. */
  private noteJunk(msgs: Iterable<MessageHeader>) {
    if (typeof api.sparkJunk?.guesses !== "function") return;
    for (const m of msgs) {
      if (!m.junk || this.roleOfFolder(m.folder?.id) !== "inbox") continue;
      const key = messageKey(m);
      if (this.junkAsked.has(key)) continue;
      this.junkAsked.add(key);
      this.junkPending.push(m);
    }
    if (!this.junkPending.length || this.junkTimer) return;
    this.junkTimer = setTimeout(async () => {
      this.junkTimer = undefined;
      const batch = this.junkPending.splice(0);
      try {
        const guessed = new Set<number>(await api.sparkJunk.guesses(batch.map((m) => m.id)));
        const found = batch.filter((m) => guessed.has(m.id));
        if (!found.length) return;
        for (const m of found) this.junkGuesses.add(messageKey(m));
        this.aiRev++;
        const add = found.filter((m) => this.inView(m) || this.viewFolders.has(m.folder?.id || ""));
        if (add.length) this.add(add);
      } catch { for (const m of batch) this.junkAsked.delete(messageKey(m)); }
    }, 300);
  }

  private add(msgs: MessageHeader[]) {
    for (const m of msgs) {
      if (this.hiddenJunk(m) && this.view.kind !== "folder" && this.view.kind !== "mailbox") { this.noteJunk([m]); continue; }
      this.dataset.set(m.id, m);
      this.pendingLoad?.changes.set(m.id, m);
      this.noteCorrespondents(m);
    }
    this.bump();
    this.keepArchived(msgs);
  }

  isInboxView(): boolean {
    this.rev;
    const view = this.view;
    return view.kind === "smart" || view.kind === "category" || (view.kind === "mailbox" && view.role === "inbox") ||
      (view.kind === "folder" && this.roleOfFolder(view.folderId) === "inbox");
  }
  openCategory(cat: InboxCategory | (string & {})) { return this.setView(scopedCategory(cat, this.view)); }
  backToInbox() { return this.setView(categoryParent(this.view)); }

  foldersForRole(role: string, accountId?: string): MailFolder[] {
    return Array.from(this.folderById.values()).filter((folder) => roleOf(folder) === role && (!accountId || folder.accountId === accountId));
  }

  private countForView(): number { return this.listConversations.length; }

  captureListScroll?: () => void;
  listScroll(): number { return this.scrollPositions.get(navigationKey(this.view)) || 0; }
  saveListScroll(value: number, key = navigationKey(this.view)) { this.scrollPositions.set(key, value); }

  private cancelLoad() {
    this.attachmentAbort?.abort();
    this.attachmentAbort = null;
    this.loadToken++;
    this.listIds.forEach(abortList);
    this.listIds.clear();
    // Leaving (or redoing) a search: stop Thunderbird's search engine too.
    if (this.nativeSearching) { this.nativeSearching = false; void Promise.resolve(api?.sparkSearch?.cancel?.()).catch(() => {}); }
    this.pendingLoad = null;
    this.meta.clearBackground();
    clearTimeout(this.attachmentRefreshTimer);
    this.attachmentRefreshNeeded = false;
    clearTimeout(this.bumpTimer);
    this.bumpTimer = null;
  }

  async setView(v: View, opts: { keepSelection?: boolean } = {}) {
    this.captureListScroll?.();
    if (v.kind !== "category" || this.view.kind !== "category" || v.cat !== this.view.cat) this.signalFilter = "";
    const sameData = datasetKey(this.view) === datasetKey(v);
    this.view = v;
    this.clearPicks();
    const opened = (v.kind === "smart" || v.kind === "category") && v.inbox;
    if (opened && opened !== this.settings.lastInbox) void this.setSetting("lastInbox", opened).catch(() => {});
    if (!opts.keepSelection) {
      this.selectedKey = null;
      this.selectedId = null;
      this.readerOpen = false;
    }
    if (sameData && (this.hasLoadedView || this.loading)) {
      if (this.loading && this.hasLoadedView) this.refreshConversationCount = this.countForView();
      return;
    }
    if (v.kind === "trip") { this.loadTripView(v.id); return; }
    if (v.kind === "calendar") {
      // Its own page (CalendarPage.svelte), from Exchange: no list to load.
      this.cancelLoad();
      this.error = null;
      this.dataset = new Map(); this.viewFolders = new Set(); this.attachmentIds = new Set();
      this.loadedCount = 0; this.hasLoadedView = true; this.loading = false; this.rev++;
      return;
    }
    if (v.kind === "activity") {
      // Its own page (AgentActivity.svelte), from the activity log: no list to load.
      this.cancelLoad();
      this.error = null;
      this.dataset = new Map(); this.viewFolders = new Set(); this.attachmentIds = new Set();
      this.loadedCount = 0; this.hasLoadedView = true; this.loading = false; this.rev++;
      void this.checkAgentDrafts();
      return;
    }
    if (v.kind === "senders") {
      // Its own page (IgnoredSenders.svelte), worked out from saved mail: no list to load.
      this.cancelLoad();
      this.error = null;
      this.dataset = new Map(); this.viewFolders = new Set(); this.attachmentIds = new Set();
      this.loadedCount = 0; this.hasLoadedView = true; this.loading = false; this.rev++;
      void this.findIgnoredSenders();
      return;
    }
    this.cancelLoad();
    this.related.clear();
    this.relatedIds.clear();
    this.error = null;
    this.attachments = [];
    let snapshot = this.viewCache.get(v);
    // Rebuilt from scratch: older mail listed earlier isn't carried anymore, so offer it again.
    if (!snapshot) { this.olderLoaded.delete(datasetKey(v)); this.olderWanted.delete(datasetKey(v)); }
    if (!snapshot && v.kind !== "search") {
      const headers = mailCache.all();
      const pinView = v.kind === "pinned" || (v.kind === "category" && v.cat === "pinned");
      const source = v.kind === "category" ? categoryParent(v) : v;
      const folders = source.kind === "folder" ? [source.folderId] : source.kind === "mailbox" ? this.foldersForRole(source.role, source.accountId).map((f) => f.id) : this.inboxFolders(source.kind === "smart" ? source.inbox : undefined).map((f) => f.id);
      const selected = headers.filter((m) => pinView ? m.flagged && (!("accountId" in v) || !v.accountId || m.folder?.accountId === v.accountId) && (!("folderId" in v) || !v.folderId || m.folder?.id === v.folderId) && !["trash", "junk"].includes(this.roleOfFolder(m.folder?.id) || "") :
        v.kind === "attachments" ? isReceivedAttachmentMessage(m, this.me, excludedAttachmentFolders(this.folderById.values())) : folders.includes(m.folder?.id || "") && (!this.hiddenJunk(m) || v.kind === "folder" || v.kind === "mailbox"));
      if (v.kind !== "attachments" && !pinView) this.noteJunk(headers.filter((m) => m.junk && folders.includes(m.folder?.id || "")));
      if (selected.length) snapshot = { view: v, headers: new Map(selected.map((m) => [m.id, m])), folderIds: new Set(pinView || v.kind === "attachments" ? [] : folders), attachmentIds: new Set(), savedAt: 0, dirty: true };
      if (v.kind === "attachments" && selected.length) {
        const token = this.loadToken;
        const records = await mailCache.attachmentIndex().catch(() => []);
        if (token !== this.loadToken) return;
        const ids = new Set(selected.map((m) => m.id));
        this.attachments = records.filter(({ message }) => ids.has(message.id)).flatMap(({ message, files }) => files.filter(isFileAttachment).map((attachment) => ({ key: `${message.id}:${attachment.partName}`, message, attachment, domain: senderDomain(message.author) || "" })));
      }
    }
    if (snapshot) {
      this.dataset = new Map(snapshot.headers);
      this.viewFolders = new Set(snapshot.folderIds);
      this.attachmentIds = new Set(snapshot.attachmentIds);
      this.loadedCount = this.dataset.size;
      this.hasLoadedView = true;
      this.loading = false;
      this.rev++;
      this.keepArchived(this.dataset.values());
      if (!this.viewCache.needsRefresh(snapshot)) { this.backgroundClassify(); return; }
    } else {
      this.dataset = new Map();
      this.viewFolders = new Set();
      this.attachmentIds = new Set();
      this.hasLoadedView = false;
      this.loadedCount = 0;
      this.rev++;
    }
    await this.reload();
  }

  /** Whether the cache can answer for Thunderbird. One finished inventory covers every pin and 90 days
   *  of mail, kept current by message events, so later passes (or one the user interrupted) don't
   *  make it stale; file lists additionally need one finished body pass. */
  private cacheCovers(what: "pins" | "files") {
    const status = this.cacheStatus;
    if (status.phase === "paused") return false;
    return status.phase === "ready" || !!(what === "pins" ? status.lastInventoryAt || status.lastCompletedAt : status.lastCompletedAt);
  }

  /** Start-up: the view was drawn from the cache's first (newest) page; reload once all of it arrived. */
  /** Start-up lists come from the newest saved page first; the rest streams in (about a second at 20k). */
  cacheStreaming = $state(false);
  private cacheDone = false;
  /** The list came from the cache (90 days + pins); older mail in these folders isn't listed yet. */
  listFromCache = $state(false);
  /** The current list was built from the cache (so an inventory's findings need a reload to show). */
  private cacheServed = false;
  /** Folder views whose older mail was requested; their mail older than 90 days, once listed, is kept. */
  private olderWanted = new Set<string>();
  private olderLoaded = new Set<string>();
  get olderAvailable() { return this.listFromCache && !this.loading && this.view.kind !== "search" && this.view.kind !== "attachments" && !this.isPinnedView(); }
  private isPinnedView() { return this.view.kind === "pinned" || (this.view.kind === "category" && this.view.cat === "pinned"); }
  /** List mail older than the cache window (Thunderbird lists every message in these folders once). */
  loadOlder() {
    if (!this.olderAvailable) return;
    this.olderWanted.add(datasetKey(this.view));
    return this.reload();
  }

  /** Folder counts when the check below (or the background's inventory) last covered each folder. */
  private recentMarks?: Promise<Map<string, string>>;
  private coveredMarks() {
    return this.recentMarks ||= Promise.resolve().then(() => api.storage.local.get("cacheFolderMarks")).then(
      ({ cacheFolderMarks }: any) => {
        const marks = new Map(Object.entries(cacheFolderMarks?.marks || {}).map(([id, mark]) => [id, String(mark)]));
        // Each later inventory covers its folders too (at start-up it often runs alongside the first view).
        api.storage.onChanged?.addListener((changes: any, area: string) => {
          if (area !== "local" || !changes.cacheFolderMarks) return;
          const next = changes.cacheFolderMarks.newValue?.marks || {};
          for (const [id, mark] of Object.entries(next)) marks.set(id, String(mark));
          // A mark the background dropped (that folder lost mail) is no longer proof of anything here either.
          for (const id of Object.keys(changes.cacheFolderMarks.oldValue?.marks || {})) if (!(id in next)) marks.delete(id);
        });
        return marks;
      },
      () => new Map<string, string>());
  }
  /** Each folder's last-three-days safety check (cache-served views): when it ran, or the one in flight. */
  private recentChecks = new Map<string, { at: number; pending?: Promise<MessageHeader[] | null> }>();
  /** Folders that lost mail since their last walk: equal counts don't prove nothing new arrived. */
  private countsUnreliable = new Set<string>();
  /**
   * Mail Thunderbird didn't announce (an account whose new-mail events were missed) still shows up:
   * the last three days of each folder. A date search converts only those headers (a newest-first
   * listing would convert the whole folder to sort it), but it still walks the folder: about 2 s of
   * Thunderbird's main thread at 20k emails. So it runs after the cached list is shown, at most every
   * few minutes per folder, and a restarted load shares the one in flight. What it lists is
   * registered in the cache, so later cache-served visits include it.
   */
  private async checkRecent(folders: MailFolder[], token: number, ownJunk: boolean, days = 3) {
    const since = new Date(Date.now() - days * 86400000);
    const marks = await this.coveredMarks();
    const lists = await Promise.all(folders.map((folder) => {
      const last = this.recentChecks.get(folder.id);
      if (last?.pending) return last.pending;
      if (last && Date.now() - last.at < RECENT_CHECK_MS) return null;
      const entry: { at: number; pending?: Promise<MessageHeader[] | null> } = { at: Date.now() };
      // Unchanged counts since the last walk (or the background's last inventory, which re-lists every
      // folder whose counts changed): nothing can be missing, so skip the walk (unless mail left it since).
      const trustCounts = !this.countsUnreliable.delete(folder.id);
      entry.pending = folderMark(folder.id).then((mark) => trustCounts && mark && marks.get(folder.id) === mark ? [] :
        drain(api.messages.query({ folderId: folder.id, fromDate: since })).then((list) => { if (mark) marks.set(folder.id, mark); return list; }))
        .catch(() => null).then((list) => {
        entry.pending = undefined;
        if (list) entry.at = Date.now(); else this.recentChecks.delete(folder.id);
        return list;
      });
      this.recentChecks.set(folder.id, entry);
      return entry.pending;
    }));
    if (token !== this.loadToken) return;
    const known = new Set(Array.from(this.dataset.values(), messageKey));
    // A list that started before a move or delete must not bring that mail back.
    const all = lists.flatMap((list) => list || []);
    if (!ownJunk) this.noteJunk(all);
    const unknown = all.filter((m) => !(this.hiddenJunk(m) && !ownJunk) && !known.has(messageKey(m)) && !this.removedSince(m, Date.now() - 60000));
    if (unknown.length) this.add(unknown);
  }
  /** Each listed folder's counts when the list last looked (pollListedFolders). */
  private polledMarks = new Map<string, string>();
  private polling = false;
  private polls = 0;
  /** The listed folders whose counts changed since the last look are walked for mail the list doesn't have
   *  (the last 3 days; a getFolderInfo per folder otherwise). The background's inventory may already have
   *  saved that mail, which doesn't put it on this list: the walk is forced. Counts a folder reports can lag
   *  mail added without notice, so every third look walks every listed folder anyway. */
  private async pollListedFolders() {
    if (this.polling || !this.ready || this.loading || !this.shown || !this.viewFolders.size) return;
    this.polling = true;
    try {
      const token = this.loadToken;
      const every = ++this.polls % 3 === 0;
      const changed: string[] = [];
      let countsMoved = false;
      for (const id of this.viewFolders) {
        const mark = await folderMark(id);
        if (!mark) continue;
        const moved = this.polledMarks.get(id) !== mark;
        if (moved) countsMoved = true;
        if (every || moved) changed.push(id);
        this.polledMarks.set(id, mark);
      }
      if (!changed.length || token !== this.loadToken || this.loading) return;
      for (const id of changed) { this.countsUnreliable.add(id); if (!this.recentChecks.get(id)?.pending) this.recentChecks.delete(id); }
      const v = this.view;
      // The look that runs whatever the counts say covers today and yesterday (a walk of 3 days costs ~0.2 s at
      // 300 emails, on Thunderbird's main thread).
      await this.checkRecent(changed.map((id) => ({ id }) as MailFolder), token, v.kind === "folder" || v.kind === "mailbox", countsMoved ? 3 : 1);
    } finally { this.polling = false; }
  }
  private explicitRefresh = false;
  /** An explicit refresh (button, retry, resume): views served from the cache also re-ask Thunderbird. */
  refresh() {
    this.explicitRefresh = true;
    return this.reload();
  }

  /** Stage every page, then swap once. Cached lists remain visible during refresh. */
  async reload() {
    if (this.view.kind === "senders") { void this.findIgnoredSenders(); return; }
    if (this.view.kind === "activity") { void this.checkAgentDrafts(); return; }
    if (this.view.kind === "calendar") { window.dispatchEvent(new Event("spark:calendar-changed")); return; }
    if (this.view.kind === "trip") { this.loadTripView(this.view.id); return; }
    this.cancelLoad();
    const token = this.loadToken;
    const v = this.view;
    const explicit = this.explicitRefresh;
    this.explicitRefresh = false;
    let fromCache = false;
    let servedByCache = false; // also with older mail carried over (fromCache is then false)
    let afterSwap: (() => void) | undefined;
    const next = new Map<MessageId, MessageHeader>();
    const nextAttachments = new Set<MessageId>();
    const nextFiles: ReceivedAttachment[] = v.kind === "attachments" ? [...this.attachments] : [];
    const pending = { token, headers: next, changes: new Map<MessageId, MessageHeader | null>() };
    this.pendingLoad = pending;
    this.attachmentFailures = 0;
    this.attachmentsScanned = 0;
    this.attachmentDeferred = 0;
    this.attachmentStopped = false;
    this.refreshConversationCount = this.hasLoadedView ? this.countForView() : null;
    this.loading = true;
    this.error = null;
    try {
      if (v.kind === "smart" || (v.kind === "category" && v.cat !== "pinned") || v.kind === "folder" || v.kind === "mailbox") {
        const source = v.kind === "category" ? categoryParent(v) : v;
        const folders = source.kind === "folder" ? [this.folderById.get(source.folderId) || { id: source.folderId } as MailFolder] :
          source.kind === "mailbox" ? this.foldersForRole(source.role, source.accountId) : this.inboxFolders(source.kind === "smart" ? source.inbox : undefined);
        this.viewFolders = new Set(folders.map((f) => f.id));
        const key = datasetKey(v);
        // A finished inventory keeps 90 days of these folders current (message events), so the
        // cache answers without Thunderbird paging every message on its main thread (seconds on a
        // large inbox, delaying input). Thunderbird lists them on Refresh; older mail is asked for
        // once, and carried over after that.
        if (this.cacheCovers("pins") && !explicit) {
          const ids = this.viewFolders;
          const ownJunk = v.kind === "folder" || v.kind === "mailbox";
          for (const m of mailCache.all()) {
            if (!ids.has(m.folder?.id || "")) continue;
            if (!this.hiddenJunk(m) || ownJunk) next.set(m.id, m); else this.noteJunk([m]);
          }
          afterSwap = () => void this.checkRecent(folders, token, ownJunk);
          servedByCache = true;
          if (this.olderWanted.has(key) && !this.olderLoaded.has(key)) {
            // Only what the cache doesn't keep: a date search converts just the older headers
            // (listing the folder converted every one: 9.5 s and ~200 calls at 20k emails).
            const older = new Map<MessageId, MessageHeader>();
            const until = new Date(Date.now() - 90 * 86400000);
            await Promise.all(folders.map((f) => this.loadList(api.messages.query({ folderId: f.id, toDate: until }), token, older)));
            if (token !== this.loadToken) return;
            const listed = new Set(Array.from(next.values(), messageKey));
            for (const m of older.values()) if (!listed.has(messageKey(m))) next.set(m.id, m);
            this.olderLoaded.add(key);
          } else if (this.olderLoaded.has(key)) {
            const listed = new Set(Array.from(next.values(), messageKey));
            for (const m of this.dataset.values()) if (!keepMessage(m) && ids.has(m.folder?.id || "") && !listed.has(messageKey(m))) next.set(m.id, m);
          }
          fromCache = !this.olderLoaded.has(key);
        } else {
          await Promise.all(folders.map((f) => this.loadList(listFolder(f.id), token, next)));
          if (token === this.loadToken) this.olderLoaded.add(key);
        }
      } else if (v.kind === "pinned" || (v.kind === "category" && v.cat === "pinned")) {
        this.viewFolders = new Set();
        const keep = (m: MessageHeader) => {
          const role = this.roleOfFolder(m.folder?.id);
          return role !== "trash" && role !== "junk" && (!v.accountId || m.folder?.accountId === v.accountId) && (!("folderId" in v) || !v.folderId || m.folder?.id === v.folderId);
        };
        // The cache keeps every pin (any age) current through flag events. Thunderbird's
        // flagged search walks every folder on its main thread, so it runs only on Refresh.
        if (this.cacheCovers("pins") && !explicit) {
          for (const m of mailCache.all()) if (m.flagged && keep(m)) next.set(m.id, m);
        } else {
          const q = await api.messages.query({ flagged: true, returnMessageListId: true });
          await this.loadList(typeof q === "string" ? api.messages.continueList(q) : q, token, next, keep);
        }
      } else if (v.kind === "attachments") {
        this.viewFolders = new Set();
        const now = new Date();
        const excluded = excludedAttachmentFolders(this.folderById.values());
        const controller = new AbortController();
        this.attachmentAbort = controller;
        this.attachmentPhase = "query";
        // A complete local cache lists files for the whole 90-day window. Thunderbird's
        // attachment search inspects every message on its main thread (1-2 s per page),
        // delaying input, so it runs only on an explicit refresh or while the cache is filling.
        const scanRequested = explicit;
        // A complete cache answers even when it has no files (null: ask Thunderbird).
        const cached = this.cacheCovers("files") && !scanRequested
          ? (await mailCache.attachmentIndex().catch(() => null))?.filter(({ message }) => isReceivedAttachmentMessage(message, this.me, excluded, now)) ?? null
          : null;
        if (token !== this.loadToken) return;
        if (cached) {
          nextFiles.length = 0; // complete list: replaces the instant snapshot rather than adding to it
          for (const { message, files } of cached) {
            next.set(message.id, message);
            nextFiles.push(...files.filter(isFileAttachment).map((attachment) => ({ key: `${message.id}:${attachment.partName}`, message, attachment, domain: senderDomain(message.author) || "" })));
          }
        } else {
          const query = api.messages.query({ attachment: true, fromDate: attachmentCutoff(now), toDate: now, returnMessageListId: true });
          query.then((late: MessageList | string) => { if (controller.signal.aborted || token !== this.loadToken) abortList(typeof late === "string" ? late : late.id); }).catch(() => {});
          const q = await withDeadline(query, 20000, controller.signal, "Finding attachment messages");
          await this.loadList(typeof q === "string" ? api.messages.continueList(q) : q, token, next,
            (m) => isReceivedAttachmentMessage(m, this.me, excluded, now));
          if (token !== this.loadToken) return;
          this.attachmentPhase = "files";
          // Publish results as they arrive; a slow/offline message cannot hide every file.
          this.dataset = next;
          this.hasLoadedView = true;
          this.rev++;
          const messages = Array.from(next.values()).sort((a, b) => +new Date(b.date) - +new Date(a.date));
          this.loadedCount = messages.length;
          const release = this.meta.hold();
          try { await collectAttachments(messages, {
            signal: controller.signal,
            list: (id) => this.listFileMetadata(id),
            active: () => token === this.loadToken,
            onMessage: (message, files) => {
              this.attachmentsScanned++;
              for (let i = nextFiles.length - 1; i >= 0; i--) if (messageKey(nextFiles[i].message) === messageKey(message)) nextFiles.splice(i, 1);
              nextFiles.push(...files.map((attachment) => ({ key: `${message.id}:${attachment.partName}`, message, attachment, domain: senderDomain(message.author) || "" })));
              this.attachments = [...nextFiles];
            },
            onError: () => { this.attachmentsScanned++; this.attachmentFailures++; },
            onDeferred: (count) => { this.attachmentDeferred = count; },
          }); } finally { release(); }
          this.attachmentStopped = controller.signal.aborted;
        }
      } else if (v.kind === "search") {
        this.viewFolders = new Set();
        if (v.scope !== "all") {
          const result = await mailCache.search(v.query, v.filters);
          if (token !== this.loadToken) return;
          this.searchCoverage = { indexed: result.indexed, cached: result.cached };
          for (const message of result.messages) if (this.roleOfFolder(message.folder?.id) !== "junk") next.set(message.id, message);
        } else {
          // Thunderbird's search of all mail can take many seconds: show the saved-mail matches at once,
          // then add what Thunderbird finds (the same email found both ways is listed once).
          const saved = await mailCache.search(v.query, v.filters).catch(() => null);
          if (token !== this.loadToken) return;
          if (saved?.messages.length) {
            for (const message of saved.messages) if (this.roleOfFolder(message.folder?.id) !== "junk") next.set(message.id, message);
            this.dataset = new Map(next); this.hasLoadedView = true; this.loadedCount = next.size; this.rev++;
          }
          const native = !v.filters?.hasAttachments && typeof api.sparkSearch?.search === "function";
          let searched = false;
          if (native) {
            // Thunderbird's own search engine: subjects, senders and recipients first (instant), then bodies.
            const keep = this.searchKeep(v.filters);
            this.nativeSearching = true;
            const quick = await api.sparkSearch.search(v.query, { headersOnly: true, limit: 2000 }).catch(() => null);
            if (token !== this.loadToken) return;
            if (quick && !quick.interrupted) {
              for (const message of quick.messages) if (keep(message)) next.set(message.id, message);
              this.dataset = new Map(next); this.hasLoadedView = true; this.loadedCount = next.size; this.rev++;
            }
            const full = await api.sparkSearch.search(v.query, { limit: 2000 }).catch(() => null);
            if (token !== this.loadToken) return;
            this.nativeSearching = false;
            if (full && !full.interrupted) {
              for (const message of full.messages) if (keep(message)) next.set(message.id, message);
              searched = true;
            }
          }
          if (!searched) await this.runSearch(v.query, token, next, v.filters);
          const byKey = new Map<string, MessageId>();
          for (const [id, message] of next) {
            const key = messageKey(message), other = byKey.get(key);
            if (other === undefined) byKey.set(key, id);
            else if (other < 0 && id >= 0) { next.delete(other); byKey.set(key, id); } // prefer Thunderbird's live copy
            else next.delete(id);
          }
        }
      }
      if (token !== this.loadToken) return;
      // Events that arrived during paging win over an older backend page.
      for (const [id, message] of pending.changes) {
        if (message) next.set(id, message);
        else next.delete(id);
      }
      this.dataset = next;
      this.listFromCache = fromCache;
      this.cacheServed = servedByCache;
      this.readerRev++;
      this.attachmentIds = nextAttachments;
      const currentByKey = new Map(Array.from(next.values(), (message) => [messageKey(message), message]));
      this.attachments = nextFiles.flatMap((file) => { const message = currentByKey.get(messageKey(file.message)); return message ? [{ ...file, message, key: `${message.id}:${file.attachment.partName}` }] : []; });
      this.hasLoadedView = true;
      this.loadedCount = next.size;
      this.rev++;
      for (const message of next.values()) this.noteCorrespondents(message);
      this.viewCache.put(v, next, this.viewFolders, nextAttachments);
      if (this.viewFolders.size) this.loadAttachmentFlags(token);
      afterSwap?.();
      this.keepArchived(next.values());
    } catch (e: any) {
      if (token === this.loadToken) {
        if (e?.name === "AbortError") this.attachmentStopped = true;
        else {
          this.error = e?.message || String(e);
          if (v.kind === "attachments") this.attachmentAbort?.abort();
        }
      }
    } finally {
      if (token === this.loadToken) {
        this.pendingLoad = null;
        this.attachmentPhase = "done";
        this.loading = false;
        this.refreshConversationCount = null;
        this.rev++;
        if (this.readerOpen && !this.selected) this.select(null);
        this.backgroundClassify();
        if (v.kind === "attachments" && this.attachmentRefreshNeeded && !this.attachmentStopped) {
          this.attachmentRefreshNeeded = false;
          this.refreshAttachmentsSoon();
        }
      }
    }
  }

  private listFileMetadata(id: number): Promise<import("./types").MessageAttachment[]> {
    const cached = this.attachmentMetadata.get(id);
    if (cached) return Promise.resolve(cached);
    let request = this.attachmentRequests.get(id);
    if (!request) {
      request = Promise.resolve().then(() => api.messages.listAttachments(id)).then((files) => {
        this.attachmentMetadata.set(id, files);
        if (this.attachmentMetadata.size > 2000) this.attachmentMetadata.delete(this.attachmentMetadata.keys().next().value!);
        return files;
      }).finally(() => this.attachmentRequests.delete(id));
      this.attachmentRequests.set(id, request);
    }
    return request;
  }

  stopAttachmentScan() { this.attachmentAbort?.abort(); }

  private async loadList(first: Promise<MessageList> | MessageList, token: number, target: Map<MessageId, MessageHeader>, filter?: (m: MessageHeader) => boolean) {
    const attachmentScan = this.view.kind === "attachments";
    const signal = this.attachmentAbort?.signal;
    if (attachmentScan) Promise.resolve(first).then((late) => { if (signal?.aborted || token !== this.loadToken) abortList(late?.id); }).catch(() => {});
    let page = attachmentScan ? await withDeadline(Promise.resolve(first), 20000, this.attachmentAbort?.signal, "Finding attachment messages") : await first;
    if (token !== this.loadToken) { abortList(page?.id); return; }
    while (page && token === this.loadToken) {
      if (page.id) this.listIds.add(page.id);
      for (const message of page.messages) {
        if (filter && !filter(message)) continue;
        if (this.hiddenJunk(message) && this.view.kind !== "folder" && this.view.kind !== "mailbox") { this.noteJunk([message]); continue; }
        target.set(message.id, message);
      }
      if (!this.hasLoadedView) this.loadedCount = target.size;
      if (!page.id) break;
      const pageId = page.id;
      try {
        const work = api.messages.continueList(pageId);
        page = attachmentScan ? await withDeadline(work, 20000, this.attachmentAbort?.signal, "Finding attachment messages") : await work;
      } catch (error) { this.listIds.delete(pageId); abortList(pageId); throw error; }
      if (!page?.id) this.listIds.delete(pageId);
      if (token !== this.loadToken) abortList(page?.id);
    }
  }

  private nativeSearching = false;
  private searchKeep(filters: SearchFilters = {}) {
    return (m: MessageHeader) => this.roleOfFolder(m.folder?.id) !== "junk" && matchesSearchHeader(m, filters);
  }

  private async runSearch(q: string, token: number, target: Map<MessageId, MessageHeader>, filters: SearchFilters = {}) {
    const text = q.trim();
    // fullText covers subject, body and author. Thunderbird's matching turned out to be
    // case-sensitive for some fields, so query a few case variants and merge (dedupe by id).
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
    const variants = Array.from(
      new Set([text, text.toLowerCase(), cap(text.toLowerCase()), text.toLowerCase().split(/\s+/).map(cap).join(" ")]),
    );
    const keep = this.searchKeep(filters);
    await Promise.all(
      variants.map(async (q) => {
        const first = await api.messages.query({ ...(q ? { fullText: q } : {}), ...(filters.hasAttachments ? { attachment: true } : {}), ...(filters.unread ? { unread: true } : {}), returnMessageListId: true });
        await this.loadList(typeof first === "string" ? api.messages.continueList(first) : first, token, target, keep);
      }),
    );
  }

  /**
   * Paperclips come from the local cache's attachment lists. Thunderbird answers an
   * `attachment: true` query by inspecting every message on its main thread (1-2 s per
   * page on large inboxes), which delayed clicks for the whole scan.
   */
  private async loadAttachmentFlags(token: number) {
    const view = this.view;
    try {
      const keys = new Set(await mailCache.attachmentKeys());
      if (token !== this.loadToken) return;
      for (const message of this.dataset.values()) if (keys.has(messageKey(message))) this.attachmentIds.add(message.id);
      this.bump();
      this.viewCache.setAttachmentFlags(view, this.attachmentIds);
    } catch {
      /* Cache unavailable: the reader's MIME metadata still supplies flags. */
    }
  }

  /** Classify (headers only) the most recent N messages of the dataset in the background. */
  private backgroundClassify() {
    const v = this.view;
    if (!this.isInboxView()) return;
    const recent = Array.from(this.dataset.values())
      .sort((a, b) => +new Date(b.date) - +new Date(a.date))
      .slice(0, 600); // each classification streams the message (IMAP: a server fetch) — keep it modest
    for (const m of recent) this.meta.request(m, "h", 2);
  }

  /** Called by the virtual list for rows currently on screen. */
  requestVisible(convs: Conversation[]) {
    this.meta.clearVisible();
    for (const c of convs) {
      const m = this.dataset.get(c.ids[0]);
      if (m) this.meta.request(m, "f", 0);
    }
  }

  get(id: MessageId): MessageHeader | undefined {
    return this.dataset.get(id) || this.related.get(id);
  }

  headersOf(c: Conversation): MessageHeader[] {
    return c.ids.map((id) => this.dataset.get(id)).filter(Boolean) as MessageHeader[];
  }

  // ================= selection =================

  /** Show one message (e.g. a clicked new-mail notification): Smart Inbox for inbox mail, else its folder. */
  async openMessage(id: number) {
    const header: MessageHeader | undefined = await api.messages.get(id).catch(() => undefined);
    if (!header) return;
    this.shown = true; // Ember is being shown for this (it may still be minimized): group the list now
    const folderId = header.folder?.id;
    const inbox = this.inboxOfAccount(header.folder?.accountId);
    const view: View = !folderId || this.roleOfFolder(folderId) === "inbox" ? (inbox ? { kind: "smart", inbox } : { kind: "smart" }) : { kind: "folder", folderId };
    if (datasetKey(view) !== datasetKey(this.view) || this.view.kind === "category") await this.setView(view);
    const key = messageKey(header);
    if (![...this.dataset.values()].some((m) => messageKey(m) === key)) this.add([header]);
    const conversation = this.conversations.find((c) => c.ids.some((mid) => { const m = this.get(mid); return !!m && messageKey(m) === key; }));
    if (conversation) this.select(conversation.key);
  }
  /** A message Ember was asked to show while it was closed or opening (notification click). */
  private async takeOpenRequest(request?: { id?: number; missing?: boolean; at: number }) {
    if (!request || Date.now() - request.at > 30000) return;
    await api.storage.local.remove("sparkOpenMessage").catch(() => {});
    if (request.missing) { this.shown = true; this.toast({ text: "That email isn't in Thunderbird any more.", kind: "info" }); return; }
    if (request.id !== undefined) await this.openMessage(request.id);
  }

  /** Links that open an email: their address while Thunderbird answers them ({ url }), or why not ({ error }). */
  mailLinkStatus = $state<{ url?: string; error?: string } | null>(null);
  /** The link to an email, or null while links are off. Its code is kept, so it opens even once Ember no
   *  longer saves the email. */
  emailLink(m: Pick<MessageHeader, "headerMessageId"> | undefined): string | null {
    const base = this.mailLinkStatus?.url;
    const key = m ? aiKey(m) : "";
    if (!base || !key) return null;
    this.keepLinks([key]);
    return mailLink(base, key);
  }
  /** Keep links' codes (mail-links.ts), one storage write for a burst of them. */
  private keptLinks: string[] = [];
  keepLinks(ids: string[]) {
    if (!this.keptLinks.length) setTimeout(() => {
      const ids = this.keptLinks;
      this.keptLinks = [];
      void Promise.resolve(api.storage.local.get({ mailLinks: {} })).then((s: any) => {
        const next = keepLinks(readKept(s?.mailLinks), ids);
        if (next) return api.storage.local.set({ mailLinks: next });
      }).catch(() => {});
    }, 200);
    this.keptLinks.push(...ids);
  }
  /** Right-click → Copy link: a link that opens this conversation's newest email in Ember. */
  async copyLink(c: Conversation) {
    const link = this.emailLink(c.latest);
    if (!link) return;
    try { await navigator.clipboard.writeText(link); this.toast({ text: "Link copied: it opens this email in Ember", kind: "success", timeout: 2500 }); }
    catch { this.toast({ text: "Couldn't copy the link.", kind: "error" }); }
  }

  /** The agents' socket while it's open ({ path }), or why it couldn't open ({ error }), for Settings. */
  agentSocket = $state<{ path?: string; error?: string } | null>(null);
  /** AI sorting progress (background AiSorter), for Settings. */
  aiSortStatus = $state<AiSortStatus | null>(null);

  /** "Before your meeting": recent email with the people in a meeting, as a list. */
  openBrief(brief: MeetingBrief) {
    perf.record("meeting.brief", { people: brief.people.length });
    this.shown = true;
    this.searchText = "";
    return this.setView(briefView(brief, Date.now()));
  }
  /** A brief notification was clicked (meeting-brief.ts, reminder-service.ts). */
  private async takeBriefRequest(request?: { brief: MeetingBrief; at: number }) {
    if (!request?.brief || Date.now() - request.at > 30000) return;
    await api.storage.local.remove("sparkOpenBrief").catch(() => {});
    await this.openBrief(request.brief);
  }

  // ---- Several conversations at once (⌘-click, Shift-click, ⌘A, the avatar's check box): bulk actions ----
  /** Picked conversations (by key); the selected one is still the one the reader shows. */
  picked = $state<Set<string>>(new Set());
  private pickAnchor: string | null = null;
  /** The picked conversations in list order (ones that left the list drop out). */
  pickedConversations = $derived.by(() => this.picked.size ? this.navOrder.filter((c) => this.picked.has(c.key)) : []);
  /** What an action applies to: the picked conversations, else the one given. */
  targets(c?: Conversation | null): Conversation[] { return this.pickedConversations.length ? this.pickedConversations : c ? [c] : []; }
  /** ⌘-click or the check box: pick or unpick one (the selected one joins the first pick). */
  togglePick(key: string) {
    const next = new Set(this.picked.size ? this.picked : this.selectedKey && this.selectedKey !== key ? [this.selectedKey] : []);
    if (next.has(key)) {
      next.delete(key);
      if (this.pickAnchor === key) this.pickAnchor = [...next].at(-1) ?? null;
    } else { next.add(key); this.pickAnchor = key; }
    this.picked = next;
  }
  /** Shift-click: everything from the last picked (or selected) conversation to this one. */
  pickRange(key: string) {
    const order = this.navOrder.map((c) => c.key);
    const from = order.indexOf(this.pickAnchor ?? this.selectedKey ?? key), to = order.indexOf(key);
    if (to < 0) return;
    const [a, b] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
    this.picked = new Set([...this.picked, ...order.slice(a, b + 1)]);
    this.pickAnchor ??= key;
  }
  /** Shift+↓/↑ (Shift+J/K): move and pick along the way. */
  extendPick(delta: number) {
    const from = this.selected?.key;
    if (from && !this.picked.size) { this.picked = new Set([from]); this.pickAnchor = from; }
    this.move(delta);
    const to = this.selected?.key;
    if (to) this.picked = new Set([...this.picked, to]);
  }
  pickAll() { this.picked = new Set(this.navOrder.map((c) => c.key)); this.pickAnchor = null; }
  clearPicks() { if (this.picked.size) this.picked = new Set(); this.pickAnchor = null; }

  select(key: string | null, open = true) {
    perf.record("select", { open });
    this.selectedId = this.conversations.find((c) => c.key === key)?.ids[0] ?? null;
    this.selectedKey = key;
    this.readerOpen = !!key && open;
  }

  move(delta: number) {
    const order = this.navOrder;
    if (!order.length) return;
    const i = order.findIndex((c) => c.key === this.selected?.key);
    const j = i < 0 ? 0 : Math.max(0, Math.min(order.length - 1, i + delta));
    this.select(order[j].key);
  }

  /** After removing the selected conversation, select the next one (Ember behavior). */
  private selectNextAfter(keys: string[]) {
    if (!this.selected || !keys.includes(this.selected.key)) return;
    const after = (order: Conversation[], step: 1 | -1) => {
      const i = order.findIndex((c) => c.key === this.selected?.key);
      if (i < 0) return undefined;
      for (let j = i + step; j >= 0 && j < order.length; j += step) if (!keys.includes(order[j].key)) return order[j];
    };
    // The next visible conversation; else the next one in a collapsed date section (e.g. after
    // archiving the last of Today, the following section moves to the top), before going back up.
    const next = after(this.navOrder, 1) ?? after(this.buckets.flatMap((bucket) => bucket.conversations), 1) ?? after(this.navOrder, -1);
    this.select(next ? next.key : null, !!next && this.readerOpen);
  }

  // ================= toasts =================

  toast(t: Omit<Toast, "id">) {
    if (t.kind === "error") perf.record("error", { text: `toast: ${t.text}`.slice(0, 300) });
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts.slice(-2), { id, ...t }];
    setTimeout(() => this.dismiss(id), t.timeout ?? (t.action ? 6000 : 3500));
    return id;
  }

  dismiss(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  // ================= actions =================

  private idsOf(c: Conversation | Conversation[]): MessageId[] {
    const cs = Array.isArray(c) ? c : [c];
    // A draft's conversation acts on the draft alone: the emails it answers (shown beside it in the reader) stay.
    const drafts = (x: Conversation) => x.ids.every((id) => this.roleOfFolder(this.get(id)?.folder?.id) === "drafts");
    return Array.from(new Set(cs.flatMap((x) => [...x.ids, ...(drafts(x) ? [] : this.relatedIds.get(x.key) || [])])));
  }

  /**
   * Remove-from-view actions (archive/delete/move) with optimistic UI, rollback and Undo. `op` may report emails
   * it couldn't act on ({ failed, text }): those come back into view, with `text` as the error.
   */
  private async removeAction(
    convs: Conversation[],
    label: string,
    op: (ids: MessageId[]) => Promise<unknown>,
    undoable = true,
    verb = label === "Archived" ? "archive" : label === "Deleted" ? "delete" : label === "Moved to Trash" ? "move to Trash" : "move",
    /** Runs before an Undo moves them back, with each email's id where it is now (Mark as spam: take the verdict back). */
    beforeUndo?: (current: MessageId[]) => Promise<unknown>,
  ) {
    const ids = this.idsOf(convs);
    if (!ids.length) return;
    const originals = ids.map((id) => this.get(id)).filter(Boolean) as MessageHeader[];
    this.selectNextAfter(convs.map((c) => c.key));
    // Acted on: no longer picked (an Undo brings them back unpicked).
    if (this.picked.size) this.picked = new Set([...this.picked].filter((key) => !convs.some((c) => c.key === key)));
    ids.forEach((id) => this.hidden.add(id));
    this.rev++;
    const startedAt = Date.now();
    try {
      const result = await op(ids) as { failed?: MessageId[]; text?: string } | undefined;
      this.viewCache.markDirty();
      if (result?.failed?.length) {
        // Some (or all) didn't move: back in view, and said so. No Undo for a part that didn't happen.
        result.failed.forEach((id) => this.hidden.delete(id));
        this.rev++;
        this.toast({ text: result.text || `Couldn't ${verb} ${result.failed.length} of ${ids.length}`, kind: "error" });
        return;
      }
      const n = convs.length;
      const undo = undoable ? this.pushUndo(label, async () => {
        if (beforeUndo) await beforeUndo(originals.map((o) => this.recentMoves.get(this.moveKey(o))?.header.id ?? o.id)).catch(() => {});
        await this.undoMove(originals, startedAt);
      }) : undefined;
      this.toast({
        text: n === 1 ? label : `${label} · ${n} conversations`,
        kind: "info",
        action: undo ? { label: "Undo", run: undo } : undefined,
      });
    } catch (e: any) {
      ids.forEach((id) => this.hidden.delete(id));
      this.rev++;
      this.toast({ text: `Couldn't ${verb}: ${e?.message || e}`, kind: "error" });
    }
  }

  private async undoMove(originals: MessageHeader[], since: number) {
    // Brought back on purpose: not an archive that came back by itself.
    this.updateArchiveIntents((intents) => forget(intents, originals.map((o) => o.headerMessageId)));
    // Moves arrive via messages.onMoved (we index them by Message-ID). Give TB a moment.
    for (let tries = 0; tries < 20; tries++) {
      const found = originals.every((o) => (this.recentMoves.get(this.moveKey(o))?.at ?? 0) >= since);
      if (found) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const byFolder = new Map<string, MessageId[]>();
    let missing = 0;
    for (const o of originals) {
      let id = this.recentMoves.get(this.moveKey(o))?.header.id;
      // Moved a while ago (no longer remembered): found again by its Message-ID in the same account, not in its old folder.
      if (id === undefined && o.folder?.id && o.headerMessageId) {
        const found = await api.messages.query({ headerMessageId: o.headerMessageId, accountId: o.folder.accountId }).catch(() => null);
        id = (found?.messages || []).find((m: MessageHeader) => m.folder?.id !== o.folder!.id)?.id;
      }
      if (id === undefined || !o.folder?.id) {
        missing++;
        continue;
      }
      const arr = byFolder.get(o.folder.id) || [];
      arr.push(id);
      byFolder.set(o.folder.id, arr);
    }
    try {
      for (const [folderId, ids] of byFolder) await api.messages.move(ids, folderId);
      // Show the restored messages immediately; onMoved will replace them with fresh headers.
      for (const o of originals) this.hidden.delete(o.id);
      this.rev++;
      if (missing) this.toast({ text: `Restored ${originals.length - missing} of ${originals.length}`, kind: "info" });
      else this.toast({ text: "Restored", kind: "success" });
    } catch (e: any) {
      this.toast({ text: `Undo failed: ${e?.message || e}`, kind: "error" });
    }
  }

  archive(convs: Conversation[]) {
    if (typeof api.sparkArchive?.archive !== "function") return this.removeAction(convs, "Archived", (ids) => api.messages.archive(ids));
    return this.removeAction(convs, "Archived", (ids) => this.archiveChecked(ids));
  }

  /**
   * Archive and check each email really left its folder (Thunderbird reports an archive as done even when the
   * server refused the move). What didn't move is tried again twice; what still didn't is returned as failed.
   */
  private async archiveChecked(ids: MessageId[]): Promise<{ failed: MessageId[]; reason: string; text: string } | undefined> {
    const headers = ids.map((id) => this.get(id)).filter(Boolean) as MessageHeader[];
    // Already in an archive folder: Thunderbird leaves it there, so there's nothing to keep archived (remembered,
    // it would look like an email that came back: "Archived … again", seen 2026-11-13).
    this.updateArchiveIntents((intents) => remember(intents, headers.filter((h) => !this.inArchive(h)), Date.now()));
    let left = ids;
    let reason = "";
    for (const wait of [0, ...ARCHIVE_RETRY_MS]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const { failed } = await this.tryArchive(left);
      left = failed.map((f) => f.id);
      reason = failed[0]?.error || reason;
      if (!left.length) break;
    }
    const failed = new Set(left);
    const moved = headers.filter((h) => !failed.has(h.id)).map((h) => h.headerMessageId);
    const stayed = headers.filter((h) => failed.has(h.id)).map((h) => h.headerMessageId);
    // Refused: the server may be down (an outage can last an hour). Ember keeps trying (retryWaitingArchives).
    this.updateArchiveIntents((intents) => defer(settle(intents, moved), stayed, Date.now()));
    return left.length ? { failed: left, reason, text: failureText(left.length, ids.length, reason, true) } : undefined;
  }

  /** One archive try, within ARCHIVE_TRY_MS: no answer (or an error) counts as every email failing. */
  private async tryArchive(ids: MessageId[]): Promise<{ failed: { id: MessageId; error: string }[] }> {
    try {
      return await withDeadline(api.sparkArchive.archive(ids) as Promise<{ failed: { id: MessageId; error: string }[] }>, ARCHIVE_TRY_MS, undefined, "Archiving");
    } catch (e: any) {
      const error = e?.name === "RequestTimeout" || /timed out|in time/i.test(String(e?.message)) ? "Thunderbird didn't finish archiving in time" : String(e?.message || e).replace(/\.$/, "");
      return { failed: ids.map((id) => ({ id, error })) };
    }
  }

  /** Moved or deleted in Ember: whatever happens to them now is the user's doing. */
  private forgetArchived(convs: Conversation[]) {
    const keys = this.idsOf(convs).map((id) => this.get(id)?.headerMessageId).filter(Boolean) as string[];
    if (keys.some((key) => this.archiveIntents[key])) this.updateArchiveIntents((intents) => forget(intents, keys));
  }

  private updateArchiveIntents(change: (intents: ArchiveIntents) => ArchiveIntents) {
    this.archiveIntents = change(this.archiveIntents); // at once: a list loaded meanwhile sees it
    void Promise.resolve(api.storage.local.set?.({ archiveIntents: this.archiveIntents })).catch(() => {});
  }

  /** Archived emails back in the folder they were archived from (the server put them back): archive them again. */
  private keepArchived(headers: Iterable<MessageHeader>) {
    if (typeof api.sparkArchive?.archive !== "function") return;
    for (const _ in this.archiveIntents) {
      // Never from an archive folder (remembered there by 0.1.113–0.1.116: archiving it again does nothing).
      const back = cameBack(this.archiveIntents, [...headers], Date.now()).filter((m) => !this.inArchive(m));
      if (back.length) void this.archiveAgain(back);
      return;
    }
  }

  private inArchive(m: MessageHeader): boolean {
    return this.roleOfFolder(m.folder?.id) === "archives" || !!m.folder?.specialUse?.includes("archives");
  }

  private async archiveAgain(back: MessageHeader[]) {
    const keys = back.map((m) => m.headerMessageId);
    this.updateArchiveIntents((intents) => again(intents, keys, Date.now()));
    back.forEach((m) => this.hidden.add(m.id));
    this.rev++;
    const { failed } = await this.tryArchive(back.map((m) => m.id));
    const stayed = new Set(failed.map((f) => f.id));
    const moved = back.filter((m) => !stayed.has(m.id));
    this.updateArchiveIntents((intents) => defer(settle(intents, moved.map((m) => m.headerMessageId)), back.filter((m) => stayed.has(m.id)).map((m) => m.headerMessageId), Date.now()));
    const folderId = back[0].folder?.id || "";
    const where = this.roleOfFolder(folderId) === "inbox" || !this.folderById.get(folderId) ? "the inbox" : this.folderById.get(folderId)!.name;
    if (moved.length) {
      // Worth knowing later (ember_status, performance reports): the server undid an archive.
      errorLog.add(`archive didn't stick: the server put ${moved.length === 1 ? "an email" : `${moved.length} emails`} back in ${where}; archived again`);
      this.toast({ text: moved.length === 1 ? `Archived “${moved[0].subject || "(no subject)"}” again: it came back to ${where}` : `Archived ${moved.length} emails again: they came back to ${where}`, kind: "info" });
    }
    if (stayed.size) {
      back.forEach((m) => { if (stayed.has(m.id)) this.hidden.delete(m.id); });
      this.rev++;
      this.toast({ text: failureText(stayed.size, back.length, failed[0].error, true), kind: "error" });
    }
  }

  /** Archives the server refused (it was down): try them again, quietly, until it takes them or RETRY_FOR_MS passes. */
  private async retryWaitingArchives() {
    if (typeof api.sparkArchive?.archive !== "function") return;
    const now = Date.now();
    if (!Object.values(this.archiveIntents).some((intent) => intent.pending)) return;
    // Even while a try is still out: what has waited too long is let go.
    this.updateArchiveIntents((intents) => prune(intents, now));
    if (this.retryingArchives) return;
    // Thunderbird's own listed emails first (their ids need no lookup), then saved mail.
    const due = waiting(this.archiveIntents, [...this.dataset.values(), ...mailCache.all()], now);
    if (!due.length) return;
    this.retryingArchives = true;
    try {
      const { failed } = await this.tryArchive(due.map((m) => m.id));
      const stayed = new Set(failed.map((f) => f.id));
      const moved = due.filter((m) => !stayed.has(m.id));
      if (!moved.length) return;
      this.updateArchiveIntents((intents) => settle(intents, moved.map((m) => m.headerMessageId)));
      this.toast({ text: moved.length === 1 ? `Archived “${moved[0].subject || "(no subject)"}”: the server took it this time` : `Archived ${moved.length} emails: the server took them this time`, kind: "success" });
    } catch { /* still down: next time */ } finally { this.retryingArchives = false; }
  }
  private retryingArchives = false;

  trash(convs: Conversation[]) {
    this.forgetArchived(convs);
    const inTrash = convs.every((c) => this.roleOfFolder(this.dataset.get(c.ids[0])?.folder?.id) === "trash");
    return this.removeAction(
      convs,
      inTrash ? "Deleted" : "Moved to Trash",
      (ids) => api.messages.delete(ids, env.hasUserAction ? { isUserAction: true } : undefined),
      !inTrash,
    );
  }

  moveTo(convs: Conversation[], folderId: string) {
    const f = this.folderById.get(folderId);
    this.forgetArchived(convs);
    void this.setSetting("recentMoveFolders", [folderId, ...this.settings.recentMoveFolders.filter((id) => id !== folderId)].slice(0, 5)).catch(() => {});
    return this.removeAction(convs, `Moved to ${f?.name || "folder"}`, (ids) =>
      api.messages.move(ids, folderId, env.hasUserAction ? { isUserAction: true } : undefined),
    );
  }

  // ================= spam you teach Ember (spam.ts) =================

  /** Your spam marks (senders, examples for Clef, emails you said aren't spam). */
  spamFeedback = $state<SpamFeedback>(emptyFeedback());
  private async saveSpamFeedback(next: SpamFeedback) {
    this.spamFeedback = next;
    await api.storage.local.set({ spamFeedback: $state.snapshot(next) });
  }
  /** The account's folder with this role (Spam is "junk"), or null. */
  private roleFolder(accountId: string | undefined, role: string): string | null {
    const node = this.accounts.find((a) => a.account.id === accountId);
    const primary = node?.primary.find((f) => f.role === role)?.folder.id;
    if (primary) return primary;
    for (const f of this.folderById.values()) if (f.accountId === accountId && f.specialUse?.includes(role)) return f.id;
    return null;
  }
  /** The emails a spam verdict is about: received ones (not yours, not in Sent or Drafts). */
  private receivedOf(ids: MessageId[]): MessageHeader[] {
    return ids.map((id) => this.get(id)).filter((m): m is MessageHeader => !!m && !this.me.has(emailOf(m.author).toLowerCase()) && !["sent", "drafts", "templates", "outbox"].includes(this.roleOfFolder(m.folder?.id) || ""));
  }
  /** Whether a conversation is in Spam (its newest email in a Spam folder, or marked junk). */
  inSpam(c: Conversation): boolean { return this.roleOfFolder(c.latest.folder?.id) === "junk" || !!c.latest.junk; }
  /** Clef thinks an Inbox email may be spam (70–90%, or higher on mail it didn't move): "Looks like spam?". */
  spamAsk(m: MessageHeader): boolean {
    this.aiRev;
    // Thunderbird's junk filter guessed: asked, whether or not AI sorting is on.
    if (this.isJunkGuess(m) && this.roleOfFolder(m.folder?.id) === "inbox") return true;
    if (!this.settings.aiSort || this.roleOfFolder(m.folder?.id) !== "inbox" || m.junk || this.me.has(emailOf(m.author).toLowerCase())) return false;
    if (this.spamFeedback.cleared.includes(aiKey(m))) return false;
    return (aiSpam(this.aiAnswers, m) ?? 0) >= SPAM_ASK;
  }

  /** Mark as spam: Thunderbird's junk filter learns it, the sender's new mail goes to Spam, Clef gets it as an example,
   *  and it moves to the account's Spam folder. Undo takes all of it back. */
  markSpam(convs: Conversation[]) {
    let marked: MessageHeader[] = [];
    return this.removeAction(convs, "Moved to Spam", async (ids) => {
      marked = this.receivedOf(ids);
      if (!marked.length) return { failed: ids, text: "Only emails you received can be marked as spam" };
      this.forgetArchived(convs);
      await this.saveSpamFeedback(markedSpam(this.spamFeedback, marked, this.me));
      // Train first (the ids change when they move). An older Thunderbird without the Experiment: just the junk flag.
      if (typeof api.sparkJunk?.classify === "function") await api.sparkJunk.classify(marked.map((m) => m.id), "spam");
      else await Promise.all(marked.map((m) => api.messages.update(m.id, { junk: true })));
      const byFolder = new Map<string, MessageId[]>();
      for (const m of marked) {
        const spam = this.roleFolder(m.folder?.accountId, "junk");
        if (spam && spam !== m.folder?.id) byFolder.set(spam, [...(byFolder.get(spam) || []), m.id]);
      }
      // No Spam folder on an account: marked junk, which keeps it out of the Inbox.
      for (const [folder, list] of byFolder) await api.messages.move(list, folder, env.hasUserAction ? { isUserAction: true } : undefined);
    }, true, "move to Spam", async (current) => {
      if (typeof api.sparkJunk?.classify === "function") await api.sparkJunk.classify(current, "unknown");
      else await Promise.all(current.map((id) => api.messages.update(id, { junk: false })));
      await this.saveSpamFeedback(unmarkedSpam(this.spamFeedback, marked));
    });
  }

  /** Not spam: Thunderbird's filter learns it's good mail, the sender is forgotten, Clef gets a counter-example, and an
   *  email in Spam goes back to its account's Inbox (one in the Inbox stays, without "Looks like spam?"). */
  async notSpam(convs: Conversation[]) {
    const ids = this.idsOf(convs);
    const list = this.receivedOf(ids);
    if (!list.length) return;
    try {
      await this.saveSpamFeedback(markedNotSpam(this.spamFeedback, list));
      if (typeof api.sparkJunk?.classify === "function") await api.sparkJunk.classify(list.map((m) => m.id), "good");
      else await Promise.all(list.map((m) => api.messages.update(m.id, { junk: false })));
    } catch (e: any) { this.toast({ text: `Couldn't mark as not spam: ${e?.message || e}`, kind: "error" }); return; }
    const toInbox = list.filter((m) => this.roleOfFolder(m.folder?.id) === "junk");
    if (!toInbox.length) { this.aiRev++; this.rev++; this.toast({ text: "Got it: not spam. Ember will remember.", kind: "success", timeout: 3000 }); return; }
    const back = convs.filter((c) => c.ids.some((id) => toInbox.some((m) => m.id === id)));
    return this.removeAction(back, "Moved to Inbox", async () => {
      const byFolder = new Map<string, MessageId[]>();
      for (const m of toInbox) { const inbox = this.roleFolder(m.folder?.accountId, "inbox"); if (inbox) byFolder.set(inbox, [...(byFolder.get(inbox) || []), m.id]); }
      for (const [folder, ids] of byFolder) await api.messages.move(ids, folder, env.hasUserAction ? { isUserAction: true } : undefined);
    }, false);
  }

  /** A sender you marked as spam, taken off the list (Settings). */
  async forgetSpamSender(address: string) {
    const senders = { ...this.spamFeedback.senders };
    delete senders[address.toLowerCase()];
    await this.saveSpamFeedback({ ...this.spamFeedback, senders });
  }

  /** The background moved mail to Spam (a sender you marked, or Clef was sure): say so, with Show. */
  private lastSpamMoved = 0;
  private takeSpamMoved(moved: { at: number; reason: string; items: { subject: string; from: string }[] }) {
    if (!moved?.items?.length || moved.at <= this.lastSpamMoved || Date.now() - moved.at > 60000) return;
    this.lastSpamMoved = moved.at;
    const n = moved.items.length;
    const why = moved.reason === "sender" ? "from a sender you marked" : "Ember's AI is sure it's spam";
    this.toast({
      text: n === 1 ? `Moved “${moved.items[0].subject || "(no subject)"}” to Spam (${why})` : `Moved ${n} emails to Spam (${why})`,
      kind: "info", timeout: 8000,
      action: { label: "Show", run: () => void this.setView({ kind: "mailbox", role: "junk" }) },
    });
  }

  // ================= undo (Ctrl+Z / ⌘Z, and the toasts' Undo) =================

  private undoStack: { label: string; run: () => Promise<void> }[] = [];
  /** Remember how to reverse an action; the returned function undoes it (once). */
  private pushUndo(label: string, reverse: () => Promise<unknown>): () => void {
    const entry = { label, run: async () => { await reverse(); } };
    this.undoStack = [...this.undoStack.slice(-19), entry];
    return () => { if (this.takeUndo(entry)) void entry.run(); };
  }
  /** ⌘Z for an action outside the store (Undo send); the returned function undoes it (once). */
  rememberUndo(label: string, reverse: () => Promise<unknown>): () => void {
    return this.pushUndo(label, reverse);
  }
  private takeUndo(entry: { label: string; run: () => Promise<void> }): boolean {
    const had = this.undoStack.includes(entry);
    this.undoStack = this.undoStack.filter((e) => e !== entry);
    return had;
  }
  /** Undo the most recent action (archive, delete, move, pin, read/unread). */
  async undo() {
    const entry = this.undoStack.at(-1);
    if (!entry) { this.toast({ text: "Nothing to undo", kind: "info" }); return; }
    this.takeUndo(entry);
    await entry.run();
  }

  private async updateMany(ids: MessageId[], props: { read?: boolean; flagged?: boolean }, undoLabel?: string) {
    const before = ids.map((id) => ({ id, h: this.get(id) })).filter((x) => x.h);
    const old = before.map(({ id, h }) => ({ id, read: h!.read, flagged: h!.flagged }));
    for (const { h } of before) {
      Object.assign(h!, props);
      this.viewCache.update(h!, props);
      if (this.dataset.has(h!.id)) this.pendingLoad?.changes.set(h!.id, { ...h! });
    }
    const readOnly = props.flagged === undefined;
    if (!readOnly || !this.patchUnread(before.map(({ h }) => h!.id))) this.rev++;
    try {
      // Large batches (Mark all read on a category) go 50 at a time: thousands of concurrent updates
      // would occupy Thunderbird's main thread (and its input handling) for seconds.
      for (let i = 0; i < before.length; i += 50) {
        await Promise.all(before.slice(i, i + 50).map(({ id }) => api.messages.update(id, props)));
        if (i + 50 < before.length) await new Promise((resolve) => setTimeout(resolve, 16));
      }
      for (const { h } of before) mailCache.changed(h!, props);
      if (props.flagged !== undefined) { this.viewCache.markDirty(); }
      if (undoLabel) this.pushUndo(undoLabel, () => this.restoreFlags(old, props, undoLabel));
    } catch (e: any) {
      for (const o of old) {
        const h = this.get(o.id);
        if (h) {
          Object.assign(h, { read: o.read, flagged: o.flagged });
          this.viewCache.update(h, { read: o.read, flagged: o.flagged });
          if (this.dataset.has(h.id)) this.pendingLoad?.changes.set(h.id, { ...h });
        }
      }
      this.rev++;
      this.toast({ text: `Couldn't update: ${e?.message || e}`, kind: "error" });
    }
  }

  /** Put read/pinned back as they were before an action (Undo). */
  private async restoreFlags(old: { id: MessageId; read?: boolean; flagged?: boolean }[], props: { read?: boolean; flagged?: boolean }, label: string) {
    for (const key of ["read", "flagged"] as const) {
      if (props[key] === undefined) continue;
      for (const value of [true, false]) {
        const ids = old.filter((o) => o[key] === value).map((o) => o.id);
        if (ids.length) await this.updateMany(ids, { [key]: value });
      }
    }
    this.toast({ text: `Undid ${label.toLowerCase()}`, kind: "success" });
  }

  /** `undoable`: a user action (Ctrl+Z reverses it), not the automatic mark-as-read on open. */
  setRead(convs: Conversation[], read: boolean, undoable = false) {
    const ids = this.idsOf(convs).filter((id) => this.get(id)?.read !== read);
    if (ids.length) return this.updateMany(ids, { read }, undoable ? (read ? "Mark as read" : "Mark as unread") : undefined);
  }

  toggleRead(convs: Conversation[]) {
    const anyUnread = convs.some((c) => c.unread > 0);
    return this.setRead(convs, anyUnread, true);
  }

  toggleStar(convs: Conversation[]) {
    const flag = !convs.every((c) => c.flagged);
    const pins = this.view.kind === "pinned" || (this.view.kind === "category" && this.view.cat === "pinned");
    if ((flag && this.isInboxView() && !pins) || (!flag && pins)) this.selectNextAfter(convs.map((c) => c.key));
    // Star the newest message when pinning; unpin every message when un-pinning.
    const ids = flag ? convs.map((c) => c.ids[0]) : this.withCopies(this.idsOf(convs)).filter((id) => this.get(id)?.flagged);
    return this.updateMany(ids, { flagged: flag }, flag ? "Pin" : "Unpin");
  }

  /** The ids plus other folders' copies of the same emails (Pins shows Gmail's All Mail/Starred copies once). */
  private withCopies(ids: MessageId[]): MessageId[] {
    const mids = new Set(ids.map((id) => this.get(id)?.headerMessageId).filter(Boolean).map((mid) => messageId(mid!)));
    const copies = Array.from(this.dataset.values()).filter((m) => m.headerMessageId && mids.has(messageId(m.headerMessageId))).map((m) => m.id);
    return Array.from(new Set([...ids, ...copies]));
  }

  setMessageRead(id: MessageId, read: boolean) {
    return this.updateMany([id], { read });
  }

  setMessageFlag(id: MessageId, flagged: boolean) {
    return this.updateMany([id], { flagged });
  }

  // ================= live updates =================

  private inView(m: MessageHeader): boolean {
    const v = this.view;
    if (v.kind === "search" || v.kind === "attachments") return false;
    if (v.kind === "pinned" || (v.kind === "category" && v.cat === "pinned")) return !!m.flagged && (!v.accountId || m.folder?.accountId === v.accountId) && (!("folderId" in v) || !v.folderId || m.folder?.id === v.folderId) && !["trash", "junk"].includes(this.roleOfFolder(m.folder?.id) || "");
    return !!m.folder?.id && this.viewFolders.has(m.folder.id);
  }

  private refreshAttachmentsSoon() {
    if (this.view.kind !== "attachments") return;
    // Incoming mail during sync must not repeatedly cancel a scan before it can finish.
    if (this.loading) { this.attachmentRefreshNeeded = true; return; }
    clearTimeout(this.attachmentRefreshTimer);
    this.attachmentRefreshTimer = setTimeout(() => {
      if (this.view.kind === "attachments") this.reload();
    }, 350);
  }

  private listen() {
    const msgs = api.messages;
    msgs.onNewMailReceived.addListener(async (folder: MailFolder, list: MessageList) => {
      const all = await drain(list);
      this.announced(all);
      mailCache.register(all, true);
      this.viewCache.markDirty();
      // Reloading the open conversation regroups all saved mail for its related messages (~40 ms at
      // 20k emails): only when new mail may be part of it. Otherwise that index is rebuilt when idle.
      if (this.mayBelongToOpen(all)) this.readerRev++; else this.warmRelatedSoon();
      this.refreshAttachmentsSoon();
      const add = all.filter((m) => this.inView(m) || this.viewFolders.has(folder.id));
      if (add.length) {
        // New mail arrives with its preview and category: one regroup instead of one now and one when they load.
        const since = Date.now();
        for (const m of add) this.arriving.set(m.id, m);
        add.forEach((m) => this.meta.request(m, "f", 1));
        try { await this.meta.settled(add, "f", 800); } finally { for (const m of add) this.arriving.delete(m.id); }
        // Meanwhile the view may have changed, or the mail been moved or deleted (filters, junk).
        const still = add.filter((m) => !this.removedSince(m, since) && (this.inView(m) || this.viewFolders.has(m.folder?.id || "")));
        if (still.length) this.add(still);
      }
    });
    msgs.onUpdated.addListener((m: MessageHeader, changed: any) => {
      const arriving = this.arriving.get(m.id);
      if (arriving) Object.assign(arriving, changed);
      // Before the cache applies the change: a cache-served list holds the cache's own header objects,
      // which mailCache.changed() updates in place (so the difference must be measured first).
      // Saved mail is listed under stand-in ids while Thunderbird reports its own: find it by key, through the
      // cache (whose header objects cache-served lists hold) before scanning every listed email.
      const key = messageKey(m);
      const cached = (mailCache as { current?: (k: string) => MessageHeader | undefined }).current?.(key);
      const h = this.get(m.id)
        || (cached && (this.dataset.get(cached.id) === cached || this.related.get(cached.id) === cached) ? cached : undefined)
        || [...this.dataset.values(), ...this.related.values()].find((header) => messageKey(header) === key);
      const differs = !!h && Object.entries(changed || {}).some(([k, v]) => JSON.stringify((h as any)[k]) !== JSON.stringify(v));
      mailCache.changed(m, changed);
      if (changed.flagged !== undefined) { this.viewCache.markDirty(); }
      this.viewCache.update(m, changed);
      const pending = this.pendingLoad?.headers.get(m.id);
      if (pending) Object.assign(pending, changed);
      if (this.pendingLoad && (pending || this.dataset.has(m.id) || this.inView(m))) {
        // Keyed by the listed header's own id (a cached one may carry a stand-in id), never a duplicate.
        const own = h || pending;
        this.pendingLoad.changes.set(own?.id ?? m.id, { ...m, ...own, ...changed });
      }
      if (changed.junk !== undefined) this.refreshAttachmentsSoon();
      // Thunderbird's filter can mark an email after it's listed: its guess gets "Spam?".
      if (changed.junk === true) this.noteJunk([{ ...m, ...changed }]);
      if (h) {
        // Echoes of optimistic updates (read/pin toggles) would regroup the whole mailbox again.
        Object.assign(h, changed);
        const readOnly = Object.keys(changed || {}).every((k) => k === "read");
        if (differs && !(readOnly && this.patchUnread([h.id]))) this.bump();
      } else if ((this.view.kind === "pinned" || (this.view.kind === "category" && this.view.cat === "pinned")) && this.inView(m)) {
        this.add([m]);
      }
    });
    msgs.onMoved.addListener(async (orig: MessageList, moved: MessageList) => {
      const [a, b] = await Promise.all([drain(orig), drain(moved)]);
      this.announced(b);
      this.noteRemoved(a, b);
      mailCache.remove(a);
      mailCache.register(b, true);
      this.forgetRelated(a);
      const oldKeys = new Set(a.map(messageKey));
      const removedIds = [...a.map((m) => m.id), ...Array.from(this.dataset.values()).filter((m) => oldKeys.has(messageKey(m))).map((m) => m.id)];
      this.viewCache.remove(removedIds);
      this.viewCache.markDirty();
      this.readerRev++;
      this.refreshAttachmentsSoon();
      const now = Date.now();
      for (const m of b) this.recentMoves.set(this.moveKey(m), { header: m, at: now });
      // prune
      for (const [k, v] of this.recentMoves) if (now - v.at > 120000) this.recentMoves.delete(k);
      let changed = false;
      for (const m of a) {
        this.pendingLoad?.changes.set(m.id, null);
        if (this.dataset.delete(m.id)) changed = true;
        this.hidden.delete(m.id);
      }
      for (const id of removedIds) { this.dataset.delete(id); this.related.delete(id); }
      const add = b.filter((m) => this.inView(m));
      if (add.length) {
        this.add(add);
        changed = true;
      }
      if (changed) this.bump();
    });
    // A copy (including one copied back where it was just moved from) is new mail for its folder.
    msgs.onCopied?.addListener(async (_orig: MessageList, copied: MessageList) => {
      const b = await drain(copied);
      this.announced(b);
      this.noteRemoved([], b);
      mailCache.register(b, true);
      this.viewCache.markDirty();
      const add = b.filter((m) => this.inView(m) || this.viewFolders.has(m.folder?.id || ""));
      if (add.length) this.add(add);
    });
    msgs.onDeleted.addListener(async (list: MessageList) => {
      const all = await drain(list);
      this.noteRemoved(all);
      mailCache.remove(all);
      this.forgetRelated(all);
      this.readerRev++;
      this.refreshAttachmentsSoon();
      const keys = new Set(all.map(messageKey));
      const ids = [...all.map((m) => m.id), ...Array.from(this.dataset.values()).filter((m) => keys.has(messageKey(m))).map((m) => m.id)];
      this.viewCache.remove(ids);
      for (const id of ids) { this.dataset.delete(id); this.related.delete(id); }
      for (const m of all) {
        this.pendingLoad?.changes.set(m.id, null);
        this.dataset.delete(m.id);
        this.hidden.delete(m.id);
      }
      this.bump();
    });
    api.folders.onFolderInfoChanged?.addListener((folder: MailFolder, info: any) => {
      if (info && typeof info.unreadMessageCount === "number") {
        this.unread = { ...this.unread, [folder.id]: info.unreadMessageCount };
      }
      if (info && typeof info.totalMessageCount === "number") this.noteFolderTotal(folder, info.totalMessageCount);
    });
    const refreshAccounts = () => this.loadAccounts().catch(() => {});
    api.folders.onCreated?.addListener(refreshAccounts);
    api.folders.onDeleted?.addListener(refreshAccounts);
    api.folders.onRenamed?.addListener(refreshAccounts);
    api.accounts.onCreated?.addListener(refreshAccounts);
    api.accounts.onDeleted?.addListener(refreshAccounts);
  }

  // ================= correspondents (autocomplete) =================

  private noteCorrespondents(m: MessageHeader) {
    const t = +new Date(m.date);
    const note = (s: string) => {
      const e = emailOf(s);
      if (!e || this.me.has(e) || /no-?reply|notification|mailer-daemon/i.test(e)) return;
      const cur = this.recipientsSeen.get(e);
      const name = displayName(s);
      if (cur) {
        cur.count++;
        cur.last = Math.max(cur.last, t);
      } else this.recipientsSeen.set(e, { name, count: 1, last: t });
    };
    if (this.categoryOf(m) === "people") note(m.author);
    if (this.me.has(emailOf(m.author))) for (const r of [...(m.recipients || []), ...(m.ccList || [])]) note(r);
  }

  recentCorrespondents(q: string, limit = 8): { name: string; email: string }[] {
    const s = q.toLowerCase();
    const out: { name: string; email: string; score: number }[] = [];
    for (const [email, v] of this.recipientsSeen) {
      if (s && !email.includes(s) && !v.name.toLowerCase().includes(s)) continue;
      out.push({ name: v.name, email, score: v.count * 2 + v.last / 1e11 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Thunderbird announces only *new* (unread) mail. Mail read elsewhere first (on a phone, then
   * synced) arrives silently: just a higher folder total. When a total grows beyond what new-mail
   * and move events explain, that folder's recent mail is checked: now if it's on screen,
   * otherwise on the next visit.
   */
  private folderTotals = new Map<string, number>();
  private unannounced = new Map<string, number>();
  private unannouncedTimers = new Map<string, any>();
  private noteFolderTotal(folder: MailFolder, total: number) {
    const previous = this.folderTotals.get(folder.id);
    this.folderTotals.set(folder.id, total);
    if (previous === undefined || total <= previous) return;
    // Events can also come first (a move is reported ~160 ms before the folder total changes).
    let added = total - previous;
    // Each announced email credits one rise within 10 s (oldest first), never longer.
    const credits = (this.announcedCredit.get(folder.id) || []).filter((at) => Date.now() - at < 10000);
    while (added > 0 && credits.length) { credits.shift(); added--; }
    if (credits.length) this.announcedCredit.set(folder.id, credits); else this.announcedCredit.delete(folder.id);
    if (added <= 0) return;
    this.unannounced.set(folder.id, (this.unannounced.get(folder.id) || 0) + added);
    clearTimeout(this.unannouncedTimers.get(folder.id));
    // Events for the same messages can follow the total by a moment.
    this.unannouncedTimers.set(folder.id, setTimeout(() => this.checkUnannounced(folder), 5000));
  }
  private announcedCredit = new Map<string, number[]>();
  /** New mail waiting for its preview before it's listed (see onNewMailReceived). */
  private arriving = new Map<MessageId, MessageHeader>();
  /** Emails just moved away or deleted (by key), so lists that were already under way don't bring them back. */
  private recentlyRemoved = new Map<string, number>();
  private noteRemoved(removed: MessageHeader[], restored: MessageHeader[] = []) {
    const now = Date.now();
    for (const m of removed) this.recentlyRemoved.set(messageKey(m), now);
    // A folder that lost mail can gain some and end up with the same counts (a draft replaced by a new one):
    // its next safety check walks it, whatever its counts and however recently it last ran.
    for (const m of removed) if (m.folder?.id) { this.countsUnreliable.add(m.folder.id); if (!this.recentChecks.get(m.folder.id)?.pending) this.recentChecks.delete(m.folder.id); }
    for (const m of restored) this.recentlyRemoved.delete(messageKey(m)); // e.g. Undo moves it back
    for (const [key, at] of this.recentlyRemoved) if (now - at > 60000) this.recentlyRemoved.delete(key);
  }
  private removedSince(m: MessageHeader, since: number) {
    const at = this.recentlyRemoved.get(messageKey(m));
    return at !== undefined && at >= since;
  }
  private announced(messages: MessageHeader[]) {
    for (const m of messages) {
      const id = m.folder?.id; if (!id) continue;
      const pending = this.unannounced.get(id) || 0;
      if (pending > 1) this.unannounced.set(id, pending - 1);
      else if (pending === 1) this.unannounced.delete(id);
      else this.announcedCredit.set(id, [...(this.announcedCredit.get(id) || []).filter((at) => Date.now() - at < 10000), Date.now()]);
    }
  }
  private checkUnannounced(folder: MailFolder) {
    this.unannouncedTimers.delete(folder.id);
    if (!this.unannounced.has(folder.id)) return;
    this.unannounced.delete(folder.id);
    this.recentChecks.delete(folder.id); // the next check of this folder runs, not throttled
    if (this.ready && !this.loading && this.viewFolders.has(folder.id)) void this.checkRecent([folder], this.loadToken, this.view.kind === "folder" || this.view.kind === "mailbox");
  }

  /** New mail that may join the open conversation: a reply carries its subject (Thunderbird strips "Re:"). */
  private mayBelongToOpen(messages: MessageHeader[]) {
    const open = this.readerOpen ? this.selected : null;
    if (!open) return false;
    const subjects = new Set([...this.headersOf(open), ...(this.relatedIds.get(open.key) || []).map((id) => this.get(id)).filter(Boolean) as MessageHeader[]].map((m) => normSubject(m.subject)));
    return messages.some((m) => subjects.has(normSubject(m.subject)));
  }
  private relatedWarmTimer: any = null;
  private relatedWarmWhenShown = false;
  private warmRelatedSoon() {
    if (this.relatedWarmTimer || !this.settings.groupConversations) return;
    // Hidden (minimized): new mail would regroup all saved mail for nobody (~25 ms an email); do it when shown.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      if (!this.relatedWarmWhenShown) {
        this.relatedWarmWhenShown = true;
        const shown = () => { if (document.visibilityState !== "visible") return; document.removeEventListener("visibilitychange", shown); this.relatedWarmWhenShown = false; this.warmRelatedSoon(); };
        document.addEventListener("visibilitychange", shown);
      }
      return;
    }
    const idle = (globalThis as any).requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1500));
    this.relatedWarmTimer = idle(() => { this.relatedWarmTimer = null; this.relatedGroups(); }, { timeout: 5000 });
  }

  // Grouping all cached mail costs tens of ms; reuse it until headers, classification or folders change.
  private relatedIndex: { stamp: unknown[]; byMessageId: Map<string, MessageHeader[]> } | null = null;
  private relatedGroups(): Map<string, MessageHeader[]> | null {
    const version = (mailCache as { version?: number }).version;
    if (version === undefined) return null;
    const stamp = [version, this.metaThreadRev, this.accounts, this.me.size];
    if (this.relatedIndex && this.relatedIndex.stamp.every((value, i) => value === stamp[i])) return this.relatedIndex.byMessageId;
    const done = perf.span("spark.related-index");
    // Same candidates and options as the full path in cachedRelatedMessages.
    const usable = mailCache.all().filter((m) => !m.junk && !["trash", "junk", "drafts"].includes(this.roleOfFolder(m.folder?.id) || ""));
    const seen = new Set<string>(); const unique: MessageHeader[] = [];
    for (const m of usable) { const key = m.headerMessageId ? messageId(m.headerMessageId) : `id:${m.id}`; if (!seen.has(key)) { seen.add(key); unique.push(m); } }
    const byId = new Map(unique.map((m) => [m.id, m]));
    const byMessageId = new Map<string, MessageHeader[]>();
    for (const group of groupConversations(unique, { me: this.me, meta: (m) => this.meta.get(m), category: (m) => this.categoryOf(m), hasAttachment: () => false, enabled: true })) {
      const members = group.ids.map((id) => byId.get(id)).filter(Boolean) as MessageHeader[];
      for (const m of members) if (m.headerMessageId) byMessageId.set(messageId(m.headerMessageId), members);
    }
    this.relatedIndex = { stamp, byMessageId };
    done({ messages: unique.length });
    return byMessageId;
  }

  cachedRelatedMessages(c: Conversation): MessageHeader[] {
    const done = perf.span("spark.related");
    try { return this.findRelated(c); } finally { done(); }
  }

  private findRelated(c: Conversation): MessageHeader[] {
    const own = this.headersOf(c);
    if (!this.settings.groupConversations) return own;
    const existing = new Set(own.map(messageKey));
    const seeds = own.map((m) => m.headerMessageId ? messageId(m.headerMessageId) : "");
    const retained = (this.relatedIds.get(c.key) || []).map((id) => this.get(id)).filter(Boolean) as MessageHeader[];
    const groups = seeds.every(Boolean) ? this.relatedGroups() : null;
    const cached = (m: MessageHeader) => !!m.headerMessageId && !!groups?.has(messageId(m.headerMessageId));
    if (groups && own.every(cached) && retained.every(cached)) {
      // Every message is cached, so its cached group is exactly what the full path would find.
      const seen = new Set(seeds); const merged = [...own];
      for (const id of new Set(seeds)) for (const m of groups.get(id)!) {
        const key = messageId(m.headerMessageId!);
        if (!seen.has(key) && !existing.has(messageKey(m))) { seen.add(key); merged.push((mailCache as { current?: (k: string) => MessageHeader | undefined }).current?.(messageKey(m)) ?? m); }
      }
      merged.sort((a, b) => +new Date(b.date) - +new Date(a.date) || b.id - a.id);
      for (const m of merged) this.related.set(m.id, m);
      this.relatedIds.set(c.key, merged.map((m) => m.id));
      return merged;
    }
    // Retain explicitly discovered older replies for this view, preferring current
    // cache headers when an event has updated a message or rebound its handle.
    const candidates = new Map([...retained, ...mailCache.all()].map((m) => [messageKey(m), m]));
    const usable = [...candidates.values()].filter((m) => !existing.has(messageKey(m)) && !m.junk && !["trash", "junk", "drafts"].includes(this.roleOfFolder(m.folder?.id) || ""));
    const merged = relatedConversation(own, usable, { me: this.me, meta: (m) => this.meta.get(m), category: (m) => this.categoryOf(m), hasAttachment: () => false });
    for (const m of merged) this.related.set(m.id, m);
    this.relatedIds.set(c.key, merged.map((m) => m.id));
    return merged;
  }

  /** Ordinary opens are local: cached Sent/archive replies do not require a search. */
  async relatedMessages(c: Conversation, active = () => true): Promise<MessageHeader[]> {
    return active() ? this.cachedRelatedMessages(c) : this.headersOf(c);
  }

  /** Explicitly find older, uncached history across accounts and folders. */
  async discoverRelatedMessages(c: Conversation, active = () => true): Promise<MessageHeader[]> {
    const token = this.loadToken;
    const own = this.cachedRelatedMessages(c);
    if (!this.settings.groupConversations) return own;
    const latest = own[0] || c.latest;
    const candidates: MessageHeader[] = [];
    const hydrate = async (messages: MessageHeader[]) => {
      let index = 0;
      const worker = async () => {
        while (token === this.loadToken && active() && index < messages.length) {
          const m = messages[index++];
          if (this.meta.has(m, "h")) continue;
          try {
            const headers = env.hasGetHeaders ? await api.messages.getHeaders(m.id) : (await api.messages.getFull(m.id)).headers;
            if (token !== this.loadToken) return;
            this.meta.put(m, { ...this.meta.get(m), cat: this.meta.get(m)?.cat ?? classify(m.author, headers, this.me, m.subject), refs: parseRefs(headers || {}), lvl: this.meta.get(m)?.lvl || "h" });
          } catch { /* subject/participant fallback still works offline */ }
        }
      };
      await Promise.all([worker(), worker()]);
    };
    const release = this.meta.hold();
    try {
      await hydrate(own);
      if (token !== this.loadToken || !active()) return own;
      const raw = latest.subject.replace(/^\s*((re|fw|fwd|aw|wg)\s*:\s*)+/i, "").trim();
      if (normSubject(raw).length >= 3) {
        const q: any = { subject: raw };
        // Search all accounts: replies may have been sent using another identity.
        candidates.push(...await drain(api.messages.query(q)));
      }
      const known = new Set([...own, ...candidates].map((m) => m.headerMessageId));
      const refs = Array.from(new Set(own.flatMap((m) => this.meta.get(m)?.refs || []))).filter((id) => !known.has(id));
      // Fetch referenced ancestors even when their subjects changed: from saved mail when it has them
      // (Thunderbird's search for one Message-ID walks every folder, ~150 ms each at 13k emails).
      const saved = new Map<string, MessageHeader[]>();
      if (refs.length) for (const m of mailCache.all()) if (m.headerMessageId) { const k = messageId(m.headerMessageId); const list = saved.get(k); if (list) list.push(m); else saved.set(k, [m]); }
      for (const id of refs) {
        if (token !== this.loadToken || !active()) return own;
        candidates.push(...(saved.get(messageId(id)) ?? await drain(api.messages.query({ headerMessageId: id }))));
      }
      const ownKeys = new Set(own.map(messageKey));
      const usable = candidates.filter((m) => !ownKeys.has(messageKey(m)) && !m.junk && !["trash", "junk", "drafts"].includes(this.roleOfFolder(m.folder?.id) || ""));
      await hydrate(usable);
      if (token !== this.loadToken || !active()) return own;
      const merged = relatedConversation(own, usable, {
        me: this.me, meta: (m) => this.meta.get(m), category: (m) => this.categoryOf(m), hasAttachment: () => false,
      });
      for (const m of merged) this.related.set(m.id, m);
      this.relatedIds.set(c.key, merged.map((m) => m.id));
      return merged;
    } finally { release(); }
  }

  /** Everyone in the conversation an email belongs to (as far as Ember has it), lower-case addresses. */
  /** The emails of the conversation an email is in (just it, when it isn't in a loaded conversation). */
  threadIds(id: MessageId): MessageId[] {
    const conv = this.conversations.find((c) => c.ids.includes(id) || this.relatedIds.get(c.key)?.includes(id));
    return conv ? this.relatedIds.get(conv.key) || conv.ids : [id];
  }

  threadPeople(id: MessageId): string[] {
    const people = new Set<string>();
    for (const m of this.threadIds(id).map((i) => this.get(i))) {
      if (!m) continue;
      for (const raw of [m.author, ...(m.recipients || []), ...(m.ccList || []), ...(m.bccList || [])]) { const email = emailOf(raw); if (email) people.add(email); }
    }
    return [...people];
  }

  replyTarget(c: Conversation): number {
    const messages = (this.relatedIds.get(c.key) || c.ids).map((id) => this.get(id)).filter(Boolean) as MessageHeader[];
    return messages.sort((a, b) => +new Date(b.date) - +new Date(a.date) || b.id - a.id)[0]?.id ?? c.ids[0];
  }

  /** Links in received mail from the last 90 days (saved mail), each once, newest shares first. */
  async loadLinks() {
    this.linksPhase = "loading";
    this.linksError = "";
    try {
      const records = await mailCache.linkIndex();
      const excluded = excludedAttachmentFolders(this.folderById.values());
      this.links = libraryLinks(records.filter(({ message }) => isReceivedAttachmentMessage(message, this.me, excluded)), (author) => senderDomain(author) || "");
      this.linksPhase = "done";
    } catch (error: any) {
      this.linksError = String(error?.message || error);
      this.linksPhase = "error";
    }
  }

  // ================= senders you ignore =================

  ignored = $state.raw<(SenderSummary & { unsubscribe: Unsubscribe | null })[]>([]);
  ignoredPhase = $state<"idle" | "loading" | "done" | "error">("idle");
  /** Unsubscribed senders still on the list, with how many emails came after. */
  unsubscribedList = $state.raw<SenderSummary[]>([]);
  private unsubscribeInfo = new Map<string, { at: number; unsubscribe: Unsubscribe | null; bulk: boolean }>();

  /** Bulk senders with 5+ emails in 90 days (saved mail) you've opened at most 10% of. */
  async findIgnoredSenders() {
    this.ignoredPhase = "loading";
    try {
      // Not what was just archived (the cache hears of the move a moment later).
      const headers = mailCache.all().filter((m) => !this.hidden.has(m.id));
      const roleOf = (id?: string) => this.roleOfFolder(id);
      const written = writtenTo(headers, roleOf);
      const unsubscribed = this.settings.unsubscribedSenders;
      const all = ignoredSenders(headers, { me: this.me, written, roleOf, kept: this.settings.keptSenders });
      const out: (SenderSummary & { unsubscribe: Unsubscribe | null })[] = [];
      const done: SenderSummary[] = [];
      for (const sender of all) {
        if (unsubscribed[sender.address]) {
          done.push({ ...sender, since: headers.filter((m) => emailOf(m.author).toLowerCase() === sender.address && +new Date(m.date) > unsubscribed[sender.address]).length });
          continue;
        }
        const info = await this.senderInfo(sender);
        if (info.bulk) out.push({ ...sender, unsubscribe: info.unsubscribe });
      }
      // Unsubscribed senders that no longer reach the rule still show (did it work?).
      for (const [address, at] of Object.entries(unsubscribed)) if (!done.some((d) => d.address === address)) {
        const theirs = headers.filter((m) => emailOf(m.author).toLowerCase() === address).sort((a, b) => +new Date(b.date) - +new Date(a.date));
        if (theirs.length) done.push({ address, name: displayName(theirs[0].author) || address, total: theirs.length, opened: theirs.filter((m) => m.read).length, inInbox: theirs.filter((m) => roleOf(m.folder?.id) === "inbox").length, latest: theirs[0], subjects: [], since: theirs.filter((m) => +new Date(m.date) > at).length });
      }
      this.ignored = out;
      this.unsubscribedList = done;
      this.ignoredPhase = "done";
    } catch (error) {
      perf.record("error", { text: `ignored senders: ${String((error as any)?.message || error)}`.slice(0, 300) });
      this.ignoredPhase = "error";
    }
  }

  /** From the sender's newest email: bulk mail or not, and how to unsubscribe. */
  private async senderInfo(sender: SenderSummary) {
    const key = `${sender.address}:${messageKey(sender.latest)}`;
    const known = this.unsubscribeInfo.get(key);
    if (known) return known;
    let headers: Record<string, string[]> | undefined = await (mailCache as any).getCachedHeaders?.(sender.latest.id).catch(() => undefined);
    if (!headers) headers = (await withDeadline(api.messages.getFull(sender.latest.id), 8000, undefined, "Reading sender").catch(() => null) as any)?.headers;
    const lower: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(headers || {})) lower[k.toLowerCase()] = v as string[];
    const info = { at: Date.now(), bulk: isBulk(lower, classify(sender.latest.author, lower, this.me, sender.latest.subject)), unsubscribe: parseUnsubscribe(lower["list-unsubscribe"]?.join(", "), lower["list-unsubscribe-post"]?.join(", ")) };
    this.unsubscribeInfo.set(key, info);
    return info;
  }

  /** Archive everything from this sender still in an Inbox (any age), with Undo. */
  async archiveSender(address: string, quiet = false): Promise<number> {
    address = address.toLowerCase();
    const mine = (m: MessageHeader) => emailOf(m.author).toLowerCase() === address;
    const inboxes = this.inboxFolders();
    const inboxIds = new Set(inboxes.map((f) => f.id));
    const found = new Map<string, MessageHeader>();
    for (const m of mailCache.all()) if (mine(m) && inboxIds.has(m.folder?.id || "")) found.set(messageKey(m), m);
    // Older mail (beyond saved mail) too: Thunderbird's search of each Inbox for the sender.
    await Promise.all(inboxes.map(async (f) => {
      const list = await withDeadline(drain(api.messages.query({ folderId: f.id, author: address })), 20000, undefined, "Finding their emails").catch(() => [] as MessageHeader[]);
      for (const m of list) if (mine(m)) found.set(messageKey(m), m);
    }));
    const originals = [...found.values()];
    if (!originals.length) { if (!quiet) this.toast({ text: "Nothing of theirs is left in your Inbox", kind: "info" }); if (this.view.kind === "senders") void this.findIgnoredSenders(); return 0; }
    const startedAt = Date.now();
    const ids = originals.map((m) => m.id);
    ids.forEach((id) => this.hidden.add(id));
    this.rev++;
    try {
      const failed: MessageId[] = [];
      let reason = "";
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        if (typeof api.sparkArchive?.archive !== "function") { await api.messages.archive(batch); continue; }
        const result = await this.archiveChecked(batch);
        if (result) { failed.push(...result.failed); reason = result.reason; }
      }
      if (failed.length) {
        failed.forEach((id) => this.hidden.delete(id));
        this.rev++;
        this.toast({ text: failureText(failed.length, ids.length, reason, true), kind: "error" });
        if (failed.length === ids.length) { if (this.view.kind === "senders") void this.findIgnoredSenders(); return 0; }
      }
    } catch (e: any) {
      ids.forEach((id) => this.hidden.delete(id));
      this.rev++;
      this.toast({ text: `Couldn't archive: ${e?.message || e}`, kind: "error" });
      if (this.view.kind === "senders") void this.findIgnoredSenders();
      return 0;
    }
    this.viewCache.markDirty();
    const undo = this.pushUndo("Archive", async () => { await this.undoMove(originals, startedAt); void this.findIgnoredSenders(); });
    const name = displayName(originals[0].author) || address;
    this.toast({ text: `Archived ${originals.length} ${originals.length === 1 ? "email" : "emails"} from ${name}`, kind: "info", action: { label: "Undo", run: undo } });
    if (this.view.kind === "senders") void this.findIgnoredSenders();
    setTimeout(() => { if (this.view.kind === "senders") void this.findIgnoredSenders(); }, 1500);
    return originals.length;
  }

  /** Unsubscribe the way the list allows: one click (done here), else its page in the browser. Returns
   *  "done", "page" (finish in the browser) or "email" (the caller writes the email). */
  async unsubscribeSender(address: string, how: Unsubscribe, refresh = true): Promise<"done" | "page" | "email" | "failed"> {
    let result: "done" | "page" | "email" | "failed" = "failed";
    if (how.oneClick && typeof api.sparkLinks?.unsubscribe === "function") {
      const reply = await Promise.resolve(api.sparkLinks.unsubscribe(how.oneClick)).catch(() => null);
      if (reply?.ok) result = "done";
    }
    if (result === "failed" && how.web) {
      await Promise.resolve(api.windows?.openDefaultBrowser?.(how.web) ?? window.open(how.web, "_blank", "noopener")).catch(() => {});
      result = "page";
    }
    if (result === "failed" && how.mailto) result = "email";
    if (result === "failed") { this.toast({ text: "Couldn't unsubscribe. Try again later.", kind: "error" }); return result; }
    await this.setSetting("unsubscribedSenders", { ...this.settings.unsubscribedSenders, [address.toLowerCase()]: Date.now() }).catch(() => {});
    if (refresh) void this.findIgnoredSenders();
    return result;
  }

  /** Off the list (you do want their mail), or back on it. */
  async keepSender(address: string, keep = true) {
    address = address.toLowerCase();
    const kept = this.settings.keptSenders.filter((a) => a !== address);
    await this.setSetting("keptSenders", keep ? [...kept, address] : kept);
    if (keep) this.ignored = this.ignored.filter((s) => s.address !== address);
    else void this.findIgnoredSenders();
  }

  /** Forget an unsubscribe (it's back on the list if it still qualifies). */
  async forgetUnsubscribe(address: string) {
    const { [address]: _, ...rest } = this.settings.unsubscribedSenders;
    await this.setSetting("unsubscribedSenders", rest);
    void this.findIgnoredSenders();
  }

  async approveAttachmentDomain(domain: string) {
    const normalized = normalizeDomain(domain);
    if (!normalized) return;
    await this.setSetting("approvedAttachmentDomains", Array.from(new Set([...this.settings.approvedAttachmentDomains, normalized])).sort());
  }
}

export const store = new Store();
