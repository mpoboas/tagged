// Routes between the webapp tab (port "web") and the Facebook tab (content script), and fetches image bytes
// (host_permissions let the service worker read fbcdn without page CORS).
let web = null, webTab = null;
const toWeb = (m) => { try { web && web.postMessage(m); } catch (_) {} };
const FB = /^https:\/\/(www|web)\.facebook\.com\//;
// Test (0.7.1): collect with the Facebook tab left in the background. If albums come back incomplete, set this back
// to true: Chrome may not load thumbnails in a hidden tab, and then the album has to be brought to the front.
const FOCUS_ON_COLLECT = false;

function b64(buf) {
  const a = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}

async function fbTab() {
  const tabs = await chrome.tabs.query({ url: ["https://www.facebook.com/*", "https://web.facebook.com/*"] });
  const album = (t) => /\/(media\/set|photos|albums|photo)\b/.test(t.url) ? 1 : 0;   // prefer an album/photo tab over e.g. the feed
  tabs.sort((a, b) => album(b) - album(a) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0] || null;
}

async function focus(tab) {
  try { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
}

// After the extension is (re)loaded, Facebook tabs that were already open have no live content script.
// Try the message; if nobody answers, inject the script ourselves and try once more.
async function deliver(tabId, msg) {
  try { await chrome.tabs.sendMessage(tabId, msg); return true; } catch (_) { /* no receiver */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await new Promise((r) => setTimeout(r, 300));
    await chrome.tabs.sendMessage(tabId, msg);
    return true;
  } catch (e) { return false; }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "web") return;
  web = port;
  webTab = port.sender && port.sender.tab || null;
  port.onDisconnect.addListener(() => { if (web === port) web = null; });
  port.onMessage.addListener(async (msg) => {
    const tab = await fbTab();
    if (msg.t === "hello") return toWeb({ t: "ready", fb: !!tab, fbUrl: tab ? tab.url : null, v: chrome.runtime.getManifest().version });
    if (msg.t === "open") {   // open the session's album (only ever a facebook.com address)
      if (!FB.test(msg.url || "")) return;
      if (tab) { await chrome.tabs.update(tab.id, { url: msg.url }); await focus(tab); } else await chrome.tabs.create({ url: msg.url });
      return;
    }
    if (!tab) return toWeb({ t: "error", text: "Não encontrei nenhum separador do Facebook aberto. Abre o álbum e tenta de novo." });
    // Facebook only loads thumbnails in a visible tab, so the album is brought to the front while it is scrolled.
    if (msg.t === "collect" && FOCUS_ON_COLLECT) await focus(tab);
    if (!(await deliver(tab.id, msg)))
      toWeb({ t: "error", text: "Não consegui falar com o separador do Facebook (" + (tab.title || tab.url).slice(0, 40) + "). Recarrega-o (F5) e tenta de novo." });
  });
});

// Thumbnails: at most 4 fetches at a time (most come from the HTTP cache, but a long album must not open hundreds at once).
const thumbs = [];
let busy = 0, drained = [];
function pumpThumbs() {
  while (busy < 4 && thumbs.length) {
    const m = thumbs.shift();
    busy++;
    (async () => {
      try {
        const r = await fetch(m.url);
        // Facebook's CDN stamps each image with its upload time (Last-Modified): the date the photo reached Facebook.
        const lm = Date.parse(r.headers.get("last-modified") || "");
        if (r.ok) toWeb({ t: "thumb", key: m.key, b64: b64(await r.arrayBuffer()), lm: isNaN(lm) ? null : new Date(lm).toISOString() });
      } catch (_) { /* skipped; the webapp reports fewer photos than the album has */ }
      busy--;
      pumpThumbs();
    })();
  }
  if (!busy && !thumbs.length) { drained.forEach((f) => f()); drained = []; }
}
const thumbsDone = () => new Promise((r) => { if (!busy && !thumbs.length) r(); else drained.push(r); });

// events coming from the Facebook content script
chrome.runtime.onMessage.addListener((m) => {
  (async () => {
    try {
      if (m.t === "thumb") {
        thumbs.push(m);
        pumpThumbs();
      } else if (m.t === "collect-done") {
        await thumbsDone();   // so the webapp has every photo when it hears the collection ended
        toWeb(m);
        if (webTab && FOCUS_ON_COLLECT) focus(webTab);
      } else if (m.t === "full-url") {
        const t0 = performance.now();
        const r = await fetch(m.url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const buf = await r.arrayBuffer();
        const t1 = performance.now();
        const enc = b64(buf);
        const ms = { ...m.ms, download: Math.round(t1 - t0), encode: Math.round(performance.now() - t1), kb: Math.round(buf.byteLength / 1024) };
        toWeb({ t: "full-item", key: m.key, w: m.w, h: m.h, b64: enc, ms });
      } else {
        toWeb(m);   // meta, collect-progress, status, full-done, error, full-item (failures)
      }
    } catch (e) {
      if (m.t === "full-url") toWeb({ t: "full-item", key: m.key, error: String(e.message || e) });
    }
  })();
});
