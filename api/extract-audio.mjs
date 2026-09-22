import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const htmlPath = path.join(root, "index.html");
const outDir = path.join(root, "assets", "sounds");

const html = fs.readFileSync(htmlPath, "utf8");

// Match: const WATER_AUDIO_SRC = 'data:audio/mpeg;base64,<...>';
const marker = "const WATER_AUDIO_SRC = 'data:audio/mpeg;base64,";
const start = html.indexOf(marker);
if (start === -1) throw new Error("WATER_AUDIO_SRC constant not found");

const base64Start = start + marker.length;
const end = html.indexOf("';", base64Start);
if (end === -1) throw new Error("End of WATER_AUDIO_SRC constant not found");

const base64 = html.slice(base64Start, end);
const buffer = Buffer.from(base64, "base64");

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "water-ambient.mp3");
fs.writeFileSync(outPath, buffer);

// Replace the inline base64 with a lazily-resolved file path.
// The path can be overridden at runtime by the published audio config.
const htmlSizeBefore = fs.statSync(htmlPath).size;
const replacement =
  "let WATER_AUDIO_SRC = (window.FISHTANK_ASSET_BASE || '') + 'assets/sounds/water-ambient.mp3';";
const htmlAfter = html.slice(0, start) + replacement + html.slice(end + 2);
fs.writeFileSync(htmlPath, htmlAfter, "utf8");

// Report
console.log("Extracted audio bytes:", buffer.length);
console.log("index.html before:", htmlSizeBefore, "bytes");
console.log("index.html after :", fs.statSync(htmlPath).size, "bytes");
console.log("Saved to:", outPath);
console.log("Done. index.html updated in place.");
