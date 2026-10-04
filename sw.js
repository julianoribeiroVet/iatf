/* Service worker — Calendário IATF
   • App shell em cache (abre e funciona sem internet).
   • Fontes do Google em cache conforme usadas.
   • Chamadas ao Supabase NUNCA passam pelo cache (dados sempre ao vivo;
     o modo offline dos dados é tratado pelo js/store.js).
   Ao publicar uma nova versão, aumente CACHE_VERSION. */
var CACHE_VERSION = 'iatf-v2.0.1';
var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/config.js',
  './js/logo.js',
  './js/store.js',
  './js/app.js',
  './js/pwa.js',
  './vendor/supabase.js',
  './vendor/jspdf.umd.min.js',
  './icons/logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png'
];
var FONT_CACHE = 'iatf-fonts';

self.addEventListener('install', function(event){
  event.waitUntil(caches.open(CACHE_VERSION).then(function(c){ return c.addAll(SHELL); }));
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_VERSION && k !== FONT_CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('message', function(event){
  if(event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);

  /* Fontes: cache primeiro, atualiza em segundo plano */
  if(url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'){
    event.respondWith(caches.open(FONT_CACHE).then(function(cache){
      return cache.match(req).then(function(hit){
        var net = fetch(req).then(function(res){ if(res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(function(){ return hit; });
        return hit || net;
      });
    }));
    return;
  }

  if(url.origin !== self.location.origin) return; /* Supabase e demais: direto na rede */

  /* Navegação: rede primeiro (pega versão nova), cai para o cache offline */
  if(req.mode === 'navigate'){
    event.respondWith(fetch(req).catch(function(){ return caches.match('./index.html'); }));
    return;
  }

  /* Arquivos do app: cache primeiro */
  event.respondWith(caches.match(req).then(function(hit){
    return hit || fetch(req).then(function(res){
      if(res && res.ok){ var copy = res.clone(); caches.open(CACHE_VERSION).then(function(c){ c.put(req, copy); }); }
      return res;
    });
  }));
});
