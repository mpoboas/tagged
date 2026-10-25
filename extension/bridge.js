// Runs only on the tagged webapp (localhost). Relays messages between the page and the extension; nothing else.
(() => {
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
})();
