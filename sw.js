// Q service worker — handles push notifications
// Registered by every page so Q can reach you wherever you are.
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { /* bad payload */ }

    const title = data.title || 'Q';
    const options = {
        body:    data.body  || '',
        icon:    data.icon  || '/favicon-192.png',
        badge:   '/favicon-192.png',
        vibrate: [200, 100, 200],
        data:    { url: data.url || '/' },
        // Show notification even when the page is open
        requireInteraction: false,
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if (client.url === url && 'focus' in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(url);
        })
    );
});
