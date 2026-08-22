/* Service Worker cho Hy Owii — nhận Push Notification kể cả khi trình duyệt đã đóng
   (trên Android/desktop trình duyệt tự "đánh thức" service worker để chạy đoạn này;
   trên iOS cần cài app ra màn hình chính qua "Thêm vào MH chính" mới nhận được Push). */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Hy Owii', body: event.data ? event.data.text() : 'Bạn có nhắc nhở mới' };
  }
  const title = data.title || '🔔 Hy Owii';
  const options = {
    body: data.body || '',
    icon: data.icon || 'icon-192.png',
    badge: data.badge || 'icon-192.png',
    tag: data.taskId ? 'task-' + data.taskId : undefined,
    data: { taskId: data.taskId || null, url: self.registration.scope },
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
