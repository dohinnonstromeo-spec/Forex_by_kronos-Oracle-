// Service worker for browser push notifications: personal TP/SL trade outcomes, and
// (premium only) new high-confidence signal alerts. Registered from dashboard.html
// only -- this is not a full offline/PWA service worker, it only handles the "push"
// event.
self.addEventListener("push", (event) => {
  let data = { title: "Oracle Forex", body: "Une de tes analyses a évolué.", url: "/dashboard.html" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Non-JSON payload: keep the default text above rather than showing a blank notification.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/dashboard.html";
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((windowClients) => {
      // Exact pathname match, not a substring -- client.url.includes(url) would
      // also match "/dashboard.html" against a hypothetical "/old-dashboard.html"
      // or similar, focusing the wrong tab as the route set grows.
      for (const client of windowClients) {
        try {
          if (new URL(client.url).pathname === url && "focus" in client) return client.focus();
        } catch { /* malformed client.url -- fall through to opening a new tab */ }
      }
      if (clients.openWindow) return clients.openWindow(url);
    }),
  );
});

// The push spec allows the browser to silently rotate/invalidate a subscription at
// any time; without this handler, the dashboard's push toggle keeps showing
// "active" while notifications quietly stop arriving, with no code path to notice
// or recover. Re-subscribes with the same VAPID key and re-submits under the same
// topics the old subscription had (looked up by its old endpoint before it's gone).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const vapid = await fetch("/api/push/vapid-public-key").then((r) => r.json());
        if (!vapid?.configured) return;
        const oldEndpoint = event.oldSubscription?.endpoint;
        const topics = oldEndpoint
          ? await fetch(`/api/push/subscription-topics?endpoint=${encodeURIComponent(oldEndpoint)}`).then((r) => r.json()).then((d) => d?.topics || []).catch(() => [])
          : [];
        const subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
        });
        for (const topic of topics.length ? topics : ["tp_sl"]) {
          await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...subscription.toJSON(), topic }),
          });
        }
      } catch {
        // Best-effort: if this fails, the user's next dashboard visit still shows
        // the real (now inactive) state via initPush's own subscription check --
        // no permanent silent divergence, just a missed automatic recovery.
      }
    })(),
  );
});

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}
