/* Save a conversation as PDF. Ember lays the conversation out as one HTML document; this loads it in a
 * hidden content browser (no scripts) and prints it silently to PDF (as Firefox's tabs.saveAsPDF does,
 * which Thunderbird lacks), then hands the bytes back so Ember can offer the system Save dialog.
 * Printing a frame of Ember's own page never finishes (the add-on's process doesn't print), hence the
 * separate browser. */
"use strict";

var sparkPrint = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function printSettings(paper) {
      const service = Cc["@mozilla.org/gfx/printsettings-service;1"].getService(Ci.nsIPrintSettingsService);
      const settings = service.createNewPrintSettings();
      settings.isInitializedFromPrinter = true;
      settings.isInitializedFromPrefs = true;
      // A named, non-system printer: the empty name looks up the Mac's default printer.
      settings.printerName = "spark-pdf";
      settings.printSilent = true;
      settings.outputFormat = Ci.nsIPrintSettings.kOutputFormatPDF;
      settings.paperSizeUnit = Ci.nsIPrintSettings.kPaperSizeInches;
      const letter = paper !== "a4";
      settings.paperId = letter ? "na_letter" : "iso_a4";
      settings.paperWidth = letter ? 8.5 : 8.27;
      settings.paperHeight = letter ? 11 : 11.69;
      settings.orientation = Ci.nsIPrintSettings.kPortraitOrientation;
      settings.marginTop = settings.marginBottom = 0.5;
      settings.marginLeft = settings.marginRight = 0.55;
      settings.headerStrLeft = settings.headerStrCenter = settings.headerStrRight = "";
      settings.footerStrLeft = settings.footerStrRight = "";
      settings.footerStrCenter = "&PT"; // "1 of 10"
      settings.printBGColors = true;
      settings.printBGImages = true;
      settings.shrinkToFit = true;
      // No pause between pages (Gecko's default is 50 ms each). Thunderbird's printing still waits ~0.4 s per
      // page on macOS, the same from an ordinary tab: about 4.5 s for an 11-page conversation.
      settings.printPageDelay = 0;
      settings.scaling = 1;
      return settings;
    }

    return {
      sparkPrint: {
        async htmlToPDF(html, options = {}) {
          const file = PathUtils.join(PathUtils.tempDir, `spark-print-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
          await IOUtils.writeUTF8(file, html);
          const win = Services.wm.getMostRecentWindow("mail:3pane") || Services.appShell.hiddenDOMWindow;
          const browser = win.document.createXULElement("browser");
          for (const [name, value] of Object.entries({ type: "content", remote: "true", maychangeremoteness: "true", disableglobalhistory: "true", messagemanagergroup: "spark-print" })) browser.setAttribute(name, value);
          browser.style.cssText = "position:fixed;left:0;top:0;width:816px;height:1056px;opacity:0;pointer-events:none;z-index:-1;";
          win.document.documentElement.appendChild(browser);
          try {
            const url = PathUtils.toFileURI(file);
            browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
            // Loaded, images included (or given up on after 20 s).
            for (let waited = 0; ; waited += 100) {
              const loaded = browser.browsingContext?.currentWindowGlobal?.documentURI?.spec === url && !browser.webProgress?.isLoadingDocument;
              if (loaded) break;
              if (waited > 20000) throw new Error("the conversation didn't finish loading");
              await pause(100);
            }
            browser.browsingContext.allowJavascript = false;
            const settings = printSettings(options.paper);
            const stream = Cc["@mozilla.org/storagestream;1"].createInstance(Ci.nsIStorageStream);
            stream.init(65536, 0xffffffff);
            settings.outputDestination = Ci.nsIPrintSettings.kOutputDestinationStream;
            settings.outputStream = stream.getOutputStream(0);
            // A print that never finishes (seen in testing) must not leave Ember waiting forever.
            let timer;
            const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("printing didn't finish")), 60000); });
            try { await Promise.race([browser.browsingContext.print(settings), timeout]); }
            finally { clearTimeout(timer); }
            const input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
            input.setInputStream(stream.newInputStream(0));
            const bytes = new Uint8Array(input.available());
            input.readArrayBuffer(bytes.length, bytes.buffer);
            stream.close();
            return bytes;
          } catch (error) {
            throw new ExtensionError(`Couldn't make the PDF: ${error?.message || error}`);
          } finally {
            browser.remove();
            await IOUtils.remove(file, { ignoreAbsent: true }).catch(() => {});
          }
        },
      },
    };
  }
};
this.sparkPrint = sparkPrint;
