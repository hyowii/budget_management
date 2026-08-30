/* ============================================================
   Hy Language Station — Service Worker
   ------------------------------------------------------------
   Mục tiêu: cho phép mở lại app và xem/học dữ liệu đã tải kể cả
   khi KHÔNG có mạng, giống Quizlet.

   Chiến lược:
   1. SHELL_CACHE — cache "cứng" lúc cài đặt: index.html, manifest,
      các thư viện CDN (supabase-js, marked, dompurify), font.
      → Dùng cache-first, đảm bảo app luôn mở được dù offline.
   2. RUNTIME_CACHE — cache "mềm", tự lớn dần theo lúc dùng:
      stale-while-revalidate cho mọi request GET khác (kể cả file
      audio trong Supabase Storage) — trả cache ngay nếu có, đồng
      thời âm thầm tải bản mới nhất để lần sau dùng.
   3. KHÔNG can thiệp vào các request tới Supabase REST/Auth API
      (chỉ can thiệp Storage — nơi chứa audio/ảnh) để không phá vỡ
      logic online/offline và đồng bộ dữ liệu của app.
   ============================================================ */

const VERSION = 'v6';
const SHELL_CACHE = `hy-station-shell-${VERSION}`;
const RUNTIME_CACHE = `hy-station-runtime-${VERSION}`;

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js',
  'https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800&family=Noto+Sans+SC:wght@300;400;500;700&family=Noto+Sans:wght@400;500;700&display=swap',
  // Thư viện Furigana (kuroshiro + kuromoji) — chuyển hẳn sang tự lưu trữ (self-host)
  // trong ./vendor/ thay vì tải qua jsdelivr, vì CDN jsdelivr (đặc biệt đường dẫn /dict/
  // của kuromoji) không ổn định ở một số mạng VN, gây kẹt icon xoay vòng vô thời hạn trên
  // mobile. 2 file thư viện (nhỏ, vài chục KB) được precache sẵn ở đây. Riêng bộ TỪ ĐIỂN
  // (~13MB, nhiều file .dat.gz) KHÔNG ép precache cho mọi người — chỉ tự cache (qua
  // RUNTIME_CACHE bên dưới) ngay sau lần đầu ai đó bật Furigana thành công, để không bắt
  // người chưa dùng Furigana phải tải thêm ~13MB khi mở app. Nhưng giờ luôn tải same-origin
  // (cùng gốc Netlify) nên không còn phụ thuộc độ ổn định của CDN bên thứ 3 nữa.
  './vendor/kuroshiro.min.js',
  './vendor/kuroshiro-analyzer-kuromoji.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // Tải từng file riêng lẻ, lỗi 1 file (vd CDN chặn CORS) không làm hỏng cả cache
      await Promise.all(
        SHELL_URLS.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => cache.put(url, res))
            .catch((err) => console.warn('[SW] Không cache được', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isSupabaseApiCall(url) {
  // Chặn KHÔNG cache các endpoint API/Auth/Realtime — cần luôn đi thẳng
  // ra mạng để app phát hiện đúng trạng thái online/offline và đồng bộ
  // dữ liệu chính xác. Storage (audio, ảnh) thì VẪN cho cache.
  return url.hostname.endsWith('supabase.co') &&
    (url.pathname.includes('/rest/v1/') ||
     url.pathname.includes('/auth/v1/') ||
     url.pathname.includes('/realtime/'));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // Không đụng vào POST/PATCH/DELETE (Supabase ghi dữ liệu)

  const url = new URL(req.url);
  if (isSupabaseApiCall(url)) return; // để trình duyệt xử lý bình thường

  // index.html / trang gốc: network-first để luôn có bản mới nhất khi online,
  // rơi về cache khi offline (đảm bảo mở được app).
  const isNavigation = req.mode === 'navigate' || url.pathname.endsWith('index.html') || url.pathname === '/' || url.pathname.endsWith('/');
  if (isNavigation) {
    event.respondWith(
      // cache:'no-store' — KHÔNG chỉ tránh cache của Service Worker, mà còn ép
      // bỏ qua luôn cache HTTP mặc định của trình duyệt (disk cache/Cache-Control
      // từ server). Nếu không có dòng này, `fetch()` vẫn có thể âm thầm trả về
      // 1 bản index.html cũ đã lưu ở tầng HTTP dù logic ở đây đã "network-first".
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          const resClone = res.clone(); // clone NGAY, trước khi res được trả về/đọc ở nơi khác
          caches.open(SHELL_CACHE)
            .then((cache) => cache.put(req, resClone))
            .catch((err) => console.warn('[SW] Không cache được (navigation)', req.url, err));
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // Mọi request GET khác (CDN, font, audio, ảnh...): stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const resClone = res.clone(); // clone NGAY, trước khi res được trả về/đọc ở nơi khác
            caches.open(RUNTIME_CACHE)
              .then((cache) => cache.put(req, resClone))
              .catch((err) => console.warn('[SW] Không cache được (runtime)', req.url, err));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
// ── PUSH NOTIFICATIONS — nhắc lịch học đúng giờ dù đã tắt tab/trình duyệt ──
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: '📅 Hy Study Space', body: event.data ? event.data.text() : '' }; }
 
  const title = data.title || '📅 Nhắc lịch học';
  const options = {
    body: data.body || '',
    icon: './assets/logo/logo-icon.png',
    badge: './assets/logo/logo-icon.png',
    tag: data.tag || 'study-reminder',
    renotify: true,
    vibrate: [100, 50, 100],
    data: { url: data.url || './' },
  };
 
  event.waitUntil(self.registration.showNotification(title, options));
});
 
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
 
// Nếu trình duyệt tự huỷ subscription cũ (hết hạn) và cấp cái mới, đăng ký
// lại vào Supabase ngay khi app còn mở — tránh mất nhắc lịch âm thầm.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((c) => c.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' }));
    })
  );
});