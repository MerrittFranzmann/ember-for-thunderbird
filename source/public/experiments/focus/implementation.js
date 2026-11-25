/* Focus (Ember's quiet hours and work mail by network). Which network: macOS doesn't tell apps the Wi-Fi
 * name without location access, and Thunderbird's own network id changes with every start, so a network is
 * known by its router: the default route's gateway and that gateway's hardware address (route, arp), hashed.
 * New-mail alerts: while Ember announces new mail itself, Thunderbird's alert and sound are off; their
 * earlier values are kept in prefs and put back. The pure helpers at the top are unit-tested
 * (test/focus-experiment.test.ts). */
"use strict";

/** The default route's gateway and interface, from `route -n get default`. */
function focusRoute(text) {
  const gateway = /gateway:\s*([0-9a-f.:]+)/i.exec(text || "")?.[1] || null;
  const iface = /interface:\s*(\S+)/i.exec(text || "")?.[1] || null;
  return { gateway, iface };
}
/** The hardware address in `arp -n <ip>` output, normalized ("0:1b:2" → "00:1b:02"), or null. */
function focusMac(text) {
  const match = /\bat\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i.exec(text || "");
  return match ? match[1].toLowerCase().split(":").map((part) => part.padStart(2, "0")).join(":") : null;
}

if (typeof module === "object") module.exports = { focusRoute, focusMac };

const FOCUS_SAVED = "extensions.spark.focus.savedAlerts";

var sparkFocus = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    Cu.importGlobalProperties(["crypto", "TextEncoder"]);
    const run = async (command, args) => {
      try {
        const proc = await Subprocess.call({ command, arguments: args, stderr: "stdout" });
        let out = "", chunk;
        while ((chunk = await proc.stdout.readString())) out += chunk;
        await proc.wait();
        return out;
      } catch { return ""; }
    };
    const linkService = () => { try { return Cc["@mozilla.org/network/network-link-service;1"].getService(Ci.nsINetworkLinkService); } catch { return null; } };
    return {
      sparkFocus: {
        async network() {
          const link = linkService();
          let dns = [];
          try { dns = [...(link?.dnsSuffixList || [])].map(String); } catch { /* not on this system */ }
          const { gateway } = focusRoute(await run("/sbin/route", ["-n", "get", "default"]));
          const mac = gateway ? focusMac(await run("/usr/sbin/arp", ["-n", gateway])) : null;
          let key = null;
          if (gateway && mac) {
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`spark-network|${mac}|${gateway}`));
            key = [...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
          }
          return { key, router: gateway, dns, linkUp: link ? link.isLinkUp : true };
        },
        async setMailAlerts(on) {
          const prefs = Services.prefs;
          if (!on) {
            if (!prefs.prefHasUserValue(FOCUS_SAVED)) {
              prefs.setStringPref(FOCUS_SAVED, JSON.stringify({ alert: prefs.getBoolPref("mail.biff.show_alert", true), sound: prefs.getBoolPref("mail.biff.play_sound", true) }));
            }
            prefs.setBoolPref("mail.biff.show_alert", false);
            prefs.setBoolPref("mail.biff.play_sound", false);
            return false;
          }
          if (prefs.prefHasUserValue(FOCUS_SAVED)) {
            let saved = { alert: true, sound: true };
            try { saved = JSON.parse(prefs.getStringPref(FOCUS_SAVED)); } catch { /* defaults */ }
            prefs.setBoolPref("mail.biff.show_alert", !!saved.alert);
            prefs.setBoolPref("mail.biff.play_sound", !!saved.sound);
            prefs.clearUserPref(FOCUS_SAVED);
          }
          return true;
        },
        onNetworkChanged: new ExtensionCommon.EventManager({
          context,
          name: "sparkFocus.onNetworkChanged",
          register: (fire) => {
            const topics = ["network:link-status-changed", "network:networkid-changed", "network:link-type-changed"];
            let timer = null;
            const observer = { observe() {
              // A switch sends several notifications in a row: one event once it settles.
              if (timer) timer.cancel();
              timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
              timer.initWithCallback(() => { timer = null; fire.async().catch(() => {}); }, 3000, Ci.nsITimer.TYPE_ONE_SHOT);
            } };
            for (const topic of topics) Services.obs.addObserver(observer, topic);
            return () => { if (timer) timer.cancel(); for (const topic of topics) Services.obs.removeObserver(observer, topic); };
          },
        }).api(),
      },
    };
  }
};
