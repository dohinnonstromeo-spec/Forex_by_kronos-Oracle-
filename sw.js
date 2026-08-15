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
      for (const client of windowClients) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    }),
  );
});
