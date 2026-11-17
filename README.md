<p align="center"><img src="https://raw.githubusercontent.com/MerrittFranzmann/ember-for-thunderbird/main/ember.svg" width="96" alt=""></p>

<h1 align="center">Ember for Thunderbird</h1>

<p align="center">A calmer, faster way through your email, inside Thunderbird on your Mac.</p>

Ember replaces Thunderbird's everyday window with a clean mail app: a Smart Inbox across all your accounts, conversations, quick actions, an in-app composer, and a calendar. Thunderbird keeps doing what it's good at in the background: your accounts, syncing, storage and sending.

**[Download the latest version](https://github.com/MerrittFranzmann/ember-for-thunderbird/releases/latest)**

## What you need

- A Mac.
- **Thunderbird 158 or newer** ([download Thunderbird](https://www.thunderbird.net)). To check yours: Thunderbird → About Thunderbird.

## Install

1. Download `ember-<version>.xpi` from the [latest release](https://github.com/MerrittFranzmann/ember-for-thunderbird/releases/latest). If your browser asks, keep the file.
2. In Thunderbird, open **Tools → Add-ons and Themes** (or the ☰ menu → Add-ons and Themes).
3. Click the **gear** button, choose **Install Add-on From File…**, and pick the file you downloaded.
4. Thunderbird says Ember can access everything in Thunderbird and on your computer. Ember needs that to show your calendar, run its own window and keep itself up to date. Click **Add**.

Ember opens in its own window. If Thunderbird has no email account yet, click **Add an email account**: Gmail, Outlook and Microsoft 365, iCloud, Exchange and most other providers set themselves up from your address.

## Updates

Ember updates itself. New versions come from this page's releases, and Ember installs only versions signed by its publisher. They install while you're not using Ember, never while you're writing an email, and Ember reopens where you were. To check now: **Settings → Updates**.

## What's in it

- **Smart Inbox** across every account, with People, Calendar, Updates, Newsletters and Pinned, and optional Work and Personal inboxes.
- **Conversations**, quick archive and pin, and an undo window for sending.
- **Calendar** for Exchange and Microsoft 365 accounts: day, week, month and year, create and change events, answer invitations, find a time with colleagues, and see shared calendars.
- **Attachments and links** collected from your mail; checks that shared links will open for the people you send them to.
- **Focus**, a **lock** with Touch ID, **dark mode** for email, and keyboard shortcuts for everything.
- **AI**, only if you turn it on: inbox sorting with your own Cloudflare account, and a connector so AI agents (Claude and others) can help with your email. Agents can draft replies but never send.

## Your data

Your email stays in Thunderbird on your Mac. Ember has no account, no server and no analytics. It connects to:

- your mail and calendar servers, through Thunderbird;
- GitHub, to check for updates;
- only if you turn them on: Cloudflare (AI sorting, with your own key), VirusTotal (attachment checks, with your own key, sending only a file's fingerprint unless you choose to upload it), and Google, Microsoft and Dropbox (to check whether a shared link opens without signing in).

## Going back to Thunderbird

**Settings → Switch to Thunderbird** shows Thunderbird's own window at any time. To remove Ember: Add-ons and Themes → Ember for Thunderbird → Remove. Thunderbird's own settings and window come back as they were.

## Problems or ideas

Open an [issue](https://github.com/MerrittFranzmann/ember-for-thunderbird/issues), with your Ember and Thunderbird versions (**Settings → Troubleshooting → About**).

---

Ember is an independent project. It isn't made by, or affiliated with, Mozilla (Thunderbird) or Readdle (Spark).
