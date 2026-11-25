import { api, env } from "./api";

class SendSettings {
  supported = $state(false);
  enabled = $state(false);
  busy = $state(false);
  error = $state("");

  refresh() {
    this.supported = env.tb >= 153;
    this.enabled = env.hasBackgroundSend;
  }

  /** Call directly from a user gesture: Thunderbird requires explicit approval. */
  async enable(): Promise<boolean> {
    this.error = "";
    if (env.hasBackgroundSend) { this.refresh(); return true; }
    if (env.tb < 153 || !api.permissions?.request) {
      this.error = "This Thunderbird version doesn't support window-free sending.";
      return false;
    }
    this.busy = true;
    try {
      const granted = await api.permissions.request({ permissions: ["messages.send"] });
      this.refresh();
      if (!granted) this.error = "Window-free sending wasn't enabled. You can enable it here later.";
      else if (!this.enabled) this.error = "Reopen Ember to finish enabling window-free sending.";
      return granted && this.enabled;
    } catch (error: any) {
      this.error = error?.message || "Couldn't enable window-free sending.";
      return false;
    } finally { this.busy = false; }
  }
}

export const sendSettings = new SendSettings();
