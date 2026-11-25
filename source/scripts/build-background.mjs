import {rolldown} from "rolldown";
import {cpSync, mkdirSync} from "node:fs";
const bundle = await rolldown({input:"src/background.ts"});
await bundle.write({file:"dist/background.js",format:"iife"});await bundle.close();
mkdirSync("dist/pdf",{recursive:true});
cpSync("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs","dist/pdf/pdf.worker.mjs");
for(const folder of ["cmaps","standard_fonts","wasm"])cpSync(`node_modules/pdfjs-dist/${folder}`,`dist/pdf/${folder}`,{recursive:true});
// The MCP server agents run (the sparkAgent Experiment writes it to ~/Library/Application Support/Ember).
mkdirSync("dist/mcp",{recursive:true});
cpSync("mcp/spark-mcp.mjs","dist/mcp/ember-mcp.mjs");
