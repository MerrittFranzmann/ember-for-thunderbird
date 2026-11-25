#!/usr/bin/env python3
"""Generate a realistic fixture mailbox set for testing Ember for Thunderbird.

Writes Berkeley mbox files (one per folder) into an output directory:

    <out>/work/Inbox, Sent, Drafts, Archives, Projects, Receipts
    <out>/local/Inbox

~300 varied messages: people, threads (incl. my replies in Sent), notifications
(noreply senders, Auto-Submitted, X-GitHub-Reason, List-Unsubscribe without
List-Id), newsletters (List-Unsubscribe + List-Id + Precedence: bulk, HTML with
remote images), attachments (pdf/png/txt), an inline cid: image, HTML and plain.

Dates are relative to "now" so the list shows today / this week / older.
Deterministic for a given seed and day.

Usage: make_fixtures.py <outdir> [--seed N] [--scale N]   (--scale 15 ≈ 4,000 messages)
"""
import base64
import os
import random
import struct
import sys
import time
import zlib
from email.utils import formatdate

ME = ("Merritt Franzmann", "merritt@spark.test")
NOW = time.time()

PEOPLE = [
    ("Ada Lovelace", "ada@analytical.engineering"),
    ("Grace Hopper", "grace@navy-compilers.org"),
    ("Katherine Johnson", "katherine@langley.space"),
    ("Alan Turing", "alan@bletchley.park"),
    ("Margaret Hamilton", "margaret@apollo.software"),
    ("Edsger Dijkstra", "edsger@eindhoven.nl"),
    ("Hedy Lamarr", "hedy@frequency.hop"),
    ("Claude Shannon", "claude@bell-labs.io"),
    ("Barbara Liskov", "barbara@clu.mit.edu"),
    ("Donald Knuth", "don@taocp.stanford.edu"),
    ("Radia Perlman", "radia@spanning.tree"),
    ("Tim Berners-Lee", "tim@w3.example"),
    ("Frances Allen", "fran@ibm-research.example"),
    ("Linus Torvalds", "linus@kernel.example"),
    ("Sophie Wilson", "sophie@acorn.example"),
    ("Jean Sammet", "jean@cobol.example"),
    ("Annie Easley", "annie@glenn.example"),
    ("Ken Thompson", "ken@unix.example"),
    ("Dorothy Vaughan", "dorothy@fortran.example"),
    ("John McCarthy", "jmc@lisp.example"),
    ("Mary Kenneth Keller", "mary@basic.example"),
    ("Vint Cerf", "vint@tcpip.example"),
]

PEOPLE_SUBJECTS = [
    "Coffee next week?", "Quick question about the deck", "Notes from today's call",
    "Draft budget for Q4", "Can you review this?", "Lunch on Friday", "Re-scheduling our 1:1",
    "Photos from the offsite", "Feedback on the proposal", "The plan for Monday",
    "Contract — final version", "Intro: you two should meet", "Book recommendation",
    "Travel itinerary", "Thoughts on the new layout", "Following up", "Thank you!",
    "Where did we land on pricing?", "Board meeting prep", "Volunteer schedule",
    "Video edit v3 is ready", "Interview loop for Thursday", "Ideas for the newsletter",
    "Grant report numbers", "Sound check at 6pm",
]

PEOPLE_BODIES = [
    "Hi Merritt,\n\n{line}\n\nLet me know what you think when you get a chance.\n\nThanks,\n{first}",
    "Hey!\n\n{line} I can also jump on a quick call if that's easier.\n\n— {first}",
    "Merritt,\n\n{line}\n\nNo rush on this — end of week is fine.\n\nBest,\n{first}",
    "{line}\n\nSent from my phone",
    "Hello,\n\nFollowing up on our conversation. {line}\n\nCheers,\n{first}",
]

