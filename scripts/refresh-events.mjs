// Weekly events refresh for greenvillestays.com
// Runs inside GitHub Actions. Calls the Anthropic API (with web search) to
// regenerate ONLY the `const EVENTS = [ ... ]` array in index.html, then the
// workflow commits the change. No sandbox / external server involved.

import { readFileSync, writeFileSync } from "node:fs";

const API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
if (!API_KEY) { console.error("Missing ANTHROPIC_API_KEY secret."); process.exit(1); }

// Try these models in order (first that works wins). Override with the
// ANTHROPIC_MODEL repo variable to pin a specific one.
const MODELS = (process.env.ANTHROPIC_MODEL && process.env.ANTHROPIC_MODEL.trim())
  ? [process.env.ANTHROPIC_MODEL.trim()]
  : ["claude-sonnet-4-5", "claude-3-7-sonnet-latest", "claude-3-5-sonnet-latest"];

const FILE = "index.html";
let html = readFileSync(FILE, "utf8");

// --- Locate the EVENTS array and bracket-match its bounds ---
const anchor = html.indexOf("const EVENTS");
if (anchor === -1) { console.error("Could not find 'const EVENTS' in index.html"); process.exit(1); }
const startBracket = html.indexOf("[", anchor);
let depth = 0, endBracket = -1;
for (let i = startBracket; i < html.length; i++) {
  const c = html[i];
  if (c === "[") depth++;
  else if (c === "]") { depth--; if (depth === 0) { endBracket = i; break; } }
}
if (endBracket === -1) { console.error("Could not find end of EVENTS array"); process.exit(1); }
const currentArray = html.slice(startBracket, endBracket + 1);

const today = new Date().toISOString().slice(0, 10);

const PROMPT = `You maintain the live events feed for greenvillestays.com, a Greenville & Travelers Rest, SC vacation-rental site. Today is ${today}.

Use web search to compile a COMPREHENSIVE, current list of upcoming events in the Greenville / Travelers Rest, SC area for roughly the next 5 months. Search broadly across: 6amcity.com/sc/greenville (GVLtoday), visitgreenvillesc.com/events, travelersresthere.com, kiddingaroundgreenville.com, greenvilledrive.com/schedule, peacecenter.org/events, and greenvillesc.gov. Aim for 30-40 entries. Include recurring weekly series (TD Saturday Market, Travelers Rest Farmers Market at Trailblazer Park, Main Street Fridays, Downtown Alive), Greenville Drive home games, Peace Center shows, festivals (euphoria, Fall for Greenville, Gran Fondo, Oktoberfest, Greek Festival, Artisphere), and seasonal/holiday events (Ice on Main, Poinsettia Parade). Verify confirmed dates; where a date is not published, use a "typical [month]" seasonal entry instead of inventing a date. DROP any event whose date has already fully passed relative to today.

Match these object shapes EXACTLY (keys and types):
- Confirmed dated event: {"name": "...", "date": "YYYY-MM-DD", "end": "YYYY-MM-DD" (optional), "venue": "Place · City", "desc": "...", "featured": true (optional)}
- Recurring weekly: {"name": "...", "recurring": true, "dows": [0-6 with Sunday=0], "badge": "...", "dayShort": "...", "freq": "...", "start": "YYYY-MM-DD", "until": "YYYY-MM-DD", "venue": "...", "desc": "..."}
- Typical-annual (no fixed date): {"name": "...", "recurring": true, "badge": "...", "dayShort": "...", "freq": "...", "venue": "...", "desc": "..."}

Here is the CURRENT array (refresh it: keep good recurring/seasonal entries, update their start/until windows, drop past-dated events, add newly announced ones):

${currentArray}

Respond with ONLY the new array as a single strict JSON array (a JSON document that starts with [ and ends with ]). No commentary, no code fences, no trailing text.`;

async function callModel(model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 12000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      messages: [{ role: "user", content: PROMPT }],
    }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 400)}`);
  const data = JSON.parse(txt);
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

let text = null, lastErr = null;
for (const model of MODELS) {
  try { console.log(`Calling ${model}...`); text = await callModel(model); console.log(`OK (${model})`); break; }
  catch (e) {
    const cause = e && e.cause ? ` | cause: ${e.cause.code || ""} ${e.cause.message || e.cause}` : "";
    console.error(`Model ${model} failed: ${e.message}${cause}`);
    lastErr = e;
  }
}
if (text === null) { console.error("All models failed. Last error:", lastErr?.message); process.exit(1); }

// --- Extract the JSON array from the response ---
let jsonStr = text.trim();
const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
if (fence) jsonStr = fence[1];
const a = jsonStr.indexOf("["), b = jsonStr.lastIndexOf("]");
if (a === -1 || b === -1 || b < a) { console.error("No JSON array in model response:\n", text.slice(0, 600)); process.exit(1); }
jsonStr = jsonStr.slice(a, b + 1);

let events;
try { events = JSON.parse(jsonStr); }
catch (e) { console.error("JSON parse failed:", e.message, "\n", jsonStr.slice(0, 600)); process.exit(1); }

// --- Validate before touching the file ---
if (!Array.isArray(events) || events.length < 12) {
  console.error(`Refusing to write: got ${Array.isArray(events) ? events.length : "non-array"} events (need >= 12).`);
  process.exit(1);
}
for (const ev of events) {
  if (typeof ev !== "object" || ev === null || typeof ev.name !== "string" || !ev.name) {
    console.error("Refusing to write: malformed event object:", JSON.stringify(ev).slice(0, 200));
    process.exit(1);
  }
  const dated = typeof ev.date === "string";
  const recurring = ev.recurring === true;
  if (!dated && !recurring) {
    console.error("Refusing to write: event is neither dated nor recurring:", JSON.stringify(ev).slice(0, 200));
    process.exit(1);
  }
  if (dated && !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) {
    console.error("Refusing to write: bad date format:", JSON.stringify(ev).slice(0, 200));
    process.exit(1);
  }
}

const newArray = JSON.stringify(events, null, 2);
html = html.slice(0, startBracket) + newArray + html.slice(endBracket + 1);
writeFileSync(FILE, html);
console.log(`index.html updated with ${events.length} events.`);
