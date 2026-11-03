/* NEOCURE Admin background push notifications - Firebase Web SDK 8.10.1 */
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js');

firebase.initializeApp({
  apiKey: "AIzaSyABFenv_KFSxvUvw7KpnW29QB34w4TTcl4",
  authDomain: "neocure-live-2026.firebaseapp.com",
  databaseURL: "https://neocure-live-2026-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "neocure-live-2026",
  storageBucket: "neocure-live-2026.firebasestorage.app",
  messagingSenderId: "651603399266",
  appId: "1:651603399266:web:6a5004ed3e95283f81773b"
});

const messaging = firebase.messaging();
messaging.setBackgroundMessageHandler(function(payload) {
  const notification = payload.notification || {};
  const title = notification.title || 'NEOCURE Notification';
  const options = {
    body: notification.body || 'NEOCURE App‌ನಲ್ಲಿ ಹೊಸ ಮಾಹಿತಿ ಬಂದಿದೆ.',
    data: payload.data || { url: '/' },
    icon: '/favicon.ico',
    tag: 'neocure-dealer-request'
  };
  return self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/admin/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
    for (const client of list) {
      if ('focus' in client) {
        if ('navigate' in client) client.navigate(target);
        return client.focus();
      }
    }
    return clients.openWindow(target);
  }));
});