LINES = [
    "I went through the draft this morning and left comments on the second half.",
    "Are you free Tuesday around 10? I'd love to walk through the timeline together.",
    "The numbers look good overall, but the travel line item seems high to me.",
    "Attached is the latest version — the changes are mostly in section three.",
    "We should loop in the design team before we commit to anything.",
    "I think we can ship this as-is and iterate after launch.",
    "Could you send me the recording from yesterday? I missed the last twenty minutes.",
    "The venue confirmed for the 14th, so we're officially on.",
    "Great work on the presentation — the board loved the story arc.",
    "Can we push our meeting to Thursday? Something came up on my end.",
    "Here's the link to the shared folder with all the raw footage.",
    "I'm not sure the second option works for the mobile layout.",
]

NOTIFS = [
    # (name, email, subject templates, extra headers, html?)
    ("GitHub", "notifications@github.com",
     ["[northwind/site] Pull request #{n}: Fix header spacing on mobile",
      "[northwind/site] Issue #{n}: Footer links broken on Safari",
      "[northwind/app] Re: Build failing on main (#{n})",
      "[northwind/app] Merged #{n} into main"],
     {"X-GitHub-Reason": "review_requested", "List-Id": "northwind/site <site.northwind.github.com>",
      "List-Unsubscribe": "<mailto:unsub+{n}@reply.github.com>", "Precedence": "list"}, False),
    ("Stripe", "receipts@stripe.com",
     ["Your receipt from Acme Studio #{n}", "Payment of $49.00 to Northwind succeeded"],
     {"Auto-Submitted": "auto-generated"}, True),
    ("Google Calendar", "calendar-notification@google.com",
     ["Invitation: Design sync @ Tue 10am", "Updated invitation: Weekly review",
      "Reminder: Board meeting tomorrow at 2pm"],
     {"Auto-Submitted": "auto-generated"}, False),
    ("Slack", "no-reply@slack.com",
     ["You have {n} unread messages in #design", "New sign-in to your Slack account"],
     {"List-Unsubscribe": "<https://slack.com/unsubscribe/{n}>"}, True),
    ("Apple", "no_reply@email.apple.com",
     ["Your receipt from Apple.", "Your Apple ID was used to sign in to iCloud"], {}, True),
    ("UPS", "mcinfo@ups.com",
     ["UPS Update: Package scheduled for delivery today", "Your package has been delivered"],
     {"Auto-Submitted": "auto-generated"}, False),
    ("Dropbox", "no-reply@dropbox.com",
     ["Merritt, 12 files were added to “Footage”", "Security alert: new sign-in"], {}, True),
    ("Linear", "notifications@linear.app",
     ["ENG-{n} was assigned to you", "Weekly summary: 14 issues completed"],
     {"List-Unsubscribe": "<https://linear.app/unsub/{n}>"}, False),
    ("Bank of Example", "alerts@bank.example",
     ["Your statement is ready", "A deposit of $1,250.00 was posted"], {"Auto-Submitted": "auto-generated"}, False),
]

NEWSLETTERS = [
    ("The Verge", "newsletter@theverge.example", "The Verge Daily",
     ["Apple's next big thing", "The week in gadgets", "Why everyone is talking about AI glasses"]),
    ("Stratechery", "email@stratechery.example", "Stratechery",
     ["Aggregation theory, revisited", "The end of the beginning", "Platforms and their discontents"]),
    ("Morning Brew", "crew@morningbrew.example", "Morning Brew",
     ["☕ Markets rally on rate news", "☕ The four-day work week", "☕ What's in a logo?"]),
    ("Figma", "hello@figma.example", "Figma Updates",
     ["Config 2026 recap: everything we announced", "New in Figma: variables for prototyping"]),
    ("Product Hunt", "hello@digest.producthunt.example", "Product Hunt Daily",
     ["Today's top 5 products", "The best new productivity apps"]),
    ("Craig Mod", "craig@roden.example", "Roden",
     ["Roden #102: Walking the Kumano Kodo", "Roden #103: Books, slowly"]),
    ("Christian Today", "news@christiantoday.example", "Christian Today",
     ["This week: stories of hope from around the world", "Faith & film: a conversation"]),
]

