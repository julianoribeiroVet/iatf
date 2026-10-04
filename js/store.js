/* ============================================================================
   IatfStore — camada de dados do Calendário IATF
   ----------------------------------------------------------------------------
   • Offline-first: todo dado vive primeiro no aparelho (localStorage). A tela
     nunca espera a rede para mostrar ou salvar algo.
   • Fila de pendências (outbox): cada alteração entra numa fila persistente e é
     enviada ao Supabase assim que houver internet e login. Várias edições do
     mesmo registro são coalescidas (vale a última).
   • Tempo real: alterações feitas em outro aparelho chegam via Supabase Realtime.
     Enquanto houver pendência local para um registro, a versão local prevalece
     até ser enviada (last-writer-wins por registro).
   • Sem Supabase configurado (js/config.js vazio) o app funciona 100% local.

   Modelo remoto: uma única tabela genérica `registros(colecao, id, dados jsonb)`
   — coleções: lotes | overrides | config | autorizacoes. Ver supabase/schema.sql.
   ============================================================================ */
(function(){
  'use strict';

  var CACHE_KEY  = 'iatf-jsrural-dados-v1';      /* mesmo formato do modo local antigo */
  var OUTBOX_KEY = 'iatf-jsrural-pendentes-v1';
  var AUTH_KEY   = 'iatf-jsrural-auth';
  var TABLE      = 'registros';
  var COLECOES   = ['lotes','overrides','config','autorizacoes'];
  var RETRY_MS   = 30000;

  function readJSON(k){ try{ var r = localStorage.getItem(k); return r ? JSON.parse(r) : null; }catch(e){ return null; } }
  function writeJSON(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } }
  function clone(o){ return o==null ? o : JSON.parse(JSON.stringify(o)); }
  function emptyRecs(){ return {lotes:{}, overrides:{}, config:{}, autorizacoes:{}}; }

  /* Formato do app  <->  registros por coleção */
  function recsFromAppState(s){
    var r = emptyRecs();
    if(!s) return r;
    (Array.isArray(s.lotes) ? s.lotes : []).forEach(function(l){
      if(!l || !l.id) return;
      var d = clone(l); delete d.id; r.lotes[l.id] = d;
    });
    Object.keys(s.overrides||{}).forEach(function(k){ r.overrides[k] = clone(s.overrides[k]); });
    Object.keys(s.autorizacoes||{}).forEach(function(k){ r.autorizacoes[k] = clone(s.autorizacoes[k]); });
    if(s.params) r.config.parametros = clone(s.params);
    return r;
  }
  function appStateFromRecs(r){
    return {
      lotes: Object.keys(r.lotes).map(function(id){ return Object.assign({id:id}, clone(r.lotes[id])); }),
      overrides: clone(r.overrides),
      autorizacoes: clone(r.autorizacoes),
      params: r.config.parametros ? clone(r.config.parametros) : null
    };
  }

  function create(opts){
    opts = opts || {};
    var cfg = opts.config || {};
    var remote = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
    var client = null;
    if(remote){
      if(window.supabase && typeof window.supabase.createClient === 'function'){
        client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: {persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, storageKey:AUTH_KEY}
        });
      } else {
        remote = false; /* biblioteca não carregou — segue local, sem perder dados */
      }
    }

    var recs = recsFromAppState(readJSON(CACHE_KEY));
    var outbox = readJSON(OUTBOX_KEY) || [];
    var seq = outbox.reduce(function(m,e){ return Math.max(m, e.seq||0); }, 0);
    var user = null, channel = null, flushing = null, retryTimer = null;
    var status = {
      mode: remote ? 'conectando' : 'local',
      online: navigator.onLine !== false,
      pendentes: outbox.length,
      email: null,
      erro: null,
      ultimaSync: null
    };

    function persist(){
      var s = appStateFromRecs(recs);
      s.salvoEm = new Date().toISOString();
      writeJSON(CACHE_KEY, s);
      writeJSON(OUTBOX_KEY, outbox);
      status.pendentes = outbox.length;
    }
    function emitState(){ if(opts.onState) opts.onState(appStateFromRecs(recs)); }
    function emitStatus(){ if(opts.onStatus) opts.onStatus(Object.assign({}, status)); }
    function setStatus(patch){ Object.assign(status, patch); emitStatus(); }

    function hasPending(col, id){
      for(var i=0;i<outbox.length;i++){ if(outbox[i].col===col && outbox[i].id===id) return true; }
      return false;
    }
    function enqueue(op, col, id, data){
      outbox = outbox.filter(function(e){ return !(e.col===col && e.id===id); });
      outbox.push({seq: ++seq, op: op, col: col, id: id, data: op==='put' ? clone(data) : null, ts: Date.now()});
    }
    function applyOutboxOver(r){
      outbox.forEach(function(e){
        if(!r[e.col]) return;
        if(e.op==='put') r[e.col][e.id] = clone(e.data);
        else delete r[e.col][e.id];
      });
    }

    /* ---------------- escrita local (sempre imediata) ---------------- */
    function put(col, id, data){
      if(COLECOES.indexOf(col)===-1 || !id) return;
      recs[col][id] = clone(data);
      enqueue('put', col, id, data);
      persist(); emitStatus(); scheduleFlush();
    }
    function del(col, id){
      if(COLECOES.indexOf(col)===-1 || !id) return;
      delete recs[col][id];
      enqueue('del', col, id, null);
      persist(); emitStatus(); scheduleFlush();
    }
    /* Substitui todo o conteúdo (importação de backup): gera as operações de diferença. */
    function replaceAll(appState){
      var next = recsFromAppState(appState);
      COLECOES.forEach(function(col){
        Object.keys(recs[col]).forEach(function(id){ if(!(id in next[col])) enqueue('del', col, id, null); });
        Object.keys(next[col]).forEach(function(id){ enqueue('put', col, id, next[col][id]); });
      });
      recs = next;
      persist(); emitState(); emitStatus(); scheduleFlush();
    }

    /* ---------------- envio ao Supabase ---------------- */
    function canSync(){ return remote && user && status.online && status.mode!=='sem-acesso'; }
    function scheduleFlush(){ if(canSync()) setTimeout(function(){ flush(); }, 250); }

    function flush(){
      if(!remote) return Promise.resolve({ok:true, msg:'Alterações salvas neste aparelho.'});
      if(!user) return Promise.resolve({ok:false, msg:'Salvo no aparelho. Entre na sua conta para sincronizar.'});
      if(!status.online) return Promise.resolve({ok:true, msg:'Sem internet — salvo no aparelho; envia sozinho quando a conexão voltar.'});
      if(flushing) return flushing;
      var lote = outbox.slice();
      if(!lote.length){ return Promise.resolve({ok:true, msg:'Tudo sincronizado.'}); }

      var puts = lote.filter(function(e){ return e.op==='put'; });
      var dels = lote.filter(function(e){ return e.op==='del'; });
      var tasks = [];
      if(puts.length){
        tasks.push(function(){
          return client.from(TABLE).upsert(puts.map(function(e){
            return {colecao:e.col, id:e.id, dados:e.data, atualizado_por:user.id};
          }), {onConflict:'colecao,id'});
        });
      }
      COLECOES.forEach(function(col){
        var ids = dels.filter(function(e){ return e.col===col; }).map(function(e){ return e.id; });
        if(ids.length){ tasks.push(function(){ return client.from(TABLE).delete().eq('colecao', col).in('id', ids); }); }
      });

      setStatus({mode:'sincronizando'});
      flushing = tasks.reduce(function(p, t){
        return p.then(function(){ return t().then(function(res){ if(res && res.error) throw res.error; }); });
      }, Promise.resolve()).then(function(){
        var enviados = {};
        lote.forEach(function(e){ enviados[e.seq] = true; });
        outbox = outbox.filter(function(e){ return !enviados[e.seq]; });
        persist();
        setStatus({mode:'online', erro:null, ultimaSync:new Date().toISOString()});
        flushing = null;
        if(outbox.length) scheduleFlush();
        return {ok:true, msg:'Alterações sincronizadas com a nuvem.'};
      }).catch(function(err){
        flushing = null;
        var negado = err && (err.code==='42501' || /row-level security|permission/i.test(err.message||''));
        if(negado){
          setStatus({mode:'sem-acesso', erro:'Seu usuário não tem permissão de gravação. Peça ao administrador para incluir seu e-mail.'});
          return {ok:false, msg:'Sem permissão para gravar na nuvem (dados mantidos no aparelho).'};
        }
        setStatus({mode: status.online ? 'erro' : 'offline', erro: (err && err.message) || 'Falha de conexão'});
        armRetry();
        return {ok:false, msg:'Não foi possível enviar agora — salvo no aparelho, nova tentativa automática.'};
      });
      return flushing;
    }
    function armRetry(){
      if(retryTimer) return;
      retryTimer = setTimeout(function(){ retryTimer = null; if(canSync()) { pull().then(flush); } }, RETRY_MS);
    }

    /* ---------------- leitura completa + tempo real ---------------- */
    function pull(){
      if(!remote || !user) return Promise.resolve();
      return client.from(TABLE).select('colecao,id,dados').then(function(res){
        if(res.error) throw res.error;
        var r = emptyRecs();
        (res.data||[]).forEach(function(row){ if(r[row.colecao]) r[row.colecao][row.id] = row.dados; });
        applyOutboxOver(r);   /* pendências locais ainda não enviadas prevalecem */
        recs = r;
        persist(); emitState();
        setStatus({mode: outbox.length ? 'sincronizando' : 'online', erro:null, ultimaSync:new Date().toISOString()});
      }).catch(function(err){
        setStatus({mode: status.online ? 'erro' : 'offline', erro:(err && err.message) || 'Falha ao baixar dados'});
        armRetry();
      });
    }
    function onRemoteChange(payload){
      var row = payload.eventType==='DELETE' ? payload.old : payload.new;
      if(!row || !recs[row.colecao] || !row.id) return;
      if(hasPending(row.colecao, row.id)) return;
      if(payload.eventType==='DELETE') delete recs[row.colecao][row.id];
      else recs[row.colecao][row.id] = row.dados;
      persist(); emitState();
    }
    function subscribe(){
      if(channel || !client) return;
      channel = client.channel('iatf-registros')
        .on('postgres_changes', {event:'*', schema:'public', table:TABLE}, onRemoteChange)
        .subscribe(function(st){
          if(st==='CHANNEL_ERROR' || st==='TIMED_OUT'){ armRetry(); }
        });
    }
    function unsubscribe(){
      if(channel && client){ client.removeChannel(channel); }
      channel = null;
    }

    function onSignedIn(session){
      user = session.user;
      setStatus({mode:'conectando', email:user.email, erro:null});
      return client.rpc('sou_membro').then(function(res){
        if(!res.error && res.data===false){
          setStatus({mode:'sem-acesso', erro:'Este e-mail ainda não foi liberado. Peça ao administrador para incluí-lo na lista de membros.'});
          return;
        }
        subscribe();
        return pull().then(flush);
      }).catch(function(){
        /* sem rede no momento: mantém o cache e tenta de novo depois */
        setStatus({mode: status.online ? 'erro' : 'offline'});
        armRetry();
      });
    }

    /* ---------------- autenticação ---------------- */
    function signIn(email, password){
      if(!client) return Promise.reject(new Error('Nuvem não configurada.'));
      return client.auth.signInWithPassword({email:email, password:password}).then(function(res){
        if(res.error) throw res.error;
        return onSignedIn(res.data.session);
      });
    }
    function resetPassword(email){
      if(!client) return Promise.reject(new Error('Nuvem não configurada.'));
      var back = location.origin + location.pathname;
      return client.auth.resetPasswordForEmail(email, {redirectTo: back}).then(function(res){ if(res.error) throw res.error; });
    }
    function updatePassword(pw){
      return client.auth.updateUser({password:pw}).then(function(res){ if(res.error) throw res.error; });
    }
    /* Sair: só apaga os dados do aparelho se não houver nada pendente de envio. */
    function signOut(){
      var pend = outbox.length;
      unsubscribe();
      user = null;
      var p = client ? client.auth.signOut() : Promise.resolve();
      return p.then(function(){
        if(!pend){ recs = emptyRecs(); persist(); emitState(); }
        setStatus({mode:'login', email:null});
        return pend;
      });
    }

    /* ---------------- início ---------------- */
    function start(){
      emitState(); emitStatus();
      window.addEventListener('online', function(){ setStatus({online:true}); if(user){ subscribe(); pull().then(flush); } });
      window.addEventListener('offline', function(){ setStatus({online:false, mode: remote && user ? 'offline' : status.mode}); });
      document.addEventListener('visibilitychange', function(){
        if(document.visibilityState==='visible' && canSync()){ pull().then(flush); }
      });
      if(!remote) return;
      client.auth.onAuthStateChange(function(event, session){
        if(event==='PASSWORD_RECOVERY' && opts.onPasswordRecovery){ opts.onPasswordRecovery(); }
        if(event==='TOKEN_REFRESHED' && session){ user = session.user; }
      });
      client.auth.getSession().then(function(res){
        var session = res && res.data && res.data.session;
        if(session) return onSignedIn(session);
        setStatus({mode:'login'});
      }).catch(function(){
        setStatus({mode: status.online ? 'login' : 'offline'});
      });
    }

    function newId(prefix){
      var r = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g,'').slice(0,20)
            : Date.now().toString(36)+Math.random().toString(36).slice(2,10);
      return (prefix||'id')+'-'+r;
    }

    return {
      start:start, put:put, del:del, replaceAll:replaceAll, flush:flush,
      signIn:signIn, signOut:signOut, resetPassword:resetPassword, updatePassword:updatePassword,
      newId:newId, isRemote:function(){ return remote; }, getStatus:function(){ return Object.assign({}, status); }
    };
  }

  window.IatfStore = {create:create};
})();
