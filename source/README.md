# Ember for Thunderbird: source

Ember is a fast, focused mail app that runs inside Thunderbird on the Mac. Thunderbird keeps doing
the plumbing (accounts, sign-in, sync, storage, filters and sending), and Ember replaces the
day-to-day interface: one Smart Inbox, conversations, a reader and composer, a calendar,
Attachments, and an optional connection for AI agents.

To **install** Ember, see the [install page](../README.md). This folder is the source code.

## Requirements

- Thunderbird 158 or later, on macOS (Touch ID lock, Focus networks and the Dock icon are
  Mac-specific; most of the app would run elsewhere but is only tested on the Mac).
- Node.js 22 or later, for building.
- Python 3, only for the test tools in `tools/`.

## Build

```
npm install
npm run build      # Svelte 5 + Vite → dist/
npm run package    # build, then zip dist/ into thunderbird-spark-<version>.xpi
npm test           # unit tests (Vitest)
npm run check      # type check (svelte-check)
```

To try a build without installing it: Thunderbird → **Tools → Developer Tools → Debug Add-ons**
→ **Load Temporary Add-on…** → pick `dist/manifest.json`. To install a packaged `.xpi`, use
**Add-ons and Themes → gear → Install Add-on From File…** (Thunderbird must allow unsigned
add-ons: `xpinstall.signatures.required` set to `false` in the Config Editor).

Use a separate Thunderbird profile for development (`/Applications/Thunderbird.app/Contents/MacOS/thunderbird -P`
creates one), not the profile with your own mail.

## How it fits together

```
public/manifest.json        Manifest V3. The add-on id is still "thunderbird-spark@…" (Ember's
                            earlier name); changing it would break updates for installed copies.
public/experiments/         Experiment APIs: privileged code for what MailExtensions can't do
src/                        The app (Svelte 5 + TypeScript)
  App.svelte, Settings.svelte   The main window and the Settings window
  components/               Sidebar, message list, reader, composer, calendar, Attachments …
  lib/store.svelte.ts       The data layer: views, paging, conversations, actions, live events
  lib/local-mail-cache.ts   The saved copy of recent mail (instant lists, offline search)
  lib/body.ts               MIME selection and HTML sanitizing for the reader
  background.ts             The background page (startup, new mail, caching)
mcp/spark-mcp.mjs           The MCP server AI agents talk to (bundled into the add-on)
scripts/                    Build, packaging and fixture-mail generation
test/                       Unit tests
tools/                      Live tests that drive a real Thunderbird through Marionette (see below)
```

**Experiment APIs** (`public/experiments/<name>/`, each with a `schema.json` describing it):

| Name | What it does |
|---|---|
| `window` | Ember-only mode: Thunderbird keeps running with its own window hidden |
| `calendar` | Calendar invitations and events through Thunderbird's calendars and Exchange (EWS) |
| `send` | Sends replies and forwards without opening Thunderbird's composer window |
| `archive` | Archives the way Thunderbird does, and reports emails that didn't move |
| `junk` | Mark as spam / not spam, training Thunderbird's own junk filter |
| `search` | Search all mail with Thunderbird's own search engine |
| `links` | Whether a shared Google Drive, OneDrive or Dropbox link opens without signing in; one-click unsubscribe |
| `maillinks` | Links that open an email in Ember (a loopback-only address) |
| `print` | A conversation saved as a PDF |
| `scan` | VirusTotal lookups by file hash, with the user's own key |
| `ai` | AI sorting through the user's own Cloudflare Workers AI account |
| `agent` | A local socket for AI agents (MCP); off until the user turns it on |
| `focus` | Which network the Mac is on (for work-only notifications) |
| `lock` | Lock with Touch ID |
| `update` | Signed automatic updates from this repository's releases |

## Security notes

- **Email HTML** is sanitized (scripts, event handlers, frames, `javascript:` links and
  external stylesheets removed) and shown in a sandboxed `<iframe srcdoc>` without
  `allow-scripts`, under a CSP that blocks remote content until the user loads images and
  stops forms from submitting.
- **Updates are signed.** Each release's `latest.json` carries the XPI's SHA-256 and an ECDSA
  P-256 signature; `public/experiments/update/implementation.js` holds the public key and
  installs only what the publisher's private key signed. The private key is not in this
  repository.
- **AI agents** connect only through a socket in the user's own Library folder, only after the
  user turns them on, can never send mail, and every action is logged in Agent Activity.
- Some test hooks read Thunderbird preferences (`extensions.spark.test*`, `lock.testAuth`). The
  Touch ID test hook works only while Thunderbird is under Marionette remote control, which
  already gives full control of Thunderbird.

## Forking

If you publish your own build, give it your own identity so it can't collide with Ember:

1. Change the add-on id in `public/manifest.json`.
2. Point `public/experiments/update/implementation.js` at your own releases, with your own
   public key (or turn updates off), since installed copies only accept releases signed for the
   key they carry.
3. Choose a different name and icon.

## Tests

- `npm test`: unit tests for the data layer, threading, sanitizing, calendar parsing, send
  checks and the Experiment helpers. They need no Thunderbird.
- `tools/`: the maintainer's live tests. They launch Thunderbird with a throwaway profile
  (`tools/fresh_profile.py`, or the fixture profile from `tools/setup_test_profile.sh`) on a
  separate Marionette port, seed fictional mail, and check the app end to end. Mock servers
  stand in for Exchange (`ews_mock.py`), CalDAV (`caldav_mock.py`) and SMTP (`smtp_sink.py`), so
  nothing reaches a real account. They're written for the maintainer's Mac and paths, so
  expect to adjust them. Never point them at a profile with your own mail.

## Third-party code

ICAL.js 2.2.1 (MPL-2.0) parses calendars, and PDF.js 6.4.299 (Apache-2.0) previews PDFs. Both
are bundled, and their licenses ship in `public/licenses/`. No remote code is loaded at runtime.

## License

[MIT](LICENSE). Ember is an independent project. It isn't made by, or affiliated with, Mozilla
(Thunderbird) or Readdle (Spark).