THREADS = [
    ("Ada Lovelace", "ada@analytical.engineering", "Reading pane layout review", [
        ("them", "Hi Merritt,\n\nAttached are my first thoughts on the reading-pane layouts. The sheet variant is my favorite so far, but the hero band needs a stronger tint.\n\nCould we try the rail on a wide window tomorrow?\n\n— Ada"),
        ("me", "Agreed on the sheet. Bumping the hero tint to 24% today.\n\n— M"),
        ("them", "24% reads much better. Ship it.\n\nOne more: the date rail wraps on narrow panes — worth a look.\n\n— Ada"),
        ("me", "Fixed the wrap — it was a min-width on the rail. Pushed a new build."),
        ("them", "Perfect. Closing this out. Thanks for the quick turnaround!\n\n— Ada"),
    ]),
    ("Grace Hopper", "grace@navy-compilers.org", "Compiler talk moved to Thursday", [
        ("them", "Room 4B, 2pm. Bring the demo tape.\n\n— G"),
        ("me", "Will do. Should I bring the projector adapter too?"),
        ("them", "Yes please — the one in 4B only does VGA. Nanoseconds matter.\n\n— G"),
    ]),
    ("Katherine Johnson", "katherine@langley.space", "Trajectory numbers for the Friday review", [
        ("them", "Here are the numbers. Please use this version and not the spreadsheet from Monday.\n\n— KJ"),
        ("me", "Got it, thanks. One question about row 14 — is that in seconds or minutes?"),
        ("them", "Seconds. I'll relabel the column so nobody else trips on it.\n\n— KJ"),
        ("them", "Relabelled and re-sent. Also added the error bars you asked for.\n\n— KJ"),
    ]),
    ("Hedy Lamarr", "hedy@frequency.hop", "Lunch on Friday", [
        ("them", "Are you still up for lunch Friday? I found a new place downtown."),
        ("me", "Yes! 12:30 works for me."),
    ]),
    ("Barbara Liskov", "barbara@clu.mit.edu", "Contract — final version", [
        ("them", "Final contract attached. Legal signed off this morning."),
        ("me", "Thanks Barbara — countersigned and sent back."),
        ("them", "Received. We're official! 🎉"),
    ]),
    ("Donald Knuth", "don@taocp.stanford.edu", "Typos in chapter 7", [
        ("them", "I found three typos in chapter 7. A check for $2.56 is in the mail for each."),
        ("me", "Ha — I'll frame them. Corrections are in the errata now."),
        ("them", "Splendid. Volume 4C is next.\n\n— DEK"),
        ("me", "Looking forward to it!"),
        ("them", "Also: please don't call it a 'blog post'. It is a 'note'.\n\n— DEK"),
        ("them", "(That was a joke.)"),
    ]),
]

FIRST_NAMES = lambda n: n.split()[0]


