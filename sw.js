// public/sw.js
//
// Handles incoming push messages and shows the actual OS notification -
// this is what lets an alert arrive even with the site closed. Runs in
// the background, separate from any open tab.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Goliath Alert', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Goliath Alert';
  const options = {
    body: data.body || 'Your alternate number is coming up - head back to the desk.',
    tag: data.tag || 'goliath-alt-alert',
    requireInteraction: true // stays on screen until dismissed, rather than auto-vanishing
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification brings them back to the hub rather than just
// dismissing it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});