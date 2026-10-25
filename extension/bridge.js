// Runs on the tagged webapp's address. Relays messages between the page and the extension; nothing else.
// The match patterns cannot name a port, so it only wakes up on a page that carries <meta name="tagged-app">:
// other local apps on 127.0.0.1/localhost never get to drive the Facebook tab.
(() => {
  const start = () => {
    if (!document.querySelector('meta[name="tagged-app"]')) return;
    let port;
    const connect = () => {
      port = chrome.runtime.connect({ name: "web" });
      port.onMessage.addListener((m) => window.postMessage({ src: "tagged-ext", ...m }, location.origin));
      port.onDisconnect.addListener(() => setTimeout(connect, 500));  // the service worker may have been restarted
    };
    connect();
    window.addEventListener("message", (e) => {
      if (e.source !== window || !e.data || e.data.src !== "tagged-web") return;
      try { port.postMessage(e.data); } catch (_) { /* reconnecting */ }
    });
    window.postMessage({ src: "tagged-ext", t: "bridge" }, location.origin);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