def png(w=48, h=48, rgb=(10, 132, 255)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
       b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")


class Gen:
    def __init__(self, seed):
        self.r = random.Random(seed)
        self.n = 0

    def mid(self):
        self.n += 1
        return f"fx{self.n:05d}.{self.r.randrange(1 << 30):x}@spark.fixtures"

    def b64(self, data):
        s = base64.b64encode(data).decode()
        return "\n".join(s[i:i + 76] for i in range(0, len(s), 76))

    def message(self, *, frm, to, subject, ts, body, html=None, read=True, flagged=False,
                replied=False, msgid=None, in_reply_to=None, references=None, extra=None,
                attachments=None, inline_png=None, cc=None):
        msgid = msgid or self.mid()
        status = (1 if read else 0) | (2 if replied else 0) | (4 if flagged else 0)
        h = []
        h.append(f"X-Mozilla-Status: {status:04x}")
        h.append("X-Mozilla-Status2: 00000000")
        h.append(f"Message-ID: <{msgid}>")
        h.append(f"Date: {formatdate(ts, localtime=True)}")
        h.append(f"From: {frm[0]} <{frm[1]}>" if frm[0] else f"From: {frm[1]}")
        h.append("To: " + ", ".join(f"{n} <{e}>" for n, e in to))
        if cc:
            h.append("Cc: " + ", ".join(f"{n} <{e}>" for n, e in cc))
        h.append(f"Subject: {subject}")
        if in_reply_to:
            h.append(f"In-Reply-To: <{in_reply_to}>")
        if references:
            h.append("References: " + " ".join(f"<{r}>" for r in references))
        for k, v in (extra or {}).items():
            h.append(f"{k}: {v}")
        h.append("MIME-Version: 1.0")

        def text_part():
            if html is None:
                return ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body]
            ba = "alt-" + msgid.split("@")[0]
            return [f'Content-Type: multipart/alternative; boundary="{ba}"', "", f"--{ba}",
                    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body, "",
                    f"--{ba}", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit", "",
                    html, "", f"--{ba}--"]

        if inline_png:
            br = "rel-" + msgid.split("@")[0]
            part = [f'Content-Type: multipart/related; boundary="{br}"', "", f"--{br}",
                    "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", html, "",
                    f"--{br}", "Content-Type: image/png", "Content-Transfer-Encoding: base64",
                    f"Content-ID: <{inline_png}>", 'Content-Disposition: inline; filename="logo.png"', "",
                    self.b64(png(120, 40, (10, 132, 255))), f"--{br}--"]
        else:
            part = text_part()

        if attachments:
            bm = "mix-" + msgid.split("@")[0]
            lines = [f'Content-Type: multipart/mixed; boundary="{bm}"', "", f"--{bm}"] + part + [""]
            for name, ctype, data in attachments:
                lines += [f"--{bm}", f'Content-Type: {ctype}; name="{name}"', "Content-Transfer-Encoding: base64",
                          f'Content-Disposition: attachment; filename="{name}"', "", self.b64(data), ""]
            lines.append(f"--{bm}--")
            content = lines
        else:
            content = part
        out = "\n".join(h + content)
        # mbox escaping
        out = "\n".join((">" + l) if l.startswith("From ") else l for l in out.split("\n"))
        sep = time.strftime("From - %a %b %d %H:%M:%S %Y", time.gmtime(ts))
        return sep + "\n" + out + "\n\n", msgid


def ago(r, lo_days, hi_days):
    return NOW - r.uniform(lo_days, hi_days) * 86400


def newsletter_html(title, headline, r, n):
    color = r.choice(["#1a4731", "#3b2a7a", "#8a2b06", "#0b3d91", "#222222"])
    return f"""<html><head><style>body{{margin:0;font-family:Georgia,serif}} .btn{{display:inline-block;background:{color};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none}}</style></head>
<body><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="{color}" style="padding:28px">
<img src="https://images.newsletter.example/{n}/masthead.png" width="160" height="40" alt="{title}">
<h1 style="color:#fff;margin:10px 0 0">{title}</h1></td></tr>
<tr><td style="padding:24px 32px"><h2 style="margin:0 0 8px">{headline}</h2>
<img src="https://images.newsletter.example/{n}/hero.jpg" width="536" height="240" alt="" style="display:block;max-width:100%;background:#ddd">
<p style="line-height:1.6">This issue we dig into the story behind the headline, what it means for you, and three
things worth reading this week. Grab a coffee — it's a good one.</p>
<p style="line-height:1.6">Plus: a reader question about workflows, and a quick tip for keeping your inbox calm.</p>
<a class="btn" href="https://newsletter.example/read/{n}">Read the full story</a>
<p style="color:#888;font-size:12px;margin-top:28px">You're receiving this because you subscribed.
<a href="https://newsletter.example/unsubscribe/{n}">Unsubscribe</a></p></td></tr></table>
<img src="https://track.newsletter.example/open/{n}.gif" width="1" height="1" alt=""></body></html>"""


