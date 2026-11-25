import { getDocument, GlobalWorkerOptions, PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs";
export type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist/types/src/display/api";
export function loadPDF(data: Uint8Array, resource: (path: string) => string) {
  const url = resource("pdf/pdf.worker.mjs");
  GlobalWorkerOptions.workerSrc = url;
  // Explicit extension-local worker avoids PDF.js's cross-origin blob wrapper.
  const port = new Worker(url, { type: "module" });
  const worker = PDFWorker.create({ port });
  try {
    const task = getDocument({ data, worker, cMapUrl: resource("pdf/cmaps/"), cMapPacked: true, standardFontDataUrl: resource("pdf/standard_fonts/"), wasmUrl: resource("pdf/wasm/"), useWorkerFetch: false, enableXfa: false });
    const destroy = task.destroy.bind(task);
    let closing: Promise<void> | undefined;
    task.destroy = () => closing ||= (async () => { try { await destroy(); } finally { worker.destroy(); port.terminate(); } })();
    return task;
  } catch (error) { worker.destroy(); port.terminate(); throw error; }
}
