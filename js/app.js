(function(){
  "use strict";

  /* ============================== constants ============================== */
  var CATEGORIAS = ['Multípara','Primípara','Novilha','Solteiras'];
  var PERIODOS = ['Manhã','Tarde'];
  var SITUACOES = ['Planejado','Em andamento','Concluído','Cancelado'];
  var STATUS_EVENTO = ['Planejado','Em andamento','Concluído','Cancelado'];
  var RETIROS = ['Água Funda','Pontal','Placa','Seringa'];
  var RETIRO_KEY = {'Água Funda':'agua-funda','Pontal':'pontal','Placa':'placa','Seringa':'seringa'};
  var LOGO_DATA_URI = window.IATF_LOGO || '';
  var ACAO_ORDER = {'D0':0,'D7':1,'D8':1,'IATF':2,'DG':3};
  var WEEKDAY_LONG = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
  var WEEKDAY_SHORT = ['DOM','SEG','TER','QUA','QUI','SEX','SÁB'];

  /* gestacao=291: média usual de gestação em zebuínos (Nelore e cruzamentos), predominantes
     na pecuária de corte brasileira — mais longa que a média de Bos taurus (~283 dias usada
     em protocolos europeus/americanos). Ajuste em Parâmetros conforme a genética do rebanho
     e a orientação do médico-veterinário responsável; o valor aqui só define o padrão inicial. */
  var DEFAULT_PARAMS = {
    d0d8: 8, d8iatf: 2, iatfdg: 32, dgd0: 0,
    maxIatfNormal: 2, maxIatfNovilha: 3,
    gestacao: 291, d0d7Novilha: 7, d7iatfNovilha: 2
  };

  /* ============================== state ============================== */
  var state = {
    activeTab: 'calendario',
    params: Object.assign({}, DEFAULT_PARAMS),
    lotes: [],
    overrides: {},
    autorizacoes: {},
    refDate: null,
    agendaFilters: {retiro:'', acao:'', status:'', busca:''},
    calendarioFiltroRetiro: '',
    lotesFiltroRetiro: ''
  };

  /* ============================== utils ============================== */
  function uid(prefix){
    return (prefix||'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
  }
  function parseISO(s){
    if(!s) return null;
    var p = String(s).split('-');
    if(p.length!==3) return null;
    var d = new Date(Number(p[0]), Number(p[1])-1, Number(p[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  function toISO(d){
    var y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
    return y+'-'+m+'-'+dd;
  }
  function addDays(d,n){ var r=new Date(d.getTime()); r.setDate(r.getDate()+Number(n||0)); return r; }
  function sameDate(a,b){ return a && b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
  function mondayOf(d){ var day=d.getDay(); var diff=(day===0?-6:1-day); return addDays(d,diff); }
  function fmtDateShort(d){ return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0'); }
  function fmtDateFull(d){ return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear(); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function retiroVars(retiro){
    var key = RETIRO_KEY[retiro] || 'outro';
    return {rc:'var(--'+key+')', rbg:'var(--'+key+'-bg)', rink:'var(--'+key+'-ink)', key:key};
  }
  function statusClass(status){
    switch(status){
      case 'Em andamento': return 'status-andamento';
      case 'Concluído': return 'status-concluido';
      case 'Cancelado': return 'status-cancelado';
      default: return 'status-planejado';
    }
  }
  function debounce(fn, ms){
    var t=null;
    return function(){ var args=arguments, ctx=this; clearTimeout(t); t=setTimeout(function(){ fn.apply(ctx,args); }, ms); };
  }

  /* ============================== schedule engine ============================== */
  function maxIatfFor(categoria, params){
    return categoria==='Novilha' ? params.maxIatfNovilha : params.maxIatfNormal;
  }
  function orientacaoFor(cycle){
    if(cycle===1) return 'Primeira IATF';
    if(cycle===2) return '1ª ressincronização — somente fêmeas vazias';
    return (cycle-1)+'ª ressincronização — somente fêmeas vazias';
  }
  function ovDate(key){
    var ov = state.overrides[key];
    return ov && ov.dataAjustada ? parseISO(ov.dataAjustada) : null;
  }
  function computeSchedule(lotes, params){
    var events = [];
    /* Fêmeas que chegam ao fim do número máximo de IATFs programado (1ª IATF +
       ressincronizações) e seguem vazias precisam de uma decisão explícita do
       responsável (repasse com touro, exame andrológico/ginecológico ou descarte) —
       não devem simplesmente desaparecer do cronograma. Essa lista alimenta o
       card "Falha reprodutiva — decisão pendente" na aba Indicadores. */
    var falhas = [];
    lotes.forEach(function(lote){
      if(!lote.ativo) return;
      var d0Inicial = parseISO(lote.dataD0);
      if(!d0Inicial) return;
      var isNovilha = lote.categoria==='Novilha';
      var maxIatf = maxIatfFor(lote.categoria, params);
      var acaoIntermed = isNovilha ? 'D7' : 'D8';
      var offIntermed = isNovilha ? params.d0d7Novilha : params.d0d8;
      var offIatf = isNovilha ? params.d7iatfNovilha : params.d8iatf;
      var d0 = d0Inicial, prevDG = null;
      /* Só as fêmeas diagnosticadas vazias seguem para a próxima IATF — as prenhes
         saem do cronograma. qtdCiclo carrega esse total adiante a cada ciclo, reduzido
         pelo nº de prenhas lançado no DG anterior (campo editável na Agenda). */
      var qtdCiclo = Number(lote.qtd)||0;
      var ultimoDGLancado = null;
      for(var cycle=1; cycle<=maxIatf; cycle++){
        if(qtdCiclo<=0) break;
        if(cycle>1){ d0 = addDays(prevDG, params.dgd0); }
        /* Datas ajustadas manualmente (para desfazer um conflito de manejos no retiro):
           a ação movida assume a nova data e as ações seguintes do lote acompanham em
           cascata, mantendo os intervalos do protocolo (D0→D8/D7→IATF→DG→novo D0). */
        var kD0 = lote.id+'-c'+cycle+'-D0', kInter = lote.id+'-c'+cycle+'-'+acaoIntermed, kIatf = lote.id+'-c'+cycle+'-IATF';
        var dgKey = lote.id+'-c'+cycle+'-DG';
        var adjD0 = cycle>1 ? ovDate(kD0) : null, adjInter = ovDate(kInter), adjIatf = ovDate(kIatf), adjDG = ovDate(dgKey);
        if(adjD0) d0 = adjD0;
        var dInter = adjInter || addDays(d0, offIntermed);
        var dIatf = adjIatf || addDays(dInter, offIatf);
        var dDG = adjDG || addDays(dIatf, params.iatfdg);
        var parto = addDays(dIatf, params.gestacao);
        var base = {
          loteId: lote.id, lote: lote.nome, categoria: lote.categoria, retiro: lote.retiro,
          periodo: lote.periodo, qtd: qtdCiclo, responsavel: lote.responsavel||'',
          cycle: cycle, orientacao: orientacaoFor(cycle), parto: parto
        };
        events.push(Object.assign({}, base, {acao:'D0', date:d0, key: kD0, ajustada: !!adjD0}));
        events.push(Object.assign({}, base, {acao:acaoIntermed, date:dInter, key: kInter, ajustada: !!adjInter}));
        events.push(Object.assign({}, base, {acao:'IATF', date:dIatf, key: kIatf, ajustada: !!adjIatf}));
        events.push(Object.assign({}, base, {acao:'DG', date:dDG, key: dgKey, ajustada: !!adjDG}));
        prevDG = dDG;

        var ovDG = state.overrides[dgKey] || {};
        if(ovDG.qtdPrenhe!=null && ovDG.qtdPrenhe!==''){
          var qp = Math.max(0, Math.min(qtdCiclo, Number(ovDG.qtdPrenhe)||0));
          qtdCiclo = qtdCiclo - qp;
          ultimoDGLancado = {cycle:cycle, qtdRestante:qtdCiclo, dataDG:dDG};
        }
      }
      if(ultimoDGLancado && ultimoDGLancado.cycle===maxIatf && ultimoDGLancado.qtdRestante>0){
        falhas.push({
          loteId: lote.id, lote: lote.nome, categoria: lote.categoria, retiro: lote.retiro,
          qtd: ultimoDGLancado.qtdRestante, dataUltimoDG: ultimoDGLancado.dataDG
        });
      }
    });
    events.falhas = falhas;
    events.sort(function(a,b){
      if(a.date - b.date !== 0) return a.date - b.date;
      if(a.periodo !== b.periodo) return a.periodo==='Manhã' ? -1 : 1;
      var oa = ACAO_ORDER[a.acao], ob = ACAO_ORDER[b.acao];
      if(oa!==ob) return oa-ob;
      return (a.lote||'').localeCompare(b.lote||'');
    });
    events.forEach(function(e){
      var ov = state.overrides[e.key] || {};
      e.status = ov.status || 'Planejado';
      e.obs = ov.obs || '';
      if(e.acao==='DG'){
        if(ov.qtdPrenhe!=null && ov.qtdPrenhe!==''){
          var qtdPrenhe = Math.max(0, Math.min(e.qtd, Number(ov.qtdPrenhe)||0));
          var qtdVazia = e.qtd - qtdPrenhe;
          e.qtdPrenhe = qtdPrenhe; e.qtdVazia = qtdVazia;
          e.resultadoDG = qtdVazia===0 ? 'Prenhe' : (qtdPrenhe===0 ? 'Vazia' : 'Parcial');
        } else {
          e.qtdPrenhe = null; e.qtdVazia = null; e.resultadoDG = 'Pendente';
        }
      } else {
        e.qtdPrenhe = null; e.qtdVazia = null; e.resultadoDG = null;
      }
    });
    return events;
  }
  /* Quando o DG de um ciclo (ex.: IATF 1) cai no mesmo dia do D0 do ciclo seguinte
     (ex.: IATF 2) — o caso normal quando "Intervalo DG → novo D0" = 0 — as duas
     ações do mesmo lote, no mesmo dia e período, são um único manejo na prática
     (o vazio já sai do DG direto para o novo protocolo). Mescla essas duas linhas
     num único cartão com a sigla combinada "DG-D0" para a visão do calendário/PDF. */
  function mergeDayEvents(dayEvents){
    var byLoteCycleAcao = {};
    dayEvents.forEach(function(e){ byLoteCycleAcao[e.loteId+'|'+e.cycle+'|'+e.acao] = e; });
    var used = {};
    var out = [];
    dayEvents.forEach(function(e){
      if(used[e.key]) return;
      var partner = null;
      if(e.acao==='D0'){ partner = byLoteCycleAcao[e.loteId+'|'+(e.cycle-1)+'|DG']; }
      else if(e.acao==='DG'){ partner = byLoteCycleAcao[e.loteId+'|'+(e.cycle+1)+'|D0']; }
      if(partner && !used[partner.key]){
        var dgEvt = e.acao==='DG' ? e : partner;
        var d0Evt = e.acao==='D0' ? e : partner;
        used[e.key] = true; used[partner.key] = true;
        /* Importante: dgEvt.qtd é o nº de fêmeas que ENTROU no ciclo que está sendo
           diagnosticado (serve para o DG); d0Evt.qtd já é o nº de vazias (reduzido pelo
           resultado do DG) que de fato segue para o novo D0. São públicos diferentes do
           mesmo manejo no mesmo dia — guardar os dois evita subestimar/superestimar
           dose/implante ao ler só um número no cartão mesclado. */
        out.push(Object.assign({}, dgEvt, {
          acao:'DG-D0', cycle:dgEvt.cycle, cycleTo:d0Evt.cycle, merged:true,
          qtdDG: dgEvt.qtd, qtdD0: d0Evt.qtd, orientacaoD0: d0Evt.orientacao
        }));
      } else {
        used[e.key] = true;
        out.push(e);
      }
    });
    return out;
  }
  function iatfLabel(e){
    return e.merged ? ('IATF '+e.cycle+'→'+e.cycleTo) : ('IATF '+e.cycle);
  }
  /* Versão do rótulo usada dentro do PDF vetorial: as fontes padrão do jsPDF (Helvetica)
     só suportam WinAnsi/CP1252, que não inclui a seta "→" — usá-la ali corrompe o texto
     (ex.: "IATF 1!'2"). Aqui trocamos a seta por um hífen, seguro em qualquer fonte. */
  function iatfLabelPdf(e){
    return e.merged ? ('IATF '+e.cycle+'-'+e.cycleTo) : ('IATF '+e.cycle);
  }
  var ACAO_DISPLAY = {'DG-D0':'DG + novo D0'};
  /* Rótulo da ação, compartilhado entre calendário (tela), PDF e WhatsApp — um único
     lugar para ajustar como cada ação aparece, em vez de repetir em cada renderizador. */
  function eventAcaoText(e){
    return ACAO_DISPLAY[e.acao] || e.acao;
  }
  /* Texto de quantidade, compartilhado entre calendário (tela), PDF e WhatsApp. No
     cartão mesclado "DG-D0" (DG de um ciclo + D0 do ciclo seguinte no mesmo dia),
     mostra as duas contagens em vez de reaproveitar só uma — ver nota em
     mergeDayEvents sobre por que elas são diferentes. */
  function eventQtdText(e){
    if(e.merged){
      return e.qtdDG+' diagnosticadas · '+e.qtdD0+' vazia'+(e.qtdD0===1?'':'s')+' seguem p/ novo D0';
    }
    return e.qtd+' matrizes';
  }
  function pickDefaultMonday(events){
    if(!events.length) return mondayOf(new Date());
    var counts = {};
    events.forEach(function(e){
      var mon = toISO(mondayOf(e.date));
      counts[mon] = (counts[mon]||0)+1;
    });
    var best=null, bestCount=-1;
    Object.keys(counts).sort().forEach(function(k){
      if(counts[k]>bestCount){ bestCount=counts[k]; best=k; }
    });
    return parseISO(best);
  }

  /* ============================== conflitos de manejo ==============================
     Regra: no mesmo retiro e na mesma data não podem coincidir manejos DIFERENTES
     (ex.: D0 de um lote e IATF de outro). Vários lotes com o MESMO manejo no mesmo dia
     não são conflito, e o "DG + novo D0" do mesmo lote conta como um único manejo.
     Eventos cancelados não entram na verificação. Um conflito só é aceito com
     autorização prévia registrada (quem autorizou, quando e motivo). A autorização
     fica presa ao conjunto exato de eventos: se outro manejo entrar naquele dia,
     o conflito volta a exigir autorização. */
  function hashStr(s){
    var h = 5381;
    for(var i=0;i<s.length;i++){ h = ((h<<5)+h + s.charCodeAt(i)) >>> 0; }
    return h.toString(36);
  }
  function detectConflicts(events){
    var groups = {}, order = [];
    events.forEach(function(e){
      if(e.status==='Cancelado') return;
      var k = e.retiro+'|'+toISO(e.date);
      if(!groups[k]){ groups[k] = []; order.push(k); }
      groups[k].push(e);
    });
    var out = [];
    order.forEach(function(k){
      var raw = groups[k];
      var merged = mergeDayEvents(raw);
      var acoes = [];
      merged.forEach(function(e){ if(acoes.indexOf(e.acao)===-1) acoes.push(e.acao); });
      if(acoes.length<2) return;
      var keys = raw.map(function(e){ return e.key; }).sort();
      var first = raw[0];
      var id = 'cf-'+(RETIRO_KEY[first.retiro]||'outro')+'-'+toISO(first.date)+'-'+hashStr(keys.join(','));
      out.push({
        id: id, retiro: first.retiro, date: first.date, acoes: acoes, events: merged, keys: keys,
        autorizacao: state.autorizacoes[id] || null
      });
    });
    out.sort(function(a,b){ return a.date - b.date || a.retiro.localeCompare(b.retiro); });
    return out;
  }
  function currentConflicts(){ return detectConflicts(computeSchedule(state.lotes, state.params)); }
  function pendingConflicts(list){ return (list||currentConflicts()).filter(function(c){ return !c.autorizacao; }); }
  /* Mapa evento → situação de conflito, usado para marcar cartões e linhas da agenda. */
  function conflictIndex(list){
    var idx = {};
    list.forEach(function(c){
      var st = c.autorizacao ? 'ok' : 'pending';
      c.keys.forEach(function(k){ idx[k] = {status:st, conflito:c}; });
      c.events.forEach(function(e){ idx[e.key] = {status:st, conflito:c}; });
    });
    return idx;
  }
  function conflictSummary(c){
    return c.events.map(function(e){ return eventAcaoText(e)+' ('+e.lote+', '+e.periodo+')'; }).join(' × ');
  }
  function updateConflictBadge(list){
    var btn = document.getElementById('btnConflitos');
    if(!btn) return;
    var pend = pendingConflicts(list);
    if(pend.length){
      btn.hidden = false;
      btn.textContent = '⚠ '+pend.length+' conflito'+(pend.length===1?'':'s')+' sem autorização';
    } else {
      btn.hidden = true;
    }
  }
  function goToFirstPendingConflict(){
    var pend = pendingConflicts();
    if(!pend.length) return;
    state.refDate = pend[0].date;
    if(state.calendarioFiltroRetiro && state.calendarioFiltroRetiro!==pend[0].retiro){ state.calendarioFiltroRetiro = ''; }
    switchTab('calendario');
    var el = document.getElementById('conflictPanel');
    if(el && el.scrollIntoView) el.scrollIntoView({behavior:'smooth', block:'start'});
  }

  /* Portão de autorização prévia: toda edição que mexe em datas/retiros passa por aqui.
     Se a alteração cria um conflito novo ainda não autorizado, abre o diálogo e só deixa
     seguir com autorização registrada — senão a alteração é desfeita. */
  function withConflictGuard(mutate, undo, contexto){
    var before = {};
    pendingConflicts().forEach(function(c){ before[c.id] = true; });
    mutate();
    var novos = pendingConflicts().filter(function(c){ return !before[c.id]; });
    if(novos.length){ openAuthDialog(novos, {gate:true, undo:undo, contexto:contexto}); }
  }

  var AUTORIZADOR_KEY = 'iatf-jsrural-autorizador';
  function lastAutorizador(){ try{ return window.localStorage.getItem(AUTORIZADOR_KEY)||''; }catch(e){ return ''; } }
  function rememberAutorizador(n){ try{ window.localStorage.setItem(AUTORIZADOR_KEY, n); }catch(e){} }

  function saveAutorizacao(c, nome, motivo){
    var rec = {
      conflitoId: c.id, retiro: c.retiro, data: toISO(c.date), acoes: c.acoes.slice(),
      lotes: c.events.map(function(e){ return e.lote; }), keys: c.keys.slice(),
      autorizadoPor: nome, motivo: motivo||'', em: new Date().toISOString()
    };
    state.autorizacoes = Object.assign({}, state.autorizacoes);
    state.autorizacoes[c.id] = rec;
    store.put('autorizacoes', c.id, rec);
  }
  function revokeAutorizacao(id){
    state.autorizacoes = Object.assign({}, state.autorizacoes);
    delete state.autorizacoes[id];
    renderActive();
    store.del('autorizacoes', id);
  }

  var cfDialogState = null;
  function cfDialog(){ return document.getElementById('cfDialog'); }
  function closeCfDialog(){
    var d = cfDialog();
    cfDialogState = null;
    if(d && d.open) d.close();
  }
  function showCfDialog(html, st){
    var d = cfDialog();
    if(d.open) d.close();
    cfDialogState = st;
    document.getElementById('cfDialogBody').innerHTML = html;
    d.showModal();
  }
  function conflictListHtml(list){
    return '<div class="conflict-list" style="margin-top:10px;">'+list.map(function(c){
      return '<div class="conflict-item pending"><div class="conflict-title">'+esc(c.retiro)+' · '+WEEKDAY_LONG[c.date.getDay()]+' '+fmtDateFull(c.date)+'</div>'
        + '<div class="conflict-events">'+c.events.map(function(e){
            return '<div class="conflict-ev"><span><b>'+esc(eventAcaoText(e))+'</b> · '+esc(e.lote)+' · '+esc(e.periodo)+'</span></div>';
          }).join('')+'</div></div>';
    }).join('')+'</div>';
  }

  /* Diálogo de autorização — usado tanto pelo botão "Autorizar" do alerta quanto pelo
     portão (gate) que aparece logo após uma edição que cria conflito. */
  function openAuthDialog(list, opts){
    opts = opts || {};
    var gate = !!opts.gate;
    var html = '<h2>'+(gate ? '⚠ Esta alteração cria conflito de manejo' : 'Autorizar manejos no mesmo dia')+'</h2>'
      + '<p class="section-hint">'+(gate
          ? 'No mesmo retiro e na mesma data ficariam manejos diferentes. Para manter a alteração é preciso autorização prévia; caso contrário, ela será desfeita.'
          : 'Manejos diferentes no mesmo retiro e na mesma data só podem seguir com autorização registrada.')+'</p>'
      + conflictListHtml(list)
      + '<div class="field"><label for="cfNome">Autorizado por</label><input class="input" id="cfNome" value="'+esc(lastAutorizador())+'" placeholder="Nome do responsável"></div>'
      + '<div class="field"><label for="cfMotivo">Motivo <span class="hint">· opcional</span></label><textarea class="input" id="cfMotivo" placeholder="Ex.: equipe reforçada, curral comporta os dois lotes"></textarea></div>'
      + '<div class="cf-error" id="cfErro"></div>'
      + '<div class="cf-buttons">'
        + (gate ? '<button class="icon-btn btn-danger" type="button" id="cfUndo">Desfazer alteração</button>'
                : '<button class="icon-btn" type="button" id="cfCancel">Cancelar</button>')
        + '<button class="icon-btn btn-primary" type="button" id="cfOk">✔ Autorizar</button>'
      + '</div>';
    showCfDialog(html, {tipo:'auth', gate:gate, undo:opts.undo});
    var d = cfDialog();
    function doUndo(){
      var u = opts.undo;
      closeCfDialog();
      if(typeof u==='function') u();
    }
    if(gate){ document.getElementById('cfUndo').addEventListener('click', doUndo); }
    else { document.getElementById('cfCancel').addEventListener('click', closeCfDialog); }
    document.getElementById('cfOk').addEventListener('click', function(){
      var nome = document.getElementById('cfNome').value.trim();
      var motivo = document.getElementById('cfMotivo').value.trim();
      if(!nome){ document.getElementById('cfErro').textContent = 'Informe quem está autorizando.'; document.getElementById('cfNome').focus(); return; }
      rememberAutorizador(nome);
      list.forEach(function(c){ saveAutorizacao(c, nome, motivo); });
      closeCfDialog();
      renderActive();
    });
    /* Esc no portão equivale a "Desfazer" — a alteração não pode ficar sem autorização. */
    d.oncancel = function(ev){
      if(cfDialogState && cfDialogState.gate){ ev.preventDefault(); doUndo(); }
      else { cfDialogState = null; }
    };
  }

  function findEventByKey(key){
    var evs = computeSchedule(state.lotes, state.params);
    for(var i=0;i<evs.length;i++){ if(evs[i].key===key) return evs[i]; }
    return null;
  }
  function isFirstD0(key){ return /-c1-D0$/.test(key); }
  function loteIdFromKey(key){ return key.replace(/-c\d+-(D0|D7|D8|IATF|DG)$/, ''); }

  /* Aplica uma nova data a um evento. O D0 do 1º ciclo é a própria "Data D0" do lote
     (mantém a aba Lotes coerente); os demais viram um ajuste (override dataAjustada). */
  function applyEventDate(key, iso){
    if(isFirstD0(key)){
      var lid = loteIdFromKey(key);
      var lote = state.lotes.find(function(l){ return l.id===lid; });
      if(lote){ upsertLoteField(lid, 'dataD0', iso); }
      return;
    }
    setOverride(key, 'dataAjustada', iso || '');
  }

  function openDateDialog(key){
    var e = findEventByKey(key);
    if(!e) return;
    var current = toISO(e.date);
    var html = '<h2>Alterar data do manejo</h2>'
      + '<p class="section-hint"><b>'+esc(eventAcaoText(e))+'</b> (IATF '+e.cycle+') · '+esc(e.lote)+' · '+esc(e.retiro)+' · '+esc(e.periodo)+'</p>'
      + '<div class="field"><label for="cfData">Nova data <span class="hint">· atual: '+fmtDateFull(e.date)+(e.ajustada?' (ajustada)':'')+'</span></label>'
      + '<input class="input" type="date" id="cfData" value="'+current+'"></div>'
      + '<div class="cf-footnote section-hint" style="margin-top:8px;">As ações seguintes deste lote acompanham a nova data, mantendo os intervalos do protocolo. Confirme o ajuste com o médico-veterinário responsável.</div>'
      + '<div id="cfPreview"></div>'
      + '<div class="cf-buttons">'
        + (e.ajustada && !isFirstD0(key) ? '<button class="icon-btn" type="button" id="cfReset">Voltar à data calculada</button>' : '')
        + '<button class="icon-btn" type="button" id="cfCancel">Cancelar</button>'
        + '<button class="icon-btn btn-primary" type="button" id="cfOk">Salvar nova data</button>'
      + '</div>';
    showCfDialog(html, {tipo:'date', key:key});
    cfDialog().oncancel = function(){ cfDialogState = null; };
    var input = document.getElementById('cfData');
    function preview(){
      var iso = input.value;
      var box = document.getElementById('cfPreview');
      if(!iso || !parseISO(iso)){ box.innerHTML=''; return; }
      /* Simula a mudança sem gravar, para mostrar se a nova data ainda conflita. */
      var savedOv = state.overrides, savedLotes = state.lotes;
      try{
        if(isFirstD0(key)){
          var lid = loteIdFromKey(key);
          state.lotes = savedLotes.map(function(l){ return l.id===lid ? Object.assign({}, l, {dataD0:iso}) : l; });
        } else {
          state.overrides = Object.assign({}, savedOv);
          state.overrides[key] = Object.assign({}, savedOv[key]||{}, {dataAjustada:iso});
        }
        var lid2 = loteIdFromKey(key);
        var afetados = pendingConflicts().filter(function(c){
          return c.events.some(function(ev){ return ev.loteId===lid2; });
        });
      } finally {
        state.overrides = savedOv; state.lotes = savedLotes;
      }
      box.innerHTML = afetados.length
        ? '<div class="cf-preview bad">⚠ Com esta data, o lote ainda teria '+afetados.length+' conflito'+(afetados.length===1?'':'s')+' sem autorização: '
            + afetados.map(function(c){ return esc(c.retiro)+' '+fmtDateShort(c.date)+' ('+esc(c.acoes.map(function(a){return ACAO_DISPLAY[a]||a;}).join(' × '))+')'; }).join('; ')
            + '. Ao salvar, será pedida autorização.</div>'
        : '<div class="cf-preview ok">✔ Sem conflito de manejos para este lote com esta data.</div>';
    }
    input.addEventListener('input', preview);
    input.addEventListener('change', preview);
    preview();
    document.getElementById('cfCancel').addEventListener('click', closeCfDialog);
    var resetBtn = document.getElementById('cfReset');
    if(resetBtn){ resetBtn.addEventListener('click', function(){ closeCfDialog(); applyEventDate(key, ''); }); }
    document.getElementById('cfOk').addEventListener('click', function(){
      var iso = input.value;
      if(!iso || !parseISO(iso)){ return; }
      closeCfDialog();
      if(iso!==current){ applyEventDate(key, iso); }
    });
  }

  /* Painel de alerta exibido no topo do calendário semanal. */
  function conflictPanelHtml(weekConflicts, totalPend){
    if(!weekConflicts.length){
      if(!totalPend) return '';
      return '<div class="card conflict-panel no-print" id="conflictPanel"><h3>⚠ '+totalPend+' conflito'+(totalPend===1?'':'s')+' de manejo sem autorização em outras semanas</h3>'
        + '<div class="conflict-actions" style="margin-top:8px;"><button class="icon-btn btn-sm" type="button" data-cf-goto="1">Ir para o próximo conflito</button></div></div>';
    }
    var pendWeek = weekConflicts.filter(function(c){ return !c.autorizacao; }).length;
    var items = weekConflicts.map(function(c){
      var a = c.autorizacao;
      var evs = c.events.map(function(e){
        return '<div class="conflict-ev"><span><b>'+esc(eventAcaoText(e))+'</b> · '+esc(e.lote)+' · '+esc(e.periodo)+' · '+esc(eventQtdText(e))+'</span>'
          + '<button class="icon-btn btn-sm" type="button" data-cf-date="'+esc(e.key)+'">📅 Alterar data</button></div>';
      }).join('');
      return '<div class="conflict-item '+(a?'authorized':'pending')+'">'
        + '<div class="conflict-head"><span class="conflict-title">'+esc(c.retiro)+' · '+WEEKDAY_LONG[c.date.getDay()]+' '+fmtDateFull(c.date)+'</span>'
          + '<span class="conflict-actions">'
            + (a ? '<span class="chip-status chip-ok">✔ Autorizado</span><button class="icon-btn btn-sm" type="button" data-cf-revoke="'+esc(c.id)+'">Revogar</button>'
                 : '<span class="chip-status chip-pending">Sem autorização</span><button class="icon-btn btn-sm btn-primary" type="button" data-cf-auth="'+esc(c.id)+'">✔ Autorizar</button>')
          + '</span></div>'
        + '<div class="conflict-events">'+evs+'</div>'
        + (a ? '<div class="auth-note">Autorizado por <b>'+esc(a.autorizadoPor)+'</b> em '+fmtDateFull(new Date(a.em))+(a.motivo ? ' — '+esc(a.motivo) : '')+'</div>' : '')
        + '</div>';
    }).join('');
    var outras = totalPend - pendWeek;
    return '<div class="card conflict-panel no-print'+(pendWeek?'':' all-ok')+'" id="conflictPanel">'
      + '<h3>'+(pendWeek ? '⚠ Conflito de manejos no mesmo retiro e data' : '✔ Manejos coincidentes autorizados')+'</h3>'
      + '<p class="section-hint">Manejos diferentes no mesmo retiro e no mesmo dia só podem seguir com autorização prévia. Autorize ou altere a data de um dos manejos.'
        + (outras>0 ? ' Há mais '+outras+' conflito'+(outras===1?'':'s')+' sem autorização em outras semanas. <a href="#" data-cf-goto="1">Ver</a>' : '')+'</p>'
      + '<div class="conflict-list">'+items+'</div></div>';
  }
  function bindConflictPanel(root, weekConflicts){
    root.querySelectorAll('[data-cf-date]').forEach(function(b){
      b.addEventListener('click', function(){ openDateDialog(b.getAttribute('data-cf-date')); });
    });
    root.querySelectorAll('[data-cf-auth]').forEach(function(b){
      b.addEventListener('click', function(){
        var id = b.getAttribute('data-cf-auth');
        var c = weekConflicts.filter(function(x){ return x.id===id; });
        if(c.length) openAuthDialog(c, {gate:false});
      });
    });
    root.querySelectorAll('[data-cf-revoke]').forEach(function(b){
      b.addEventListener('click', function(){
        if(b.getAttribute('data-armed')==='1'){ revokeAutorizacao(b.getAttribute('data-cf-revoke')); }
        else{
          b.setAttribute('data-armed','1'); b.textContent='Confirmar?';
          setTimeout(function(){ b.setAttribute('data-armed','0'); b.textContent='Revogar'; }, 2600);
        }
      });
    });
    root.querySelectorAll('[data-cf-goto]').forEach(function(b){
      b.addEventListener('click', function(ev){ ev.preventDefault(); goToFirstPendingConflict(); });
    });
  }

  /* ============================== status de sincronização ============================== */
  var SYNC_TEXT = {
    'local':         ['off',  'Modo local — dados salvos neste aparelho'],
    'conectando':    ['busy', 'Conectando à nuvem…'],
    'login':         ['off',  'Entre na sua conta para sincronizar'],
    'sincronizando': ['busy', 'Sincronizando…'],
    'online':        ['on',   'Sincronizado — visível em todos os aparelhos'],
    'offline':       ['off',  'Sem internet — trabalhando no aparelho'],
    'erro':          ['warn', 'Falha na sincronização — nova tentativa automática'],
    'sem-acesso':    ['warn', 'Usuário sem acesso à nuvem']
  };
  var lastStatus = null;
  function renderSyncStatus(st){
    lastStatus = st;
    var t = SYNC_TEXT[st.mode] || SYNC_TEXT.local;
    var pend = st.pendentes ? ' · '+st.pendentes+' alteraç'+(st.pendentes===1?'ão':'ões')+' a enviar' : '';
    var el = document.getElementById('syncStatus');
    if(el) el.innerHTML = '<span class="sync-dot '+t[0]+'"></span>'+esc(t[1]+pend)+(st.erro && st.mode!=='online' ? ' — '+esc(st.erro) : '');
    var pill = document.getElementById('syncPill');
    if(pill){
      pill.className = 'sync-pill no-print '+t[0];
      pill.textContent = st.mode==='online' && !st.pendentes ? '● Online' : (st.mode==='local' ? '● Local' : (st.pendentes ? '● '+st.pendentes+' pendente'+(st.pendentes===1?'':'s') : '● '+(st.mode==='offline'?'Offline':(st.mode==='login'?'Desconectado':'…'))));
      pill.title = t[1]+pend;
    }
    var who = document.getElementById('userBox');
    if(who){
      who.hidden = !st.email;
      var em = document.getElementById('userEmail'); if(em) em.textContent = st.email||'';
    }
    var login = document.getElementById('loginScreen');
    if(login){ login.hidden = st.mode!=='login'; }
  }

  /* Campos que mudam datas/retiros dos manejos passam pelo portão de conflitos. */
  var LOTE_FIELDS_AGENDA = ['dataD0','retiro','ativo','categoria'];
  function upsertLoteField(id, field, value){
    var lote = state.lotes.find(function(l){ return l.id===id; });
    if(!lote) return;
    if(LOTE_FIELDS_AGENDA.indexOf(field)===-1){ applyLoteField(id, field, value); return; }
    var old = lote[field];
    if(old===value){ applyLoteField(id, field, value); return; }
    withConflictGuard(
      function(){ applyLoteField(id, field, value); },
      function(){ applyLoteField(id, field, old); }
    );
  }
  function applyLoteField(id, field, value){
    var lote = state.lotes.find(function(l){ return l.id===id; });
    if(!lote) return;
    if(lote[field]===value) return;
    lote[field] = value;
    renderActive();
    store.put('lotes', id, stripId(lote));
  }
  function addLote(){
    /* Se o cadastro estiver filtrado por um retiro, o novo lote já nasce nele —
       assim não "desaparece" da lista filtrada assim que é criado. */
    var retiroPadrao = state.lotesFiltroRetiro || 'Água Funda';
    var data = {ativo:true, categoria:'Multípara', nome:'Novo lote', retiro:retiroPadrao, periodo:'Manhã', qtd:0, dataD0: toISO(new Date()), responsavel:'', situacao:'Planejado', obs:'', criadoEm: Date.now()};
    data.id = store.newId('lote');
    state.lotes.push(data);
    renderActive();
    store.put('lotes', data.id, stripId(data));
  }
  function deleteLote(id){
    state.lotes = state.lotes.filter(function(l){ return l.id!==id; });
    renderActive();
    store.del('lotes', id);
  }
  function setOverride(key, field, value){
    if(field==='dataAjustada' || field==='status' || field==='qtdPrenhe'){
      /* qtdPrenhe também mexe na agenda: com todas prenhes, os ciclos seguintes somem. */
      var cur0 = state.overrides[key] || {};
      var old = cur0[field]==null ? (field==='status' ? 'Planejado' : '') : cur0[field];
      if(String(old)===String(value)){ applyOverride(key, field, value); return; }
      withConflictGuard(
        function(){ applyOverride(key, field, value); },
        function(){ applyOverride(key, field, old); }
      );
      return;
    }
    applyOverride(key, field, value);
  }
  function applyOverride(key, field, value){
    var cur = state.overrides[key] || {status:'Planejado', obs:'', qtdPrenhe:''};
    var next = Object.assign({}, cur); next[field] = value;
    state.overrides[key] = next;
    renderActive();
    store.put('overrides', key, next);
  }
  function setParamField(field, value){
    var old = state.params[field];
    withConflictGuard(
      function(){ applyParamField(field, value); },
      function(){ applyParamField(field, old); }
    );
  }
  function applyParamField(field, value){
    state.params = Object.assign({}, state.params);
    var min = PARAM_MIN[field]||0;
    state.params[field] = Math.max(min, Number(value)||0);
    renderActive();
    store.put('config', 'parametros', state.params);
  }

  /* ============================== dados ==============================
     Toda leitura/gravação passa pelo IatfStore (js/store.js): cache no aparelho,
     fila offline e sincronização com o Supabase quando configurado. */
  var store = null;
  function stripId(o){ var c = Object.assign({}, o); delete c.id; return c; }
  function applySnapshot(snap){
    state.lotes = snap.lotes || [];
    state.overrides = snap.overrides || {};
    state.autorizacoes = snap.autorizacoes || {};
    state.params = Object.assign({}, DEFAULT_PARAMS, snap.params || {});
    if(state.refDate===null){ state.refDate = pickDefaultMonday(computeSchedule(state.lotes, state.params)); }
    renderActive(true);
  }
  function initData(){
    store = window.IatfStore.create({
      config: window.IATF_CONFIG || {},
      onState: applySnapshot,
      onStatus: renderSyncStatus,
      onPasswordRecovery: openNewPasswordDialog
    });
    store.start();
  }

  /* ============================== rendering: calendário ============================== */
  function renderCalendario(){
    var panel = document.getElementById('panel-calendario');
    if(state.refDate===null){
      panel.innerHTML = '<div class="card panel-pad mono" style="text-align:center; color:var(--ink-soft);">Carregando calendário…</div>';
      return;
    }
    var events = computeSchedule(state.lotes, state.params);
    var monday = mondayOf(state.refDate);
    var days = [];
    for(var i=0;i<6;i++){ days.push(addDays(monday,i)); }
    var sunday = addDays(monday,6);
    var filtroRetiro = state.calendarioFiltroRetiro;
    var weekEvents = events.filter(function(e){
      return e.date>=monday && e.date<=days[5] && (!filtroRetiro || e.retiro===filtroRetiro);
    });
    var allConflicts = detectConflicts(events);
    var cIdx = conflictIndex(allConflicts);
    var weekConflicts = allConflicts.filter(function(c){
      return c.date>=monday && c.date<=sunday && (!filtroRetiro || c.retiro===filtroRetiro);
    });
    var totalPend = pendingConflicts(allConflicts).length;

    var legendHtml = RETIROS.map(function(r){
      var v = retiroVars(r);
      var esmaecido = filtroRetiro && r!==filtroRetiro;
      return '<span class="legend-chip" style="background:'+v.rbg+'; color:'+v.rink+'; opacity:'+(esmaecido?'.35':'1')+';"><span class="legend-dot" style="background:'+v.rc+';"></span>'+esc(r)+'</span>';
    }).join('');

    var gridHtml = days.map(function(d){
      var dayEvents = mergeDayEvents(weekEvents.filter(function(e){ return sameDate(e.date, d); }));
      var dayPending = false;
      var body = dayEvents.length ? dayEvents.map(function(e){
        var v = retiroVars(e.retiro);
        var cf = cIdx[e.key];
        if(cf && cf.status==='pending') dayPending = true;
        var flag = cf ? (cf.status==='pending'
            ? '<span class="ev-flag pending" title="Manejos diferentes no mesmo retiro e data — sem autorização">⚠ Conflito</span> '
            : '<span class="ev-flag ok" title="Autorizado por '+esc(cf.conflito.autorizacao.autorizadoPor)+'">✔ Autorizado</span> ')
          : '';
        if(e.ajustada) flag += '<span class="ev-flag adj" title="Data alterada manualmente">Data ajustada</span>';
        return '<div class="event-card" style="--rc:'+v.rc+'; --rbg:'+v.rbg+'; --rink:'+v.rink+';">'
          + '<div class="ev-top"><span class="ev-acao">'+esc(e.periodo)+' — '+esc(eventAcaoText(e))+'</span><span title="'+esc(e.orientacao)+'">'+iatfLabel(e)+'</span></div>'
          + '<div class="ev-lote">'+esc(e.categoria)+' · '+esc(e.lote)+'</div>'
          + '<div class="ev-retiro">'+esc(e.retiro)+' — '+esc(eventQtdText(e))+'</div>'
          + (flag ? '<div>'+flag+'</div>' : '')
          + '</div>';
      }).join('') : '<div class="empty-day">Sem manejos</div>';
      return '<div class="day-col card'+(dayPending?' has-conflict':'')+'">'
        + '<div class="day-head"><div class="dow">'+WEEKDAY_LONG[d.getDay()]+'</div><div class="ddate">'+fmtDateShort(d)+'</div></div>'
        + '<div class="day-body">'+body+'</div>'
        + '</div>';
    }).join('');

    panel.innerHTML =
      '<div class="card cal-toolbar no-print">'
        + '<div class="refdate-group">'
          + '<label for="refDateInput">Data de referência</label>'
          + '<input class="field-input" type="date" id="refDateInput" value="'+toISO(state.refDate)+'">'
          + '<div class="week-nav">'
            + '<button class="icon-btn btn-sm" id="btnPrevWeek" type="button" title="Semana anterior">◀ Semana</button>'
            + '<button class="icon-btn btn-sm" id="btnToday" type="button">Hoje</button>'
            + '<button class="icon-btn btn-sm" id="btnNextWeek" type="button" title="Próxima semana">Semana ▶</button>'
          + '</div>'
          + '<span class="week-range">Semana de '+fmtDateFull(monday)+' a '+fmtDateFull(sunday)+'</span>'
        + '</div>'
        + '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">'
          + '<label for="fCalRetiro" class="mono" style="font-size:.8rem; color:var(--ink-soft);">Retiro</label>'
          + '<select class="select" id="fCalRetiro"><option value="">Todos os retiros</option>'+RETIROS.map(function(r){ return '<option '+(r===filtroRetiro?'selected':'')+'>'+r+'</option>'; }).join('')+'</select>'
          + '<span class="pdf-status" id="pdfStatus"></span>'
          + '<button class="icon-btn" id="btnBackup" type="button">💾 Salvar Backup</button>'
          + '<button class="icon-btn" id="btnImport" type="button">📂 Importar Backup</button>'
          + '<button class="icon-btn btn-primary" id="btnPdf" type="button">⬇ Salvar PDF</button>'
          + '<a class="icon-btn btn-whatsapp" id="btnWhatsapp" href="#" target="_blank" rel="noopener noreferrer">📲 WhatsApp</a>'
        + '</div>'
      + '</div>'
      + '<div class="card cal-brand">'
        + '<img class="cal-logo" src="'+LOGO_DATA_URI+'" alt="JS Rural">'
        + '<div class="cal-brand-text">'
          + '<h2>Calendário Semanal — Programa de IATF'+(filtroRetiro ? ' · '+esc(filtroRetiro) : '')+'</h2>'
          + '<div class="mono week-range-print">Semana de '+fmtDateFull(monday)+' a '+fmtDateFull(sunday)+' · gerado em '+fmtDateFull(new Date())+'</div>'
        + '</div>'
      + '</div>'
      + conflictPanelHtml(weekConflicts, totalPend)
      + '<div class="card legend"><span class="legend-title">Retiros</span>'+legendHtml+'</div>'
      + '<div class="week-grid">'+gridHtml+'</div>';

    bindConflictPanel(panel, weekConflicts);

    document.getElementById('refDateInput').addEventListener('change', function(e){
      var d = parseISO(e.target.value);
      if(d){ state.refDate = d; renderActive(); }
    });
    document.getElementById('btnPrevWeek').addEventListener('click', function(){ state.refDate = addDays(mondayOf(state.refDate), -7); renderActive(); });
    document.getElementById('btnNextWeek').addEventListener('click', function(){ state.refDate = addDays(mondayOf(state.refDate), 7); renderActive(); });
    document.getElementById('btnToday').addEventListener('click', function(){ state.refDate = new Date(); renderActive(); });
    document.getElementById('fCalRetiro').addEventListener('change', function(e){ state.calendarioFiltroRetiro = e.target.value; renderActive(); });
    document.getElementById('btnBackup').addEventListener('click', exportBackup);
    document.getElementById('btnImport').addEventListener('click', pickBackupFile);
    document.getElementById('btnPdf').addEventListener('click', exportCalendarioPdf);
    document.getElementById('btnWhatsapp').setAttribute('href', 'https://wa.me/?text='+encodeURIComponent(buildWhatsAppMessage()));
  }
  function setPdfStatus(text, kind){
    var el = document.getElementById('pdfStatus');
    if(!el) return;
    el.textContent = text||'';
    el.className = 'pdf-status' + (kind ? ' '+kind : '');
  }
  function buildWhatsAppMessage(){
    var events = computeSchedule(state.lotes, state.params);
    var monday = mondayOf(state.refDate);
    var days = [];
    for(var i=0;i<6;i++){ days.push(addDays(monday,i)); }
    var sunday = addDays(monday,6);
    var filtroRetiro = state.calendarioFiltroRetiro;
    var weekEvents = events.filter(function(e){
      return e.date>=monday && e.date<=days[5] && (!filtroRetiro || e.retiro===filtroRetiro);
    });

    var waConflicts = detectConflicts(events).filter(function(c){
      return c.date>=monday && c.date<=days[5] && (!filtroRetiro || c.retiro===filtroRetiro);
    });
    var lines = [];
    lines.push('*📅 Calendário IATF — JS Rural'+(filtroRetiro ? ' · '+filtroRetiro : '')+'*');
    lines.push('Semana de '+fmtDateFull(monday)+' a '+fmtDateFull(sunday));
    lines.push('');

    days.forEach(function(d){
      var dayEvents = mergeDayEvents(weekEvents.filter(function(e){ return sameDate(e.date, d); }));
      lines.push('*'+WEEKDAY_LONG[d.getDay()]+' ('+fmtDateShort(d)+')*');
      if(dayEvents.length){
        dayEvents.forEach(function(e){
          lines.push(e.periodo+' — '+eventAcaoText(e)+' ('+iatfLabel(e)+')');
          lines.push(e.categoria+' · '+e.lote+' · '+e.retiro+' — '+eventQtdText(e));
        });
      } else {
        lines.push('Sem manejos');
      }
      waConflicts.filter(function(c){ return sameDate(c.date, d); }).forEach(function(c){
        lines.push(c.autorizacao
          ? '✔ '+c.retiro+': manejos diferentes no mesmo dia — autorizado por '+c.autorizacao.autorizadoPor
          : '⚠ '+c.retiro+': CONFLITO de manejos no mesmo dia — SEM AUTORIZAÇÃO');
      });
      lines.push('');
    });

    return lines.join('\n').trim();
  }
  /* ============================== PDF vetorial (texto e formas nítidas, arquivo leve) ============================== */
  /* Gerado inteiramente com comandos vetoriais do jsPDF (sem captura de tela/CSS var), o que
     evita tanto o esmaecimento de cores (var() nem sempre é resolvido por rasterizadores de DOM)
     quanto arquivos enormes — o resultado é nítido em qualquer zoom e pesa poucas centenas de KB. */
  var PDF_RETIRO = {
    'agua-funda': {solid:'#2f9e44', bg:'#e6f6ea', ink:'#1c6b2c'},
    'pontal':     {solid:'#E6E600', bg:'#FFFF66', ink:'#4D4000'},
    'placa':      {solid:'#2f95c9', bg:'#e2f2fa', ink:'#1a6086'},
    'seringa':    {solid:'#e07a1f', bg:'#fdead4', ink:'#8a4710'},
    'outro':      {solid:'#6b7280', bg:'#eceef1', ink:'#43484f'}
  };
  var PDF_INK='#1a2420', PDF_INK_SOFT='#57645c', PDF_INK_FAINT='#8a988f';
  var PDF_BRAND='#223047', PDF_BRAND_INK='#ffffff', PDF_BORDER='#c9cfc3';
  var PDF_SURFACE='#ffffff', PDF_SURFACE2='#f2f4ee';

  function hexRGB(hex){
    var h = String(hex).replace('#','');
    if(h.length===3){ h = h.split('').map(function(c){ return c+c; }).join(''); }
    var num = parseInt(h,16);
    return [(num>>16)&255, (num>>8)&255, num&255];
  }
  function setFillHex(pdf,hex){ var c=hexRGB(hex); pdf.setFillColor(c[0],c[1],c[2]); }
  function setTextHex(pdf,hex){ var c=hexRGB(hex); pdf.setTextColor(c[0],c[1],c[2]); }
  function setDrawHex(pdf,hex){ var c=hexRGB(hex); pdf.setDrawColor(c[0],c[1],c[2]); }
  function ptToMm(pt){ return pt*0.3527778; }
  function lineH(pt){ return ptToMm(pt)*1.22; }
  function fmtTime(d){ return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }

  function measureEventCard(pdf, e, innerW, k){
    var fsA=7*k, fsB=7.6*k, fsC=7*k, padT=2.1*k, padB=2.1*k, gap=1*k;
    pdf.setFont('helvetica','bold'); pdf.setFontSize(fsB);
    var linesB = pdf.splitTextToSize(e.categoria+' · '+e.lote, innerW);
    pdf.setFont('helvetica','bold'); pdf.setFontSize(fsC);
    /* No cartão mesclado "DG-D0" o texto de quantidade é mais longo (duas contagens,
       ver eventQtdText) — quebra em mais de uma linha em vez de estourar a largura
       da coluna, por isso essa linha agora é medida como a linha B. */
    var linesC = pdf.splitTextToSize(e.retiro+' — '+eventQtdText(e), innerW);
    var h = padT + lineH(fsA) + gap + linesB.length*lineH(fsB) + gap + linesC.length*lineH(fsC) + padB;
    return {h:h, linesB:linesB, linesC:linesC, fsA:fsA, fsB:fsB, fsC:fsC, padT:padT, gap:gap};
  }
  function drawEventCard(pdf, x, y, w, e, innerW, k){
    var key = RETIRO_KEY[e.retiro] || 'outro';
    var c = PDF_RETIRO[key];
    var m = measureEventCard(pdf, e, innerW, k);

    setFillHex(pdf, c.bg);
    pdf.roundedRect(x, y, w, m.h, 1, 1, 'F');
    setFillHex(pdf, c.solid);
    pdf.rect(x, y, 1.1, m.h, 'F');

    var tx = x + 3.4*k;
    var cursorY = y + m.padT;

    cursorY += lineH(m.fsA)*0.78;
    pdf.setFont('helvetica','bold'); pdf.setFontSize(m.fsA); setTextHex(pdf, c.ink);
    pdf.text(e.periodo+' — '+eventAcaoText(e)+'  ·  '+iatfLabelPdf(e), tx, cursorY);
    cursorY += lineH(m.fsA)*0.22 + m.gap;

    pdf.setFont('helvetica','bold'); pdf.setFontSize(m.fsB); setTextHex(pdf, PDF_INK);
    m.linesB.forEach(function(line){
      cursorY += lineH(m.fsB)*0.78;
      pdf.text(line, tx, cursorY);
      cursorY += lineH(m.fsB)*0.22;
    });
    cursorY += m.gap;

    pdf.setFont('helvetica','bold'); pdf.setFontSize(m.fsC); setTextHex(pdf, c.ink);
    m.linesC.forEach(function(line){
      cursorY += lineH(m.fsC)*0.78;
      pdf.text(line, tx, cursorY);
      cursorY += lineH(m.fsC)*0.22;
    });

    return m.h;
  }

  function buildCalendarPdf(pdf){
    var events = computeSchedule(state.lotes, state.params);
    var monday = mondayOf(state.refDate);
    var days = []; for(var i=0;i<6;i++){ days.push(addDays(monday,i)); }
    var saturday = days[5];
    var sunday = addDays(monday,6);
    var filtroRetiro = state.calendarioFiltroRetiro;
    var weekEvents = events.filter(function(e){
      return e.date>=monday && e.date<=saturday && (!filtroRetiro || e.retiro===filtroRetiro);
    });

    var pageW = pdf.internal.pageSize.getWidth();
    var pageH = pdf.internal.pageSize.getHeight();
    var margin = 9;
    var x0 = margin, contentW = pageW - margin*2;
    var y = margin;

    var logoH = 14, logoW = logoH*(1100/379);
    try{ pdf.addImage(LOGO_DATA_URI, 'PNG', x0, y, logoW, logoH); }catch(errLogo){}
    var titleX = x0 + logoW + 6;
    pdf.setFont('helvetica','bold'); pdf.setFontSize(16); setTextHex(pdf, PDF_BRAND);
    pdf.text('Calendário Semanal — Programa de IATF'+(filtroRetiro ? ' · '+filtroRetiro : ''), titleX, y+6.5);
    pdf.setFont('helvetica','normal'); pdf.setFontSize(9.5); setTextHex(pdf, PDF_INK_SOFT);
    pdf.text('Semana de '+fmtDateFull(monday)+' a '+fmtDateFull(sunday)+'   ·   gerado em '+fmtDateFull(new Date())+' às '+fmtTime(new Date()), titleX, y+12.5);
    y += Math.max(logoH, 17) + 5;

    pdf.setFont('helvetica','bold'); pdf.setFontSize(7.3); setTextHex(pdf, PDF_INK_SOFT);
    pdf.text('RETIROS', x0, y+3);
    var lx = x0 + 16;
    RETIROS.forEach(function(r){
      var key = RETIRO_KEY[r] || 'outro';
      var c = PDF_RETIRO[key];
      setFillHex(pdf, c.solid);
      pdf.circle(lx+1.1, y+2.1, 1.3, 'F');
      pdf.setFont('helvetica','bold'); pdf.setFontSize(8); setTextHex(pdf, PDF_INK);
      pdf.text(r, lx+3.6, y+3);
      lx += 3.6 + pdf.getTextWidth(r) + 9;
    });
    y += 8.5;

    var footerH = 0;
    var gridTop = y;
    var gridBottom = pageH - margin - footerH;
    var gridH = gridBottom - gridTop;
    var colGap = 3, colW = (contentW - colGap*5)/6;
    var headH = 11, bodyPad = 2.4, cardGap = 1.8;
    var innerW = colW - bodyPad*2 - 1.1 - 1.6;

    var colsData = days.map(function(d){
      return {date:d, events: mergeDayEvents(weekEvents.filter(function(e){ return sameDate(e.date,d); }))};
    });

    var k = 1;
    var maxBodyH = 0;
    [1, 0.9, 0.8].some(function(tryK){
      maxBodyH = 0;
      colsData.forEach(function(col){
        var h = bodyPad*2;
        if(!col.events.length){ h = Math.max(h, 12); }
        col.events.forEach(function(e, idx){
          h += measureEventCard(pdf, e, innerW, tryK).h;
          if(idx>0) h += cardGap;
        });
        if(h>maxBodyH) maxBodyH = h;
      });
      k = tryK;
      return (headH+maxBodyH) <= gridH;
    });

    var gridColH = Math.min(headH+maxBodyH, gridH);
    var bodyH = gridColH - headH;

    colsData.forEach(function(col, idx){
      var cx = x0 + idx*(colW+colGap);
      setFillHex(pdf, PDF_SURFACE); setDrawHex(pdf, PDF_BORDER); pdf.setLineWidth(0.25);
      pdf.rect(cx, gridTop, colW, gridColH, 'FD');
      setFillHex(pdf, PDF_BRAND);
      pdf.rect(cx, gridTop, colW, headH, 'F');
      pdf.setFont('helvetica','bold'); pdf.setFontSize(7.6); setTextHex(pdf, PDF_BRAND_INK);
      pdf.text(WEEKDAY_LONG[col.date.getDay()].toUpperCase(), cx+3, gridTop+4.3);
      pdf.setFont('helvetica','bold'); pdf.setFontSize(11.5);
      pdf.text(fmtDateShort(col.date), cx+3, gridTop+9);

      var cy = gridTop + headH + bodyPad;
      if(!col.events.length){
        pdf.setFont('helvetica','normal'); pdf.setFontSize(8); setTextHex(pdf, PDF_INK_FAINT);
        pdf.text('Sem manejos', cx+colW/2, gridTop+headH+bodyH/2, {align:'center'});
      } else {
        col.events.forEach(function(e){
          var cardH = drawEventCard(pdf, cx+bodyPad, cy, colW-bodyPad*2, e, innerW, k);
          cy += cardH + cardGap;
        });
      }
    });
  }

  /* ============================== arquivos: salvar / compartilhar ==============================
     No celular usa o compartilhamento nativo (WhatsApp, Drive, Arquivos…) quando disponível;
     no computador faz o download direto. */
  function saveBlobNativo(blob, filename){
    try{
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
      return true;
    }catch(e){
      return false;
    }
  }
  function saveFile(blob, filename){
    var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    var file = null;
    try{ file = new File([blob], filename, {type: blob.type}); }catch(e){}
    if(isMobile && file && navigator.canShare && navigator.canShare({files:[file]})){
      return navigator.share({files:[file], title:filename}).then(function(){ return 'ok'; }, function(err){
        if(err && err.name==='AbortError') return 'cancel';
        return saveBlobNativo(blob, filename) ? 'ok' : 'err';
      });
    }
    return Promise.resolve(saveBlobNativo(blob, filename) ? 'ok' : 'err');
  }

  var pdfBusy = false;
  var backupBusy = false;
  var saveBusy = false;
  function setSaveStatus(text, kind){
    var el = document.getElementById('saveStatus');
    if(!el) return;
    el.textContent = text||'';
    el.className = 'pdf-status' + (kind ? ' '+kind : '');
  }
  /* Botão global "Salvar Alterações": cada edição já é gravada no aparelho na hora e entra na
     fila de sincronização. O botão (1) confirma o campo ainda em edição e (2) força o envio
     imediato das pendências, mostrando o resultado. */
  function saveAlteracoes(){
    if(saveBusy) return;
    var active = document.activeElement;
    if(active && active !== document.body && typeof active.blur === 'function'){ active.blur(); }

    saveBusy = true;
    var btn = document.getElementById('btnSalvarGlobal');
    if(btn) btn.disabled = true;
    setSaveStatus('Salvando alterações…');

    function finish(msg, kind){
      setSaveStatus(msg, kind);
      saveBusy = false;
      var b = document.getElementById('btnSalvarGlobal');
      if(b) b.disabled = false;
      setTimeout(function(){ setSaveStatus(''); }, 5000);
    }
    setTimeout(function(){
      store.flush().then(function(r){ finish(r.msg, r.ok ? 'ok' : 'err'); }, function(){ finish('Não foi possível salvar.', 'err'); });
    }, 50);
  }

  /* ============================== backup: exportar / importar ============================== */
  function backupPayload(){
    return {
      app: 'Calendário IATF JS Rural',
      versao: 2,
      geradoEm: new Date().toISOString(),
      params: state.params,
      lotes: state.lotes,
      overrides: state.overrides,
      autorizacoes: state.autorizacoes
    };
  }
  function exportBackup(){
    if(backupBusy) return;
    backupBusy = true;
    setPdfStatus('Gerando backup…');
    var blob = new Blob([JSON.stringify(backupPayload(), null, 2)], {type:'application/json'});
    saveFile(blob, 'backup-iatf-' + toISO(new Date()) + '.json').then(function(r){
      setPdfStatus(r==='ok' ? 'Backup salvo.' : (r==='cancel' ? '' : 'Não foi possível salvar o backup.'), r==='ok' ? 'ok' : 'err');
    }).then(function(){
      backupBusy = false;
      setTimeout(function(){ setPdfStatus(''); }, 5000);
    });
  }
  function validarBackup(obj){
    if(!obj || typeof obj!=='object') return 'Arquivo inválido.';
    if(!Array.isArray(obj.lotes)) return 'O arquivo não contém a lista de lotes.';
    for(var i=0;i<obj.lotes.length;i++){
      var l = obj.lotes[i];
      if(!l || typeof l!=='object' || !l.id || typeof l.nome!=='string') return 'Lote '+(i+1)+' está incompleto no arquivo.';
    }
    return null;
  }
  function importBackupFile(file){
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(){
      var obj;
      try{ obj = JSON.parse(reader.result); }catch(e){ alert('Não foi possível ler o arquivo: não é um backup válido (.json).'); return; }
      var erro = validarBackup(obj);
      if(erro){ alert(erro); return; }
      var msg = 'Importar backup'+(obj.geradoEm ? ' de '+fmtDateFull(new Date(obj.geradoEm)) : '')+' com '+obj.lotes.length+' lote(s)?\n\n'
        + 'ATENÇÃO: os dados atuais ('+state.lotes.length+' lote(s)) serão SUBSTITUÍDOS'+(store.isRemote() ? ' para todos os aparelhos sincronizados' : '')+'.\n'
        + 'Dica: salve um backup dos dados atuais antes.';
      if(!confirm(msg)) return;
      store.replaceAll({
        lotes: obj.lotes,
        overrides: obj.overrides || {},
        params: Object.assign({}, DEFAULT_PARAMS, obj.params || {}),
        autorizacoes: obj.autorizacoes || {}
      });
      state.refDate = null;
      applySnapshot({lotes:obj.lotes, overrides:obj.overrides||{}, params:obj.params||{}, autorizacoes:obj.autorizacoes||{}});
      setSaveStatus('Backup importado.', 'ok');
      setTimeout(function(){ setSaveStatus(''); }, 5000);
    };
    reader.readAsText(file);
  }
  function pickBackupFile(){
    var inp = document.getElementById('backupFileInput');
    if(!inp) return;
    inp.value = '';
    inp.click();
  }

  function exportCalendarioPdf(){
    if(pdfBusy) return;
    if(!window.jspdf || !window.jspdf.jsPDF){
      setPdfStatus('Gerador de PDF indisponível — use Ctrl+P e escolha "Salvar como PDF".', 'err');
      return;
    }
    pdfBusy = true;
    setPdfStatus('Gerando PDF…');
    var btn = document.getElementById('btnPdf');
    if(btn) btn.disabled = true;
    Promise.resolve().then(function(){
      var pdf = new window.jspdf.jsPDF({orientation:'landscape', unit:'mm', format:'a4', compress:true});
      buildCalendarPdf(pdf);
      var filename = 'calendario-iatf-' + toISO(mondayOf(state.refDate)) + '.pdf';
      return saveFile(pdf.output('blob'), filename);
    }).then(function(r){
      setPdfStatus(r==='ok' ? 'PDF salvo.' : (r==='cancel' ? '' : 'Não foi possível salvar o PDF — use Ctrl+P.'), r==='ok' ? 'ok' : 'err');
    }, function(){
      setPdfStatus('Falha ao gerar o PDF. Tente novamente.', 'err');
    }).then(function(){
      pdfBusy = false;
      var b = document.getElementById('btnPdf');
      if(b) b.disabled = false;
      setTimeout(function(){ setPdfStatus(''); }, 5000);
    });
  }

  /* ============================== rendering: lotes ============================== */
  function renderLotes(){
    var panel = document.getElementById('panel-lotes');
    var filtroRetiro = state.lotesFiltroRetiro;
    /* Ordena do menor para o maior lote (Qtd.); em caso de empate, mantém a ordem
       de lançamento (a ordem em que os lotes foram cadastrados). */
    var sortedLotes = state.lotes.filter(function(l){
      return !filtroRetiro || l.retiro===filtroRetiro;
    }).sort(function(a,b){
      var qa = Number(a.qtd)||0, qb = Number(b.qtd)||0;
      if(qa !== qb) return qa - qb;
      return (Number(a.criadoEm)||0) - (Number(b.criadoEm)||0);
    });
    var rows = sortedLotes.map(function(l){
      var v = retiroVars(l.retiro);
      return '<tr data-id="'+l.id+'">'
        + '<td class="col-tight"><input type="checkbox" data-field="ativo" '+(l.ativo?'checked':'')+'></td>'
        + '<td><select class="select" data-field="categoria">'+CATEGORIAS.map(function(c){ return '<option '+(c===l.categoria?'selected':'')+'>'+c+'</option>'; }).join('')+'</select></td>'
        + '<td style="min-width:220px;"><input class="input" data-field="nome" value="'+esc(l.nome)+'"></td>'
        + '<td><select class="select" data-field="retiro" style="background:'+v.rbg+'; color:'+v.rink+'; font-weight:600;">'+RETIROS.map(function(r){ return '<option '+(r===l.retiro?'selected':'')+'>'+r+'</option>'; }).join('')+'</select></td>'
        + '<td><select class="select" data-field="periodo">'+PERIODOS.map(function(p){ return '<option '+(p===l.periodo?'selected':'')+'>'+p+'</option>'; }).join('')+'</select></td>'
        + '<td class="col-tight"><input class="input" type="number" min="0" style="width:80px;" data-field="qtd" value="'+(l.qtd||0)+'"></td>'
        + '<td class="col-tight"><input class="input" type="date" data-field="dataD0" value="'+esc(l.dataD0||'')+'"></td>'
        + '<td style="min-width:130px;"><input class="input" data-field="responsavel" value="'+esc(l.responsavel||'')+'"></td>'
        + '<td><select class="select" data-field="situacao">'+SITUACOES.map(function(s){ return '<option '+(s===l.situacao?'selected':'')+'>'+s+'</option>'; }).join('')+'</select></td>'
        + '<td class="col-tight"><button class="icon-btn btn-sm btn-danger" data-action="delete" type="button">Excluir</button></td>'
        + '</tr>';
    }).join('');

    var femeasAtivas = sortedLotes.filter(function(l){return l.ativo;}).reduce(function(s,l){ return s+(Number(l.qtd)||0); },0);
    var emptyMsg = filtroRetiro ? 'Nenhum lote cadastrado neste retiro.' : 'Nenhum lote cadastrado. Clique em “+ Novo lote” ou importe um backup (aba Calendário → 📂 Importar Backup).';

    panel.innerHTML =
      '<div class="card panel-pad">'
        + '<h2 class="section-title">Cadastro de lotes</h2>'
        + '<p class="section-hint">Uma linha por lote. As datas e ações dos ciclos seguintes (D0, D8/D7, IATF, DG) são calculadas automaticamente a partir do primeiro D0. Multíparas, primíparas e solteiras: até 2 IATFs. Novilhas: até 3 IATFs.</p>'
        + '<div class="toolbar-row">'
          + '<div style="display:flex; align-items:center; gap:8px;">'
            + '<label for="fLoteRetiro" class="mono" style="font-size:.8rem; color:var(--ink-soft);">Retiro</label>'
            + '<select class="select" id="fLoteRetiro"><option value="">Todos os retiros</option>'+RETIROS.map(function(r){ return '<option '+(r===filtroRetiro?'selected':'')+'>'+r+'</option>'; }).join('')+'</select>'
          + '</div>'
          + '<span class="mono" style="font-size:.82rem; color:var(--ink-soft);">'+sortedLotes.filter(function(l){return l.ativo;}).length+' de '+state.lotes.filter(function(l){return l.ativo;}).length+' lotes ativos · '+femeasAtivas+' fêmeas</span>'
          + '<button class="icon-btn btn-primary" id="btnAddLote" type="button">+ Novo lote</button>'
        + '</div>'
        + '<div class="table-scroll"><table class="lotes-table"><thead><tr>'
          + '<th>Ativo</th><th>Categoria</th><th>Lote</th><th>Retiro</th><th>Período</th><th>Qtd.</th><th>Data D0</th><th>Responsável</th><th>Situação</th><th>Ações</th>'
          + '</tr></thead><tbody>'+(rows || '<tr><td colspan="10" style="padding:24px; text-align:center; color:var(--ink-faint);">'+emptyMsg+'</td></tr>')+'</tbody></table></div>'
      + '</div>';

    panel.querySelectorAll('tbody tr[data-id]').forEach(function(tr){
      var id = tr.getAttribute('data-id');
      tr.querySelectorAll('[data-field]').forEach(function(el){
        var field = el.getAttribute('data-field');
        var evName = (el.tagName==='SELECT' || el.type==='checkbox' || el.type==='date' || el.type==='number') ? 'change' : 'blur';
        el.addEventListener(evName, function(){
          var val = el.type==='checkbox' ? el.checked : (el.type==='number' ? Number(el.value)||0 : el.value);
          upsertLoteField(id, field, val);
        });
      });
      var delBtn = tr.querySelector('[data-action="delete"]');
      delBtn.addEventListener('click', function(){
        if(delBtn.getAttribute('data-armed')==='1'){ deleteLote(id); }
        else{
          delBtn.setAttribute('data-armed','1');
          delBtn.textContent='Confirmar?';
          setTimeout(function(){ delBtn.setAttribute('data-armed','0'); delBtn.textContent='Excluir'; }, 2600);
        }
      });
    });
    document.getElementById('btnAddLote').addEventListener('click', addLote);
    document.getElementById('fLoteRetiro').addEventListener('change', function(e){ state.lotesFiltroRetiro = e.target.value; renderActive(); });
  }

  /* ============================== rendering: retiros ============================== */
  /* Visão agrupada por retiro (piquete/área de manejo): quantos lotes e fêmeas estão
     alocados em cada um, e a lista desses lotes. Os retiros em si continuam fixos em
     RETIROS (ver constantes) — renomear/adicionar retiro aqui exigiria também ajustar
     as cores por retiro (CSS, PDF, WhatsApp), então essa tela só organiza o que já
     existe nos lotes; para mover um lote de retiro, o campo é editado na aba Lotes. */
  function renderRetiros(){
    var panel = document.getElementById('panel-retiros');
    var cardsHtml = RETIROS.map(function(r){
      var v = retiroVars(r);
      var lotesDoRetiro = state.lotes.filter(function(l){ return l.retiro===r; });
      var ativos = lotesDoRetiro.filter(function(l){ return l.ativo; });
      var femeasAtivas = ativos.reduce(function(s,l){ return s+(Number(l.qtd)||0); },0);
      var rows = lotesDoRetiro.slice().sort(function(a,b){
        if(!!a.ativo !== !!b.ativo) return a.ativo ? -1 : 1;
        return (Number(b.qtd)||0) - (Number(a.qtd)||0);
      }).map(function(l){
        return '<tr>'
          + '<td class="col-tight">'+(l.ativo ? '<span class="mono" style="color:var(--good);">●</span>' : '<span class="mono" style="color:var(--ink-faint);">○</span>')+'</td>'
          + '<td>'+esc(l.categoria)+'</td>'
          + '<td>'+esc(l.nome)+'</td>'
          + '<td class="col-tight">'+esc(l.periodo||'')+'</td>'
          + '<td class="col-tight">'+(l.qtd||0)+'</td>'
          + '<td>'+esc(l.situacao||'')+'</td>'
          + '<td>'+esc(l.responsavel||'')+'</td>'
          + '</tr>';
      }).join('');
      return '<div class="card panel-pad">'
        + '<div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">'
          + '<span class="pill" style="background:'+v.rbg+'; color:'+v.rink+'; font-size:.95rem; padding:6px 14px;"><span class="pill-dot" style="background:'+v.rc+';"></span>'+esc(r)+'</span>'
          + '<span class="mono" style="font-size:.82rem; color:var(--ink-soft);">'+ativos.length+' lote'+(ativos.length===1?'':'s')+' ativo'+(ativos.length===1?'':'s')+' · '+femeasAtivas+' fêmeas ativas</span>'
        + '</div>'
        + (lotesDoRetiro.length
            ? '<div class="table-scroll" style="margin-top:12px;"><table class="lotes-table"><thead><tr><th>Ativo</th><th>Categoria</th><th>Lote</th><th>Período</th><th>Qtd.</th><th>Situação</th><th>Responsável</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
            : '<p class="section-hint" style="margin-top:12px;">Nenhum lote cadastrado neste retiro ainda.</p>')
        + '</div>';
    }).join('');

    var totalAtivos = state.lotes.filter(function(l){ return l.ativo; });
    var totalFemeas = totalAtivos.reduce(function(s,l){ return s+(Number(l.qtd)||0); },0);

    panel.innerHTML =
      '<div class="stack-16">'
      + '<div class="card panel-pad">'
        + '<h2 class="section-title">Retiros e lotes</h2>'
        + '<p class="section-hint">Cada retiro (piquete/área de manejo) com os lotes hoje alocados nele. Para mover um lote de retiro, edite o campo "Retiro" na aba Lotes — esta tela só reorganiza essa informação por local.</p>'
        + '<div class="kpi-grid small" style="margin-top:12px;">'
          + kpiTile(RETIROS.length,'Retiros cadastrados')
          + kpiTile(totalAtivos.length,'Lotes ativos (todos os retiros)')
          + kpiTile(totalFemeas,'Fêmeas ativas (todos os retiros)')
        + '</div>'
      + '</div>'
      + cardsHtml
      + '</div>';
  }

  /* Célula editável do DG: só a quantidade de prenhas é lançada — as vazias (qtd - prenhas)
     seguem automaticamente para a próxima IATF (calculado em computeSchedule). */
  function dgResultCell(e){
    var val = e.qtdPrenhe==null ? '' : String(e.qtdPrenhe);
    var info;
    if(e.qtdPrenhe==null){
      info = '<span class="mono" style="color:var(--ink-faint); font-size:.72rem;">aguardando resultado</span>';
    } else if(e.qtdVazia===0){
      info = '<span class="mono" style="color:var(--good); font-size:.72rem;">todas prenhes</span>';
    } else {
      info = '<span class="mono" style="color:var(--ink-soft); font-size:.72rem;">'+e.qtdVazia+' vazia'+(e.qtdVazia===1?'':'s')+' → próxima IATF</span>';
    }
    /* Previsão de parto (D0 do ciclo + duração média da gestação, configurável em
       Parâmetros) só é informativa quando há pelo menos uma fêmea prenhe confirmada
       neste DG — antes disso, "quando" é apenas hipotético. */
    var partoInfo = (e.qtdPrenhe>0)
      ? '<span class="mono" style="color:var(--ink-faint); font-size:.72rem;">previsão de parto: '+fmtDateFull(e.parto)+'</span>'
      : '';
    return '<div style="display:flex; flex-direction:column; gap:3px; min-width:150px;">'
      + '<input class="input" type="number" min="0" max="'+e.qtd+'" step="1" data-field="qtdPrenhe" placeholder="Nº prenhas (de '+e.qtd+')" value="'+esc(val)+'">'
      + info
      + partoInfo
      + '</div>';
  }

  /* ============================== rendering: agenda ============================== */
  function renderAgenda(){
    var panel = document.getElementById('panel-agenda');
    var events = computeSchedule(state.lotes, state.params);
    var f = state.agendaFilters;
    var filtered = events.filter(function(e){
      if(f.retiro && e.retiro!==f.retiro) return false;
      if(f.acao && e.acao!==f.acao) return false;
      if(f.status && e.status!==f.status) return false;
      if(f.busca){
        var hay = (e.lote+' '+e.categoria+' '+e.retiro+' '+e.responsavel).toLowerCase();
        if(hay.indexOf(f.busca.toLowerCase())===-1) return false;
      }
      return true;
    });

    var acoesUnicas = ['D0','D7','D8','IATF','DG'];
    var cIdx = conflictIndex(detectConflicts(events));

    var rows = filtered.map(function(e){
      var v = retiroVars(e.retiro);
      var cf = cIdx[e.key];
      var mark = cf ? (cf.status==='pending'
          ? ' <span class="ev-flag pending" title="Conflito sem autorização: '+esc(conflictSummary(cf.conflito))+'">⚠</span>'
          : ' <span class="ev-flag ok" title="Coincidência autorizada por '+esc(cf.conflito.autorizacao.autorizadoPor)+'">✔</span>')
        : '';
      if(e.ajustada) mark += ' <span class="ev-flag adj" title="Data alterada manualmente">aj.</span>';
      return '<tr data-key="'+e.key+'">'
        + '<td class="mono col-tight">'+fmtDateShort(e.date)+mark+' <button class="date-adj-btn" type="button" data-adj-date="'+esc(e.key)+'" title="Alterar data">📅</button></td>'
        + '<td class="col-tight">'+esc(e.periodo)+'</td>'
        + '<td class="col-tight" title="'+esc(e.orientacao)+'"><b>'+esc(e.acao)+'</b> <span class="mono" style="color:var(--ink-faint);">(IATF '+e.cycle+')</span></td>'
        + '<td>'+esc(e.categoria)+'</td>'
        + '<td style="min-width:200px;">'+esc(e.lote)+'</td>'
        + '<td><span class="pill" style="background:'+v.rbg+'; color:'+v.rink+';"><span class="pill-dot" style="background:'+v.rc+';"></span>'+esc(e.retiro)+'</span></td>'
        + '<td class="col-tight">'+e.qtd+'</td>'
        + '<td><select class="select" data-field="status">'+STATUS_EVENTO.map(function(s){ return '<option '+(s===e.status?'selected':'')+'>'+s+'</option>'; }).join('')+'</select></td>'
        + '<td>'+(e.acao==='DG' ? dgResultCell(e) : '<span class="mono" style="color:var(--ink-faint);">—</span>')+'</td>'
        + '<td style="min-width:160px;"><input class="input" data-field="obs" placeholder="Observações" value="'+esc(e.obs)+'"></td>'
        + '</tr>';
    }).join('');

    panel.innerHTML =
      '<div class="card panel-pad">'
        + '<h2 class="section-title">Agenda completa de manejos</h2>'
        + '<p class="section-hint">Lista de todos os eventos calculados (D0, D8/D7, IATF, DG) para todos os ciclos elegíveis. Atualize status, resultado do DG e observações de execução.</p>'
        + '<div class="filters-row">'
          + '<input class="input" id="fBusca" placeholder="Buscar lote, categoria, responsável…" value="'+esc(f.busca)+'">'
          + '<select class="select" id="fRetiro"><option value="">Todos os retiros</option>'+RETIROS.map(function(r){ return '<option '+(r===f.retiro?'selected':'')+'>'+r+'</option>'; }).join('')+'</select>'
          + '<select class="select" id="fAcao"><option value="">Todas as ações</option>'+acoesUnicas.map(function(a){ return '<option '+(a===f.acao?'selected':'')+'>'+a+'</option>'; }).join('')+'</select>'
          + '<select class="select" id="fStatus"><option value="">Todos os status</option>'+STATUS_EVENTO.map(function(s){ return '<option '+(s===f.status?'selected':'')+'>'+s+'</option>'; }).join('')+'</select>'
          + '<span class="mono" style="font-size:.8rem; color:var(--ink-soft);">'+filtered.length+' de '+events.length+' eventos</span>'
        + '</div>'
        + '<div class="table-scroll"><table><thead><tr>'
          + '<th>Data</th><th>Período</th><th>Ação</th><th>Categoria</th><th>Lote</th><th>Retiro</th><th>Qtd.</th><th>Status</th><th>Prenhas / Vazias (DG)</th><th>Observações</th>'
          + '</tr></thead><tbody>'+(rows || '<tr><td colspan="10" style="padding:24px; text-align:center; color:var(--ink-faint);">Nenhum evento encontrado.</td></tr>')+'</tbody></table></div>'
      + '</div>';

    document.getElementById('fBusca').addEventListener('input', debounce(function(e){ f.busca=e.target.value; renderActive(); },350));
    document.getElementById('fRetiro').addEventListener('change', function(e){ f.retiro=e.target.value; renderActive(); });
    document.getElementById('fAcao').addEventListener('change', function(e){ f.acao=e.target.value; renderActive(); });
    document.getElementById('fStatus').addEventListener('change', function(e){ f.status=e.target.value; renderActive(); });

    panel.querySelectorAll('[data-adj-date]').forEach(function(b){
      b.addEventListener('click', function(){ openDateDialog(b.getAttribute('data-adj-date')); });
    });
    panel.querySelectorAll('tbody tr[data-key]').forEach(function(tr){
      var key = tr.getAttribute('data-key');
      tr.querySelectorAll('[data-field]').forEach(function(el){
        var field = el.getAttribute('data-field');
        var evName = el.tagName==='SELECT' ? 'change' : 'blur';
        el.addEventListener(evName, function(){ setOverride(key, field, el.value); });
      });
    });
  }

  /* ============================== rendering: parâmetros ============================== */
  /* "min" é um piso de sanidade clínica (evita, por ex., salvar 0 dia de gestação ou
     0 dia entre IATF e DG, o que corromperia todas as datas calculadas a partir daí) —
     não substitui o protocolo definido pelo médico-veterinário responsável. */
  var PARAM_FIELDS = [
    {key:'d0d8', label:'Intervalo D0 → D8', hint:'dias · demais categorias', min:5},
    {key:'d0d7Novilha', label:'Intervalo D0 → D7', hint:'dias · novilhas', min:5},
    {key:'d8iatf', label:'Intervalo D8 → IATF', hint:'dias · demais categorias', min:1},
    {key:'d7iatfNovilha', label:'Intervalo D7 → IATF', hint:'dias · novilhas', min:1},
    {key:'iatfdg', label:'Intervalo IATF → DG', hint:'dias · diagnóstico de gestação', min:20},
    {key:'dgd0', label:'Intervalo DG → novo D0', hint:'dias · ressincronização (0 = mesmo dia)', min:0},
    {key:'maxIatfNormal', label:'Máx. IATFs — Multíparas/Primíparas/Solteiras', hint:'1ª IATF + ressincronizações', min:1},
    {key:'maxIatfNovilha', label:'Máx. IATFs — Novilhas', hint:'1ª IATF + ressincronizações', min:1},
    {key:'gestacao', label:'Duração média da gestação', hint:'dias · previsão de parto — ajuste à genética do rebanho (zebuínos/Nelore tendem a ~290-294 dias; Bos taurus, ~279-285)', min:240}
  ];
  var PARAM_MIN = {};
  PARAM_FIELDS.forEach(function(pf){ PARAM_MIN[pf.key] = pf.min!=null ? pf.min : 0; });
  function renderParametros(){
    var panel = document.getElementById('panel-parametros');
    var fieldsHtml = PARAM_FIELDS.map(function(pf){
      return '<div class="field"><label>'+esc(pf.label)+' <span class="hint">· '+esc(pf.hint)+'</span></label>'
        + '<input class="input" type="number" min="'+PARAM_MIN[pf.key]+'" data-field="'+pf.key+'" value="'+state.params[pf.key]+'"></div>';
    }).join('');
    panel.innerHTML =
      '<div class="card panel-pad stack-16">'
        + '<div><h2 class="section-title">Parâmetros do programa</h2><p class="section-hint">Intervalos e limites de ressincronização — editáveis. Ajuste conforme o protocolo definido pelo médico-veterinário responsável.</p></div>'
        + '<div class="grid-3">'+fieldsHtml+'</div>'
        + '<div class="cal-footnote">O protocolo hormonal, a indicação de produtos, as doses e a aptidão reprodutiva dos animais devem ser definidos e acompanhados pelo médico-veterinário responsável. Estes campos controlam apenas o cronograma de datas.</div>'
      + '</div>';
    panel.querySelectorAll('[data-field]').forEach(function(el){
      el.addEventListener('change', function(){ setParamField(el.getAttribute('data-field'), el.value); });
    });
  }

  /* ============================== rendering: indicadores ============================== */
  function renderIndicadores(){
    var panel = document.getElementById('panel-indicadores');
    var events = computeSchedule(state.lotes, state.params);
    var ativos = state.lotes.filter(function(l){ return l.ativo; });
    var femeasAtivas = ativos.reduce(function(s,l){ return s+(Number(l.qtd)||0); },0);
    var ciclosElegiveis = ativos.reduce(function(s,l){ return s+maxIatfFor(l.categoria,state.params); },0);
    var d0 = events.filter(function(e){ return e.acao==='D0'; }).length;
    var inter = events.filter(function(e){ return e.acao==='D7'||e.acao==='D8'; }).length;
    var iatf = events.filter(function(e){ return e.acao==='IATF'; }).length;
    var dgEvents = events.filter(function(e){ return e.acao==='DG'; });
    var dgPrevistos = dgEvents.length;
    var dgRealizados = dgEvents.filter(function(e){ return e.resultadoDG!=='Pendente'; }).length;
    var prenhes = dgEvents.reduce(function(s,e){ return s+(e.qtdPrenhe||0); },0);
    var vazias = dgEvents.reduce(function(s,e){ return s+(e.qtdVazia||0); },0);
    var taxaGeral = (prenhes+vazias)>0 ? (100*prenhes/(prenhes+vazias)) : null;

    /* Taxa de prenhez na 1ª IATF e em ressincronizações são indicadores clinicamente
       distintos (benchmarks de mercado e causas de baixo desempenho são diferentes para
       cada um) — misturar os dois num "geral" único mascara se o problema está no
       protocolo inicial ou nas repetições. Separar por e.cycle já é suficiente, já que
       cycle===1 é sempre a 1ª IATF e cycle>1 é sempre ressincronização (ver orientacaoFor). */
    function taxaDe(bucket){ return (bucket.p+bucket.v)>0 ? (100*bucket.p/(bucket.p+bucket.v)) : null; }
    var porRodada = {primeira:{p:0,v:0}, resync:{p:0,v:0}};
    dgEvents.forEach(function(e){
      if(e.resultadoDG==='Pendente') return;
      var bucket = e.cycle===1 ? porRodada.primeira : porRodada.resync;
      bucket.p += (e.qtdPrenhe||0);
      bucket.v += (e.qtdVazia||0);
    });
    var taxa1aIatf = taxaDe(porRodada.primeira);
    var taxaResync = taxaDe(porRodada.resync);

    var porCategoria = {};
    dgEvents.forEach(function(e){
      if(e.resultadoDG==='Pendente') return;
      porCategoria[e.categoria] = porCategoria[e.categoria] || {p:0,v:0};
      porCategoria[e.categoria].p += (e.qtdPrenhe||0);
      porCategoria[e.categoria].v += (e.qtdVazia||0);
    });
    var rateRows = CATEGORIAS.map(function(c){
      var d = porCategoria[c];
      if(!d || (d.p+d.v)===0) return '<div class="rate-row"><span>'+c+'</span><span class="mono" style="color:var(--ink-faint);">sem DG lançado</span></div>';
      var pct = 100*d.p/(d.p+d.v);
      return '<div><div class="rate-row"><span>'+c+'</span><b>'+pct.toFixed(1)+'%</b></div><div class="rate-bar"><span style="width:'+pct.toFixed(1)+'%;"></span></div></div>';
    }).join('');

    var falhas = events.falhas || [];
    var falhasHtml = falhas.length
      ? '<div class="table-scroll"><table><thead><tr><th>Lote</th><th>Categoria</th><th>Retiro</th><th>Vazias ao final do protocolo</th><th>Data do último DG</th></tr></thead><tbody>'
        + falhas.map(function(f){
            return '<tr><td>'+esc(f.lote)+'</td><td>'+esc(f.categoria)+'</td><td>'+esc(f.retiro)+'</td><td class="col-tight">'+f.qtd+'</td><td class="col-tight">'+fmtDateFull(f.dataUltimoDG)+'</td></tr>';
          }).join('')
        + '</tbody></table></div>'
      : '<p class="section-hint">Nenhuma fêmea esgotou o nº máximo de IATFs programado ainda seguindo vazia.</p>';

    panel.innerHTML =
      '<div class="stack-16">'
      + '<div class="card panel-pad">'
        + '<h2 class="section-title">Plantel e cobertura do programa</h2>'
        + '<div class="kpi-grid small" style="margin-top:12px;">'
          + kpiTile(ativos.length,'Lotes ativos')
          + kpiTile(femeasAtivas,'Fêmeas ativas (matrizes/novilhas)')
          + kpiTile(ciclosElegiveis,'Ciclos elegíveis no cronograma')
        + '</div>'
      + '</div>'
      + '<div class="card panel-pad">'
        + '<h2 class="section-title">Execução de manejos (todo o cronograma)</h2>'
        + '<div class="kpi-grid" style="margin-top:12px;">'
          + kpiTile(d0,'D0 previstos')
          + kpiTile(inter,'D7/D8 previstos')
          + kpiTile(iatf,'IATFs previstas')
          + kpiTile(dgPrevistos,'DGs previstos')
        + '</div>'
        + '<p class="section-hint" style="margin-top:10px;">DGs com resultado lançado: <b class="mono" style="color:var(--ink);">'+dgRealizados+'</b> de '+dgPrevistos+'</p>'
      + '</div>'
      + '<div class="card panel-pad">'
        + '<h2 class="section-title">Resultado reprodutivo (diagnóstico de gestação)</h2>'
        + '<div class="kpi-grid small" style="margin-top:12px;">'
          + kpiTile(prenhes,'Fêmeas prenhes (DG)')
          + kpiTile(vazias,'Fêmeas vazias (DG)')
          + kpiTile(taxaGeral!==null ? taxaGeral.toFixed(1)+'%' : '—','Taxa de prenhez geral')
        + '</div>'
        + '<div class="kpi-grid small" style="margin-top:10px;">'
          + kpiTile(taxa1aIatf!==null ? taxa1aIatf.toFixed(1)+'%' : '—','Taxa de prenhez — 1ª IATF')
          + kpiTile(taxaResync!==null ? taxaResync.toFixed(1)+'%' : '—','Taxa de prenhez — ressincronizações')
        + '</div>'
        + '<div style="margin-top:16px; display:flex; flex-direction:column; gap:10px;">'+rateRows+'</div>'
        + '<div class="cal-footnote" style="margin-top:16px;">A taxa de prenhez à IATF costuma variar entre 35% e 55% conforme categoria, escore de condição corporal, protocolo hormonal e estação; ressincronizações costumam render menos que a 1ª IATF. Lance o resultado do DG na aba Agenda para atualizar estes indicadores automaticamente.</div>'
      + '</div>'
      + '<div class="card panel-pad">'
        + '<h2 class="section-title">Falha reprodutiva — decisão pendente</h2>'
        + '<p class="section-hint">Fêmeas que esgotaram o nº máximo de IATFs programado (1ª IATF + ressincronizações) e seguem vazias no último DG lançado. Avalie repasse com touro, exame andrológico/ginecológico ou descarte junto ao médico-veterinário responsável — elas não entram em nenhum novo ciclo automaticamente.</p>'
        + '<div style="margin-top:12px;">'+falhasHtml+'</div>'
      + '</div>'
      + '</div>';
  }
  function kpiTile(num,label){
    return '<div class="card kpi-tile"><div class="num mono">'+num+'</div><div class="label">'+esc(label)+'</div></div>';
  }

  /* ============================== login / conta ============================== */
  function setLoginMsg(text, kind){
    var el = document.getElementById('loginMsg');
    if(el){ el.textContent = text||''; el.className = 'cf-error'+(kind==='ok' ? ' ok' : ''); }
  }
  function bindAuthUi(){
    var form = document.getElementById('loginForm');
    form.addEventListener('submit', function(ev){
      ev.preventDefault();
      var email = document.getElementById('loginEmail').value.trim();
      var senha = document.getElementById('loginSenha').value;
      if(!email || !senha){ setLoginMsg('Informe e-mail e senha.'); return; }
      var btn = document.getElementById('loginBtn');
      btn.disabled = true; setLoginMsg('Entrando…', 'ok');
      store.signIn(email, senha).then(function(){
        setLoginMsg('');
        document.getElementById('loginSenha').value = '';
      }, function(err){
        var m = (err && err.message) || '';
        setLoginMsg(/invalid/i.test(m) ? 'E-mail ou senha incorretos.' : (navigator.onLine===false ? 'Sem internet. Conecte-se para entrar.' : 'Não foi possível entrar: '+m));
      }).then(function(){ btn.disabled = false; });
    });
    document.getElementById('loginEsqueci').addEventListener('click', function(ev){
      ev.preventDefault();
      var email = document.getElementById('loginEmail').value.trim();
      if(!email){ setLoginMsg('Digite seu e-mail acima e clique de novo em “Esqueci a senha”.'); return; }
      store.resetPassword(email).then(function(){
        setLoginMsg('Enviamos um link para '+email+'. Abra-o neste aparelho para criar uma nova senha.', 'ok');
      }, function(err){ setLoginMsg('Não foi possível enviar: '+((err && err.message)||'')); });
    });
    document.getElementById('btnSair').addEventListener('click', function(){
      var st = store.getStatus();
      var aviso = st.pendentes
        ? 'Há '+st.pendentes+' alteração(ões) ainda não enviadas à nuvem. Elas ficarão guardadas neste aparelho até você entrar de novo.\n\nSair mesmo assim?'
        : 'Sair da conta neste aparelho?';
      if(!confirm(aviso)) return;
      store.signOut();
    });
  }
  function openNewPasswordDialog(){
    var html = '<h2>Criar nova senha</h2>'
      + '<p class="section-hint">Digite a nova senha da sua conta (mínimo 8 caracteres).</p>'
      + '<div class="field"><label for="npSenha">Nova senha</label><input class="input" type="password" id="npSenha" autocomplete="new-password"></div>'
      + '<div class="field"><label for="npSenha2">Repita a senha</label><input class="input" type="password" id="npSenha2" autocomplete="new-password"></div>'
      + '<div class="cf-error" id="npErro"></div>'
      + '<div class="cf-buttons"><button class="icon-btn btn-primary" type="button" id="npOk">Salvar senha</button></div>';
    showCfDialog(html, {tipo:'senha'});
    cfDialog().oncancel = function(ev){ ev.preventDefault(); };
    document.getElementById('npOk').addEventListener('click', function(){
      var a = document.getElementById('npSenha').value, b = document.getElementById('npSenha2').value;
      var err = document.getElementById('npErro');
      if(a.length<8){ err.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
      if(a!==b){ err.textContent = 'As senhas não conferem.'; return; }
      store.updatePassword(a).then(function(){ closeCfDialog(); setSaveStatus('Senha alterada.', 'ok'); }, function(e){ err.textContent = 'Erro: '+((e && e.message)||''); });
    });
  }

  /* ============================== render dispatch ============================== */
  /* Evita redesenho aninhado: ao trocar o HTML de uma aba, o campo em foco é removido e
     dispara "blur", cujo handler pediria outro redesenho no meio do primeiro. */
  var rendering = false, rerenderPending = false;
  function renderActive(){
    if(rendering){ rerenderPending = true; return; }
    rendering = true;
    try{ renderActiveNow(); } finally { rendering = false; }
    if(rerenderPending){ rerenderPending = false; setTimeout(renderActive, 0); }
  }
  function renderActiveNow(){
    try{ updateConflictBadge(currentConflicts()); }catch(e){}
    switch(state.activeTab){
      case 'calendario': renderCalendario(); break;
      case 'lotes': renderLotes(); break;
      case 'retiros': renderRetiros(); break;
      case 'agenda': renderAgenda(); break;
      case 'parametros': renderParametros(); break;
      case 'indicadores': renderIndicadores(); break;
    }
  }
  function switchTab(tab){
    state.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-tab')===tab); });
    document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.toggle('active', p.id==='panel-'+tab); });
    renderActive();
  }

  /* ============================== boot ============================== */
  document.addEventListener('DOMContentLoaded', function(){
    document.getElementById('tabNav').addEventListener('click', function(e){
      var btn = e.target.closest('.tab-btn');
      if(btn) switchTab(btn.getAttribute('data-tab'));
    });
    var helpDialog = document.getElementById('helpDialog');
    document.getElementById('btnHelp').addEventListener('click', function(){
      var legend = document.getElementById('helpLegend');
      legend.innerHTML = RETIROS.map(function(r){
        var v = retiroVars(r);
        return '<span class="legend-chip" style="background:'+v.rbg+'; color:'+v.rink+';"><span class="legend-dot" style="background:'+v.rc+';"></span>'+esc(r)+'</span>';
      }).join('');
      helpDialog.showModal();
    });
    document.getElementById('btnCloseHelp').addEventListener('click', function(){ helpDialog.close(); });
    helpDialog.addEventListener('click', function(e){ if(e.target===helpDialog) helpDialog.close(); });
    document.getElementById('btnSalvarGlobal').addEventListener('click', saveAlteracoes);
    document.getElementById('btnConflitos').addEventListener('click', goToFirstPendingConflict);
    document.getElementById('backupFileInput').addEventListener('change', function(e){ importBackupFile(e.target.files && e.target.files[0]); });
    bindAuthUi();
    document.addEventListener('keydown', function(e){
      var isSaveShortcut = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key==='s' || e.key==='S');
      if(isSaveShortcut){ e.preventDefault(); saveAlteracoes(); }
    });

    renderActive();
    initData();
  });
})();