def notif_html(name, subject, color="#635bff"):
    return f"""<html><body style="margin:0;background:#f6f9fc;font-family:-apple-system,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e3e8ee">
<tr><td style="padding:24px 28px;border-bottom:4px solid {color}"><b style="font-size:18px">{name}</b></td></tr>
<tr><td style="padding:24px 28px;color:#32325d;font-size:15px;line-height:1.5">
<p style="margin:0 0 12px"><b>{subject}</b></p>
<p style="margin:0 0 12px">This is an automated message. Amount: <b>$49.00</b> · Method: Visa •••• 4242</p>
<p style="margin:0;color:#8898aa;font-size:12px">Questions? Visit our help center.</p></td></tr></table></td></tr></table></body></html>"""


def main():
    out = sys.argv[1]
    seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 7
    scale = int(sys.argv[sys.argv.index("--scale") + 1]) if "--scale" in sys.argv else 1
    if scale > 1 and "--seed" not in sys.argv:
        seed += scale  # distinct Message-IDs from the small set
    g = Gen(seed)
    r = g.r
    folders = {k: [] for k in ["work/Inbox", "work/Sent", "work/Drafts", "work/Archives",
                               "work/Projects", "work/Receipts", "local/Inbox"]}

    def add(folder, ts, text):
        folders[folder].append((ts, text))

    me_to = [ME]

    # --- Threads (inbox has their messages, Sent has mine) ---
    for ti, (name, email, subject, msgs) in enumerate(THREADS):
        start = ago(r, 0.2 + ti * 1.7, 0.4 + ti * 1.7 + 0.3) - len(msgs) * 3600 * 3
        ids = []
        ts = start
        for i, (who, body) in enumerate(msgs):
            ts += 3600 * r.uniform(0.5, 4) if i else 0
            subj = subject if i == 0 else "Re: " + subject
            refs = ids[:] if ids else None
            last = i == len(msgs) - 1
            if who == "me":
                text, mid = g.message(frm=ME, to=[(name, email)], subject=subj, ts=ts, body=body + "\n\n— Merritt",
                                      in_reply_to=ids[-1] if ids else None, references=refs)
                add("work/Sent", ts, text)
            else:
                atts = [("trajectory-v3.pdf", "application/pdf", PDF)] if (ti == 2 and i == 0) else None
                if ti == 4 and i == 0:
                    atts = [("contract-final.pdf", "application/pdf", PDF)]
                text, mid = g.message(frm=(name, email), to=me_to, subject=subj, ts=ts, body=body,
                                      read=not last, in_reply_to=ids[-1] if ids else None, references=refs,
                                      attachments=atts, flagged=(ti == 0 and last))
                add("work/Inbox", ts, text)
            ids.append(mid)

    # --- People one-offs ---
    for i in range(115 * scale):
        name, email = r.choice(PEOPLE)
        ts = ago(r, 0, 75 * scale ** 0.5) if i > 6 else ago(r, 0, 0.6)
        subj = r.choice(PEOPLE_SUBJECTS)
        body = r.choice(PEOPLE_BODIES).format(line=r.choice(LINES) + " " + r.choice(LINES), first=FIRST_NAMES(name))
        html = None
        if r.random() < 0.25:
            paras = "".join(f"<p>{p}</p>" for p in body.split("\n\n"))
            html = (f'<html><body><div style="font-family:Helvetica,Arial,sans-serif;font-size:14px">{paras}'
                    f'<p><a href="https://docs.example/shared/{i}">Shared doc</a></p></div></body></html>')
        atts = None
        roll = r.random()
        if roll < 0.08:
            atts = [(f"photo-{i}.png", "image/png", png(64, 48, (r.randrange(256), r.randrange(256), 180)))]
        elif roll < 0.14:
            atts = [(f"notes-{i}.txt", "text/plain", ("Notes\n=====\n\n- " + r.choice(LINES) + "\n").encode())]
        elif roll < 0.18:
            atts = [(f"report-{i}.pdf", "application/pdf", PDF)]
        cc = [r.choice(PEOPLE)] if r.random() < 0.2 else None
        age_days = (NOW - ts) / 86400
        text, _ = g.message(frm=(name, email), to=me_to, cc=cc, subject=subj, ts=ts, body=body, html=html,
                            read=age_days > 3 or r.random() < 0.3, flagged=r.random() < 0.05, attachments=atts)
        folder = "local/Inbox" if i % 3 == 0 else "work/Inbox"
        if i % 17 == 5:
            folder = "work/Archives"
        if i % 23 == 7:
            folder = "work/Projects"
        add(folder, ts, text)

    # --- Inline cid image message ---
    ts = ago(r, 0.05, 0.1)
    html = ('<html><body style="font-family:Helvetica,Arial,sans-serif"><p>Here is the new logo lockup we discussed — '
            'embedded right in the email:</p><p><img src="cid:logo@spark.fixtures" width="120" height="40" alt="Logo"></p>'
            '<p>And the remote version for comparison:</p><p><img src="https://cdn.example/logo-remote.png" width="120" height="40" alt="Remote logo"></p>'
            '<p>— Sophie</p></body></html>')
    text, _ = g.message(frm=("Sophie Wilson", "sophie@acorn.example"), to=me_to, subject="New logo lockup (inline image)",
                        ts=ts, body="", html=html, read=False, inline_png="logo@spark.fixtures")
    add("work/Inbox", ts, text)

    # --- Notifications ---
    for i in range(85 * scale):
        name, email, subjects, extra, is_html = r.choice(NOTIFS)
        n = r.randrange(100, 999)
        subj = r.choice(subjects).format(n=n)
        ts = ago(r, 0, 40)
        ex = {k: v.format(n=n) for k, v in extra.items()}
        body = f"{subj}\n\nThis is an automated notification from {name}.\n\nView it online: https://{email.split('@')[1]}/n/{n}"
        html = notif_html(name, subj) if is_html else None
        age_days = (NOW - ts) / 86400
        text, _ = g.message(frm=(name, email), to=me_to, subject=subj, ts=ts, body=body, html=html, extra=ex,
                            read=age_days > 2 or r.random() < 0.5)
        folder = "local/Inbox" if i % 4 == 0 else "work/Inbox"
        if name in ("Stripe", "Apple") and i % 3 == 0:
            folder = "work/Receipts"
        add(folder, ts, text)

    # --- Newsletters ---
    for i in range(60 * scale):
        name, email, title, heads = r.choice(NEWSLETTERS)
        n = r.randrange(1000, 9999)
        ts = ago(r, 0, 50)
        ex = {"List-Unsubscribe": f"<https://newsletter.example/unsubscribe/{n}>, <mailto:unsub-{n}@{email.split('@')[1]}>",
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              "List-Id": f"{title} <{title.lower().replace(' ', '-')}.list.example>",
              "Precedence": "bulk"}
        headline = r.choice(heads)
        age_days = (NOW - ts) / 86400
        text, _ = g.message(frm=(name, email), to=me_to, subject=headline, ts=ts,
                            body=f"{title}\n\n{headline}\n\nRead online: https://newsletter.example/read/{n}",
                            html=newsletter_html(title, headline, r, n), extra=ex,
                            read=age_days > 4 or r.random() < 0.3)
        add("local/Inbox" if i % 3 == 0 else "work/Inbox", ts, text)

    # --- Drafts ---
    for subj, body in [("Ideas for the spring campaign", "Rough list so far:\n\n- Story-driven video series\n- Partner spotlights"),
                       ("Re: Board meeting prep", "Here's my take on the agenda — ")]:
        ts = ago(r, 0, 3)
        text, _ = g.message(frm=ME, to=[r.choice(PEOPLE)], subject=subj, ts=ts, body=body)
        add("work/Drafts", ts, text)

    os.makedirs(out, exist_ok=True)
    total = 0
    for key, items in folders.items():
        acct, name = key.split("/")
        d = os.path.join(out, acct)
        os.makedirs(d, exist_ok=True)
        items.sort(key=lambda x: x[0])
        with open(os.path.join(d, name), "w", encoding="utf-8") as f:
            f.write("".join(t for _, t in items))
        total += len(items)
        print(f"  {key}: {len(items)}")
    print(f"wrote {total} messages to {out}")


if __name__ == "__main__":
    main()
