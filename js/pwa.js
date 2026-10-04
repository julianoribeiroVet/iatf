/* Registro do service worker (app instalável + funcionamento offline) e aviso de nova versão. */
(function(){
  'use strict';
  var APP_VERSION = '2.0.1';
  var v = document.getElementById('appVersion');
  if(v) v.textContent = 'v' + APP_VERSION;
  if(!('serviceWorker' in navigator) || location.protocol === 'file:') return;

  var refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', function(){
    if(refreshing) return;
    refreshing = true;
    location.reload();
  });

  function offerUpdate(worker){
    var toast = document.getElementById('updateToast');
    var btn = document.getElementById('btnUpdate');
    if(!toast || !btn) return;
    toast.hidden = false;
    btn.onclick = function(){ btn.disabled = true; worker.postMessage({type:'SKIP_WAITING'}); };
  }

  window.addEventListener('load', function(){
    navigator.serviceWorker.register('sw.js').then(function(reg){
      if(reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', function(){
        var w = reg.installing;
        if(!w) return;
        w.addEventListener('statechange', function(){
          if(w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
        });
      });
      /* procura atualização ao voltar para o app e a cada hora */
      document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible') reg.update().catch(function(){}); });
      setInterval(function(){ reg.update().catch(function(){}); }, 3600000);
    }).catch(function(){});
  });
})();
