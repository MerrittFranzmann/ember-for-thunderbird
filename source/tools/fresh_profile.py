"""A brand-new Thunderbird profile for testing what someone who downloads Ember gets (tools/test_fresh_install.py).

Nothing of the fixture profile: no accounts, no mail, none of its prefs (not xpinstall.signatures.required, not
extensions.experiments.enabled). Only what keeps the test apart from the user's own Ember and the internet:
Marionette on FRESH_PORT, a dead proxy for everything but 127.0.0.1, the test agent socket and link port, and the
update feed pointed at a local mock of GitHub. The profile is deleted by `remove()`.
"""
import os, shutil, socket, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
FRESH_PORT = 2834
PROFILE = "/private/tmp/claude-503/emberfresh"
SOCKET = "/private/tmp/claude-503/ember-agent-fresh.sock"
TB = "/Applications/Thunderbird.app/Contents/MacOS/thunderbird"
LOG = "/private/tmp/claude-503/ember-fresh-tb.log"


def create(feed_url="off"):
    remove()
    os.makedirs(PROFILE)
    prefs = {
        "marionette.port": FRESH_PORT,
        # Nothing leaves this Mac: every connection but 127.0.0.1 goes to a closed port.
        "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": 9,
        "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": 9, "network.proxy.no_proxies_on": "127.0.0.1, localhost",
        "network.proxy.allow_hijacking_localhost": False,
        # Never the user's own Ember's socket, link port or updates.
        "extensions.spark.agentSocket": SOCKET,
        "extensions.spark.mailLinkPort": 47393, "extensions.spark.mailLinkActivate": False,
        "extensions.spark.updateFeed": feed_url,
        # A modal "make Thunderbird your default mail app?" would block the test (a real user just answers it).
        "mail.shell.checkDefaultClient": False,
    }
    with open(os.path.join(PROFILE, "user.js"), "w") as out:
        for key, value in prefs.items():
            literal = "true" if value is True else "false" if value is False else str(value) if isinstance(value, int) else '"' + value.replace('"', '\\"') + '"'
            out.write(f'user_pref("{key}", {literal});\n')


def port_open():
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", FRESH_PORT)) == 0


def launch():
    if port_open():
        raise RuntimeError(f"something already listens on {FRESH_PORT}: not a fresh Thunderbird")
    subprocess.Popen([TB, "-profile", PROFILE, "-no-remote", "--marionette", "-remote-allow-system-access"],
                     stdout=open(LOG, "a"), stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(160):
        if port_open():
            break
        time.sleep(0.25)
    else:
        raise RuntimeError("the fresh Thunderbird didn't start")
    os.environ["SPARK_PORT"] = str(FRESH_PORT)
    import spark
    spark.PORT = FRESH_PORT
    m = spark.connect()
    for _ in range(80):
        if m.execute("return document.readyState === 'complete'"):
            break
        time.sleep(0.25)
    return m


def pids():
    """Thunderbird processes running this profile (never the user's or the fixture profile's)."""
    out = subprocess.run(["pgrep", "-f", "--", f"-profile {PROFILE}"], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out]


def quit(m=None):
    try:
        if m: m._cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
    except Exception:
        pass
    for _ in range(40):
        if not pids():
            return
        time.sleep(0.25)
    for pid in pids():
        os.kill(pid, 15)


def remove():
    quit()
    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)
    if os.path.exists(SOCKET):
        os.remove(SOCKET)
