/* My Robot — Sistema de Eventos
   Service worker propositalmente simples e NETWORK-FIRST:
   sempre tenta a rede primeiro (então um deploy novo aparece na hora)
   e só cai no cache se o sinal falhar — útil no meio do shopping.
   Nada de /api/ é cacheado. */

const CACHE = 'myrobot-eventos-v1';
const PAGINAS = [
  '/evento-captacao.html',
  '/relatorio-evento.html',
  '/leads-evento.html',
  '/manifest.json',
  '/assets/icon-192.png',
  '/assets/icon-512.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(PAGINAS.map(function (u) {
        return c.add(u).catch(function () { /* ignora o que não existir */ });
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // CDN de fontes etc.
  if (url.pathname.indexOf('/api/') === 0) return;   // nunca cachear API

  e.respondWith(
    fetch(req).then(function (resp) {
      if (resp && resp.status === 200) {
        const copia = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copia); });
      }
      return resp;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('/evento-captacao.html');
      });
    })
  );
});
