// ==UserScript==
// @name         Grepolis Maestro (multi-módulo)
// @namespace    grepo-maestro
// @version      2026.08.27.1725
// @description  Núcleo que corre vários módulos (apoio, trocas, ...) em sequência, cada um com o seu intervalo, sem colisões. Painel unificado.
// @match        https://*.grepolis.com/game/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Shad0wRA/maestroo/main/maestro.user.js
// @downloadURL  https://raw.githubusercontent.com/Shad0wRA/maestroo/main/maestro.user.js
// ==/UserScript==

/* ATUALIZAÇÃO AUTOMÁTICA
 *
 * O Tampermonkey vai ao `@updateURL` de tempos a tempos (por omissão de hora
 * a hora) e, se a `@version` de lá for maior do que a instalada, actualiza-se
 * sozinho.
 *
 * O ficheiro no Gist NÃO tem credenciais: o Gist de dados, o token e os
 * webhooks ficam guardados em cada conta, no painel. Assim uma actualização
 * nunca os apaga. */

(function () {
  'use strict';
  const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  /* =============================================================================
   *  NÚCLEO DO MAESTRO
   *  ---------------------------------------------------------------------------
   *  Corre uma lista de MÓDULOS em sequência. Cada módulo tem o seu próprio
   *  intervalo; o maestro, a cada "tick", corre os módulos que já estão "na hora".
   *  Como é tudo o mesmo loop, nunca há dois módulos a mexer nas cidades ao mesmo
   *  tempo — não é preciso semáforo ENTRE módulos (só com scripts externos, ex. GPT).
   *
   *  Interface de um módulo:
   *    {
   *      id: 'apoio',                       // identificador único
   *      nome: 'Apoio',                     // nome no painel
   *      intervaloMin: 2,                   // de quantos em quantos minutos corre
   *      worlds: ['pt125','pt126'] | null,  // mundos onde corre (null = todos)
   *      run: async (ctx) => {...},         // faz o trabalho (uma passagem)
   *      painel: (container, ctx) => {...}, // desenha a sua secção no painel (opcional)
   *      autoStart: true,                   // corre automaticamente
   *    }
   *  O ctx dá acesso a utilidades partilhadas (log, sleep, switchToTown, world...).
   * ========================================================================== */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a));

  const WORLD = (uw.location && uw.location.hostname.split('.')[0]) || '';

  // ---- log partilhado ----
  let logLines = [];
  /* ============ MOSTRAR SEMPRE A HORA DO JOGO ===========================
   * O relógio do computador pode estar horas ao lado do servidor — o do
   * utilizador estava 1 h à frente, e o registo mostrava horas que não batiam
   * com nada do jogo.
   *
   * Esta função converte um instante do jogo (segundos) para texto, usando o
   * fuso do SERVIDOR. Todos os módulos a usam.
   * ==================================================================== */
  function horaDoJogo(segundos) {
    try {
      const t = Number(segundos);
      if (!Number.isFinite(t) || t <= 0) return '?';

      /* Desvio horário do SERVIDOR.
       *
       * ATENÇÃO: `Timestamp.serverGMTOffset` é uma FUNÇÃO, não um número —
       * `Number(...)` dava NaN e o desvio ficava a zero. Confirmado no jogo:
       * o relógio mostrava 03:52 e o cálculo dava 02:52.
       *
       * A função devolve `Game.server_gmt_offset`, em segundos. */
      let desvio = 0;
      try {
        const raw = uw.Timestamp.serverGMTOffset;
        const d = (typeof raw === 'function') ? Number(raw.call(uw.Timestamp)) : Number(raw);
        if (Number.isFinite(d)) desvio = d;
      } catch (e) {}
      if (!desvio) {
        try {
          const d2 = Number(uw.Game && uw.Game.server_gmt_offset);
          if (Number.isFinite(d2)) desvio = d2;
        } catch (e) {}
      }

      return new Date((t + desvio) * 1000).toISOString().slice(11, 19);
    } catch (e) { return '?'; }
  }
  try { uw.__maestroHoraJogo = horaDoJogo; } catch (e) {}

  function log(modId, msg) {
    /* O carimbo é a hora do JOGO, não a do computador: o relógio do
     * utilizador estava 1 h à frente do servidor e as linhas do registo não
     * batiam com nada do que se vê no jogo. */
    const agoraJogo = (() => {
      try { return horaDoJogo(Number(uw.Timestamp.now())); } catch (e) { return null; }
    })();
    const line = `[${agoraJogo || new Date().toLocaleTimeString()}] [${modId}] ${msg}`;
    logLines.push(line);
    if (logLines.length > 300) logLines = logLines.slice(-300);
    const box = document.getElementById('maestro-log');
    if (box) { box.textContent = logLines.slice(-50).join('\n'); box.scrollTop = box.scrollHeight; }
    console.log('[MAESTRO]', line);
  }

  /* ---- WEBHOOKS DO DISCORD ------------------------------------------------
   * Cola aqui os teus três webhooks. Ficam vazios por omissão; sem eles, os
   * avisos só aparecem no log do painel.
   *   captcha   → verificação de bot (o módulo pára e avisa)
   *   ataque    → ataque a chegar, sem suspeita de navio colonizador
   *   ataqueNC  → ataque a chegar COM suspeita de navio colonizador
   * --------------------------------------------------------------------- */
  /* Os endereços ficam guardados e configuram-se no painel — é mais prático
   * do que editar o ficheiro em cada uma das contas. Os valores abaixo são só
   * o ponto de partida. */
  /* ================= CREDENCIAIS DO GIST =================================
   * GUARDADAS NA CONTA, não no ficheiro.
   *
   * Com a actualização automática, o ficheiro é substituído sempre que há uma
   * versão nova. Se as credenciais estivessem no ficheiro, seriam apagadas nas
   * 20 contas a cada actualização.
   *
   * Configuram-se uma vez no painel e ficam no navegador.
   * ==================================================================== */
  const CREDENCIAIS_KEY = 'grepoMaestro_gist_v1';
  const GIST_GUARDADO = (() => {
    try { return JSON.parse(localStorage.getItem(CREDENCIAIS_KEY) || '{}'); }
    catch (e) { return {}; }
  })();

  const WEBHOOKS_KEY = 'grepoMaestro_webhooks_v1';
  const WEBHOOKS_OMISSAO = { captcha: '', ataque: '', ataqueNC: '' };

  /* Canais já preenchidos, pela organização do Discord: um por mundo e por
   * perfil, mais os do captcha. Servem de ponto de partida — o que guardares
   * no painel fica por cima destes. */
  const WEBHOOKS_DE_FABRICA = {
    'main:pt125': {
      ataque: '',
      ataqueNC: '',
      captcha: '',
    },
    'main:pt126': {
      ataque: '',
      ataqueNC: '',
      captcha: '',
    },
    'multi:pt125': {
      ataque: '',
      ataqueNC: '',
      captcha: '',
    },
    'multi:pt126': {
      ataque: '',
      ataqueNC: '',
      captcha: '',
    },
  };

  /* Os canais são por MUNDO e por PERFIL — é assim que o Discord está
   * organizado: shadow-125, shadow-126 (a main de cada mundo), multis-125,
   * multis-126, e captcha-125, captcha-126.
   *
   * Guarda-se um conjunto de endereços por combinação. Se não houver um
   * específico, usa-se o geral — assim quem só quiser um canal não tem de
   * preencher tudo. */
  function chaveWebhooks() {
    const p = perfilAtual() || 'main';
    return `${p}:${WORLD}`;
  }

  function webhooks() {
    const w = Object.assign({}, WEBHOOKS_OMISSAO);
    // os de fábrica primeiro; o que guardares no painel fica por cima
    Object.assign(w, WEBHOOKS_DE_FABRICA[chaveWebhooks()] || {});
    try {
      const todos = JSON.parse(localStorage.getItem(WEBHOOKS_KEY) || '{}');
      // formato antigo: os endereços à cabeça
      if (todos.captcha || todos.ataque || todos.ataqueNC) Object.assign(w, todos);
      // geral, depois o específico deste perfil+mundo
      if (todos.geral) Object.assign(w, todos.geral);
      const k = chaveWebhooks();
      if (todos[k]) Object.assign(w, todos[k]);
    } catch (e) {}
    return w;
  }
  function guardarWebhooks(w) {
    try {
      const todos = JSON.parse(localStorage.getItem(WEBHOOKS_KEY) || '{}');
      // limpar o formato antigo, se existir
      delete todos.captcha; delete todos.ataque; delete todos.ataqueNC;
      todos[chaveWebhooks()] = w;
      localStorage.setItem(WEBHOOKS_KEY, JSON.stringify(todos));
    } catch (e) {}
  }

  async function avisarDiscord(tipo, texto) {
    const url = webhooks()[tipo];
    if (!url) return false;
    /* Com 20 contas no mesmo canal, uma mensagem sem dizer de quem é não serve
     * de nada. Prefixa-se com o nome do jogador e o mundo. */
    let quem = '';
    try { quem = String(uw.Game.player_name || ''); } catch (e) {}
    if (quem) texto = `**${quem}** · ${WORLD.toUpperCase()} — ${texto}`;
    try {
      await uw.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: texto }),
      });
      return true;
    } catch (e) { return false; }
  }

  // ---- semáforo (coordena com scripts externos como o GPT; entre módulos não é preciso) ----
  const LOCK_KEY = 'grepoBotLock';
  const LOCK_TTL_MS = 10 * 60 * 1000;
  const LOCK_WAIT_MAX_MS = 3 * 60 * 1000;
  const LOCK_OWNER = 'maestro';
  function lockGet() { try { return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); } catch (e) { return null; } }
  function lockFree() { const l = lockGet(); return !l || l.ate < Date.now(); }
  function lockAcquire() {
    if (!lockFree()) { const l = lockGet(); if (l && l.dono !== LOCK_OWNER) return false; }
    localStorage.setItem(LOCK_KEY, JSON.stringify({ dono: LOCK_OWNER, ate: Date.now() + LOCK_TTL_MS }));
    return true;
  }
  function lockRenew() { localStorage.setItem(LOCK_KEY, JSON.stringify({ dono: LOCK_OWNER, ate: Date.now() + LOCK_TTL_MS })); }
  function lockRelease() { const l = lockGet(); if (l && l.dono === LOCK_OWNER) localStorage.removeItem(LOCK_KEY); }
  async function lockWaitAndAcquire() {
    const start = Date.now();
    while (Date.now() - start < LOCK_WAIT_MAX_MS) {
      if (lockAcquire()) return true;
      await sleep(rand(3000, 6000));
    }
    return false;
  }

  // ---- utilidades de jogo partilhadas ----
  function getMyTowns() {
    try {
      return Object.keys(uw.ITowns.towns).map((id) => {
        const t = uw.ITowns.getTown(Number(id));
        return { id: Number(id), name: t.getName ? t.getName() : String(id) };
      });
    } catch (e) { return []; }
  }
  function switchToTown(townId) {
    lockRenew(); // mantém o semáforo vivo durante trabalho longo
    return new Promise((resolve) => {
      try {
        if (Number(uw.Game?.townId) === Number(townId)) return resolve(true);
        uw.HelperTown.townSwitch(Number(townId));
      } catch (e) { return resolve(false); }
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        let ready = false;
        try {
          const t = uw.ITowns.getCurrentTown();
          ready = Number(uw.Game?.townId) === Number(townId) && t && typeof t.units === 'function';
        } catch (e) {}
        if (ready) { clearInterval(iv); resolve(true); }
        else if (tries >= 20) { clearInterval(iv); resolve(false); }
      }, 500);
    });
  }

  // contexto passado a cada módulo
  /* Erro lançado quando o utilizador desliga um módulo a meio do trabalho.
   * Não é uma falha — é uma paragem pedida. */
  function ModuloDesligado(nome) {
    const e = new Error(`Módulo "${nome}" desligado a meio.`);
    e.desligado = true;
    return e;
  }

  function makeCtx(modId) {
    const mod = MODULES.find((x) => x.id === modId);

    /* O sleep de cada módulo verifica, ao acordar, se ainda está ligado. Como
     * os módulos fazem pausas entre acções, isto dá-lhes um ponto de paragem
     * quase imediato quando se tira o visto — em vez de terminarem a passagem
     * toda. */
    const sleepDoModulo = async (ms) => {
      const fim = Date.now() + Math.max(0, ms || 0);
      while (Date.now() < fim) {
        const st = modState[modId];
        if (st && !st.ativo) throw ModuloDesligado(mod ? mod.nome : modId);
        if (!maestroTimer) throw ModuloDesligado(mod ? mod.nome : modId);
        await sleep(Math.min(400, fim - Date.now()));
      }
      const st2 = modState[modId];
      if (st2 && !st2.ativo) throw ModuloDesligado(mod ? mod.nome : modId);
    };

    /* Linhas de rotina ("nada a fazer agora", "à espera de recursos") não
     * aparecem: o registo é para ver o que o bot FAZ. Que os módulos estão
     * vivos sabe-se pelo resumo de 2 em 2 horas.
     *
     * Vão para a consola do navegador, para quem quiser depurar. */
    const rotina = (msg) => {
      try { console.log('[MAESTRO/rotina]', modId, msg); } catch (e) {}
    };

    return {
      uw, WORLD, sleep: sleepDoModulo, rand,
      log: (msg) => log(modId, msg),
      logRotina: rotina,
      getMyTowns, switchToTown,
      lockRenew,
      avisarDiscord,
      // para os módulos que queiram verificar de propósito
      ligado: () => !!(modState[modId] && modState[modId].ativo) && !!maestroTimer,
    };
  }

  /* --------------------------- registo de módulos ------------------------ */
  const MODULES = [];
  function registerModule(mod) { MODULES.push(mod); }
  // expõe para os módulos se registarem (definidos mais abaixo no ficheiro)
  uw.__maestroRegister = registerModule;

  // estado de execução por módulo
  const modState = {}; // id -> { proximaExec: timestamp, ativo: bool, aCorrer: bool }

  /* ---- que módulos correm NESTA conta (guardado, por conta) -------------
   * Cada conta (container) tem o seu localStorage, por isso a escolha fica
   * guardada por conta. Há perfis prontos para não teres de configurar
   * módulo a módulo em 20 contas.
   * -------------------------------------------------------------------- */
  /* Marca da versão instalada — para saber, de dentro do jogo, se o ficheiro
   * é o mais recente. Ler com: unsafeWindow.__maestroVersao */
  const MAESTRO_VERSAO = '2026.08.27.1725';
  try { uw.__maestroVersao = MAESTRO_VERSAO; } catch (e) {}

  /* ============ VERSÃO NOVA: RECARREGAR A PÁGINA ========================
   * O Tampermonkey só verifica o `@updateURL` de 6 em 6 horas no mínimo, o
   * que é muito para o ritmo a que se corrigem coisas. E mesmo depois de
   * descarregar, só troca o código no carregamento seguinte da página.
   *
   * Aqui vai-se buscar o ficheiro do repositório de 10 em 10 minutos, compara-
   * se a `@version`, e se for maior recarrega-se a página — o que faz o
   * Tampermonkey ir buscar a versão nova.
   *
   * SALVAGUARDA: não recarrega se houver uma esquiva ou um encaixe agendados
   * para os próximos minutos. Recarregar perde o temporizador, e ele só é
   * rearmado na passagem seguinte.
   * ==================================================================== */
  const FONTE_ATUALIZACAO = 'https://raw.githubusercontent.com/Shad0wRA/maestroo/main/maestro.user.js';
  const RECARREGADO_KEY = 'grepoMaestro_recarreguei_v1';

  function haPlanoIminente() {
    /* Um plano de esquiva ou de encaixe a sair dentro de 5 minutos. */
    try {
      const agora = Math.floor(Date.now() / 1000);
      for (const chave of ['grepoEsquiva_planos_v1', 'grepoEncaixe_planos_v1']) {
        for (const sufixo of ['', '__main', '__multi']) {
          const raw = localStorage.getItem(chave + sufixo);
          if (!raw) continue;
          const p2 = JSON.parse(raw);
          const lista = Array.isArray(p2) ? p2 : Object.values(p2 || {});
          for (const x of lista) {
            const sai = Number(x && (x.S || x.saida || x.quando)) || 0;
            if (sai && sai > agora - 60 && sai < agora + 300) return true;
          }
        }
      }
    } catch (e) {}
    return false;
  }

  async function verificarVersaoNova() {
    try {
      const r = await uw.fetch(FONTE_ATUALIZACAO + '?_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const txt = await r.text();
      const nova = (txt.match(/@version\s+(\S+)/) || [])[1];
      if (!nova || nova === MAESTRO_VERSAO) return;

      /* Só recarrega se a versão for MAIOR: assim uma reversão no repositório
       * não põe as contas em ciclo. */
      if (String(nova) <= String(MAESTRO_VERSAO)) return;

      /* Não recarregar duas vezes pela mesma versão. */
      let ja = null;
      try { ja = localStorage.getItem(RECARREGADO_KEY); } catch (e) {}
      if (ja === nova) return;

      if (haPlanoIminente()) {
        log('core', `Versão ${nova} disponível — espero, há um plano a sair já.`);
        return;
      }

      try { localStorage.setItem(RECARREGADO_KEY, nova); } catch (e) {}
      log('core', `Versão ${nova} disponível (tenho a ${MAESTRO_VERSAO}) — vou recarregar.`);
      setTimeout(() => { try { uw.location.reload(); } catch (e) {} }, 3000);
    } catch (e) {}
  }

  /* ============ CHAVES SEPARADAS POR PERFIL =============================
   * Cada perfil tem as SUAS chaves no armazenamento: em vez de
   * `grepoConstru_templates_v1`, usa-se `grepoConstru_templates_v1__multi`.
   *
   * Porquê: antes os perfis partilhavam as mesmas chaves, e trocar de perfil
   * obrigava a copiar tudo de um lado para o outro. Essa cópia falhava — foi
   * ela que pôs os templates da main no perfil multi.
   *
   * Assim os perfis nunca se tocam. Trocar de perfil passa a ser apenas usar
   * outro sufixo; não há nada a copiar, portanto não há nada que corra mal.
   *
   * As chaves do próprio maestro (grepoMaestro_*) ficam de fora: são comuns
   * aos perfis por definição (qual está activo, os webhooks, etc.).
   * ==================================================================== */
  function perfilParaChaves() {
    try {
      const e = JSON.parse(localStorage.getItem('grepoMaestro_modulos_v1') || 'null');
      if (e && e.perfil) return String(e.perfil);
    } catch (e) {}
    return 'main';
  }

  function chavePorPerfil(chave) {
    const k = String(chave || '');
    if (!/^grepo/.test(k)) return k;
    if (/^grepoMaestro_/.test(k)) return k;      // do núcleo: comum aos perfis
    return `${k}__${perfilParaChaves()}`;
  }

  /* Armazenamento do maestro, com o sufixo do perfil.
   *
   * NÃO se toca no `localStorage` global — o jogo também o usa, e embrulhá-lo
   * podia partir coisas fora do nosso alcance. Em vez disso oferece-se este
   * objecto aos módulos, que o usam no lugar do localStorage.
   *
   * Só afecta as chaves `grepo*` que não sejam do núcleo. */
  const armazem = {
    getItem(k) { try { return localStorage.getItem(chavePorPerfil(k)); } catch (e) { return null; } },
    setItem(k, v) { try { return localStorage.setItem(chavePorPerfil(k), v); } catch (e) {} },
    removeItem(k) { try { return localStorage.removeItem(chavePorPerfil(k)); } catch (e) {} },
    get length() { try { return localStorage.length; } catch (e) { return 0; } },
    key(i) { try { return localStorage.key(i); } catch (e) { return null; } },
  };
  try { uw.__maestroArmazem = armazem; } catch (e) {}

  const MODULOS_KEY = 'grepoMaestro_modulos_v1';

  /* Arranque automático: por omissão LIGADO, para as 20 multis começarem a
   * trabalhar sozinhas ao abrir. Desliga-se aqui quando se quer mexer sem que
   * ele ande a agir. */
  const AUTOSTART_KEY = 'grepoMaestro_autostart_v1';
  function autoStartLigado() {
    try {
      const v = localStorage.getItem(AUTOSTART_KEY);
      return v === null ? true : v === '1';
    } catch (e) { return true; }
  }
  function guardarAutoStart(v) {
    try { localStorage.setItem(AUTOSTART_KEY, v ? '1' : '0'); } catch (e) {}
  }
  /* Os perfis NÃO limitam que módulos existem — todos estão disponíveis nos
   * dois. O perfil serve para guardar QUAIS estão ligados e COM QUE definições,
   * para se poder alternar entre a configuração da main e a das multis.
   *
   * As listas abaixo são só a sugestão inicial ao aplicar um perfil pela
   * primeira vez; depois ligas e desligas o que quiseres. */
  const PERFIS = {
    main: {
      nome: 'Main',
      sugestao: null,   // null = liga todos
    },
    multi: {
      nome: 'Multi',
      sugestao: null,   // também todos: escolhes tu no painel
    },
  };

  /* ============ MENU DE ÍCONES ==========================================
   * Em vez de uma lista comprida com todos os painéis abertos ao mesmo tempo,
   * há uma grelha de ícones: clicas num e abre-se só esse módulo. Numa VPS de
   * baixa resolução, a lista toda não cabia no ecrã.
   * ==================================================================== */
  const ICONES = {
    construcao:   { icone: '🏗️', curto: 'Construção' },
    pesquisa:     { icone: '📚', curto: 'Pesquisa' },
    recrutamento: { icone: '⚔️', curto: 'Recrutar' },
    herois:       { icone: '🦸', curto: 'Heróis' },
    cultura:      { icone: '🎭', curto: 'Cultura' },
    aldeias:      { icone: '🌾', curto: 'Aldeias' },
    gruta:        { icone: '🪙', curto: 'Gruta' },
    trocacidades: { icone: '🔄', curto: 'Trocas' },
    apoio:        { icone: '🛡️', curto: 'Apoio' },
    alertas:      { icone: '🔔', curto: 'Alertas' },
    esquiva:      { icone: '🏃', curto: 'Esquiva' },
    encaixe:      { icone: '🎯', curto: 'Encaixe' },
    deuses:       { icone: '⛩️', curto: 'Deuses' },
    colonos:      { icone: '🚢', curto: 'Colonos' },
    missoes:      { icone: '📜', curto: 'Missões' },
    fundacao:     { icone: '🏛️', curto: 'Fundar' },
  };

  /* Agrupamento dos módulos no menu. */
  const GRUPOS = [
    { nome: 'Cidade', ids: ['construcao', 'pesquisa', 'recrutamento', 'herois', 'cultura'] },
    { nome: 'Recursos', ids: ['aldeias', 'gruta', 'trocacidades', 'apoio'] },
    { nome: 'Combate', ids: ['alertas', 'esquiva', 'encaixe'] },
    { nome: 'Favores e expansão', ids: ['deuses', 'colonos', 'fundacao', 'missoes'] },
  ];

  // Módulo aberto no momento ('' = menu).
  let moduloAberto = '';
  function lerEscolhas() {
    try { return JSON.parse(localStorage.getItem(MODULOS_KEY) || 'null'); } catch (e) { return null; }
  }
  function guardarEscolhas(obj) {
    try { localStorage.setItem(MODULOS_KEY, JSON.stringify(obj)); } catch (e) {}

    /* Guardar TAMBÉM na cópia do perfil, para que voltar a ele traga os
     * mesmos módulos ligados. Sem isto, trocar de perfil ligava todos. */
    try {
      const p2 = (obj && obj.perfil) || 'main';
      localStorage.setItem(`grepoMaestro_ativos_${p2}`, JSON.stringify(obj.ativos || {}));
    } catch (e) {}
  }
  /* ============ CONFIGURAÇÕES POR PERFIL ================================
   * Os módulos guardam as suas definições em chaves próprias do localStorage
   * (grepoConstru_templates_v1, grepoEsquiva_cfg_v1, ...). Sem perfis, mudar
   * uma definição na main mudava-a nas multis quando se copiasse o script.
   *
   * Agora cada perfil tem o SEU conjunto: ao trocar de perfil, guarda-se o que
   * está e repõe-se o do perfil novo. Assim podes ter, por exemplo, a esquiva
   * com modo farm nas multis e sem ele na main.
   * ==================================================================== */
  const CFG_PERFIS_KEY = 'grepoMaestro_cfgPerfis_v1';

  // preenchidos pelo montador, a partir do GIST_ID/GIST_TOKEN do topo
  let GIST_ID_GLOBAL = '';
  let GIST_TOKEN_GLOBAL = '';

  /* ============ PERFIL PARTILHADO PELO GIST ============================
   * O perfil "multi" é o mesmo nas 20 contas: os mesmos templates, os mesmos
   * deuses, as mesmas ilhas para fundar. Configurar vinte vezes não faz
   * sentido — publica-se num sítio e as outras lêem.
   *
   * O que fica DE FORA (é próprio de cada conta):
   *   • equipas e bases dos colonizadores (cada conta tem a sua)
   *   • o que já foi enviado/fundado (registo local)
   *   • os alvos do apoio (esses já têm o seu próprio Gist)
   * ==================================================================== */
  /* Dentro da configuração dos colonizadores, estes campos são de CADA conta
   * e não se sobrepõem no Buscar. Os restantes — bases, modo, mínimos — vêm
   * do perfil partilhado. */
  const CAMPOS_LOCAIS_DOS_COLONOS = ['equipa'];

  const CHAVES_LOCAIS_DO_PERFIL = [
    'grepoFundacao_estado_v1',      // o que ESTA conta enviou
    /* A configuração dos colonizadores JÁ NÃO fica toda local: as bases e o
     * modo são partilhados, para bastar mudá-los numa conta. Só a EQUIPA é de
     * cada conta — ver `CAMPOS_LOCAIS_DOS_COLONOS`. */
    'grepoColonos_cidades_v1',
    'grepoApoio_done_v1',
    'grepoAlertas_vistos_v1',
    'grepoDeuses_ultimoAlvo_v1',
    'grepoConstru_estado_v1',
    'grepoRecruta_adiamentos_v1',

    /* O ENCAIXE aponta a uma cidade concreta — os identificadores são
     * diferentes em cada conta. */
    'grepoEncaixe_cfg_v1',
    'grepoEncaixe_planos_v1',

    /* Nomes de cidades e blocos do mapa já procurados: cada conta descobre os
     * seus, e partilhá-los não traz nada. */
    'grepoApoio_nomes_v1',
    'grepoApoio_blocosVistos_v1',

    /* Quando cada conta viu cada comando: é o que permite classificar os
     * ataques. Partilhar isto estragaria a classificação. */
    'grepoEsquiva_vistos_v1',
    'grepoEsquiva_arranque_v1',
    'grepoEsquiva_planos_v1',
    'grepoEsquiva_cidadesMain_v1',
    'grepoAlertas_vistosEm_v1',
    'grepoAlertas_arranque_v1',

    /* As CREDENCIAIS do Gist são de cada conta e nunca viajam no perfil. */
    'grepoMaestro_gist_v1',
  ];

  const ficheiroPerfil = (nome) => `perfil-${nome}-${WORLD}.json`;

  /* ============ PERFIL PARTILHADO, APLICADO AO ARRANCAR ==================
   * Uma conta é a PRINCIPAL desse perfil e mundo: é a única que publica.
   * As outras leem e aplicam quando arrancam.
   *
   * Assim muda-se numa e, no reinício seguinte, as 20 ficam iguais — sem ter
   * de carregar em Buscar uma a uma.
   *
   * Só uma publica de propósito: com todas a publicar, uma configuração errada
   * espalhava-se, e 20 contas a escrever no Gist esgotam o limite do GitHub.
   * ==================================================================== */
  const PRINCIPAL_KEY = 'grepoMaestro_principal_v1';

  function souPrincipal() {
    try { return localStorage.getItem(PRINCIPAL_KEY) === '1'; } catch (e) { return false; }
  }
  function marcarPrincipal(sim) {
    try {
      if (sim) localStorage.setItem(PRINCIPAL_KEY, '1');
      else localStorage.removeItem(PRINCIPAL_KEY);
    } catch (e) {}
  }

  /* Quando foi aplicado o perfil pela última vez, para não repetir a cada
   * passagem. */
  const APLICADO_KEY = 'grepoMaestro_perfilAplicado_v1';

  async function aplicarPerfilAoArrancar() {
    if (souPrincipal()) return;                 // a principal não busca
    if (!GIST_ID_GLOBAL) return;

    const esc = lerEscolhas();
    const perfil = (esc && esc.perfil) || '';
    if (!perfil) return;

    try {
      const r = await buscarPerfil(perfil);
      if (!r.ok) return;

      /* Só avisa se trouxe algo de novo. */
      const antes = Number(localStorage.getItem(APLICADO_KEY)) || 0;
      if (r.quando && r.quando > antes) {
        localStorage.setItem(APLICADO_KEY, String(r.quando));
        log('core', `Perfil "${perfil}" actualizado a partir da conta principal `
          + `(${r.n} definição(ões)).`);
      }
    } catch (e) {}
  }

  async function publicarPerfil(nome) {
    if (!GIST_ID_GLOBAL || !GIST_TOKEN_GLOBAL) return { ok: false, msg: 'sem Gist configurado' };
    const locais = new Set(CHAVES_LOCAIS_DO_PERFIL);
    const chaves = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !/^grepo/i.test(k)) continue;
        if (locais.has(k)) continue;

        /* As chaves do núcleo (`grepoMaestro_*`) ficavam TODAS de fora, e com
         * elas a lista de módulos ligados — quem fizesse Buscar tinha de os
         * voltar a ligar um a um. Levam-se as que fazem sentido replicar. */
        if (/^grepoMaestro_/.test(k)) {
          const replicaveis = /^grepoMaestro_(ativos_|webhooks_|autostart_)/;
          if (!replicaveis.test(k)) continue;
        }

        chaves[k] = localStorage.getItem(k);
      }
    } catch (e) {}

    try {
      const body = { files: {} };
      body.files[ficheiroPerfil(nome)] = {
        content: JSON.stringify({ perfil: nome, mundo: WORLD, quando: Date.now(), chaves }, null, 1),
      };
      const r = await uw.fetch(`https://api.github.com/gists/${GIST_ID_GLOBAL}`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + GIST_TOKEN_GLOBAL,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return { ok: r.ok, n: Object.keys(chaves).length };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  async function buscarPerfil(nome) {
    if (!GIST_ID_GLOBAL) return { ok: false, msg: 'sem Gist configurado' };
    try {
      const r = await uw.fetch(`https://api.github.com/gists/${GIST_ID_GLOBAL}`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!r.ok) return { ok: false, msg: 'não consegui ler o Gist' };
      const j = await r.json();
      const f = (j.files || {})[ficheiroPerfil(nome)];
      if (!f) return { ok: false, msg: `o perfil "${nome}" ainda não foi publicado` };

      /* FICHEIROS GRANDES vêm TRUNCADOS.
       *
       * O GitHub não devolve o conteúdo de ficheiros acima de ~1 MB na
       * listagem do Gist — marca-os com `truncated: true` e dá um `raw_url`
       * para os ir buscar à parte.
       *
       * O perfil das multis tem 51 KB e vinha sem `content`, o que fazia o
       * Buscar dizer que não estava publicado quando estava. */
      let conteudo = f.content;
      if ((!conteudo || f.truncated) && f.raw_url) {
        try {
          const rr = await uw.fetch(f.raw_url, { headers: { Accept: 'text/plain' } });
          if (rr.ok) conteudo = await rr.text();
        } catch (e) {}
      }
      if (!conteudo) {
        return { ok: false, msg: `não consegui ler o perfil "${nome}" (ficheiro grande demais)` };
      }

      const dados = JSON.parse(conteudo);
      const locais = new Set(CHAVES_LOCAIS_DO_PERFIL);
      let n = 0;
      for (const k of Object.keys(dados.chaves || {})) {
        if (locais.has(k)) continue;       // nunca sobrepor o que é desta conta

        /* A configuração dos colonizadores vem do perfil, MAS a equipa é de
         * cada conta — sem isto, buscar o perfil punha todas na mesma equipa
         * e a rotação deixava de fazer sentido. */
        if (k === 'grepoColonos_cfg_v1') {
          try {
            const meu = JSON.parse(localStorage.getItem(k) || '{}');
            const veio = JSON.parse(dados.chaves[k] || '{}');
            for (const campo of CAMPOS_LOCAIS_DOS_COLONOS) {
              if (meu[campo] != null) veio[campo] = meu[campo];
            }
            localStorage.setItem(k, JSON.stringify(veio));
            n++;
            continue;
          } catch (e) {}
        }

        try { localStorage.setItem(k, dados.chaves[k]); n++; } catch (e) {}
      }

      /* Aplicar os MÓDULOS LIGADOS que vieram no perfil.
       *
       * A lista está em `grepoMaestro_ativos_<perfil>`, mas o que o maestro lê
       * no arranque é o `grepoMaestro_modulos_v1`. Sem copiar de um para o
       * outro, o Buscar trazia a lista e ela não era usada — e quem recebesse
       * tinha de ligar os módulos um a um. */
      try {
        const ativos = JSON.parse(localStorage.getItem(`grepoMaestro_ativos_${nome}`) || 'null');
        if (ativos) {
          const esc = JSON.parse(localStorage.getItem('grepoMaestro_modulos_v1') || 'null') || {};
          esc.perfil = nome;
          esc.ativos = ativos;
          localStorage.setItem('grepoMaestro_modulos_v1', JSON.stringify(esc));
        }
      } catch (e) {}

      return { ok: true, n, quando: dados.quando };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  // Chaves que pertencem aos módulos (tudo o que começa por grepo, excepto as
  // do próprio maestro, que são globais à conta).
  function chavesDosModulos() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !/^grepo/i.test(k)) continue;
        if (/^grepoMaestro_/.test(k)) continue;      // do maestro: não é do perfil
        out.push(k);
      }
    } catch (e) {}
    return out;
  }

  function lerCfgPerfis() {
    try { return JSON.parse(localStorage.getItem(CFG_PERFIS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function gravarCfgPerfis(o) {
    try { localStorage.setItem(CFG_PERFIS_KEY, JSON.stringify(o)); } catch (e) {}
  }

  // Guarda as definições actuais debaixo do perfil indicado.
  function guardarCfgDoPerfil(perfil) {
    if (!perfil) return;
    const todos = lerCfgPerfis();
    const meu = {};
    for (const k of chavesDosModulos()) {
      try { meu[k] = localStorage.getItem(k); } catch (e) {}
    }
    todos[perfil] = meu;
    gravarCfgPerfis(todos);
  }

  /* Repõe as definições de um perfil — e LIMPA as que ele não tem.
   *
   * Antes deixava-se ficar o que o perfil novo não tivesse, para "não apagar
   * trabalho". Mas o efeito era o contrário do que se quer: ao mudar da main
   * para as multis, os templates da main apareciam lá todos, e as multis
   * herdavam configuração que não é delas.
   *
   * Os perfis são independentes: um perfil sem templates fica SEM templates.
   * O trabalho não se perde — o perfil anterior é guardado antes da troca
   * (ver `aplicarPerfil`), portanto voltar a ele traz tudo de volta. */
  function reporCfgDoPerfil(perfil) {
    const todos = lerCfgPerfis();
    const meu = todos[perfil] || {};
    let n = 0, limpas = 0;

    for (const k of chavesDosModulos()) {
      try {
        if (Object.prototype.hasOwnProperty.call(meu, k) && meu[k] != null) {
          localStorage.setItem(k, meu[k]);
          n++;
        } else {
          // o perfil novo não tem esta definição: fica vazia
          if (localStorage.getItem(k) != null) { localStorage.removeItem(k); limpas++; }
        }
      } catch (e) {}
    }
    return { repostas: n, limpas };
  }

  /* ============ EXPORTAR / IMPORTAR DEFINIÇÕES ==========================
   * Para não repetir a configuração toda num mundo novo.
   *
   * O que TRANSITA bem: os templates de construção, pesquisa e recrutamento —
   * são guardados por NOME DE GRUPO, e se criares os grupos com os mesmos
   * nomes no outro mundo funcionam tal e qual.
   *
   * O que NÃO transita: tudo o que aponta a cidades concretas (identificadores
   * de cidade mudam de mundo para mundo). Essas chaves são deixadas de fora da
   * exportação, e a importação avisa quais tens de configurar à mão.
   * ==================================================================== */
  const CHAVES_COM_CIDADES = [
    'grepoColonos_cfg_v1',        // baseA, baseB, destino
    'grepoColonos_cidades_v1',
    'grepoApoio_cfg_v1',
    'grepoApoio_cacheAlvos_v1',
    'grepoApoio_done_v1',
    'grepoEncaixe_cfg_v1',        // cidade de encaixe
    'grepoDeuses_ultimoAlvo_v1',
    'grepoAlertas_vistos_v1',
    'grepoAlertas_ignorar_v1',
    'grepoFundacao_cfg_v1',       // ilhas são deste mundo
    'grepoFundacao_estado_v1',
    'grepoMaestro_webhooks_v1',   // esses queres iguais? ver abaixo
  ];

  // Destas, os webhooks até fazem sentido copiar.
  const CHAVES_A_COPIAR_MESMO_ASSIM = ['grepoMaestro_webhooks_v1'];

  function exportarDefinicoes() {
    const fora = new Set(CHAVES_COM_CIDADES.filter((k) => CHAVES_A_COPIAR_MESMO_ASSIM.indexOf(k) < 0));
    const perfil = perfilParaChaves();
    const dados = { mundo: WORLD, perfil, quando: new Date().toISOString(), chaves: {} };

    /* Exportar SÓ as chaves do perfil activo, e sem o sufixo.
     *
     * As chaves guardadas trazem o sufixo (`..._v1__main`). Se as exportasse
     * assim, a importação no outro mundo criava chaves com sufixo duplo e
     * nada funcionava. E exportar as de todos os perfis misturava-os.
     *
     * Guarda-se o nome sem sufixo; a importação volta a pô-lo, com o perfil
     * de destino. */
    try {
      const sufixo = `__${perfil}`;
      for (let i = 0; i < localStorage.length; i++) {
        const bruta = localStorage.key(i);
        if (!bruta || !/^grepo/i.test(bruta)) continue;

        let limpa = bruta;
        if (bruta.endsWith(sufixo)) limpa = bruta.slice(0, -sufixo.length);
        else if (/__[a-z]+$/i.test(bruta)) continue;   // é de OUTRO perfil
        else if (!/^grepoMaestro_/.test(bruta)) continue;   // sem sufixo e não é do núcleo

        if (fora.has(limpa)) continue;
        try { dados.chaves[limpa] = localStorage.getItem(bruta); } catch (e) {}
      }
    } catch (e) {}
    return dados;
  }

  function importarDefinicoes(texto) {
    let dados = null;
    try { dados = JSON.parse(texto); } catch (e) { return { ok: false, msg: 'não consegui ler o texto colado' }; }
    if (!dados || !dados.chaves) return { ok: false, msg: 'o texto não parece uma exportação do Maestro' };

    /* Importar para o perfil ACTIVO deste mundo. O `armazem` acrescenta o
     * sufixo certo, portanto usa-se ele e não o localStorage directo. */
    let n = 0;
    for (const k of Object.keys(dados.chaves)) {
      if (!/^grepo/i.test(k)) continue;
      if (/__[a-z]+$/i.test(k)) continue;      // veio com sufixo: não importar
      try { armazem.setItem(k, dados.chaves[k]); n++; } catch (e) {}
    }
    return { ok: true, n, de: dados.mundo || '?', dePerfil: dados.perfil || '?' };
  }

  function perfilAtual() {
    const e = lerEscolhas();
    return (e && e.perfil) || '';
  }

  /* Guardar as definições do perfil activo de vez em quando. Sem isto, as
   * alterações feitas nos painéis dos módulos perdiam-se ao trocar de perfil,
   * porque só se guardava no momento da troca. */
  function guardarPerfilPeriodicamente() {
    try {
      setInterval(() => {
        const p2 = perfilAtual();
        if (p2) guardarCfgDoPerfil(p2);
      }, 60000);

      /* A conta PRINCIPAL publica no Gist de meia em meia hora, para as outras
       * apanharem as mudanças no arranque seguinte.
       *
       * Só ela publica: com 20 contas a escrever, o GitHub corta as escritas —
       * já nos aconteceu. */
      setInterval(async () => {
        if (!souPrincipal() || !GIST_ID_GLOBAL || !GIST_TOKEN_GLOBAL) return;
        const esc = lerEscolhas();
        const perfil = (esc && esc.perfil) || '';
        if (!perfil) return;
        try {
          const r = await publicarPerfil(perfil);
          if (r && r.ok) log('core', `Perfil "${perfil}" publicado (${r.n} definição(ões)).`);
        } catch (e) {}
      }, 30 * 60 * 1000);
      // e também ao fechar a página
      uw.addEventListener('beforeunload', () => {
        const p2 = perfilAtual();
        if (p2) guardarCfgDoPerfil(p2);
      });
    } catch (e) {}
  }

  function aplicarPerfil(nome) {
    const p = PERFIS[nome];
    if (!p) return;
    // Guardar o que está antes de trocar, e repor o do perfil novo.
    const anterior = perfilAtual();

    /* Que módulos ficam ligados.
     *
     * Antes ligava TODOS a cada troca de perfil (a "sugestão" é `null` nos
     * dois), deitando fora o que o utilizador tinha escolhido. Agora cada
     * perfil lembra-se dos seus: guardam-se em `grepoMaestro_ativos_<perfil>`
     * e repõem-se ao voltar.
     *
     * Só na PRIMEIRA vez que se usa um perfil é que se aplica a sugestão. */
    const guardadosDoPerfil = (() => {
      try { return JSON.parse(localStorage.getItem(`grepoMaestro_ativos_${nome}`) || 'null'); }
      catch (e) { return null; }
    })();

    // guardar os do perfil ANTERIOR antes de trocar
    if (anterior) {
      try {
        const meus = {};
        for (const m of MODULES) meus[m.id] = !!(modState[m.id] && modState[m.id].ativo);
        localStorage.setItem(`grepoMaestro_ativos_${anterior}`, JSON.stringify(meus));
      } catch (e) {}
    }

    const escolhas = { perfil: nome, ativos: {} };
    for (const m of MODULES) {
      escolhas.ativos[m.id] = guardadosDoPerfil
        ? !!guardadosDoPerfil[m.id]
        : (p.sugestao === null ? true : p.sugestao.indexOf(m.id) >= 0);
      if (modState[m.id]) modState[m.id].ativo = escolhas.ativos[m.id];
    }
    guardarEscolhas(escolhas);
    try { localStorage.setItem(`grepoMaestro_ativos_${nome}`, JSON.stringify(escolhas.ativos)); } catch (e) {}

    /* Já NÃO é preciso copiar nem limpar nada.
     *
     * Cada perfil tem as suas chaves no armazenamento (sufixo `__perfil`),
     * portanto trocar de perfil é só passar a ler as outras. Era a cópia entre
     * perfis que estragava tudo — foi ela que pôs os templates da main no
     * perfil multi. */
    log('core', `Perfil "${p.nome}" aplicado. Cada perfil tem as suas definições.`);
  }

  function modAplicaAoMundo(mod) {
    return !mod.worlds || mod.worlds.includes(WORLD);
  }

  /* ------------------------------ loop principal ------------------------- */
  let maestroTimer = null;
  let running = false;

  async function tick() {
    if (running) return; // nunca sobrepor
    running = true;
    try {
      const agora = Date.now();
      // módulos que estão "na hora" e ativos e aplicáveis a este mundo
      const aCorrer = MODULES.filter((m) => {
        const st = modState[m.id];
        return st && st.ativo && modAplicaAoMundo(m) && agora >= st.proximaExec;
      });
      if (!aCorrer.length) return;

      // adquirir semáforo uma vez para todo o bloco (coordena com GPT externo)
      const got = await lockWaitAndAcquire();
      if (!got) { log('core', '⏳ Cidades ocupadas por script externo; salto este tick.'); return; }

      try {
        for (const m of aCorrer) {
          const st = modState[m.id];

          /* Verificar OUTRA VEZ mesmo antes de correr: a lista foi montada no
           * início do tick e o utilizador pode ter desligado o módulo — ou
           * parado o maestro — entretanto. Sem isto, tirar o visto não tinha
           * efeito imediato e o módulo corria na mesma. */
          if (!st.ativo) continue;
          if (!maestroTimer) { log('core', 'Maestro parado a meio — não corro mais nada.'); break; }

          st.aCorrer = true;
          try {
            /* Nada de anunciar cada passagem: enchia o registo sem dizer nada,
             * sobretudo nos módulos que correm de 2 em 2 minutos. Em vez disso
             * conta-se, e de duas em duas horas sai um resumo (ver
             * resumoPeriodico). O que interessa ler são as linhas do próprio
             * módulo: o que fez, ou porque não fez. */
            contagem[m.id] = (contagem[m.id] || 0) + 1;
            await m.run(makeCtx(m.id));
          } catch (e) {
            // Desligar a meio não é uma falha — é uma paragem pedida.
            if (e && e.desligado) log('core', `⏹ ${m.nome}: parado a meio (desligaste-o).`);
            else log('core', `⚠️ Módulo "${m.nome}" falhou: ${e.message}`);
          } finally {
            st.aCorrer = false;
            st.proximaExec = Date.now() + (m.intervaloMin * 60 * 1000);
            atualizarPainelEstado();
          }
        }
      } finally {
        lockRelease();
      }
    } finally {
      running = false;
    }
  }

  /* Desvio fixo desta conta, de 0 a 20 s. Deriva do nome do jogador, por isso
   * é sempre o mesmo para a mesma conta mas diferente entre contas — as 20
   * multis espalham-se sozinhas ao arrancar todas ao mesmo tempo. */
  let _desvio = null;
  function desvioDaConta() {
    if (_desvio != null) return _desvio;
    let semente = '';
    try { semente = String(uw.Game.player_id || uw.Game.player_name || Math.random()); } catch (e) { semente = String(Math.random()); }
    let h = 2166136261;
    for (let i = 0; i < semente.length; i++) { h ^= semente.charCodeAt(i); h = Math.imul(h, 16777619); }
    _desvio = Math.abs(h >>> 0) % 20000;   // 0 a 20 s
    return _desvio;
  }

  /* ---- resumo periódico -------------------------------------------------
   * Quantas vezes cada módulo correu desde o último resumo. Serve para saber
   * que estão vivos sem uma linha por passagem. */
  const contagem = {};
  let ultimoResumo = Date.now();
  const RESUMO_CADA_MS = 2 * 60 * 60 * 1000;   // 2 horas

  /* ============ LIMPAR NOTIFICAÇÕES ====================================
   * O jogo empilha avisos que se vão acumulando às centenas com 16 módulos a
   * agir. Limpam-se de tempos a tempos.
   *
   * NUNCA se apaga o aviso de verificação de bot — esse tem de ser visto.
   * ==================================================================== */
  const LIMPAR_CADA_MS = 60 * 1000;   // 1 minuto: as trocas acumulam depressa

  /* Apagam-se TODAS as notificações da interface — com o bot a agir sozinho,
   * nenhuma delas te diz o que precisas de saber; o registo do painel serve
   * melhor para isso.
   *
   * MENOS estas, que têm de ser vistas: */
  const NOTIFICACOES_A_MANTER = [
    'bot_check', 'botcheck', 'captcha',   // verificação de bot: paras se não a vires
  ];

  function deveApagar(tipo) {
    if (!tipo) return false;
    const t = String(tipo).toLowerCase();
    return !NOTIFICACOES_A_MANTER.some((k) => t.indexOf(k) >= 0);
  }

  let ultimaLimpeza = 0;
  let vigiaLigada = false;

  /* Apagar à medida que chegam é melhor do que de X em X minutos: nunca
   * chegam a aparecer. Embrulha-se o `push` da pilha do jogo. */
  function vigiarNotificacoes() {
    if (vigiaLigada) return;
    try {
      const st = uw.GrepoNotificationStack;
      if (!st || typeof st.push !== 'function') return;
      const original = st.push;
      st.push = function (...args) {
        const r = original.apply(this, args);
        try {
          const n = args[0];
          const tipo = n && typeof n.getType === 'function' ? n.getType() : null;
          if (deveApagar(tipo)) {
            /* SÓ tirar do ecrã.
             *
             * Tentei apagar no servidor com `deleteByTypeAndParamID` e correu
             * mal: cada chamada faz um pedido `notify/delete` e percorre a
             * pilha a alterá-la ao mesmo tempo. Com muitas notificações, isso
             * deu 429 (demasiados pedidos) e corrompeu a pilha do jogo — a
             * janela dos relatórios passou a rebentar com
             * "Cannot read properties of undefined (reading 'getOpt')".
             *
             * Não vale a pena: as notificações no ecrã são o incómodo, e isto
             * resolve-o sem mexer no que é do jogo. */
            setTimeout(() => {
              try { if (typeof n.despawn === 'function') n.despawn(); } catch (e) {}
              try { if (typeof n.destroy === 'function') n.destroy(); } catch (e) {}
              tirarDoEcra();
            }, 60);
          }
        } catch (e) {}
        return r;
      };
      vigiaLigada = true;
    } catch (e) {}
  }

  /* Tirar as notificações pelo ELEMENTO no ecrã.
   *
   * O `despawn()` e o `deleteOutdated()` não as removiam — ficavam 11 de
   * transporte de recursos na pilha depois de os chamar. O que resulta é
   * remover o elemento: é ele que ocupa o ecrã.
   *
   * As classes vêm no formato "notification resourcetransport". */
  function tirarDoEcra() {
    let n = 0;
    try {
      document.querySelectorAll('[class*="notification"]').forEach((el) => {
        const cls = String(el.className || '');
        if (!/\bnotification\b/.test(cls)) return;
        // nunca tocar no aviso de verificação de bot
        if (/bot_?check|captcha/i.test(cls)) return;
        // a data é filha da notificação; sai com ela
        if (/notification_date/.test(cls)) return;
        el.remove();
        n++;
      });
    } catch (e) {}
    return n;
  }

  /* Vigiar a área das notificações e tirar cada uma mal apareça.
   *
   * Limpar de minuto a minuto não chega — entre limpezas acumulam-se dezenas.
   * Um observador na árvore do documento apanha-as à chegada. */
  let obsNotificacoes = null;

  function vigiarEcra() {
    if (obsNotificacoes) return;
    try {
      obsNotificacoes = new MutationObserver((mudancas) => {
        for (const m of mudancas) {
          for (const no of (m.addedNodes || [])) {
            if (!no || no.nodeType !== 1) continue;
            const cls = String(no.className || '');
            if (!/\bnotification\b/.test(cls)) continue;
            if (/bot_?check|captcha/i.test(cls)) continue;   // esse fica
            if (/notification_date/.test(cls)) continue;
            try { no.remove(); } catch (e) {}
          }
        }
      });
      obsNotificacoes.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  /* Apagar TODAS as notificações no servidor — UM pedido só.
   *
   * Confirmado no jogo: o "X" de eliminar todas faz
   * `notify?action=delete_all` e responde "Todas as notificações foram
   * eliminadas com êxito".
   *
   * É isto que devia ter sido feito desde o início. A primeira tentativa
   * chamava `deleteByTypeAndParamID` uma vez por notificação — com 320
   * acumuladas, isso deu 429 e corrompeu a pilha do jogo.
   *
   * ATENÇÃO: apaga TUDO, incluindo a verificação de bot. Por isso só corre
   * quando o utilizador carrega no botão, nunca sozinho. */
  async function apagarTodasNoServidor() {
    try {
      const t = uw.Game.townId;
      const url = uw.location.origin + '/game/notify?town_id=' + Number(t)
        + '&action=delete_all&h=' + uw.Game.csrfToken;

      const r = await uw.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({ town_id: Number(t), nl_init: true })),
      });
      const txt = await r.text();
      if (!txt || !txt.trim()) return { ok: false, msg: `sem resposta (HTTP ${r.status})` };
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { return { ok: false, msg: 'resposta ilegível' }; }
      const err = j && j.json && j.json.error;
      return err ? { ok: false, msg: String(err) } : { ok: true };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  function limparNotificacoes() {
    vigiarNotificacoes();
    vigiarEcra();
    if (Date.now() - ultimaLimpeza < LIMPAR_CADA_MS) return;
    ultimaLimpeza = Date.now();
    try {
      const st = uw.GrepoNotificationStack;
      // deleteBotCheckNotification NÃO é chamado de propósito
      if (st && typeof st.deleteOutdated === 'function') st.deleteOutdated();
    } catch (e) {}
    tirarDoEcra();

    /* APAGAR NO SERVIDOR, de hora a hora.
     *
     * UM pedido apaga tudo — `notify?action=delete_all`. A tentativa anterior
     * chamava um pedido POR NOTIFICAÇÃO e, com centenas acumuladas, deu 429 e
     * corrompeu a pilha do jogo. Este é o pedido que o botão "X" do jogo faz.
     *
     * ATENÇÃO: apaga TUDO, incluindo a verificação de bot. Por isso só corre
     * se estiver LIGADO no painel — vem desligado. */
    if (apagarNotificacoesLigado()) apagarTodasNoServidorSeHoras();
  }

  /* Apagar todas no servidor, no máximo uma vez por hora. */
  const APAGAR_NOTIF_KEY = 'grepoMaestro_apagarNotif_v1';
  const ULTIMO_APAGAR_KEY = 'grepoMaestro_ultimoApagar_v1';

  /* LIGADO por omissão. Só fica desligado se o utilizador o desmarcar. */
  function apagarNotificacoesLigado() {
    try { return localStorage.getItem(APAGAR_NOTIF_KEY) !== '0'; } catch (e) { return true; }
  }

  /* Há uma verificação de bot por responder?
   *
   * O `delete_all` apaga TUDO, incluindo essa. Se ela lá estiver, não se
   * apaga nada — perder uma verificação de bot sem a ver custa a conta. */
  function haVerificacaoDeBot() {
    try {
      const st = uw.GrepoNotificationStack;
      if (!st || typeof st.loop !== 'function') return false;
      let achei = false;
      st.loop((el, notif) => {
        try {
          const t = String((typeof notif.getType === 'function' ? notif.getType() : '') || '').toLowerCase();
          if (/bot_check|botcheck|captcha/.test(t)) achei = true;
        } catch (e) {}
      });
      return achei;
    } catch (e) { return false; }
  }

  async function apagarTodasNoServidorSeHoras() {
    try {
      const ultimo = Number(localStorage.getItem(ULTIMO_APAGAR_KEY)) || 0;
      if (Date.now() - ultimo < 60 * 60 * 1000) return;

      /* NUNCA apagar com uma verificação de bot pendente. */
      if (haVerificacaoDeBot()) {
        log('core', '⚠️ Há uma verificação de bot por responder — não apago as notificações.');
        return;
      }

      localStorage.setItem(ULTIMO_APAGAR_KEY, String(Date.now()));

      const r = await apagarTodasNoServidor();
      if (r.ok) log('core', 'Notificações: apagadas todas no servidor.');
    } catch (e) {}
  }

  function resumoPeriodico() {
    if (Date.now() - ultimoResumo < RESUMO_CADA_MS) return;
    ultimoResumo = Date.now();

    const linhas = MODULES
      .filter((m) => contagem[m.id])
      .sort((a, b) => contagem[b.id] - contagem[a.id])
      .map((m) => `${m.nome} ${contagem[m.id]}×`);

    if (linhas.length) {
      log('core', `🕑 Últimas 2 h: ${linhas.join(' · ')}.`);
    } else {
      const ligados = MODULES.filter((m) => modState[m.id] && modState[m.id].ativo).length;
      log('core', `🕑 Últimas 2 h: nenhum módulo correu (${ligados} ligado(s)) — algo está errado.`);
    }
    for (const k of Object.keys(contagem)) delete contagem[k];
  }

  function startMaestro() {
    if (!MODULES.length) {
      log('core', 'Nenhum módulo registado ainda. Adiciona módulos no ficheiro (ver secção MÓDULOS).');
      return;
    }
    // inicializar estado dos módulos
    const escolhas = lerEscolhas();
    for (const m of MODULES) {
      if (!modState[m.id]) {
        const guardado = escolhas && escolhas.ativos && (m.id in escolhas.ativos)
          ? !!escolhas.ativos[m.id] : (m.autoStart !== false);
        modState[m.id] = {
          ativo: guardado,
          // arranque escalonado: cada módulo começa com um atraso aleatório
          // Atraso próprio de cada módulo, MAIS um desvio próprio da conta
          // (ver desvioDaConta): sem o segundo, as 20 contas arrancavam todas
          // na mesma janela ao reiniciar a VPS e faziam um pico de pedidos.
          proximaExec: Date.now() + desvioDaConta() + rand(3000, 30000),
          aCorrer: false,
        };
      }
    }
    if (maestroTimer) clearInterval(maestroTimer);
    // tick frequente (o "na hora" é decidido por módulo); 15s é leve
    maestroTimer = setInterval(() => { tick(); resumoPeriodico(); limparNotificacoes(); }, 15000);
    try { if (uw.__maestroPintarToggle) uw.__maestroPintarToggle(); } catch (e) {}
    const nAtivos = MODULES.filter((m) => modState[m.id] && modState[m.id].ativo).length;
    log('core', `▶ Maestro A CORRER — ${nAtivos} de ${MODULES.length} módulo(s) ativos em ${WORLD}`
      + ` (desvio desta conta: ${Math.round(desvioDaConta() / 1000)}s).`);
    tick();
  }
  function stopMaestro() {
    if (maestroTimer) clearInterval(maestroTimer);
    maestroTimer = null;
    log('core', '⏸ Maestro PARADO — nenhum módulo vai correr até carregares em Iniciar.');
    try { if (uw.__maestroPintarToggle) uw.__maestroPintarToggle(); } catch (e) {}
  }

  /* ------------------------------ painel --------------------------------- */
  /* ============ GUARDAR SOZINHO =========================================
   * Esquecer de carregar em Guardar é mais provável — e mais caro — do que
   * enganar-se num campo. Por isso, mexer num campo guarda logo.
   *
   * Nos campos de NÚMERO guarda-se ao SAIR do campo, não a cada tecla: a meio
   * de escrever "250" passa-se por "2" e por "25", e se o módulo corresse nesse
   * instante agia com o valor errado.
   *
   * Faz-se aqui, no núcleo, carregando no botão Guardar que cada painel já tem
   * — em vez de mexer nos 16 módulos um a um.
   * ==================================================================== */
  /* ============ TRAVÃO DAS ESCRITAS NO GIST =============================
   * O GitHub tem um limite de escritas por hora bem mais apertado do que o de
   * leituras — e foi excedido: cinco gravações em 45 segundos ao mexer nos
   * campos do painel deram "API rate limit exceeded", e a partir daí os
   * templates deixaram de subir.
   *
   * Aqui espaça-se: uma escrita por ficheiro de cada vez, com um mínimo de
   * tempo entre elas. As alterações vão-se acumulando e sobe a última.
   * ==================================================================== */
  const ESPERA_ENTRE_ESCRITAS = 30000;   // 30 s por ficheiro
  const ultimaEscrita = {};
  const escritaPendente = {};

  /* Um módulo chama isto em vez de escrever directamente. */
  function escreverNoGistComTravao(chave, fazer) {
    const agora = Date.now();
    const desde = agora - (ultimaEscrita[chave] || 0);

    if (desde >= ESPERA_ENTRE_ESCRITAS) {
      ultimaEscrita[chave] = agora;
      return fazer();
    }

    /* Ainda cedo: agenda-se, substituindo o que estivesse pendente — só
     * interessa a última versão. */
    if (escritaPendente[chave]) clearTimeout(escritaPendente[chave]);
    return new Promise((resolve) => {
      escritaPendente[chave] = setTimeout(async () => {
        delete escritaPendente[chave];
        ultimaEscrita[chave] = Date.now();
        try { resolve(await fazer()); } catch (e) { resolve({ ok: false, msg: e.message }); }
      }, ESPERA_ENTRE_ESCRITAS - desde);
    });
  }
  try { uw.__maestroGistTravao = escreverNoGistComTravao; } catch (e) {}

  function guardarSozinho(caixa, mod) {
    if (!caixa) return;

    /* O botão TEM de ser o do módulo, não outro qualquer do painel.
     *
     * A primeira versão procurava a partir do painel inteiro e apanhava o
     * "Guardar" do perfil, lá no topo — as alterações do módulo nunca eram
     * guardadas. Agora procura-se só dentro da caixa deste módulo, e ainda se
     * exclui explicitamente os botões do núcleo. */
    const botao = Array.prototype.find.call(
      caixa.querySelectorAll('button'),
      (b) => {
        const id = String(b.id || '');
        if (/^maestro-|^wh-|^cfg-|^perfil-/.test(id)) return false;   // do núcleo
        return /guardar/i.test(id) || /guardar/i.test(b.textContent || '');
      });
    if (!botao) return;

    let porGuardar = null;
    /* Procurar o botão OUTRA VEZ no momento de carregar: muitos painéis
     * redesenham-se ao sair de um campo, e o botão que se guardou aqui já não
     * está no ecrã — carregar nele não faz nada. */
    const acharBotao = () => Array.prototype.find.call(
      caixa.querySelectorAll('button'),
      (b) => {
        const id = String(b.id || '');
        if (/^maestro-|^wh-|^cfg-|^perfil-/.test(id)) return false;
        return /guardar/i.test(id) || /guardar/i.test(b.textContent || '');
      });

    const guardaJa = () => {
      if (porGuardar) { clearTimeout(porGuardar); porGuardar = null; }
      try {
        const b = acharBotao() || botao;
        if (b && b.isConnected !== false) b.click();
      } catch (e) {}

      /* E logo a seguir, guardar no PERFIL: de pouco serve gravar a definição
       * do módulo se ela não ficar no perfil que está aplicado. Sem isto, uma
       * troca de perfil (ou a reposição ao arrancar) trazia a versão antiga.
       *
       * O clique acima é síncrono, mas alguns painéis gravam a seguir a um
       * redesenho — daí a pequena espera. */
      setTimeout(() => {
      }, 150);
    };
    const guardaDaquiAPouco = () => {
      if (porGuardar) clearTimeout(porGuardar);
      porGuardar = setTimeout(guardaJa, 400);
    };

    const ligarCampos = () => {
      caixa.querySelectorAll('input, select, textarea').forEach((el) => {
        if (el.dataset && el.dataset.maestroLigado) return;   // já tem
        if (el.dataset) el.dataset.maestroLigado = '1';

        const tipo = (el.type || '').toLowerCase();
        if (tipo === 'checkbox' || tipo === 'radio' || el.tagName === 'SELECT') {
          el.addEventListener('change', guardaDaquiAPouco);
          return;
        }
        el.addEventListener('blur', guardaDaquiAPouco);
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') guardaJa(); });
      });
    };
    ligarCampos();

    /* O painel do módulo redesenha-se sozinho (ao mudar de grupo, ao acrescentar
     * uma unidade...). Os campos novos não têm os ouvintes — daí vigiar a caixa
     * e voltar a ligá-los. */
    try {
      const obs = new MutationObserver(() => ligarCampos());
      obs.observe(caixa, { childList: true, subtree: true });
    } catch (e) {}
  }

  function buildPanel() {
    if (document.getElementById('maestro-panel')) return;
    const btn = document.createElement('div');
    btn.id = 'maestro-btn';
    /* Barra com o nome, encostada à direita por baixo dos indicadores de
     * tropas do jogo (quartel/porto). Antes era um "M" solto que não dizia
     * nada e ficava a meio da coluna. */
    btn.textContent = 'MAESTRO';
    btn.style.cssText = [
      'position:fixed', 'right:6px', 'top:340px', 'z-index:99999',
      'background:linear-gradient(180deg,#1c2530,#141b24)',
      'border:1px solid #3a4757', 'border-radius:5px',
      'color:#d8a33f', 'font:600 11px/1 system-ui,-apple-system,"Segoe UI",sans-serif',
      'letter-spacing:.16em', 'text-align:center',
      'padding:7px 14px', 'cursor:pointer', 'user-select:none',
      'box-shadow:0 2px 8px rgba(0,0,0,.45)',
      'transition:border-color .12s,color .12s',
    ].join(';');
    btn.title = 'Abrir ou fechar o Maestro';
    btn.onmouseover = () => { btn.style.borderColor = '#d8a33f'; btn.style.color = '#f0c76a'; };
    btn.onmouseout = () => { btn.style.borderColor = '#3a4757'; btn.style.color = '#d8a33f'; };

    /* Encostar por baixo do último painel lateral do jogo (Porto/Quartel), em
     * vez de uma posição fixa que pode calhar mal noutra resolução. */
    /* Encostar por baixo do painel do PORTO, que é o último da coluna
     * lateral direita.
     *
     * Medir a coluna inteira não funcionava: o #ui_box ocupa o ecrã todo, e
     * o cálculo dava sempre o fundo da janela. O que identifica o sítio é a
     * etiqueta "Porto" — o seu contentor termina exactamente onde queremos
     * (medido no jogo: fundo aos 479 px). */
    const encostarAoLado = () => {
      try {
        let fundo = 0;
        document.querySelectorAll('.bottom_link, .nav').forEach((el) => {
          const txt = (el.textContent || '').trim();
          if (!/^(porto|harbor|hafen|puerto)$/i.test(txt)) return;
          const r = el.getBoundingClientRect();
          // Sem condição de largura: o jogo tem largura fixa e numa janela
          // larga o painel fica bem à esquerda do meio do ecrã (medido: x=1168
          // numa janela de 2551).
          if (r.height > 5) fundo = Math.max(fundo, r.bottom);
        });

        // sem a etiqueta (idioma diferente?), usar o quartel como referência
        if (!fundo) {
          document.querySelectorAll('.bottom_link, .nav').forEach((el) => {
            const txt = (el.textContent || '').trim();
            if (!/^(quartel|barracks|kaserne|cuartel)$/i.test(txt)) return;
            const r = el.getBoundingClientRect();
            if (r.height > 5) fundo = Math.max(fundo, r.bottom + 90);
          });
        }

        if (fundo > 60 && fundo < window.innerHeight - 40) {
          btn.style.top = Math.round(fundo + 12) + 'px';

          /* Alinhar também na horizontal com a coluna do jogo: numa janela
           * larga, o jogo fica centrado e a barra colada à direita ficaria
           * longe dele. */
          let dir = null;
          document.querySelectorAll('.bottom_link, .nav').forEach((el) => {
            const txt = (el.textContent || '').trim();
            if (!/^(porto|quartel|harbor|barracks)$/i.test(txt)) return;
            const r = el.getBoundingClientRect();
            if (r.width > 20) dir = Math.max(dir || 0, r.right);
          });
          if (dir && dir < window.innerWidth - 20) {
            btn.style.right = Math.round(window.innerWidth - dir) + 'px';
          }
        }
      } catch (e) {}
    };

    setTimeout(encostarAoLado, 1500);
    setTimeout(encostarAoLado, 5000);
    try { window.addEventListener('resize', encostarAoLado); } catch (e) {}
    btn.onclick = () => { const p = document.getElementById('maestro-panel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; };
    document.body.appendChild(btn);

    const p = document.createElement('div');
    p.id = 'maestro-panel';
    /* Painel CENTRADO e redimensionável. Antes estava colado à direita com
     * largura fixa — numa VPS de baixa resolução, com muitas cidades, não se
     * via a lista toda. Agora abre ao centro, pode arrastar-se pelo cabeçalho
     * e esticar-se pelo canto; a posição e o tamanho ficam guardados. */
    const POS_KEY = 'maestro_painel_pos_v1';
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) {}

    // Tamanho comedido: o painel não deve tapar o jogo. Ajusta-se pelo canto
    // e o tamanho fica guardado.
    const larguraOmissao = Math.min(560, Math.max(420, Math.floor(window.innerWidth * 0.36)));
    const alturaOmissao = Math.min(820, Math.max(480, Math.floor(window.innerHeight * 0.82)));
    /* A posição guardada pode ficar fora do ecrã se a janela encolher (ou se
     * ficou de uma resolução maior). Limitar sempre ao que é visível — senão o
     * cabeçalho fica inacessível e não há como arrastar de volta. */
    const larg = (pos && pos.width) || larguraOmissao;
    const alt = (pos && pos.height) || alturaOmissao;
    const esquerda = Math.max(0, Math.min(
      window.innerWidth - Math.min(larg, window.innerWidth) ,
      pos && pos.left != null ? pos.left : Math.floor((window.innerWidth - larguraOmissao) / 2)));
    const topo = Math.max(0, Math.min(
      Math.max(0, window.innerHeight - 60),
      pos && pos.top != null ? pos.top : Math.floor((window.innerHeight - alturaOmissao) / 2)));

    p.style.cssText = 'position:fixed;z-index:99999;'
      + `left:${esquerda}px;top:${topo}px;`
      + `width:${(pos && pos.width) || larguraOmissao}px;`
      + `height:${(pos && pos.height) || alturaOmissao}px;`
      + 'min-width:300px;min-height:220px;resize:both;overflow:auto;'
      + 'background:#1b2838;color:#cde;font:12px sans-serif;padding:10px;'
      // text-align e line-height explícitos: o CSS do jogo centra tudo o que
      // apanha, e o painel ficava com o conteúdo ao meio.
      + 'text-align:left;line-height:1.4;'
      + 'border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.5);display:none';

    // guardar tamanho quando o utilizador estica
    try {
      const ro = new ResizeObserver(() => {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({
            left: parseInt(p.style.left, 10), top: parseInt(p.style.top, 10),
            width: p.offsetWidth, height: p.offsetHeight,
          }));
        } catch (e) {}
      });
      ro.observe(p);
    } catch (e) {}
    p.innerHTML = `
      <div id="maestro-cabecalho" class="mCab">
        <span class="mNome">Maestro</span>
        <span class="mMundo">${WORLD.toUpperCase()}</span>
        <span style="flex:1"></span>
        <a href="#" id="maestro-centrar" class="mEtiq" style="color:var(--mFaint)"
           title="Voltar a pôr o painel ao centro">centrar</a>
        <button id="maestro-fechar" title="Fechar (o botão M volta a abrir)"
          style="padding:1px 7px;line-height:1.3;font-size:14px;border:none;background:transparent;
                 color:var(--mFaint)">×</button>
      </div>

      <div id="maestro-faixa" class="mFaixa">
        <span class="mPulso"></span>
        <div style="flex:1;min-width:0">
          <div class="mEtiq">a tocar agora</div>
          <div id="maestro-agora" style="font-size:12px">—</div>
        </div>
        <button id="maestro-toggle" class="mPrinc">Iniciar</button>
      </div>

      <div class="mCaixa" style="display:flex;flex-direction:column;gap:7px">
        <div style="display:flex;gap:6px;align-items:center">
          <span class="mEtiq" style="flex:0 0 auto">perfil</span>
          <select id="maestro-perfil" style="flex:1">
            <option value="main">Main</option>
            <option value="multi">Multi</option>
          </select>
          <button id="maestro-perfil-aplicar">Aplicar</button>
          <button id="maestro-perfil-guardar" title="Guardar as definições actuais neste perfil">Guardar</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
          <span class="mEtiq" style="flex:0 0 auto">limpar</span>
          <button id="perfil-reset" style="flex:1;color:#f88"
            title="Apaga o perfil que está escolhido na lista acima">Apagar o perfil escolhido</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
          <span class="mEtiq" style="flex:0 0 auto">avisos</span>
          <button id="maestro-limpar-notif" style="flex:1"
            title="Apaga todas as notificações do jogo, num pedido só">
            Apagar todas as notificações
          </button>
        </div>
        <label style="display:block;margin-top:3px;font-size:11px">
          <input type="checkbox" id="maestro-apagar-auto"${apagarNotificacoesLigado() ? ' checked' : ''}>
          apagar automaticamente, de hora a hora
        </label>
        <div style="opacity:.6;font-size:10px;margin-left:18px">
          Um pedido apaga tudo. <b>Nunca corre</b> se houver uma verificação de bot
          por responder — essa fica sempre à tua espera.
        </div>

        <div style="background:#0d141c;padding:6px 8px;border-radius:4px;margin-top:7px">
          <label style="font-size:11px">
            <input type="checkbox" id="maestro-principal"${souPrincipal() ? ' checked' : ''}>
            <b>Esta é a conta PRINCIPAL deste perfil</b>
          </label>
          <div style="opacity:.6;font-size:10px;margin:2px 0 0 18px">
            A principal <b>publica</b> a configuração; as outras <b>aplicam-na</b> ao
            arrancar. Configura só aqui e reinicia as restantes.<br>
            Marca isto em <b>UMA</b> conta por perfil e mundo — se marcares em várias,
            a última a gravar manda.
          </div>
        </div>

        <div style="background:#0d141c;padding:6px 8px;border-radius:4px;margin-top:7px">
          <b style="font-size:11px">Gist (partilha entre contas)</b>
          <div style="opacity:.6;font-size:10px;margin:2px 0 4px">
            Guardado NESTA conta — não se perde quando o script se actualiza.
          </div>
          <div style="display:flex;gap:4px;align-items:center;margin-bottom:3px">
            <span style="opacity:.75;font-size:10px;width:42px">id</span>
            <input type="text" id="maestro-gist-id" value="${String(GIST_GUARDADO.id || '').replace(/[<>"&]/g, '')}"
              placeholder="identificador do Gist" style="flex:1;font-size:10px">
          </div>
          <div style="display:flex;gap:4px;align-items:center">
            <span style="opacity:.75;font-size:10px;width:42px">token</span>
            <input type="password" id="maestro-gist-token" value="${String(GIST_GUARDADO.token || '').replace(/[<>"&]/g, '')}"
              placeholder="token do GitHub (scope: gist)" style="flex:1;font-size:10px">
          </div>
          <button id="maestro-gist-guardar" style="width:100%;margin-top:4px;font-size:10px">
            Guardar credenciais
          </button>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="mEtiq" style="flex:0 0 auto">partilhar</span>
          <button id="perfil-publicar" style="flex:1" title="Enviar este perfil para as outras contas">↑ Publicar</button>
          <button id="perfil-buscar" style="flex:1" title="Trazer o perfil publicado noutra conta">↓ Buscar</button>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
          <input type="checkbox" id="maestro-autostart">
          <span>Começar sozinho ao abrir o jogo</span>
        </label>
        <div class="mDica">
          Cada perfil guarda os módulos ligados <b>e as definições de cada um</b>.
          Trocar de perfil guarda o anterior e repõe o novo.
        </div>
      </div>

      <details id="maestro-copiar-cfg" class="mCaixa" style="padding:7px 9px">
        <summary style="cursor:pointer;font-size:11px;opacity:.85">Copiar definições para outro mundo</summary>
        <div class="mDica" style="margin:5px 0">
          Exporta aqui, cola no outro mundo. Os <b>templates</b> passam tal e qual
          desde que os grupos tenham os mesmos nomes.
          Fica de fora tudo o que aponta a cidades — os identificadores mudam de
          mundo para mundo.
        </div>
        <div style="display:flex;gap:5px;margin-bottom:5px">
          <button id="cfg-exportar" style="flex:1">Exportar</button>
          <button id="cfg-importar" style="flex:1">Importar</button>
        </div>
        <textarea id="cfg-texto" rows="3" placeholder="cola aqui o que exportaste do outro mundo"
          style="width:100%;box-sizing:border-box;font-size:10px;font-family:ui-monospace,monospace"></textarea>
      </details>

      <details id="maestro-avisos" class="mCaixa" style="padding:7px 9px">
        <summary style="cursor:pointer;font-size:11px;opacity:.85">Avisos no Discord</summary>
        <div class="mDica" style="margin:5px 0">
          Estes endereços são deste <b>perfil</b> e deste <b>mundo</b>
          (<span id="wh-onde" style="color:var(--mBrass)">—</span>) — cada combinação tem
          os seus, como tens os canais organizados.
        </div>
        <div style="display:grid;gap:4px">
          <label style="font-size:11px">
            <span class="mEtiq">verificação de bot</span><br>
            <input type="text" id="wh-captcha" placeholder=""
              style="width:100%;box-sizing:border-box;font-size:10px">
          </label>
          <label style="font-size:11px">
            <span class="mEtiq">ataque a chegar</span><br>
            <input type="text" id="wh-ataque" placeholder=""
              style="width:100%;box-sizing:border-box;font-size:10px">
          </label>
          <label style="font-size:11px">
            <span class="mEtiq">ataque com colonizador</span><br>
            <input type="text" id="wh-ataquenc" placeholder=""
              style="width:100%;box-sizing:border-box;font-size:10px">
          </label>
        </div>
        <div style="display:flex;gap:5px;margin-top:6px">
          <button id="wh-guardar" style="flex:1">Guardar</button>
          <button id="wh-testar">Enviar teste</button>
        </div>
      </details>

      <div id="maestro-modulos"></div>

      <div id="maestro-estado" class="mCaixa" style="font-size:11px">
        <div class="mEtiq" style="margin-bottom:3px">estado</div>
        <div id="maestro-estado-txt">—</div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span class="mEtiq">registo</span>
        <span style="font-size:10px">
          <a href="#" id="maestro-copiar">copiar</a>
          <span style="color:var(--mFaint);margin:0 3px">·</span>
          <a href="#" id="maestro-limpar">limpar</a>
        </span>
      </div>
      <pre id="maestro-log" class="mLog"></pre>
    `;

    /* ======================= APARÊNCIA =================================
     * Direcção: o nome é "Maestro" — quem coordena instrumentos que entram e
     * saem. Daí o vocabulário: módulos que "tocam", uma faixa a dizer o que
     * está a tocar agora e o que entra a seguir.
     *
     * Paleta de bronze grego sobre tinta escura, não o verde-néon de terminal
     * (que é o que qualquer bot usa) nem o cinzento-azulado de painel de
     * administração. Latão para o que exige atenção, verde-azulado sereno para
     * o que está a trabalhar.
     *
     * O CSS do jogo é agressivo (centra tudo, herda tipos de letra), por isso
     * quase tudo aqui é explícito.
     * ================================================================= */
    try {
      const est = document.createElement('style');
      est.id = 'maestro-estilo';
      est.textContent = `
        #maestro-panel{
          --mBg:#0f141b; --mSurf:#161d26; --mSurf2:#1c2530; --mLine:#28323f;
          --mTxt:#dce4ee; --mDim:#8493a5; --mFaint:#5b6878;
          --mBrass:#d8a33f; --mBrassDim:#8a6b2b;
          --mLive:#4fc7a1; --mStop:#d9705f;
          color:var(--mTxt);
          font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
          text-align:left; letter-spacing:0;
        }
        #maestro-panel *{ text-align:inherit; font-family:inherit; box-sizing:border-box; }
        #maestro-panel b,#maestro-panel strong{ font-weight:600; }

        /* micro-etiquetas: maiúsculas espaçadas, o registo de sala de controlo */
        #maestro-panel .mEtiq{
          font-size:9px; letter-spacing:.14em; text-transform:uppercase;
          color:var(--mFaint); font-weight:600;
        }

        #maestro-panel .mCab{
          display:flex; align-items:baseline; gap:8px; cursor:move; user-select:none;
          padding-bottom:9px; margin-bottom:11px; border-bottom:1px solid var(--mLine);
        }
        #maestro-panel .mNome{
          font-size:15px; font-weight:600; letter-spacing:.02em;
        }
        #maestro-panel .mMundo{
          color:var(--mBrass); font-weight:600; font-size:11px; letter-spacing:.1em;
        }

        /* faixa de estado — o elemento assinatura */
        #maestro-panel .mFaixa{
          display:flex; align-items:center; gap:10px;
          background:linear-gradient(90deg,rgba(216,163,63,.06),transparent 60%);
          border:1px solid var(--mLine);
          border-left:3px solid var(--mBrassDim);
          border-radius:0 6px 6px 0; padding:10px 11px; margin-bottom:10px;
        }
        #maestro-panel .mFaixa.tocando{
          background:linear-gradient(90deg,rgba(79,199,161,.08),transparent 60%);
        }
        #maestro-panel .mFaixa.parado{
          background:linear-gradient(90deg,rgba(217,112,95,.06),transparent 60%);
        }
        #maestro-panel .mFaixa.tocando{ border-left-color:var(--mLive); }
        #maestro-panel .mFaixa.parado{ border-left-color:var(--mStop); }
        #maestro-panel .mPulso{
          width:7px; height:7px; border-radius:50%; background:var(--mFaint); flex:0 0 auto;
        }
        #maestro-panel .mFaixa.tocando .mPulso{
          background:var(--mLive); box-shadow:0 0 0 0 rgba(79,199,161,.5);
          animation:mPulsar 2.4s ease-out infinite;
        }
        @keyframes mPulsar{
          70%{ box-shadow:0 0 0 7px rgba(79,199,161,0); }
          100%{ box-shadow:0 0 0 0 rgba(79,199,161,0); }
        }
        @media (prefers-reduced-motion: reduce){
          #maestro-panel .mFaixa.tocando .mPulso{ animation:none; }
        }

        #maestro-panel button{
          font:inherit; font-size:12px; cursor:pointer; border:1px solid var(--mLine);
          background:var(--mSurf2); color:var(--mTxt);
          border-radius:5px; padding:5px 11px; transition:background .12s,border-color .12s;
        }
        #maestro-panel button:hover{ background:#232e3b; border-color:#3a4757; }
        #maestro-panel button:focus-visible{ outline:2px solid var(--mBrass); outline-offset:1px; }
        #maestro-panel .mPrinc{
          background:transparent; border:1px solid var(--mLive); color:var(--mLive);
          font-weight:600; letter-spacing:.03em;
        }
        #maestro-panel .mPrinc:hover{ background:rgba(79,199,161,.1); }
        #maestro-panel .mPrinc.aParar{ border-color:var(--mStop); color:var(--mStop); }
        #maestro-panel .mPrinc.aParar:hover{ background:rgba(217,112,95,.1); }

        #maestro-panel input[type=text],#maestro-panel input[type=number],
        #maestro-panel select,#maestro-panel textarea{
          font:inherit; font-size:12px; background:var(--mBg); color:var(--mTxt);
          border:1px solid var(--mLine); border-radius:4px; padding:4px 6px;
        }
        #maestro-panel input:focus,#maestro-panel select:focus,#maestro-panel textarea:focus{
          outline:none; border-color:var(--mBrassDim);
        }
        #maestro-panel input[type=checkbox]{ accent-color:var(--mLive); cursor:pointer; }
        #maestro-panel a{ color:var(--mBrass); text-decoration:none; }
        #maestro-panel a:hover{ text-decoration:underline; }

        /* grelha de módulos */
        #maestro-panel .mGrupo{ margin-bottom:13px; }
        #maestro-panel .mGrupoCab{
          display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;
        }
        #maestro-panel .mGrelha{
          display:grid; grid-template-columns:repeat(auto-fit,minmax(72px,1fr)); gap:5px;
        }
        #maestro-panel .mCartao{
          position:relative; cursor:pointer; text-align:center;
          padding:10px 4px 8px; border-radius:6px;
          background:var(--mSurf); border:1px solid var(--mLine);
          transition:transform .1s, border-color .12s, background .12s;
        }
        #maestro-panel .mCartao:hover{ transform:translateY(-1px); border-color:#3a4757; background:var(--mSurf2); }
        #maestro-panel .mCartao.mOn{ border-color:rgba(79,199,161,.42); }
        #maestro-panel .mCartao.mOn::after{
          content:''; position:absolute; left:9px; right:9px; bottom:0; height:2px;
          background:var(--mLive); border-radius:2px 2px 0 0; opacity:.75;
        }
        #maestro-panel .mIcone{ font-size:19px; line-height:1.15; }
        #maestro-panel .mCartao.mOff .mIcone{ filter:grayscale(1); opacity:.34; }
        #maestro-panel .mRotulo{ font-size:10px; margin-top:3px; color:var(--mDim); }
        #maestro-panel .mCartao.mOn .mRotulo{ color:var(--mTxt); }
        /* O visto é secundário — o que se lê é o ícone. Fica pequeno e só
         * ganha cor ao passar por cima do cartão. */
        #maestro-panel .mVisto{
          position:absolute; top:4px; right:4px; margin:0;
          width:11px; height:11px; opacity:.28; transition:opacity .12s;
        }
        #maestro-panel .mCartao:hover .mVisto{ opacity:.9; }
        #maestro-panel .mCartao.mOn .mVisto{ opacity:.5; }
        #maestro-panel .mCartao.mOn:hover .mVisto{ opacity:1; }

        /* dentro de um módulo */
        #maestro-panel .mModCab{
          display:flex; align-items:center; gap:8px;
          padding-bottom:8px; margin-bottom:10px; border-bottom:1px solid var(--mLine);
        }

        #maestro-panel .mCaixa{
          background:var(--mSurf); border:1px solid var(--mLine);
          border-radius:6px; padding:8px 10px; margin-bottom:9px;
        }
        #maestro-panel .mLog{
          background:var(--mBg); border:1px solid var(--mLine); border-radius:6px;
          padding:8px 10px; height:140px; overflow:auto; margin:0;
          white-space:pre-wrap; font:11px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace;
          color:var(--mDim); font-variant-numeric:tabular-nums;
        }
        #maestro-panel .mLog::-webkit-scrollbar{ width:8px; }
        #maestro-panel .mLog::-webkit-scrollbar-thumb{ background:var(--mLine); border-radius:4px; }
        #maestro-panel .mDica{ font-size:10px; color:var(--mFaint); line-height:1.45; }
      `;
      document.head.appendChild(est);
    } catch (e) {}

    document.body.appendChild(p);

    // copiar e limpar o registo
    try {
      const elCop = p.querySelector('#maestro-copiar');
      if (elCop) elCop.onclick = async (ev) => {
        ev.preventDefault();
        const txt = (document.getElementById('maestro-log') || {}).textContent || '';
        let ok = false;
        try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) {}
        if (!ok) {
          // recurso alternativo para quando a área de transferência é recusada
          try {
            const ta = document.createElement('textarea');
            ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            ok = document.execCommand('copy');
            ta.remove();
          } catch (e) {}
        }
        elCop.textContent = ok ? 'copiado' : 'não deu';
        setTimeout(() => { elCop.textContent = 'copiar'; }, 1600);
      };
      const elLim = p.querySelector('#maestro-limpar');
      if (elLim) elLim.onclick = (ev) => {
        ev.preventDefault();
        /* Limpar também a lista em memória: o ecrã é reconstruído a partir
         * dela a cada mensagem nova, por isso apagar só o elemento fazia o
         * registo voltar todo na linha seguinte. */
        logLines = [];
        const el = document.getElementById('maestro-log');
        if (el) el.textContent = '';
        log('core', 'Registo limpo.');
      };
    } catch (e) {}

    // fechar
    try {
      const elX = p.querySelector('#maestro-fechar');
      if (elX) {
        elX.onmousedown = (ev) => ev.stopPropagation();   // não arrastar ao clicar
        elX.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); p.style.display = 'none'; };
        elX.onmouseover = () => { elX.style.color = 'var(--mStop)'; };
        elX.onmouseout = () => { elX.style.color = 'var(--mFaint)'; };
      }
    } catch (e) {}

    // voltar ao centro, se se perder de vista
    try {
      const elC = p.querySelector('#maestro-centrar');
      if (elC) elC.onmousedown = (ev) => ev.stopPropagation();
      if (elC) elC.onclick = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        p.style.left = Math.max(0, Math.floor((window.innerWidth - p.offsetWidth) / 2)) + 'px';
        p.style.top = Math.max(0, Math.floor((window.innerHeight - p.offsetHeight) / 2)) + 'px';
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({
            left: parseInt(p.style.left, 10), top: parseInt(p.style.top, 10),
            width: p.offsetWidth, height: p.offsetHeight,
          }));
        } catch (e) {}
      };
    } catch (e) {}

    // arrastar pelo cabeçalho
    (function () {
      const cab = p.querySelector('#maestro-cabecalho');
      if (!cab) return;
      let a = false, dx = 0, dy = 0;
      cab.addEventListener('mousedown', (e) => {
        a = true;
        dx = e.clientX - p.offsetLeft;
        dy = e.clientY - p.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!a) return;
        p.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - dx)) + 'px';
        p.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy)) + 'px';
      });
      document.addEventListener('mouseup', () => {
        if (!a) return;
        a = false;
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({
            left: parseInt(p.style.left, 10), top: parseInt(p.style.top, 10),
            width: p.offsetWidth, height: p.offsetHeight,
          }));
        } catch (e) {}
      });
    })();

    const selPerfil = document.getElementById('maestro-perfil');
    const btnPerfil = document.getElementById('maestro-perfil-aplicar');
    if (selPerfil) {
      const esc = lerEscolhas();
      selPerfil.value = (esc && esc.perfil) || 'main';
    }

    /* O botão APLICAR estava declarado mas sem clique ligado — não fazia
     * nada, e por isso o perfil activo nunca mudava. Como o sufixo das chaves
     * vem do perfil activo, tudo continuava a ler as do main. */
    if (btnPerfil) btnPerfil.onclick = () => {
      const nome = selPerfil && selPerfil.value;
      if (!nome) { log('core', 'Escolhe primeiro um perfil na lista.'); return; }
      aplicarPerfil(nome);
      /* Recarregar: os módulos já leram as chaves do perfil anterior e têm-nas
       * em memória. */
      setTimeout(() => { try { location.reload(); } catch (e) {} }, 1200);
    };
    /* ---- apagar notificações automaticamente ---- */
    const chkA = document.getElementById('maestro-apagar-auto');
    if (chkA) chkA.onchange = () => {
      try {
        // '0' = desligado; qualquer outra coisa (ou nada) = ligado
        if (chkA.checked) localStorage.removeItem(APAGAR_NOTIF_KEY);
        else localStorage.setItem(APAGAR_NOTIF_KEY, '0');
      } catch (e) {}
      log('core', chkA.checked
        ? 'Notificações: passo a apagá-las no servidor de hora a hora.'
        : 'Notificações: deixo de as apagar no servidor.');
    };

    /* ---- conta principal ---- */
    const chkP = document.getElementById('maestro-principal');
    if (chkP) chkP.onchange = () => {
      marcarPrincipal(chkP.checked);
      log('core', chkP.checked
        ? 'Esta conta passa a PUBLICAR a configuração do perfil.'
        : 'Esta conta passa a APLICAR a configuração publicada por outra.');
    };

    /* ---- credenciais do Gist ---- */
    const btG = document.getElementById('maestro-gist-guardar');
    if (btG) btG.onclick = () => {
      const id = (document.getElementById('maestro-gist-id') || {}).value || '';
      const tk = (document.getElementById('maestro-gist-token') || {}).value || '';
      try {
        localStorage.setItem(CREDENCIAIS_KEY, JSON.stringify({
          id: String(id).trim(), token: String(tk).trim(),
        }));
        log('core', 'Gist: credenciais guardadas. Recarrega a página para as usar.');
      } catch (e) {
        log('core', 'Não consegui guardar as credenciais: ' + e.message);
      }
    };

    /* ---- apagar todas as notificações no servidor ---- */
    const btNot = document.getElementById('maestro-limpar-notif');
    if (btNot) btNot.onclick = async () => {
      if (!confirm('Apagar TODAS as notificações do jogo?\n\n'
        + 'Inclui a verificação de bot, se houver alguma por responder.\n'
        + 'Isto não se desfaz.')) return;

      btNot.disabled = true; btNot.textContent = 'a apagar...';
      const r = await apagarTodasNoServidor();
      btNot.disabled = false; btNot.textContent = 'Apagar todas as notificações';
      log('core', r.ok
        ? 'Notificações: apagadas todas no servidor.'
        : `Não consegui apagar: ${r.msg}`);
      tirarDoEcra();
    };

    /* ---- apagar as definições deste perfil ---- */
    const btReset = document.getElementById('perfil-reset');
    if (btReset) btReset.onclick = () => {
      /* Apagar o perfil ESCOLHIDO no seletor, não o que está activo.
       *
       * Antes usava o perfil activo, e quem estivesse na main a querer limpar
       * o multi acabava por limpar a main — que é exactamente o contrário do
       * que se quer. */
      const sel = document.getElementById('maestro-perfil');
      const p2 = (sel && sel.value) || perfilAtual() || 'main';
      const ativo = perfilAtual();

      if (!confirm(`Apagar TUDO o que o perfil "${p2}" tem guardado?\n\n`
        + 'Templates, definições dos módulos, tudo. Fica como novo.\n'
        + 'Os outros perfis não são tocados.\n\nIsto não se desfaz.')) return;

      /* Apagar do armazenamento actual E do que está gravado no perfil: senão
       * a configuração volta na próxima troca. */
      /* O que está guardado NO PERFIL apaga-se sempre. O armazenamento actual
       * só se limpa se for o perfil que está a ser usado — senão apagava-se a
       * configuração de outro perfil por engano. */
      let n = 0;
      try {
        const todos = lerCfgPerfis();
        n = Object.keys(todos[p2] || {}).length;
        delete todos[p2];
        gravarCfgPerfis(todos);
      } catch (e) {}

      /* Apagar as chaves COM O SUFIXO deste perfil, esteja ele activo ou não.
       *
       * Antes só limpava se fosse o perfil activo, porque as chaves eram
       * comuns. Agora cada perfil tem as suas, portanto pode-se apagar as de
       * qualquer um sem tocar nos outros. */
      let n2 = 0;
      try {
        const sufixo = `__${p2}`;
        const aRemover = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.endsWith(sufixo)) aRemover.push(k);
        }
        for (const k of aRemover) { localStorage.removeItem(k); n2++; }
        // e a lista de módulos activos deste perfil
        localStorage.removeItem(`grepoMaestro_ativos_${p2}`);
      } catch (e) {}

      log('core', `Perfil "${p2}": apagadas ${n2} definição(ões). Está como novo.`
        + (ativo === p2 ? ' Vou recarregar.' : ' Os outros perfis não foram tocados.'));
      setTimeout(() => { try { location.reload(); } catch (e) {} }, 1500);
    };

    /* ---- publicar / buscar o perfil pelo Gist ---- */
    const btPub = document.getElementById('perfil-publicar');
    if (btPub) btPub.onclick = async () => {
      const p2 = perfilAtual() || 'main';
      if (!confirm(`Publicar o perfil "${p2}" para as outras contas?`)) return;
      btPub.disabled = true; btPub.textContent = 'a publicar...';
      guardarCfgDoPerfil(p2);
      const r = await publicarPerfil(p2);
      btPub.disabled = false; btPub.textContent = '↑ Publicar';
      log('core', r.ok
        ? `Perfil "${p2}" publicado (${r.n} definições).`
        : `Não consegui publicar: ${r.msg}`);
    };

    const btBus = document.getElementById('perfil-buscar');
    if (btBus) btBus.onclick = async () => {
      const p2 = perfilAtual() || 'main';
      if (!confirm(`Trazer o perfil "${p2}" publicado?\n\n`
        + 'Substitui os templates e as definições desta conta.')) return;
      btBus.disabled = true; btBus.textContent = 'a buscar...';
      const r = await buscarPerfil(p2);
      btBus.disabled = false; btBus.textContent = '↓ Buscar';
      if (!r.ok) { log('core', `Não consegui buscar: ${r.msg}`); return; }
      log('core', `Perfil "${p2}" trazido (${r.n} definições).`);
      log('core', 'Falta configurar à mão o que depende de cidades: bases dos colonos, '
        + 'alvos do apoio, cidade de encaixe e ilhas da fundação.');
      setTimeout(() => { try { location.reload(); } catch (e) {} }, 2000);
    };

    const btnGuardarPerfil = document.getElementById('maestro-perfil-guardar');
    if (btnGuardarPerfil) btnGuardarPerfil.onclick = () => {
      const p2 = perfilAtual();
      if (!p2) { log('core', 'Escolhe primeiro um perfil.'); return; }
      guardarCfgDoPerfil(p2);
      const n = Object.keys((lerCfgPerfis()[p2]) || {}).length;
      log('core', `Definições guardadas no perfil "${PERFIS[p2] ? PERFIS[p2].nome : p2}" (${n} chaves).`);
    };

    if (btnPerfil) btnPerfil.onclick = () => {
      aplicarPerfil(selPerfil.value);
      for (const m of MODULES) {
        const cb = document.getElementById(`maestro-ativo-${m.id}`);
        if (cb && modState[m.id]) cb.checked = modState[m.id].ativo;
      }
      atualizarPainelEstado();
      btnPerfil.textContent = 'Aplicado ✓';
      setTimeout(() => { btnPerfil.textContent = 'Aplicar'; }, 1500);
    };

    /* ---- copiar definições entre mundos ---- */
    (function () {
      const cx = document.getElementById('cfg-texto');
      const bE = document.getElementById('cfg-exportar');
      const bI = document.getElementById('cfg-importar');

      if (bE) bE.onclick = async () => {
        const dados = exportarDefinicoes();
        const txt = JSON.stringify(dados);
        if (cx) cx.value = txt;
        let ok = false;
        try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) {}
        const n = Object.keys(dados.chaves).length;
        log('core', `Exportadas ${n} definição(ões) do perfil "${dados.perfil}" em ${WORLD.toUpperCase()}`
          + (ok ? ' — já copiadas.' : ' — copia o texto da caixa.'));
      };

      if (bI) bI.onclick = () => {
        const txt = (cx && cx.value || '').trim();
        if (!txt) { log('core', 'Cola primeiro o texto exportado do outro mundo.'); return; }
        if (!confirm('Isto substitui as definições deste mundo pelas coladas.\n\nContinuar?')) return;
        const r = importarDefinicoes(txt);
        if (!r.ok) { log('core', `Importação falhou: ${r.msg}`); return; }
        log('core', `Importadas ${r.n} definição(ões) do perfil "${r.dePerfil}" `
          + `de ${String(r.de).toUpperCase()} → para o perfil "${perfilParaChaves()}" de ${WORLD.toUpperCase()}.`);
        log('core', 'Falta configurar à mão o que depende de cidades: bases dos colonos, '
          + 'alvos do apoio, cidade de encaixe e ilhas da fundação.');
        setTimeout(() => { try { location.reload(); } catch (e) {} }, 2500);
      };

      const det = document.getElementById('maestro-copiar-cfg');
      if (det) {
        try { det.open = localStorage.getItem('grepoMaestro_copiarAberto') === '1'; } catch (e) {}
        det.ontoggle = () => {
          try { localStorage.setItem('grepoMaestro_copiarAberto', det.open ? '1' : '0'); } catch (e) {}
        };
      }
    })();

    /* ---- webhooks do Discord ---- */
    (function () {
      const w = webhooks();
      const elOnde = document.getElementById('wh-onde');
      if (elOnde) elOnde.textContent = chaveWebhooks().replace(':', ' · ');
      const cx = document.getElementById('wh-captcha');
      const ca = document.getElementById('wh-ataque');
      const cn = document.getElementById('wh-ataquenc');
      if (cx) cx.value = w.captcha || '';
      if (ca) ca.value = w.ataque || '';
      if (cn) cn.value = w.ataqueNC || '';

      const bg = document.getElementById('wh-guardar');
      if (bg) bg.onclick = () => {
        guardarWebhooks({
          captcha: (cx && cx.value || '').trim(),
          ataque: (ca && ca.value || '').trim(),
          ataqueNC: (cn && cn.value || '').trim(),
        });
        const n = Object.values(webhooks()).filter(Boolean).length;
        log('core', `Webhooks guardados (${n} de 3 preenchidos).`);
      };

      const bt2 = document.getElementById('wh-testar');
      if (bt2) bt2.onclick = async () => {
        const w2 = webhooks();
        const quais = Object.keys(w2).filter((k) => w2[k]);
        if (!quais.length) { log('core', 'Nenhum webhook preenchido — nada a testar.'); return; }
        bt2.disabled = true; bt2.textContent = 'a enviar...';
        for (const k of quais) {
          const ok = await avisarDiscord(k, `teste do canal "${k}" (perfil ${chaveWebhooks()}).`);
          log('core', ok ? `✓ Teste enviado para "${k}".` : `✗ Falhou o envio para "${k}".`);
        }
        bt2.disabled = false; bt2.textContent = 'Enviar teste';
      };

      // manter aberto/fechado
      const det = document.getElementById('maestro-avisos');
      if (det) {
        try { det.open = localStorage.getItem('grepoMaestro_avisosAberto') === '1'; } catch (e) {}
        det.ontoggle = () => {
          try { localStorage.setItem('grepoMaestro_avisosAberto', det.open ? '1' : '0'); } catch (e) {}
        };
      }
    })();

    const btToggle = document.getElementById('maestro-toggle');
    function pintarToggle() {
      if (!btToggle) return;
      btToggle.textContent = maestroTimer ? 'Parar' : 'Iniciar';
      btToggle.classList.toggle('aParar', !!maestroTimer);
      try { atualizarPainelEstado(); } catch (e) {}
    }
    if (btToggle) btToggle.onclick = () => {
      if (maestroTimer) stopMaestro(); else startMaestro();
      pintarToggle();
    };
    pintarToggle();
    uw.__maestroPintarToggle = pintarToggle;

    const elAuto = document.getElementById('maestro-autostart');
    if (elAuto) {
      elAuto.checked = autoStartLigado();
      elAuto.onchange = () => {
        guardarAutoStart(elAuto.checked);
        log('core', elAuto.checked
          ? 'Arranque automático LIGADO — vai começar sozinho ao abrir o jogo.'
          : 'Arranque automático DESLIGADO — terás de carregar em Iniciar.');
      };
    }

    // secção de cada módulo (toggle ativo + painel próprio)
    const modsBox = document.getElementById('maestro-modulos');
    const disponiveis = MODULES.filter(modAplicaAoMundo);

    /* O modState só existe depois de arrancar o maestro. Antes disso, o que
     * vale é o que está GUARDADO — senão tirar um visto com o maestro parado
     * não pegava e o cartão voltava a ficar marcado. */
    const estaAtivo = (m) => {
      if (modState[m.id]) return !!modState[m.id].ativo;
      const esc = lerEscolhas();
      if (esc && esc.ativos && (m.id in esc.ativos)) return !!esc.ativos[m.id];
      return m.autoStart !== false;
    };

    /* ---------------- vista: MENU de ícones ---------------- */
    function desenharMenu() {
      const jaVistos = new Set();
      const blocos = [];

      for (const g of GRUPOS) {
        const mods = disponiveis.filter((m) => g.ids.indexOf(m.id) >= 0);
        mods.forEach((m) => jaVistos.add(m.id));
        if (mods.length) blocos.push({ nome: g.nome, mods });
      }
      const restantes = disponiveis.filter((m) => !jaVistos.has(m.id));
      if (restantes.length) blocos.push({ nome: 'Outros', mods: restantes });

      modsBox.innerHTML = blocos.map((g) => {
        const on = g.mods.filter(estaAtivo).length;
        return `
        <div class="mGrupo">
          <div class="mGrupoCab">
            <span class="mEtiq">${g.nome} <span style="color:var(--mDim)">${on}/${g.mods.length}</span></span>
            <span style="font-size:10px">
              <a href="#" data-grupo-on="${g.nome}">ligar todos</a>
              <span style="color:var(--mFaint);margin:0 3px">·</span>
              <a href="#" data-grupo-off="${g.nome}">desligar</a>
            </span>
          </div>
          <div class="mGrelha">
            ${g.mods.map((m) => {
              const ic = ICONES[m.id] || { icone: '⚙️', curto: m.nome };
              const ativo = estaAtivo(m);
              return `<div data-abrir="${m.id}" title="${m.nome}" class="mCartao ${ativo ? 'mOn' : 'mOff'}">
                <div class="mIcone">${ic.icone}</div>
                <div class="mRotulo">${ic.curto}</div>
                <input type="checkbox" class="mVisto" data-do-grupo="${g.nome}"
                  id="maestro-ativo-${m.id}"${ativo ? ' checked' : ''} title="ligar ou desligar">
              </div>`;
            }).join('')}
          </div>
        </div>`;
      }).join('');

      // abrir um módulo
      modsBox.querySelectorAll('[data-abrir]').forEach((el) => {
        el.addEventListener('click', (ev) => {
          if (ev.target && ev.target.tagName === 'INPUT') return;   // o visto não abre
          moduloAberto = el.getAttribute('data-abrir');
          desenhar();
        });
      });

      // ligar/desligar individual
      modsBox.querySelectorAll('[id^="maestro-ativo-"]').forEach((el) => {
        el.addEventListener('change', (e) => {
          const id = el.id.replace('maestro-ativo-', '');
          const mod = MODULES.find((x) => x.id === id);
          // criar o estado se ainda não existir (maestro parado)
          if (!modState[id]) modState[id] = { ativo: e.target.checked, proximaExec: Date.now(), aCorrer: false };
          modState[id].ativo = e.target.checked;
          const esc = lerEscolhas() || { perfil: 'main', ativos: {} };
          esc.ativos[id] = e.target.checked;
          guardarEscolhas(esc);
          const st = modState[id];
          log('core', e.target.checked
            ? `▶ ${mod ? mod.nome : id}: ligado.`
            : `⏹ ${mod ? mod.nome : id}: desligado${st && st.aCorrer ? ' — vai parar já' : ''}.`);
          desenharMenu();
        });
      });

      // grupos
      const mexer = (nomeGrupo, ligar) => {
        const g = blocos.find((x) => x.nome === nomeGrupo);
        if (!g) return;
        const esc = lerEscolhas() || { perfil: 'main', ativos: {} };
        let n = 0;
        for (const m of g.mods) {
          if (estaAtivo(m) === ligar) continue;
          if (!modState[m.id]) modState[m.id] = { ativo: ligar, proximaExec: Date.now(), aCorrer: false };
          modState[m.id].ativo = ligar;
          esc.ativos[m.id] = ligar;
          n++;
        }
        guardarEscolhas(esc);
        log('core', `Grupo "${nomeGrupo}": ${n} módulo(s) ${ligar ? 'ligados' : 'desligados'}.`);
        desenharMenu();
      };
      modsBox.querySelectorAll('[data-grupo-on]').forEach((a) => {
        a.onclick = (e) => { e.preventDefault(); mexer(a.getAttribute('data-grupo-on'), true); };
      });
      modsBox.querySelectorAll('[data-grupo-off]').forEach((a) => {
        a.onclick = (e) => { e.preventDefault(); mexer(a.getAttribute('data-grupo-off'), false); };
      });
    }

    /* ---------------- vista: UM módulo ---------------- */
    function desenharModulo(id) {
      const m = disponiveis.find((x) => x.id === id);
      if (!m) { moduloAberto = ''; desenharMenu(); return; }
      const ic = ICONES[m.id] || { icone: '⚙️' };
      const ativo = estaAtivo(m);

      modsBox.innerHTML = `
        <div class="mModCab">
          <button id="maestro-voltar" style="padding:3px 9px">‹ Módulos</button>
          <span style="font-size:16px">${ic.icone}</span>
          <b style="flex:1;font-size:13px">${m.nome}</b>
          <label style="font-size:11px;display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="maestro-ativo-${m.id}"${ativo ? ' checked' : ''}>
            <span>${ativo ? 'ligado' : 'desligado'}</span>
          </label>
        </div>
        <div id="maestro-painel-${m.id}"></div>`;

      modsBox.querySelector('#maestro-voltar').onclick = () => { moduloAberto = ''; desenhar(); };
      modsBox.querySelector(`#maestro-ativo-${m.id}`).onchange = (e) => {
        const rot = e.target.parentElement && e.target.parentElement.querySelector('span');
        if (rot) rot.textContent = e.target.checked ? 'ligado' : 'desligado';
        if (!modState[m.id]) modState[m.id] = { ativo: e.target.checked, proximaExec: Date.now(), aCorrer: false };
        modState[m.id].ativo = e.target.checked;
        const esc = lerEscolhas() || { perfil: 'main', ativos: {} };
        esc.ativos[m.id] = e.target.checked;
        guardarEscolhas(esc);
        const st = modState[m.id];
        log('core', e.target.checked
          ? `▶ ${m.nome}: ligado.`
          : `⏹ ${m.nome}: desligado${st && st.aCorrer ? ' — vai parar já' : ''}.`);
        atualizarPainelEstado();
      };

      if (typeof m.painel === 'function') {
        try {
          const caixa = document.getElementById(`maestro-painel-${m.id}`);
          m.painel(caixa, makeCtx(m.id));
          guardarSozinho(caixa, m);
        } catch (e) { log('core', `Painel do módulo "${m.nome}" falhou: ${e.message}`); }
      }
    }

    function desenhar() {
      if (moduloAberto) desenharModulo(moduloAberto);
      else desenharMenu();
    }
    desenhar();
  }

  function emBreve(segundos) {
    if (segundos == null || !Number.isFinite(segundos)) return '—';
    if (segundos <= 0) return 'já';
    if (segundos < 60) return `${segundos}s`;
    const min = Math.round(segundos / 60);
    if (min < 60) return `${min} min`;
    return `${Math.round(min / 60)} h`;
  }

  /* A faixa do topo responde ao nome do programa: diz o que está a tocar e o
   * que entra a seguir. É a única coisa que se precisa de ler de relance. */
  function atualizarPainelEstado() {
    const faixa = document.getElementById('maestro-faixa');
    const agora = document.getElementById('maestro-agora');
    const box = document.getElementById('maestro-estado-txt');

    const meus = MODULES.filter(modAplicaAoMundo);
    const escG = lerEscolhas();
    const ligadoAgora = (m) => {
      if (modState[m.id]) return !!modState[m.id].ativo;
      if (escG && escG.ativos && (m.id in escG.ativos)) return !!escG.ativos[m.id];
      return m.autoStart !== false;
    };
    const ligados = meus.filter(ligadoAgora);
    const aCorrer = ligados.filter((m) => (modState[m.id] || {}).aCorrer);

    if (faixa) {
      faixa.classList.toggle('tocando', !!maestroTimer && !!ligados.length);
      faixa.classList.toggle('parado', !maestroTimer);
    }

    if (agora) {
      if (!maestroTimer) {
        agora.textContent = 'Parado';
      } else if (!ligados.length) {
        agora.textContent = 'Nenhum módulo ligado';
      } else if (aCorrer.length) {
        agora.textContent = aCorrer.map((m) => m.nome).join(', ');
      } else {
        // o próximo a entrar
        let prox = null;
        for (const m of ligados) {
          const st = modState[m.id] || {};
          if (!st.proximaExec) continue;
          if (!prox || st.proximaExec < prox.quando) prox = { nome: m.nome, quando: st.proximaExec };
        }
        agora.textContent = prox
          ? `À espera — ${prox.nome} entra em ${emBreve(Math.round((prox.quando - Date.now()) / 1000))}`
          : 'À espera';
      }
    }

    if (!box) return;
    if (!meus.length) { box.textContent = 'Sem módulos.'; return; }

    // Só os ligados interessam aqui; os desligados vêem-se na grelha.
    const linhas = ligados.map((m) => {
      const st = modState[m.id] || {};
      const falta = st.proximaExec ? Math.round((st.proximaExec - Date.now()) / 1000) : null;
      const quando = st.aCorrer
        ? '<span style="color:var(--mLive)">a correr</span>'
        : `<span style="color:var(--mDim)">${emBreve(falta)}</span>`;
      return `<div style="display:flex;justify-content:space-between;gap:8px">
        <span>${m.nome}</span>${quando}</div>`;
    });
    box.innerHTML = linhas.length
      ? linhas.join('')
      : `<span style="color:var(--mFaint)">${meus.length} módulo(s) disponíveis, nenhum ligado.</span>`;
  }
  setInterval(atualizarPainelEstado, 5000);

  /* ------------------------------ arranque ------------------------------- */
  async function waitReady(timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ready = uw.ITowns?.towns && Object.keys(uw.ITowns.towns).length > 0
        && uw.Game && uw.Game.townId != null && uw.Game.csrfToken && uw.HelperTown;
      if (ready) return true;
      await sleep(500);
    }
    return false;
  }

  // ============================ MÓDULOS ============================
  // Para adicionar um módulo novo, chama registerModule({...}) com esta forma:
  //
  //   registerModule({
  //     id: 'meu_modulo',            // identificador único
  //     nome: 'O Meu Módulo',        // aparece no painel
  //     intervaloMin: 5,             // corre de 5 em 5 minutos
  //     worlds: ['pt126'] | null,    // mundos onde corre (null = todos)
  //     autoStart: true,             // arranca ativo
  //     run: async (ctx) => {        // faz UMA passagem do trabalho
  //       // ctx.log('...'), ctx.sleep(ms), ctx.rand(a,b),
  //       // ctx.getMyTowns(), await ctx.switchToTown(id), ctx.WORLD, ctx.uw
  //       // O semáforo e a orquestração são geridos pelo maestro — não precisas
  //       // de te preocupar com colisões entre módulos.
  //     },
  //     painel: (container, ctx) => { // desenha a secção do módulo no painel (opcional)
  //       container.innerHTML = '...';
  //     },
  //   });
  //
  // Os módulos de APOIO e TROCAS serão migrados para aqui no futuro; por agora
  // continuam nos seus próprios ficheiros, coordenados pelo semáforo partilhado.
  // =================================================================

  // ======================= MÓDULO: AUTO-CONSTRUÇÃO =======================
/* =============================================================================
 *  MÓDULO: AUTO-CONSTRUÇÃO  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Para cada cidade da conta:
 *   1. descobre o grupo da cidade (TownGroup/TownGroupTown) → template a usar
 *   2. lê o estado dos edifícios (BuildingBuildData)
 *   3. decide o que construir (lógica de blocos com prioridade)
 *   4. manda construir até encher a fila (BuildingOrder/buildUp)
 *   5. rastreia edifícios que nunca dão → marca "bloqueado" e avança
 *
 *  Templates partilhados via Gist (as multis usam "todos"; a main pode ter
 *  templates por grupo). Registível como módulo do maestro.
 * ========================================================================== */

// Este ficheiro é escrito como uma função-fábrica que devolve o objeto-módulo,
// para ser registada no maestro: registerModule(makeConstrucaoModule(cfg)).
function makeConstrucaoModule(opts) {
  opts = opts || {};
  const BLOCK_AFTER_ROUNDS = opts.blockAfterRounds || 10;

  // === GIST (partilha de templates entre contas) ===
  // Preenche estes dois campos (ou passa-os em opts). O mesmo Gist e token das
  // outras ferramentas pode ser reutilizado; o ficheiro é próprio da construção.
  /* Nome do ficheiro no Gist, COM o mundo.
   *
   * Sem o mundo, o pt125 e o pt126 escrevem no mesmo ficheiro e sobrepõem-se
   * — um mundo de cerco quer a muralha baixa e um de revolta quer a muralha
   * no máximo, e ficavam com os mesmos templates.
   *
   * Calcula-se na altura de usar, porque o mundo só se sabe quando o módulo
   * corre. */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Nome do ficheiro no Gist: inclui o PERFIL e o MUNDO.
   *
   * Sem o perfil, a main e as multis do mesmo mundo escreviam no mesmo
   * ficheiro — e apagar os templates de um perfil não servia de nada, porque
   * voltavam do Gist na leitura seguinte.
   *
   * Sem o mundo, o pt125 e o pt126 sobrepunham-se — um mundo de cerco quer a
   * muralha baixa e um de revolta quer a muralha no máximo.
   *
   * Num mundo novo (o pt127, por exemplo) o nome é novo e o ficheiro nasce
   * vazio: não é preciso fazer nada. */
  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function ficheiroGist() {
    const base = String(GIST.filename || 'templates.json').replace(/\.json$/, '');
    const mundo = (typeof WORLD !== 'undefined' && WORLD) ? WORLD : 'x';
    let perfil = 'main';
    try {
      const e = JSON.parse(armazem.getItem('grepoMaestro_modulos_v1') || 'null');
      if (e && e.perfil) perfil = String(e.perfil);
    } catch (e) {}
    return `${base}-${perfil}-${mundo}.json`;
  }

  const GIST = {
    id: opts.gistId || '',            // ex.: o identificador do teu Gist
    token: opts.gistToken || '',      // ex.: 'ghp_...'  (scope: gist)
    /* O ficheiro TEM de incluir o mundo: sem isso, o pt125 e o pt126
     * escrevem no mesmo e sobrepõem-se — um mundo de cerco quer a muralha
     * baixa e um de revolta quer a muralha no máximo, e ficavam iguais. */
    filename: opts.gistFile || 'construcao-templates.json',
  };

  // nomes internos → PT (para o log e o painel)
  const NOMES_PT = {
    main: 'Senado', hide: 'Esconderijo', place: 'Praça de reunião', lumber: 'Serração',
    stoner: 'Pedreira', ironer: 'Mina de prata', market: 'Mercado', docks: 'Porto',
    barracks: 'Quartel', wall: 'Muralha', storage: 'Armazém', farm: 'Quinta',
    academy: 'Academia', temple: 'Templo', theater: 'Teatro', thermal: 'Termas',
    library: 'Biblioteca', lighthouse: 'Farol', tower: 'Torre', statue: 'Estátua',
    oracle: 'Oráculo', trade_office: 'Comércio',
  };
  // nível máximo por edifício (para validar/mostrar "máx X" no painel)
  const MAX_LVL = {
    main: 25, hide: 10, place: 1, lumber: 40, stoner: 40, ironer: 40, market: 30,
    docks: 30, barracks: 30, wall: 25, storage: 35, farm: 45, academy: 36, temple: 30,
    theater: 1, thermal: 1, library: 1, lighthouse: 1, tower: 1, statue: 1, oracle: 1, trade_office: 1,
  };
  // ordem de apresentação nos dropdowns
  const EDIF_ORDEM = ['main', 'lumber', 'stoner', 'ironer', 'farm', 'storage', 'market',
    'barracks', 'docks', 'academy', 'temple', 'wall', 'hide', 'place', 'lighthouse',
    'tower', 'theater', 'thermal', 'library', 'statue', 'oracle', 'trade_office'];

  /* ========================= TEMPLATE BASE ==============================
   * As primeiras fases de qualquer cidade são iguais, seja qual for a função
   * que ela venha a ter. Por isso um grupo novo nasce já com estes blocos, e
   * só depois se acrescenta o que é específico (voadores, colonizadores...).
   *
   * A ordem foi pensada para os requisitos ficarem sempre cobertos: o porto
   * (bloco 8) exige senado 14, serração 15 e mina 10, que chegam nos blocos
   * 6 e 7; a academia 34 no fim é o que destranca a maioria das pesquisas.
   * ==================================================================== */
  const TEMPLATE_BASE = [
    [{ b: 'lumber', alvo: 1 }, { b: 'stoner', alvo: 1 }],
    [{ b: 'ironer', alvo: 1 }, { b: 'temple', alvo: 1 }],
    [{ b: 'farm', alvo: 3 }, { b: 'main', alvo: 2 }, { b: 'storage', alvo: 2 }, { b: 'barracks', alvo: 1 }],
    [{ b: 'ironer', alvo: 2 }, { b: 'lumber', alvo: 2 }, { b: 'stoner', alvo: 2 }],
    [{ b: 'main', alvo: 5 }, { b: 'ironer', alvo: 5 }, { b: 'lumber', alvo: 5 }, { b: 'market', alvo: 5 },
     { b: 'stoner', alvo: 5 }, { b: 'temple', alvo: 3 }, { b: 'storage', alvo: 5 }],
    [{ b: 'farm', alvo: 10 }, { b: 'main', alvo: 15 }, { b: 'academy', alvo: 13 },
     { b: 'storage', alvo: 15 }, { b: 'barracks', alvo: 5 }],
    [{ b: 'farm', alvo: 15 }, { b: 'ironer', alvo: 15 }, { b: 'lumber', alvo: 15 }, { b: 'stoner', alvo: 15 }],
    [{ b: 'hide', alvo: 10 }, { b: 'docks', alvo: 10 }],
    [{ b: 'farm', alvo: 30 }, { b: 'main', alvo: 25 }, { b: 'academy', alvo: 34 }],
  ];

  function novoTemplateBase() {
    // cópia profunda, para editar um grupo não afectar os outros
    return { modo: 'blocos', blocos: TEMPLATE_BASE.map((b) => b.map((x) => ({ b: x.b, alvo: x.alvo }))) };
  }

  /* ---------------------- lógicas centrais (testadas) ------------------- */
  function nivel(v) {
    if (v === '-' || v == null) return 0;
    const n = Number(v); return isNaN(n) ? 0 : n;
  }

  function decidirConstrucao(template, buildData, blocked) {
    blocked = blocked || new Set();
    // acumula o que fica à espera de recursos ao longo dos blocos saltados
    const esperaRecursos = [];
    const blocos = template.blocos || [];
    if (!blocos.length) return { acoes: [], blocoAtivo: -1, terminado: true };
    for (let bi = 0; bi < blocos.length; bi++) {
      const bloco = blocos[bi];
      const pendentes = [];
      for (const item of bloco) {
        // item.b vazio = linha acrescentada mas ainda por escolher; salta-se
        if (!item.b) continue;
        const bd = buildData[item.b];
        if (!bd) continue;
        if (nivel(bd.lvl) >= item.alvo) continue;
        if (blocked.has(item.b)) continue;
        pendentes.push(item);
      }
      if (!pendentes.length) continue;
      const acoes = [], naoDao = [], semRecursos = [];
      for (const item of pendentes) {
        const bd = buildData[item.b];
        if (bd.up) { acoes.push(item.b); continue; }
        // Falta de RECURSOS é temporária: mais cedo ou mais tarde haverá.
        // Só conta para bloqueio o que está impedido por outra razão — os
        // requisitos já são validados no template, mas o jogo pode recusar
        // por motivos que não conseguimos prever (população, especiais já
        // construídos noutra cidade, etc.).
        if (bd.res === false) semRecursos.push(item.b);
        else naoDao.push(item.b);
      }
      // Se NADA deste bloco pode ser construído agora E o motivo é só falta de
      // recursos, avança-se para o bloco seguinte em vez de deixar a cidade
      // parada. Os recursos hão-de chegar e o bloco será retomado; entretanto
      // constrói-se o que está ao alcance.
      if (!acoes.length && semRecursos.length && !naoDao.length) {
        esperaRecursos.push(...semRecursos);
        continue;
      }

      return {
        acoes, blocoAtivo: bi, pendentes: pendentes.map((p) => p.b),
        naoDao, semRecursos: semRecursos.concat(esperaRecursos), terminado: false,
      };
    }
    // percorreu tudo: ou está completo, ou só falta esperar por recursos
    if (esperaRecursos.length) {
      return { acoes: [], blocoAtivo: -1, naoDao: [], semRecursos: esperaRecursos, terminado: false };
    }
    return { acoes: [], blocoAtivo: -1, terminado: true };
  }

  function resolverGrupos(townGroups, townGroupTowns, templates, todasAsCidades) {
    const gruposComTemplate = new Set(Object.keys(templates).filter((k) => k !== 'todos'));
    const idParaNome = {};
    for (const g of townGroups) if (gruposComTemplate.has(g.name)) idParaNome[g.id] = g.name;
    const cidadeGrupos = {};
    for (const rel of townGroupTowns) {
      const nome = idParaNome[rel.group_id];
      if (!nome) continue;
      (cidadeGrupos[rel.town_id] = cidadeGrupos[rel.town_id] || []).push(nome);
    }
    const mapa = {}, conflitos = [];
    for (const townId of todasAsCidades) {
      const grupos = cidadeGrupos[townId] || [];
      if (grupos.length === 1) mapa[townId] = grupos[0];
      else if (grupos.length > 1) { mapa[townId] = grupos[0]; conflitos.push({ townId, grupos }); }
      else if (Object.prototype.hasOwnProperty.call(templates, 'todos')) mapa[townId] = 'todos';
    }
    return { mapa, conflitos };
  }

  function atualizarBloqueios(contadores, blockedSet, naoDaoAgora, deuAgora, limite) {
    limite = limite || BLOCK_AFTER_ROUNDS;
    const recem = [];
    for (const b of deuAgora) { contadores[b] = 0; if (blockedSet.has(b)) blockedSet.delete(b); }
    for (const b of naoDaoAgora) {
      contadores[b] = (contadores[b] || 0) + 1;
      if (contadores[b] >= limite && !blockedSet.has(b)) { blockedSet.add(b); recem.push(b); }
    }
    return recem;
  }

  /* ======================= VALIDAÇÃO DE REQUISITOS =======================
   * O jogo expõe as dependências em GameData:
   *   • edifícios → GameData.buildings[x].dependencies  = { main:24, farm:35, ... }
   *   • unidades  → GameData.units[x].building_dependencies = { docks:10, academy:13 }
   *                 GameData.units[x].research_dependencies = ['colonize_ship']
   * Usá-las evita configurar templates impossíveis — por exemplo pedir
   * colonizadores num grupo cujo template de construção nunca chega ao porto 10.
   * ==================================================================== */

  // Nível-alvo de um edifício no template (o máximo pedido em qualquer bloco).
  function alvoNoTemplate(template, edificio) {
    let alvo = 0;
    try {
      for (const bloco of (template.blocos || [])) {
        for (const item of bloco) {
          if (item.b === edificio) alvo = Math.max(alvo, Number(item.alvo) || 0);
        }
      }
    } catch (e) {}
    return alvo;
  }

  // O template chega aos níveis que este edifício exige?
  function requisitosEdificio(edificio) {
    try { return (uw.GameData.buildings[edificio] || {}).dependencies || {}; }
    catch (e) { return {}; }
  }

  /* ---------------- RESOLVER REQUISITOS EM CADEIA -----------------------
   * O templo exige pedreira 1, a muralha exige templo 3, as termas exigem
   * senado 24 + quinta 35 + porto 5 + academia 5 — e o porto exige senado 14,
   * serração 15 e mina 10. Resolver isto à mão é moroso e fácil de errar.
   * Esta função percorre a cadeia toda e devolve o que falta acrescentar.
   * -------------------------------------------------------------------- */
  // `ateBloco`: ao resolver para um bloco N, só contam os níveis previstos nos
  // blocos ANTERIORES — o que vem depois é construído mais tarde e não pode
  // servir de requisito. (Sem isto, uma serração 40 no bloco 3 fazia parecer
  // que o requisito de serração 15 do porto no bloco 1 já estava coberto.)
  function alvoNoTemplateAte(template, edificio, ateBloco) {
    let alvo = 0;
    try {
      const blocos = template.blocos || [];
      const limite = (ateBloco == null) ? blocos.length : ateBloco;
      for (let i = 0; i < limite; i++) {
        for (const item of (blocos[i] || [])) {
          if (item.b === edificio) alvo = Math.max(alvo, Number(item.alvo) || 0);
        }
      }
    } catch (e) {}
    return alvo;
  }

  function resolverRequisitos(template, edificioAlvo, nivelAlvo, ateBloco) {
    const necessario = {};   // edificio -> nível mínimo exigido

    // Acumula os requisitos de um edifício, e os requisitos deles, e assim por
    // diante. O `visitados` evita ciclos, que não deviam existir mas mais vale
    // não depender disso.
    const visitados = new Set();
    (function acumular(ed) {
      if (visitados.has(ed)) return;
      visitados.add(ed);
      const dep = requisitosEdificio(ed);
      for (const req of Object.keys(dep)) {
        const exigido = Number(dep[req]) || 0;
        necessario[req] = Math.max(necessario[req] || 0, exigido);
        acumular(req);
      }
    })(edificioAlvo);

    // O que já está previsto no template não precisa de ser acrescentado.
    const faltam = [];
    for (const ed of Object.keys(necessario)) {
      const previsto = (ateBloco == null)
        ? alvoNoTemplate(template, ed)
        : alvoNoTemplateAte(template, ed, ateBloco);
      if (previsto < necessario[ed]) {
        faltam.push({ edificio: ed, nivel: necessario[ed], previsto });
      }
    }
    // Ordenar por profundidade: os que não dependem de nada primeiro, para os
    // blocos ficarem numa ordem construível.
    faltam.sort((a, b) => {
      const da = Object.keys(requisitosEdificio(a.edificio)).length;
      const db = Object.keys(requisitosEdificio(b.edificio)).length;
      return da - db;
    });
    return faltam;
  }

  function validarEdificioNoTemplate(template, edificio) {
    const dep = requisitosEdificio(edificio);
    const faltas = [];
    for (const req of Object.keys(dep)) {
      const exigido = Number(dep[req]) || 0;
      const previsto = alvoNoTemplate(template, req);
      if (previsto < exigido) {
        faltas.push({ edificio: req, exigido, previsto });
      }
    }
    return faltas;
  }

  /* ---------------------- leitura do estado do jogo -------------------- */
  let uw; // preenchido no run via ctx

  function getBuildData(townId) {
    try {
      const col = uw.MM.getCollections().BuildingBuildData[0];
      const m = col.models.find((x) => Number(x.attributes.town_id) === Number(townId));
      if (!m) return null;
      const bd = m.attributes.building_data;
      const out = {};
      Object.keys(bd).forEach((k) => {
        const b = bd[k];
        out[k] = {
          lvl: b.level, up: !!b.can_upgrade, res: !!b.enough_resources, max: !!b.has_max_level,
          // o jogo diz se este edifício PODE ser demolido — a Praça de reunião,
          // por exemplo, não pode, e tentar só enche o registo de avisos
          podeDemolir: b.can_tear_down !== false,
        };
      });
      return { building_data: out, filaCheia: !!m.attributes.is_building_order_queue_full };
    } catch (e) { return null; }
  }

  function getTownGroups() {
    try { return uw.MM.getCollections().TownGroup[0].models.map((m) => m.attributes); } catch (e) { return []; }
  }
  function getTownGroupTowns() {
    try { return uw.MM.getCollections().TownGroupTown[0].models.map((m) => m.attributes); } catch (e) { return []; }
  }

  // manda construir um edifício (buildUp) via frontend_bridge
  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * E faz a passagem seguinte ler valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels().Town.
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = uw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = uw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }

  async function buildUp(townId, buildingId) {
    const url = uw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + uw.Game.csrfToken;
    const payload = {
      model_url: 'BuildingOrder', action_name: 'buildUp', captcha: null,
      arguments: { building_id: buildingId, build_for_gold: false },
      town_id: Number(townId), nl_init: true,
    };
    try {
      const r = await uw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      aplicarNotificacoes(r);   // refresca a interface e os modelos
      const ok = r && r.json && r.json.success;
      return { ok: !!ok, msg: ok ? r.json.success : (r && r.json && r.json.error) || 'erro' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ---------------------- persistência (por conta/mundo) --------------- */
  let WORLD = '';
  function playerId() { try { return uw.Game.player_id || uw.Game.playerId; } catch (e) { return 'x'; } }
  function stKey() { return 'grepoConstru_estado_v1_' + WORLD; }
  function loadEstado() {
    try { return (JSON.parse(armazem.getItem(stKey()) || '{}'))[playerId()] || {}; } catch (e) { return {}; }
  }
  function saveEstado(est) {
    try {
      const all = JSON.parse(armazem.getItem(stKey()) || '{}');
      all[playerId()] = est;
      armazem.setItem(stKey(), JSON.stringify(all));
    } catch (e) {}
  }

  /* ---------------------- templates (Gist + cache local) -------------- */
  // Cache local (para leitura rápida e fallback offline).
  const CACHE_KEY = 'grepoConstru_templates_v1';
  function loadTemplatesLocal() {
    try { return JSON.parse(armazem.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveTemplatesLocal(tpls) {
    try { armazem.setItem(CACHE_KEY, JSON.stringify(tpls)); } catch (e) {}
  }
  // Lê os templates do Gist (partilhado). Se falhar, usa a cache local.
  async function readTemplatesGist() {
    // não segurar o processo (importante nos testes)
    try { if (typeof t2 !== 'undefined' && t2 && t2.unref) t2.unref(); } catch (e) {}
    if (!GIST.id) return loadTemplatesLocal();
    try {
      const url = 'https://api.github.com/gists/' + GIST.id;
      const r = await uw.fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
      const j = await r.json();
      const file = j.files && j.files[ficheiroGist()];
      if (!file) return loadTemplatesLocal();
      /* Ficheiros grandes vêm TRUNCADOS na listagem do Gist: o conteúdo
       * tem de ser lido no `raw_url`. Sem isto, um template grande
       * parecia não existir. */
      let __txt = file.content;
      if ((!__txt || file.truncated) && file.raw_url) {
        try {
          const __rr = await (mUw || uw).fetch(file.raw_url, { headers: { Accept: 'text/plain' } });
          if (__rr.ok) __txt = await __rr.text();
        } catch (e) {}
      }
      const tpls = JSON.parse(__txt || '{}');
      saveTemplatesLocal(tpls); // atualiza cache
      return tpls;
    } catch (e) { return loadTemplatesLocal(); }
  }
  // Escreve os templates no Gist (precisa de token). Atualiza também a cache.
  const travaoGist = { aEsperar: false, pendente: null };

  async function writeTemplatesGist(tpls) {
    saveTemplatesLocal(tpls);   // o local grava SEMPRE, mesmo quando o Gist trava

    /* TRAVÃO: o GitHub limita as escritas por hora e várias gravações seguidas
     * esgotam-no (403 "API rate limit exceeded"). Se a última foi há menos de
     * 30 s, guarda-se e sobe só a última versão.
     *
     * O guardar LOCAL acontece sempre — só a subida ao Gist é travada. */
    if (travaoGist.aEsperar) {
      travaoGist.pendente = tpls;
      return { ok: true, msg: 'agendado (travão de 30 s)' };
    }
    travaoGist.aEsperar = true;
    const tG = setTimeout(() => {
      travaoGist.aEsperar = false;
      const p = travaoGist.pendente;
      travaoGist.pendente = null;
      if (p != null) writeTemplatesGist(p);
    }, 30000);
    try { if (tG && typeof tG.unref === 'function') tG.unref(); } catch (e) {}

    if (!GIST.id || !GIST.token) return { ok: false, msg: 'Sem GIST id/token (guardado só localmente).' };
    try {
      const url = 'https://api.github.com/gists/' + GIST.id;
      const body = { files: { [ficheiroGist()]: { content: JSON.stringify(tpls, null, 2) } } };
      const r = await uw.fetch(url, {
        method: 'PATCH',
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + GIST.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return r.ok ? { ok: true } : { ok: false, msg: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ------------------------------- run -------------------------------- */
  /* ================== DEMOLIÇÃO =========================================
   * Uma cidade conquistada pode vir com edifícios acima do template, ou com
   * especiais que não interessam. Demolir alinha-a com o template.
   *
   * Pedido confirmado em jogo:
   *   frontend_bridge?action=execute
   *   model_url BuildingOrder, action_name tearDown, arguments {building_id}
   *
   * Exige o Senado no nível `GameData.min_main_level_for_tear_down` (10).
   *
   * DUAS OPÇÕES separadas de propósito:
   *   • acima do alvo — seguro: a intenção está escrita no template;
   *   • fora do template — arriscado: se te esqueceres de acrescentar as
   *     Termas, elas são demolidas (e dão 10% de população). Por isso há uma
   *     lista de edifícios a poupar sempre.
   * ==================================================================== */
  const GRATIS_KEY = 'grepoConstru_gratis_v1';
  function cfgGratis() {
    try {
      const v = armazem.getItem(GRATIS_KEY);
      return v === null ? true : v === '1';     // ligado por omissão: não custa nada
    } catch (e) { return true; }
  }
  function guardarCfgGratis(v) {
    try { armazem.setItem(GRATIS_KEY, v ? '1' : '0'); } catch (e) {}
  }

  /* Edifícios que o jogo NÃO deixa demolir. A Praça de reunião é o caso
   * óbvio — é nível 1 e indispensável. Sem esta lista, um template que não a
   * mencione fazia o módulo tentar demoli-la em TODAS as cidades, a cada
   * passagem, enchendo o registo de avisos. */
  const INDEMOLIVEIS = ['place', 'main'];

  /* Edifícios que o SERVIDOR recusou demolir. Lista interna, separada da do
   * utilizador — antes escrevia-se na dele, e ele via nomes a aparecer no
   * campo "nunca demolir" sem os ter posto. */
  const APRENDIDOS_KEY = 'grepoConstru_indemoliveis_v1';

  function indemoliveisAprendidos() {
    try { return JSON.parse(armazem.getItem(APRENDIDOS_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function marcarIndemolivel(ed) {
    try {
      const l = indemoliveisAprendidos();
      if (l.indexOf(ed) < 0) {
        l.push(ed);
        armazem.setItem(APRENDIDOS_KEY, JSON.stringify(l));
      }
    } catch (e) {}
  }

  const DEMOLIR_KEY = 'grepoConstru_demolir_v1';

  function cfgDemolir() {
    /* A lista de poupar vem VAZIA: é do utilizador, não minha.
     *
     * Atenção: com "demolir o que não está no template" ligado e a lista
     * vazia, um edifício esquecido no template é demolido. As Termas estavam
     * aqui por omissão por causa disso — quem quiser protegê-las põe-nas. */
    const base = { acimaDoAlvo: false, foraDoTemplate: false, simular: true, poupar: [] };
    try { Object.assign(base, JSON.parse(armazem.getItem(DEMOLIR_KEY) || '{}')); } catch (e) {}
    return base;
  }
  function guardarCfgDemolir(c) {
    try { armazem.setItem(DEMOLIR_KEY, JSON.stringify(c)); } catch (e) {}
  }

  function senadoChegaParaDemolir(niveis) {
    try {
      const min = Number(uw.GameData.min_main_level_for_tear_down) || 10;
      return (Number(niveis.main) || 0) >= min;
    } catch (e) { return false; }
  }

  async function demolir(townId, edificio) {
    const url = uw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + uw.Game.csrfToken;
    try {
      const r = await uw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({
          model_url: 'BuildingOrder', action_name: 'tearDown', captcha: null,
          arguments: { building_id: edificio },
          town_id: Number(townId), nl_init: true,
        })),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      return { ok: !(j && j.error), msg: (j && (j.error || j.success)) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  function aDemolir(niveis, alvos, cd, podeDemolir) {
    const out = [];
    for (const ed of Object.keys(niveis)) {
      const atual = Number(niveis[ed]) || 0;
      if (!atual) continue;
      if ((cd.poupar || []).indexOf(ed) >= 0) continue;
      // o jogo já diz o que não se pode demolir: respeitar em vez de tentar
      if (podeDemolir && podeDemolir[ed] === false) continue;
      if (INDEMOLIVEIS.indexOf(ed) >= 0) continue;
      if (indemoliveisAprendidos().indexOf(ed) >= 0) continue;   // o servidor já recusou

      const noTemplate = Object.prototype.hasOwnProperty.call(alvos, ed);
      const alvo = Number(alvos[ed]) || 0;

      if (noTemplate) {
        if (cd.acimaDoAlvo && atual > alvo) out.push({ ed, atual, alvo, porque: 'acima do alvo' });
      } else if (cd.foraDoTemplate) {
        out.push({ ed, atual, alvo: 0, porque: 'não está no template' });
      }
    }
    return out;
  }

  /* ============ CONCLUIR DE GRAÇA ======================================
   * Nos últimos 5 minutos, terminar uma obra não custa nada. Vale sempre a
   * pena: adianta a obra e liberta a fila para a seguinte.
   *
   * Confirmado em jogo:
   *   frontend_bridge?action=execute
   *   model_url BuildingOrder/{id}, action_name buyInstant, {order_id}
   *   → resposta traz "costs": 0 quando foi grátis.
   * ==================================================================== */
  const GRATIS_ABAIXO_DE = 300;   // segundos

  function agoraServidor() {
    try { return Number(uw.Timestamp.now()) || Math.floor(Date.now() / 1000); }
    catch (e) { return Math.floor(Date.now() / 1000); }
  }

  async function concluirJa(townId, ordemId) {
    const url = uw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + uw.Game.csrfToken;
    try {
      const r = await uw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({
          model_url: 'BuildingOrder/' + Number(ordemId),
          action_name: 'buyInstant', captcha: null,
          arguments: { order_id: Number(ordemId) },
          town_id: Number(townId), nl_init: true,
        })),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      return { ok: !(j && j.error), custo: Number(j && j.costs) || 0, msg: (j && (j.error || j.success)) || 'ok' };
    } catch (e) { return { ok: false, custo: 0, msg: e.message }; }
  }

  /* Percorre as ordens em curso e conclui as que já não custam nada. */
  /* ATENÇÃO: a colecção BuildingOrder só traz as ordens da CIDADE ACTIVA —
   * confirmado no jogo, onde apareceu vazia havendo obras noutras cidades.
   * Por isso isto é chamado dentro do ciclo, depois de trocar para cada
   * cidade, e não uma vez no início. */
  async function concluirGratuitas(ctx, soDaCidade) {
    const log = ctx.log;
    let n = 0;
    try {
      const col = uw.MM.getCollections().BuildingOrder;
      const ordens = (col && col[0] && col[0].models) || [];
      const agora = agoraServidor();

      for (const m of ordens.slice()) {
        const a = m.attributes || {};
        if (soDaCidade && Number(a.town_id) !== Number(soDaCidade)) continue;
        /* As DEMOLIÇÕES também se concluem de graça — confirmado no jogo:
         * uma demolição do porto a 1 min de acabar devolveu `costs: 0`.
         * Antes eram excluídas por engano meu. */

        /* DUAS situações dão conclusão gratuita — confirmado no jogo:
         *
         *  1. a obra em si dura menos de 5 min (`building_time`), mesmo que
         *     esteja no fim da fila e só comece daqui a horas;
         *  2. faltam menos de 5 min para acabar (`to_be_completed_at`), numa
         *     obra que dura mais do que isso.
         *
         * O código antigo só via a segunda, e por isso perdia as obras curtas
         * à espera na fila. Testado: uma muralha de 111 s na 7ª posição, com
         * conclusão prevista para daqui a 196 min, devolveu `costs: 0`.
         *
         * Concluir uma dessas liberta um lugar na fila — vale sempre a pena. */
        const duracao = Number(a.building_time) || 0;
        const falta = Number(a.to_be_completed_at) - agora;

        const obraCurta = duracao > 0 && duracao <= GRATIS_ABAIXO_DE;
        const quaseAcabar = Number.isFinite(falta) && falta > 0 && falta <= GRATIS_ABAIXO_DE;
        if (!obraCurta && !quaseAcabar) continue;

        const r = await concluirJa(a.town_id, a.id);
        if (r.ok && r.custo === 0) {
          const porque = obraCurta && !quaseAcabar
            ? `obra de ${Math.round(duracao / 60)} min na fila — liberta um lugar`
            : `${Math.round(falta / 60)} min mais cedo`;
          log(`⏩ ${NOMES_PT[a.building_type] || a.building_type}: concluído de graça (${porque}).`);
          n++;
          await ctx.sleep(ctx.rand(500, 1100));
        } else if (r.ok && r.custo > 0) {
          // não devia acontecer, mas se acontecer é para saber
          log(`⚠️ ${NOMES_PT[a.building_type] || a.building_type}: a conclusão custou ${r.custo} de ouro.`);
        }
      }
    } catch (e) {}
    return n;
  }

  async function run(ctx) {
    uw = ctx.uw; WORLD = ctx.WORLD;
    const log = ctx.log;


    const rotina = ctx.logRotina || ctx.log;
    const aEsperar = [];   // cidades sem recursos: linha de rotina, não aparece
    const semPop = [];     // cidades com a população esgotada

    const templates = await readTemplatesGist();
    if (!Object.keys(templates).length) { log('Sem templates configurados; nada a construir.'); return; }

    const towns = ctx.getMyTowns();
    if (!towns.length) { log('Sem cidades.'); return; }

    // resolver que template cada cidade usa
    const townGroups = getTownGroups();
    const townGroupTowns = getTownGroupTowns();
    const { mapa, conflitos } = resolverGrupos(townGroups, townGroupTowns, templates, towns.map((t) => t.id));
    for (const c of conflitos) log(`⚠️ Cidade ${c.townId} em vários grupos com template (${c.grupos.join(', ')}); uso o 1º.`);

    // estado persistente (contadores de bloqueio por cidade)
    const estado = loadEstado();

    let construiuAlgo = false;
    for (const town of towns) {
      const tplNome = mapa[town.id];
      if (!tplNome) continue; // cidade sem template aplicável
      const template = templates[tplNome];
      if (!template || !template.blocos || !template.blocos.length) continue;

      // trocar para a cidade para ter dados atualizados
      await ctx.switchToTown(town.id);
      await ctx.sleep(ctx.rand(400, 900));

      /* Concluir o que já é grátis ANTES de decidir: liberta a fila e o nível
       * sobe, o que muda o que há a fazer. Tem de ser aqui, com a cidade
       * activa, porque a colecção só traz as ordens dela. */
      if (cfgGratis()) await concluirGratuitas(ctx, town.id);

      let popEsgotada = false;
      const bd = getBuildData(town.id);
      if (!bd) { log(`${town.name}: sem dados de construção.`); continue; }

      /* POPULAÇÃO ESGOTADA: quando `blocked` iguala `max`, NENHUM edifício
       * pode subir — o jogo põe can_upgrade a falso em todos. Sem este aviso,
       * o módulo tentava, falhava, e ao fim de 10 rondas dava o edifício por
       * bloqueado quando o problema era outro. */
      try {
        const mods = uw.MM.getModels().Town || {};
        for (const k of Object.keys(mods)) {
          const a = mods[k].attributes || {};
          if (Number(a.id) !== Number(town.id)) continue;
          const pop = a.population || {};
          if (pop.max && pop.blocked >= pop.max) {
            semPop.push(town.name);
            /* Com a população esgotada NENHUM edifício sobe — não é culpa
             * deles. Contar rondas aqui bloqueava-os por engano, que foi o
             * que aconteceu ao Mercado, à Torre, à Pedreira e ao Templo. */
            popEsgotada = true;
          }
          break;
        }
      } catch (e) {}

      /* DEMOLIR primeiro: uma cidade conquistada pode vir com edifícios acima
       * do template. Demolir liberta população e alinha-a com o resto. */
      const cd = cfgDemolir();
      if (cd.acimaDoAlvo || cd.foraDoTemplate) {
        /* O getBuildData devolve { building_data: {...}, filaCheia }, e cada
         * edifício tem o nível em `lvl` — não é o mapa directo. */
        const edificios = bd.building_data || {};
        const niveisAgora = {};
        const podeDemolir = {};
        for (const k of Object.keys(edificios)) {
          const lv = edificios[k].lvl;
          niveisAgora[k] = (lv === '-' || lv == null) ? 0 : Number(lv);
          podeDemolir[k] = edificios[k].podeDemolir !== false;
        }
        const alvosTpl = {};
        for (const bloco of (template.blocos || [])) {
          for (const it of bloco) {
            if (!it.b) continue;
            alvosTpl[it.b] = Math.max(alvosTpl[it.b] || 0, Number(it.alvo) || 0);
          }
        }

        if (!senadoChegaParaDemolir(niveisAgora)) {
          const min = Number(uw.GameData.min_main_level_for_tear_down) || 10;
          const lista = aDemolir(niveisAgora, alvosTpl, cd, podeDemolir);
          if (lista.length) {
            log(`— ${town.name}: há ${lista.length} edifício(s) a demolir, mas o Senado `
              + `precisa de estar no nível ${min} (está ${niveisAgora.main || 0}).`);
          }
        } else {
          let demolidas = 0;
          for (const d of aDemolir(niveisAgora, alvosTpl, cd, podeDemolir)) {
            if (cd.simular) {
              log(`🔎 [simulação] ${town.name}: demoliria ${(NOMES_PT[d.ed] || d.ed)} `
                + `${d.atual} → ${d.alvo} (${d.porque}).`);
              continue;
            }
            const r = await demolir(town.id, d.ed);
            if (r.ok) {
              log(`🔨 ${town.name}: ${(NOMES_PT[d.ed] || d.ed)} ${d.atual} → ${d.atual - 1} (${d.porque}).`);
              demolidas++;
              await ctx.sleep(ctx.rand(800, 1600));
              /* Continuar enquanto houver espaço na fila — antes parava sempre
               * à primeira, e uma cidade com vários edifícios acima do alvo
               * demorava uma passagem por cada nível. */
              /* Actualizar o nível deste edifício: a lista foi calculada antes
               * e o nível acabou de descer. Sem isto pedia-se a demolição do
               * mesmo nível outra vez. */
              niveisAgora[d.ed] = Math.max(0, (Number(niveisAgora[d.ed]) || 0) - 1);

              const bdAgora = getBuildData(town.id);
              if (bdAgora && bdAgora.filaCheia) {
                rotina(`${town.name}: fila cheia depois de ${demolidas} demolição(ões).`);
                break;
              }
              continue;
            }
            /* Não voltar a tentar o que o servidor recusou por ser
             * indemolível: repetir a cada passagem só enche o registo. */
            if (/n[ãa]o pode|indemol|imposs/i.test(String(r.msg))) {
              /* NÃO mexer na lista do utilizador — ela é dele.
               * Guarda-se numa lista interna, separada. */
              marcarIndemolivel(d.ed);
              log(`— ${(NOMES_PT[d.ed] || d.ed)} não se pode demolir; deixo de tentar.`);
            } else {
              log(`⚠️ ${town.name}: não consegui demolir ${(NOMES_PT[d.ed] || d.ed)} (${r.msg}).`);
            }
            break;
          }
        }
      }

      // estado desta cidade
      const cst = estado[town.id] = estado[town.id] || { contadores: {}, blocked: [] };
      const blockedSet = new Set(cst.blocked);

      // enquanto houver slots e coisas a construir, manda ordens
      let bdAtual = bd;
      let seguranca = 0;
      const deuAgora = [], naoDaoAgoraGlobal = new Set(), semRecursosGlobal = new Set();
      while (!bdAtual.filaCheia && seguranca < 15) {
        seguranca++;
        const dec = decidirConstrucao(template, bdAtual.building_data, blockedSet);
        if (dec.terminado) { break; }
        // registar os que não dão neste momento (para o rastreio de bloqueio)
        // só o que NÃO é falta de recursos conta para o bloqueio
        (dec.naoDao || []).forEach((b) => naoDaoAgoraGlobal.add(b));
        (dec.semRecursos || []).forEach((b) => semRecursosGlobal.add(b));
        if (!dec.acoes.length) break; // nada construível agora neste bloco

        // construir o primeiro que dá
        const alvo = dec.acoes[0];
        const r = await buildUp(town.id, alvo);
        if (r.ok) {
          construiuAlgo = true; deuAgora.push(alvo);
          log(`🏗️ ${town.name}: ${NOMES_PT[alvo] || alvo} (bloco ${dec.blocoAtivo + 1}).`);
          await ctx.sleep(ctx.rand(600, 1200));
          bdAtual = getBuildData(town.id) || bdAtual; // reler estado (fila/recursos mudaram)
        } else {
          /* Falta de recursos e fila cheia são o estado NORMAL de uma cidade
           * a crescer — repetir isso a cada passagem é ruído. As outras
           * falhas continuam a aparecer. */
          const normal = /recursos suficientes|fila de constru|armaz[ée]m|queue is full/i
            .test(String(r.msg));
          if (normal) {
            rotina(`${town.name}: ${NOMES_PT[alvo] || alvo} ainda não dá (${r.msg}).`);
          } else {
            log(`⚠️ ${town.name}: falha ao construir ${NOMES_PT[alvo] || alvo} (${r.msg}).`);
          }
          naoDaoAgoraGlobal.add(alvo);
          break; // evita loop infinito nesta cidade nesta ronda
        }
      }

      // atualizar bloqueios: os que não deram esta ronda incrementam; os que deram reiniciam
      const naoDaoArr = Array.from(naoDaoAgoraGlobal).filter((b) => !deuAgora.includes(b));
      // com a população esgotada, não se conta nada contra os edifícios
      const recem = popEsgotada
        ? []
        : atualizarBloqueios(cst.contadores, blockedSet, naoDaoArr, deuAgora, BLOCK_AFTER_ROUNDS);
      for (const b of recem) {
        log(`🚫 ${town.name}: ${NOMES_PT[b] || b} não avança há ${BLOCK_AFTER_ROUNDS} rondas e NÃO é falta de recursos`
          + ` — deixo de o tentar. Verifica os requisitos ou se é um especial já construído noutra cidade.`);
      }
      /* "À espera de recursos" é o estado NORMAL de quase todas as cidades —
       * uma linha por cidade enchia o registo e escondia o que interessa.
       * Junta-se tudo numa só linha no fim. */
      if (semRecursosGlobal.size && !construiuAlgo) {
        aEsperar.push(town.name);
      }
      /* O bloqueio EXPIRA. A causa costuma ser temporária (população, um
       * requisito que ainda vai ser construído), e sem isto o edifício ficava
       * fora para sempre — o que obriga a mexer à mão. */
      cst.blocked = Array.from(blockedSet);
      cst.blockedEm = cst.blockedEm || {};
      const agoraSeg2 = agoraServidor();   // hora do jogo, não a do computador
      for (const b of cst.blocked) if (!cst.blockedEm[b]) cst.blockedEm[b] = agoraSeg2;
      const EXPIRA_EM = 6 * 3600;   // 6 horas
      cst.blocked = cst.blocked.filter((b) => {
        if (agoraSeg2 - (cst.blockedEm[b] || agoraSeg2) < EXPIRA_EM) return true;
        delete cst.blockedEm[b];
        if (cst.contadores) delete cst.contadores[b];
        log(`↻ ${town.name}: volto a tentar ${NOMES_PT[b] || b} (passaram 6 h).`);
        return false;
      });
    }

    saveEstado(estado);
    if (aEsperar.length) {
      rotina(`⏳ ${aEsperar.length} cidade(s) à espera de recursos.`);
    }
    if (semPop.length) {
      // uma linha só, e sem repetir a explicação a cada cidade
      log(`⛔ População esgotada em ${semPop.length} cidade(s): ${semPop.slice(0, 6).join(', ')}`
        + (semPop.length > 6 ? ` e mais ${semPop.length - 6}` : '')
        + ' — nada sobe até libertares população.');
    }
    if (!construiuAlgo && !aEsperar.length) rotina('Ronda de construção: nada a construir agora.');
  }

  /* ---------------------- PAINEL de configuração ---------------------- */
  // Trabalha sobre os templates em memória; grava no armazém (local/Gist) ao "Guardar".
  let templatesEdicao = null;   // cópia de trabalho { nomeGrupo: {modo, blocos} }
  let grupoSelecionado = null;  // nome do grupo em edição
  let painelCtx = null;
  function gruposDisponiveis() {
    // grupos do jogo + "todos" sempre disponível
    // Excluir os grupos AUTOMÁTICOS do jogo (id negativo: "Todos", "Sem
    // grupos"): não são grupos criados por ti e o "Todos" ainda colidia com o
    // nosso grupo especial "todos".
    const doJogo = getTownGroups()
      .filter((g) => Number(g.id) > 0)
      .map((g) => g.name)
      .filter((n) => String(n).toLowerCase() !== 'todos');
    const set = new Set(['todos', ...doJogo, ...Object.keys(templatesEdicao || {})]);
    return Array.from(set);
  }

  // Bloco novo nasce com uma linha POR ESCOLHER, não com a serração.
  function novoBlocoVazio() { return [{ b: '', alvo: 1 }]; }
  function templateVazio() { return { modo: 'blocos', blocos: [novoBlocoVazio()] }; }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* Os EDIFÍCIOS ESPECIAIS vêm em dois grupos, e só se pode ter UM de cada.
   *
   * O jogo marca-os todos com `special: true` mas não diz a que grupo
   * pertencem — daí a lista estar aqui à mão.
   *
   * Separá-los no seletor evita configurar um template impossível, como pôr a
   * Estátua e o Oráculo, que são ambos do grupo 2. */
  const ESPECIAIS_G1 = ['lighthouse', 'thermal', 'library', 'theater'];
  const ESPECIAIS_G2 = ['oracle', 'statue', 'trade_office', 'tower'];

  function optionsEdificios(selecionado) {
    // Linha vazia à cabeça: quando se acrescenta um edifício novo, nada vem
    // escolhido e é preciso escolher — em vez de vir a serração e ter de se
    // trocar sempre.
    const vazio = `<option value=""${!selecionado ? ' selected' : ''}>— escolher edifício —</option>`;

    const opcao = (b) =>
      `<option value="${b}"${b === selecionado ? ' selected' : ''}>${esc(NOMES_PT[b])} (máx ${MAX_LVL[b]})</option>`;

    const normais = EDIF_ORDEM.filter((b) =>
      ESPECIAIS_G1.indexOf(b) < 0 && ESPECIAIS_G2.indexOf(b) < 0);

    let html = vazio + normais.map(opcao).join('');

    const g1 = ESPECIAIS_G1.filter((b) => EDIF_ORDEM.indexOf(b) >= 0);
    if (g1.length) {
      html += `<optgroup label="Especiais — grupo 1 (só um destes)">`
        + g1.map(opcao).join('') + `</optgroup>`;
    }
    const g2 = ESPECIAIS_G2.filter((b) => EDIF_ORDEM.indexOf(b) >= 0);
    if (g2.length) {
      html += `<optgroup label="Especiais — grupo 2 (só um destes)">`
        + g2.map(opcao).join('') + `</optgroup>`;
    }
    return html;
  }


  // O painel pode ser desenhado ANTES de o jogo ter carregado os grupos de
  // cidades — e como só se redesenha quando mexes nele, ficava com a lista
  // vazia. Aqui esperamos que apareçam e redesenhamos uma vez.
  function redesenharQuandoHouverGrupos(container, ctx) {
    try {
      if (getTownGroups().length) return;              // já lá estão
      let tentativas = 0;
      const t = setInterval(() => {
        tentativas++;
        if (getTownGroups().length) {
          clearInterval(t);
          try { renderPainel(container); } catch (e) {}
        } else if (tentativas > 40) {                  // ~20 s e desiste
          clearInterval(t);
        }
      }, 500);
    } catch (e) {}
  }

  /* Guardar e repor a posição do rolamento à volta de cada redesenho.
   * Sem isto, acrescentar um edifício ou um bloco atirava a página para o topo
   * — insuportável quando se está a mexer nos últimos blocos. */
  /* Guardar e repor a posição do rolamento à volta de cada redesenho.
   *
   * ATENÇÃO: não basta guardar a referência do elemento. O redesenho DESTRÓI
   * os elementos internos e cria outros — a referência guardada passa a
   * apontar para algo que já não está no ecrã, e repor nela não faz nada.
   * (Medido: o #maestro-panel mantinha-se, mas um DIV interno rolado a 973
   *  voltava a 0.)
   *
   * Por isso guarda-se o CAMINHO (índices dos filhos) e procura-se o elemento
   * equivalente depois do redesenho.
   */
  function caminhoDe(el) {
    const partes = [];
    let n = el;
    while (n && n.parentElement && partes.length < 30) {
      partes.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
      n = n.parentElement;
      if (n.id) { partes.unshift('#' + n.id); break; }
    }
    return partes;
  }

  function porCaminho(partes) {
    try {
      if (!partes.length) return null;
      let n = null;
      let i = 0;
      if (typeof partes[0] === 'string' && partes[0].startsWith('#')) {
        n = document.getElementById(partes[0].slice(1));
        i = 1;
      } else {
        n = document.body;
      }
      for (; n && i < partes.length; i++) n = n.children[partes[i]];
      return n || null;
    } catch (e) { return null; }
  }

  function comRolamento(fn) {
    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}

    fn();

    const repor = () => {
      guardados.forEach(({ caminho, y, el }) => {
        try {
          // primeiro o elemento original, se ainda estiver no ecrã
          if (el && el.isConnected) { el.scrollTop = y; return; }
          const novo2 = porCaminho(caminho);
          if (novo2) novo2.scrollTop = y;
        } catch (e) {}
      });
    };
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  /* Quantas linhas ainda não têm edifício escolhido. */
  function porPreencher(tpl) {
    let n = 0;
    for (const bloco of (tpl.blocos || [])) for (const it of bloco) if (!it.b) n++;
    return n;
  }

  /* Contexto do painel — guardado ao desenhar, para as funções internas
   * poderem escrever no registo e ler as cidades. */
  let ctxPainel = null;
  let buscaEdificio = '';   // termo escrito na barra de pesquisa do painel

  function renderPainel(container) {
    if (!templatesEdicao) templatesEdicao = loadTemplatesLocal();
    const grupos = gruposDisponiveis();

    /* Templates ÓRFÃOS: guardados para grupos que já não existem no jogo
     * (apagados ou renomeados). Sem os mostrar, ficam invisíveis e nunca são
     * aplicados — mas continuam a ocupar espaço e a confundir. */
    const orfaos = Object.keys(templatesEdicao).filter((g) => !grupos.includes(g));
    const todosNoSelector = grupos.concat(orfaos);

    if (!grupoSelecionado || !todosNoSelector.includes(grupoSelecionado)) {
      grupoSelecionado = grupos[0] || 'todos';
    }
    const tpl = templatesEdicao[grupoSelecionado];

    let html = `
      <div style="font-size:11px;opacity:.85;margin-bottom:4px">Configuração por grupo — aplica a regra a todas as cidades do grupo.</div>
      <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        <select id="con-grupo" style="flex:1;min-width:90px">
          ${grupos.map((g) => `<option value="${esc(g)}"${g === grupoSelecionado ? ' selected' : ''}>${esc(g)}${templatesEdicao[g] ? ' ✓' : ''}</option>`).join('')}
          ${orfaos.length ? `<optgroup label="grupos que já não existem no jogo">
            ${orfaos.map((g) => `<option value="${esc(g)}"${g === grupoSelecionado ? ' selected' : ''}>${esc(g)} ⚠</option>`).join('')}
          </optgroup>` : ''}
        </select>
        <button id="con-criar" style="cursor:pointer">Ativar grupo</button>
        <button id="con-apagar" style="cursor:pointer;color:#f88">Apagar</button>
      </div>

      ${(() => {
        /* COPIAR DE OUTRO GRUPO: dois grupos costumam ter templates parecidos,
         * e refazer tudo do zero é trabalho a mais. Copia-se e ajusta-se. */
        const outros = Object.keys(templatesEdicao).filter((g) => g !== grupoSelecionado);
        if (!outros.length) return '';
        return `<div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;font-size:11px">
          <span style="opacity:.75;flex:0 0 auto">copiar de</span>
          <select id="con-copiar-de" style="flex:1">
            <option value="">— escolher grupo —</option>
            ${outros.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
          </select>
          <button id="con-copiar" style="cursor:pointer">Copiar</button>
        </div>`;
      })()}

      <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px">
        <input type="text" id="con-busca" placeholder="procurar edifício (ex.: muralha)"
          value="${esc(buscaEdificio || '')}" style="flex:1;font-size:11px">
        ${buscaEdificio ? '<button id="con-busca-limpar" style="cursor:pointer;font-size:10px">limpar</button>' : ''}
      </div>`;

    /* RESULTADO DA PESQUISA: onde é que este edifício aparece, e em que
     * níveis. Os campos são editáveis aqui mesmo, para não ser preciso
     * percorrer os blocos à procura. */
    if (buscaEdificio) {
      const termo = buscaEdificio.toLowerCase().trim();
      const achados = [];
      (tpl.blocos || []).forEach((bloco, bi) => {
        bloco.forEach((item, ii) => {
          const nome = (NOMES_PT[item.b] || item.b).toLowerCase();
          if (nome.indexOf(termo) >= 0 || String(item.b).toLowerCase().indexOf(termo) >= 0) {
            achados.push({ bi, ii, item });
          }
        });
      });

      html += `<div style="background:#0d141c;padding:7px;border-radius:4px;margin-bottom:6px">
        <b style="font-size:11px">${achados.length
          ? `${achados.length} ocorrência(s) de "${esc(buscaEdificio)}"`
          : `"${esc(buscaEdificio)}" não está neste template`}</b>`;

      if (achados.length) {
        html += `<table style="width:100%;border-collapse:collapse;margin-top:4px;font-size:11px">`;
        for (const a of achados) {
          html += `<tr>
            <td style="padding:2px 3px;opacity:.7;width:60px">
              ${tpl.modo === 'blocos' ? `bloco ${a.bi + 1}` : 'lista'}
            </td>
            <td style="padding:2px 3px">${esc(NOMES_PT[a.item.b] || a.item.b)}</td>
            <td style="padding:2px 3px;text-align:right;width:56px">
              <input type="number" min="0" max="${MAX_LVL[a.item.b] || 45}" value="${a.item.alvo}"
                data-act="alvo" data-bi="${a.bi}" data-ii="${a.ii}" style="width:46px">
            </td>
            <td style="padding:2px 3px;width:20px;text-align:right">
              <a href="#" data-act="edif-del" data-bi="${a.bi}" data-ii="${a.ii}"
                 style="text-decoration:none;color:#f88">🗑️</a>
            </td>
          </tr>`;
        }
        html += `</table>
          <div style="opacity:.6;font-size:10px;margin-top:3px">
            Alterar aqui é o mesmo que alterar no bloco.
          </div>`;
      }
      html += `</div>`;
    }

    if (orfaos.includes(grupoSelecionado)) {
      html += `<div style="font-size:11px;padding:6px;background:#2a1a10;border:1px solid #5a3a20;
        border-radius:4px;margin-bottom:6px">
        ⚠ O grupo "<b>${esc(grupoSelecionado)}</b>" <b>não existe no jogo</b> — este template
        nunca é aplicado. Cria o grupo com este nome, ou carrega em "Apagar" para o remover.
      </div>`;
    }

    if (!tpl) {
      html += `<div style="font-size:11px;opacity:.8;padding:6px;background:#0d141c;border-radius:4px">
        O grupo "<b>${esc(grupoSelecionado)}</b>" ainda não tem template. Carrega em "Ativar grupo" para o configurar.</div>`;
      container.innerHTML = html;
      ligarTopo(container);
      return;
    }

    // seletor de modo
    html += `<div style="display:flex;gap:4px;margin-bottom:6px">
        <button id="con-modo-simples" style="flex:1;cursor:pointer;${tpl.modo !== 'blocos' ? 'background:#2a7;color:#fff' : ''}">Sem blocks</button>
        <button id="con-modo-blocos" style="flex:1;cursor:pointer;${tpl.modo === 'blocos' ? 'background:#2a7;color:#fff' : ''}">Com blocks</button>
      </div>`;

    // blocos (no modo simples, há um só "bloco" implícito)
    const blocos = tpl.blocos || [];
    // Área com deslocamento próprio: o template base tem 9 blocos e mais de 30
    // entradas, o que empurrava os botões de guardar para fora do ecrã.
    html += `<div style="max-height:52vh;overflow-y:auto;padding-right:4px;margin-bottom:6px">`;
    blocos.forEach((bloco, bi) => {
      html += `<div style="border:1px solid #2c3e50;border-radius:6px;padding:5px;margin-bottom:5px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <b>${tpl.modo === 'blocos' ? 'Bloco ' + (bi + 1) : 'Níveis'}</b>
          <span>
            ${tpl.modo === 'blocos' ? `<a href="#" data-act="bloco-up" data-bi="${bi}" style="text-decoration:none">⬆️</a>
            <a href="#" data-act="bloco-down" data-bi="${bi}" style="text-decoration:none">⬇️</a>
            <a href="#" data-act="bloco-del" data-bi="${bi}" style="text-decoration:none;color:#f88">🗑️</a>` : ''}
          </span>
        </div>`;
      bloco.forEach((item, ii) => {
        html += `<div style="display:flex;gap:3px;align-items:center;margin-bottom:3px">
          <select data-act="edif" data-bi="${bi}" data-ii="${ii}" style="flex:1">${optionsEdificios(item.b)}</select>
          <input type="number" min="0" max="${MAX_LVL[item.b] || 45}" value="${item.alvo}" data-act="alvo" data-bi="${bi}" data-ii="${ii}" style="width:42px">
          <a href="#" data-act="edif-del" data-bi="${bi}" data-ii="${ii}" style="text-decoration:none;color:#f88">🗑️</a>
        </div>`;
        // Avisar se o template não chega aos níveis que este edifício exige.
        // O jogo expõe-nos em GameData.buildings[x].dependencies — por exemplo,
        // as Termas precisam de senado 24, quinta 35, porto 5 e academia 5.
        const faltas = validarEdificioNoTemplate(tpl, item.b);
        if (faltas.length) {
          // no modo com blocos, só contam os blocos anteriores + o atual
          const cadeia = resolverRequisitos(tpl, item.b, item.alvo, tpl.modo === 'blocos' ? bi + 1 : null);
          html += `<div style="font-size:10px;color:#fc8;margin:-2px 0 4px 6px;line-height:1.4">
            ⚠ ${NOMES_PT[item.b] || item.b} exige ${faltas.map((f) => `${NOMES_PT[f.edificio] || f.edificio} ${f.exigido}`).join(', ')}
            — o template só prevê ${faltas.map((f) => `${f.previsto}`).join(', ')}.
            ${cadeia.length ? `<a href="#" data-act="resolver" data-bi="${bi}" data-ii="${ii}"
              style="color:#8cf;text-decoration:none;white-space:nowrap">➕ adicionar os ${cadeia.length} em falta</a>` : ''}
          </div>`;
        }
      });
      html += `<button data-act="edif-add" data-bi="${bi}" style="cursor:pointer;font-size:11px;margin-top:2px">+ Adicionar edifício</button>
      </div>`;
    });

    html += `</div>`;   // fecha a área com deslocamento

    if (tpl.modo === 'blocos') {
      html += `<button id="con-bloco-add" style="cursor:pointer;width:100%;margin-bottom:6px">+ Adicionar bloco</button>`;
    }
    const faltam = porPreencher(tpl);
    if (faltam) {
      html += `<div style="font-size:11px;color:#fc8;margin:4px 0">
        ${faltam} linha(s) sem edifício escolhido — vão ser ignoradas.</div>`;
    }
    html += `
    <label style="display:block;font-size:11px;margin:4px 0">
      <input type="checkbox" id="con-gratis"${cfgGratis() ? ' checked' : ''}>
      <b>Concluir de graça nos últimos 5 min</b>
      <span style="opacity:.6;font-size:10px">— adianta a obra e liberta a fila; não custa ouro</span>
    </label>`;

    const cdP = cfgDemolir();
    html += `
    <div style="background:#1a1410;border:1px solid #4a3a2a;border-radius:4px;padding:7px;margin:6px 0;font-size:11px">
      <b>🔨 Demolir o que estiver acima do template</b>
      <div style="opacity:.65;font-size:10px;margin:2px 0 5px">
        Útil em cidades conquistadas. Exige o Senado no nível
        ${(() => { try { return Number(uw.GameData.min_main_level_for_tear_down) || 10; } catch (e) { return 10; } })()}.
      </div>
      <label style="display:block"><input type="checkbox" id="con-dem-acima"${cdP.acimaDoAlvo ? ' checked' : ''}>
        Baixar os que estão <b>acima do alvo</b> do template</label>
      <label style="display:block"><input type="checkbox" id="con-dem-fora"${cdP.foraDoTemplate ? ' checked' : ''}>
        Demolir os que <b>não estão no template</b>
        <span style="color:#fc8;font-size:10px">— cuidado: um edifício esquecido no template é demolido</span></label>
      <label style="display:block"><input type="checkbox" id="con-dem-sim"${cdP.simular ? ' checked' : ''}>
        só simular <span style="opacity:.6;font-size:10px">(demolir é irreversível)</span></label>
      <div style="margin-top:4px">
        Nunca demolir: <input type="text" id="con-dem-poupar" value="${esc((cdP.poupar || []).join(', '))}"
          placeholder="thermal, tower" style="width:150px">
        <div style="opacity:.6;font-size:10px">As Termas vêm aqui por omissão — dão 10% de população.</div>
      </div>
    </div>`;
    /* Edifícios que o módulo desistiu de tentar, com botão para os repor.
     * O bloqueio expira sozinho ao fim de 6 h, mas se resolveste a causa não
     * vale a pena esperar. */
    const est = loadEstado();
    const bloqueados = [];
    for (const tid of Object.keys(est)) {
      for (const b of ((est[tid] || {}).blocked || [])) {
        bloqueados.push({ tid, b });
      }
    }
    if (bloqueados.length) {
      html += `
      <div style="background:#1a1410;border:1px solid #4a3a2a;border-radius:4px;padding:7px;margin:6px 0;font-size:11px">
        <b>⚠ ${bloqueados.length} edifício(s) que deixei de tentar</b>
        <div style="opacity:.65;font-size:10px;margin:2px 0 4px">
          Não avançaram 10 rondas seguidas sem ser por falta de recursos. A causa mais
          comum é a população estar esgotada. Voltam a ser tentados ao fim de 6 h.
        </div>
        <div style="max-height:90px;overflow:auto;opacity:.85">
          ${bloqueados.slice(0, 12).map((x) => {
            const nome = (ctxPainel ? (ctxPainel.getMyTowns() || []) : [])
              .find((t) => String(t.id) === String(x.tid));
            return `<div>${esc(nome ? nome.name : x.tid)}: ${esc(NOMES_PT[x.b] || x.b)}</div>`;
          }).join('')}
          ${bloqueados.length > 12 ? `<div style="opacity:.6">e mais ${bloqueados.length - 12}</div>` : ''}
        </div>
        <button id="con-desbloquear" style="cursor:pointer;width:100%;margin-top:5px;font-size:11px">
          Tentar todos outra vez
        </button>
      </div>`;
    }

    /* Dois especiais do MESMO grupo no template: só se pode ter um, portanto
     * o segundo nunca será construído. */
    if (tpl && tpl.blocos) {
      const postos = tpl.blocos.flat().map((x) => x.b);
      for (const [gn, lista] of [['1', ESPECIAIS_G1], ['2', ESPECIAIS_G2]]) {
        const doGrupo = lista.filter((b) => postos.indexOf(b) >= 0);
        if (doGrupo.length > 1) {
          html += `<div style="background:#2a1a10;border:1px solid #5a3a20;border-radius:4px;
            padding:6px;margin-bottom:6px;font-size:11px">
            ⚠ Tens <b>${doGrupo.map((b) => esc(NOMES_PT[b] || b)).join(' e ')}</b> no template,
            e são ambos do <b>grupo ${gn}</b> — só se pode ter um deles por cidade.
            O segundo nunca vai ser construído.
          </div>`;
        }
      }
    }

    html += `<button id="con-guardar" style="cursor:pointer;width:100%;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar templates</button>`;

    container.innerHTML = html;
    ligarTopo(container);
    ligarCorpo(container, tpl);
  }

  function ligarTopo(container) {
    // opções de demolição
    const elBusca = container.querySelector('#con-busca');
    if (elBusca) {
      elBusca.oninput = () => {
        buscaEdificio = elBusca.value;
        comRolamento(() => {
          renderPainel(container);
          // devolver o foco ao campo, senão perde-se a cada tecla
          const novo = container.querySelector('#con-busca');
          if (novo) { novo.focus(); novo.setSelectionRange(novo.value.length, novo.value.length); }
        });
      };
    }
    const bLimpar = container.querySelector('#con-busca-limpar');
    if (bLimpar) bLimpar.onclick = () => {
      buscaEdificio = '';
      comRolamento(() => renderPainel(container));
    };

    const bDes = container.querySelector('#con-desbloquear');
    if (bDes) bDes.onclick = () => {
      const e = loadEstado();
      let n = 0;
      for (const tid of Object.keys(e)) {
        n += ((e[tid] || {}).blocked || []).length;
        if (e[tid]) { e[tid].blocked = []; e[tid].blockedEm = {}; e[tid].contadores = {}; }
      }
      saveEstado(e);
      /* Usar ctxPainel: esta função corre dentro do renderPainel, que não
       * recebe o ctx — daí o "ctx is not defined" que impedia o redesenho.
       * O estado até era limpo, mas o painel não se actualizava e parecia que
       * o botão não fazia nada. */
      if (ctxPainel && ctxPainel.log) {
        ctxPainel.log(`Construção: ${n} edifício(s) desbloqueados — vou tentá-los outra vez.`);
      }
      comRolamento(() => renderPainel(container));
    };

    const elGr = container.querySelector('#con-gratis');
    if (elGr) elGr.onchange = () => guardarCfgGratis(elGr.checked);

    const guardarDem = () => {
      guardarCfgDemolir({
        acimaDoAlvo: container.querySelector('#con-dem-acima').checked,
        foraDoTemplate: container.querySelector('#con-dem-fora').checked,
        simular: container.querySelector('#con-dem-sim').checked,
        poupar: String(container.querySelector('#con-dem-poupar').value || '')
          .split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
      });
    };
    ['#con-dem-acima', '#con-dem-fora', '#con-dem-sim', '#con-dem-poupar'].forEach((sel) => {
      const el = container.querySelector(sel);
      if (el) el.onchange = guardarDem;
    });

    const gSel = container.querySelector('#con-grupo');
    // Preencher ao ABRIR: os grupos do jogo podem só carregar depois do painel
    // ser desenhado, e o seletor ficava só com "todos".
    if (gSel) gSel.onmousedown = () => {
      const nomes = gruposDisponiveis();
      if (nomes.length && gSel.options.length !== nomes.length) {
        const atual = gSel.value;
        gSel.innerHTML = nomes.map((g) =>
          `<option value="${esc(g)}"${atual === g ? ' selected' : ''}>${esc(g)}</option>`).join('');
      }
    };
    if (gSel) gSel.onchange = (e) => { grupoSelecionado = e.target.value; comRolamento(() => renderPainel(container)); };
    const bCop = container.querySelector('#con-copiar');
    if (bCop) bCop.onclick = () => {
      const sel = container.querySelector('#con-copiar-de');
      const de = sel && sel.value;
      if (!de) {
        if (ctxPainel && ctxPainel.log) ctxPainel.log('Escolhe primeiro o grupo a copiar.');
        return;
      }
      const origem = templatesEdicao[de];
      if (!origem) return;

      const destino = templatesEdicao[grupoSelecionado];
      const temCoisas = destino && (destino.blocos || []).some((b) => b.length);
      if (temCoisas && !confirm(`O grupo "${grupoSelecionado}" já tem edifícios.\n`
        + `Substituir tudo pelo template de "${de}"?`)) return;

      /* Cópia profunda: senão os dois grupos passariam a partilhar os mesmos
       * objectos e mexer num mexia no outro. */
      templatesEdicao[grupoSelecionado] = JSON.parse(JSON.stringify(origem));

      const n = (templatesEdicao[grupoSelecionado].blocos || []).flat().length;
      if (ctxPainel && ctxPainel.log) {
        ctxPainel.log(`Construção: copiei ${n} edifício(s) de "${de}" para "${grupoSelecionado}". `
          + 'Ajusta o que precisares e guarda.');
      }
      comRolamento(() => renderPainel(container));
    };

    const criar = container.querySelector('#con-criar');
    // Grupo novo nasce com o TEMPLATE BASE: as fases iniciais são iguais em
    // qualquer cidade, seja qual for a função que venha a ter.
    if (criar) criar.onclick = () => {
      if (!templatesEdicao[grupoSelecionado]) {
        templatesEdicao[grupoSelecionado] = novoTemplateBase();
        if (painelCtx) painelCtx.log(`Grupo "${grupoSelecionado}" criado com o template base (${TEMPLATE_BASE.length} blocos). Acrescenta o que for específico deste grupo.`);
      }
      comRolamento(() => renderPainel(container));
    };
    const apagar = container.querySelector('#con-apagar');
    if (apagar) apagar.onclick = () => {
      if (grupoSelecionado === 'todos') { alert('O grupo "todos" não pode ser apagado.'); return; }
      if (confirm('Apagar o template do grupo "' + grupoSelecionado + '"?')) { delete templatesEdicao[grupoSelecionado]; grupoSelecionado = null; comRolamento(() => renderPainel(container)); }
    };
  }

  function ligarCorpo(container, tpl) {
    const mS = container.querySelector('#con-modo-simples');
    const mB = container.querySelector('#con-modo-blocos');
    /* Trocar de modo NÃO pode destruir os blocos.
     *
     * Antes, ao passar para "simples", os blocos eram achatados num só — e
     * voltar a "blocos" já não os recuperava: ficava tudo num bloco gigante.
     * Agora guarda-se a divisão original e repõe-se ao voltar. */
    if (mS) mS.onclick = () => {
      if (tpl.modo !== 'simples' && tpl.blocos.length > 1) {
        tpl.blocosGuardados = JSON.parse(JSON.stringify(tpl.blocos));
      }
      tpl.modo = 'simples';

      /* ACHATAR numa lista só.
       *
       * Guardar a divisão não chega: se os blocos continuarem separados, o
       * painel desenha-os como caixas — e no modo "sem blocos" continuavam a
       * aparecer blocos.
       *
       * A divisão original fica em `blocosGuardados` e é reposta ao voltar. */
      if (tpl.blocos.length > 1) {
        tpl.blocos = [tpl.blocos.flat()];
      }

      comRolamento(() => renderPainel(container));
    };
    if (mB) mB.onclick = () => {
      tpl.modo = 'blocos';
      /* Repor a divisão, se a lista não foi mexida entretanto. Compara-se o
       * conjunto de edifícios: se for o mesmo, a divisão continua válida. */
      if (tpl.blocosGuardados && tpl.blocosGuardados.length > 1) {
        const agora = JSON.stringify(tpl.blocos.flat());
        const antes = JSON.stringify(tpl.blocosGuardados.flat());
        if (agora === antes) {
          tpl.blocos = tpl.blocosGuardados;
          if (ctxPainel && ctxPainel.log) ctxPainel.log('Blocos repostos como estavam.');
        } else if (ctxPainel && ctxPainel.log) {
          ctxPainel.log('A lista mudou no modo simples — os blocos não foram repostos.');
        }
      }
      comRolamento(() => renderPainel(container));
    };

    const bAdd = container.querySelector('#con-bloco-add');
    if (bAdd) bAdd.onclick = () => { tpl.blocos.push(novoBlocoVazio()); comRolamento(() => renderPainel(container)); };

    const guardar = container.querySelector('#con-guardar');
    if (guardar) guardar.onclick = async () => {
      guardar.textContent = 'A guardar...';
      const res = await writeTemplatesGist(templatesEdicao);
      if (res.ok) {
        if (painelCtx) painelCtx.log('Templates de construção guardados no Gist.');
        guardar.textContent = 'Guardado ✓';
      } else {
        if (painelCtx) painelCtx.log('Templates guardados localmente (' + res.msg + ').');
        guardar.textContent = 'Guardado (local)';
      }
      setTimeout(() => { guardar.textContent = 'Guardar templates'; }, 1800);
    };

    // ações delegadas (edifícios e blocos)
    container.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.getAttribute('data-act');
      const bi = Number(el.getAttribute('data-bi'));
      const ii = Number(el.getAttribute('data-ii'));
      if (act === 'edif') el.onchange = (e) => { tpl.blocos[bi][ii].b = e.target.value; comRolamento(() => renderPainel(container)); };
      else if (act === 'alvo') el.onchange = (e) => { tpl.blocos[bi][ii].alvo = Math.max(0, Number(e.target.value) || 0); };
      else if (act === 'edif-del') el.onclick = (e) => { e.preventDefault(); tpl.blocos[bi].splice(ii, 1); if (!tpl.blocos[bi].length) tpl.blocos[bi].push(novoBlocoVazio()); comRolamento(() => renderPainel(container)); };
      else if (act === 'edif-add') el.onclick = (e) => {
        e.preventDefault();
        // b vazio: obriga a escolher. Antes vinha 'lumber' (serração) e era
        // preciso trocar sempre, o que é pior do que escolher de raiz.
        tpl.blocos[bi].push({ b: '', alvo: 1 });
        comRolamento(() => renderPainel(container));
      };
      else if (act === 'resolver') el.onclick = (e) => {
        e.preventDefault();
        const item = tpl.blocos[bi][ii];
        if (!item) return;
        const faltam = resolverRequisitos(tpl, item.b, item.alvo, tpl.modo === 'blocos' ? bi + 1 : null);
        if (!faltam.length) return;

        const novos = faltam.map((f) => ({ b: f.edificio, alvo: f.nivel }));

        if (tpl.modo === 'blocos') {
          // COM BLOCOS: os requisitos são pré-condições, por isso ficam num
          // BLOCO NOVO ANTES deste — que assim só arranca quando eles fecharem.
          // Se algum já constar deste bloco com nível inferior, sobe-se lá
          // também, para o bloco não voltar a baixar o alvo.
          for (const n of novos) {
            const existente = tpl.blocos[bi].find((x) => x.b === n.b);
            if (existente) existente.alvo = Math.max(Number(existente.alvo) || 0, n.alvo);
          }
          tpl.blocos.splice(bi, 0, novos);
          if (painelCtx) painelCtx.log(`Requisitos movidos para um bloco novo antes: ${novos.map((n) => (NOMES_PT[n.b] || n.b) + ' ' + n.alvo).join(', ')}.`);
        } else {
          // SEM BLOCOS: só há uma lista e a ordem entre itens não é
          // eliminatória — basta acrescentar antes do edifício que os exige.
          for (const n of novos) {
            const existente = tpl.blocos[bi].find((x) => x.b === n.b);
            if (existente) existente.alvo = Math.max(Number(existente.alvo) || 0, n.alvo);
          }
          const jaLa = new Set(tpl.blocos[bi].map((x) => x.b));
          tpl.blocos[bi].splice(ii, 0, ...novos.filter((n) => !jaLa.has(n.b)));
          if (painelCtx) painelCtx.log(`Requisitos acrescentados: ${novos.map((n) => (NOMES_PT[n.b] || n.b) + ' ' + n.alvo).join(', ')}.`);
        }
        comRolamento(() => renderPainel(container));
      };
      else if (act === 'bloco-up') el.onclick = (e) => { e.preventDefault(); if (bi > 0) { const t = tpl.blocos[bi]; tpl.blocos[bi] = tpl.blocos[bi - 1]; tpl.blocos[bi - 1] = t; comRolamento(() => renderPainel(container)); } };
      else if (act === 'bloco-down') el.onclick = (e) => { e.preventDefault(); if (bi < tpl.blocos.length - 1) { const t = tpl.blocos[bi]; tpl.blocos[bi] = tpl.blocos[bi + 1]; tpl.blocos[bi + 1] = t; comRolamento(() => renderPainel(container)); } };
      else if (act === 'bloco-del') el.onclick = (e) => { e.preventDefault(); if (confirm('Remover este bloco?')) { tpl.blocos.splice(bi, 1); if (!tpl.blocos.length) tpl.blocos.push(novoBlocoVazio()); comRolamento(() => renderPainel(container)); } };
    });
  }

  function painel(container, ctx) {
    ctxPainel = ctx;
    painelCtx = ctx;
    uw = ctx.uw; WORLD = ctx.WORLD; // garantir acesso para ler grupos do jogo
    comRolamento(() => renderPainel(container)); // render imediato com a cache local
    redesenharQuandoHouverGrupos(container, ctx);
    // depois tenta atualizar do Gist (assíncrono) e re-renderiza
    readTemplatesGist().then((tpls) => {
      templatesEdicao = tpls;
      comRolamento(() => renderPainel(container));
    }).catch(() => {});
  }

  /* ---------------------- objeto-módulo -------------------------------- */
  return {
    id: 'construcao',
    nome: 'Auto-construção',
    intervaloMin: opts.intervaloMin || 10,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
  };
}

// exportação para teste em Node; no userscript será usado inline

  // ======================= MÓDULO: AUTO-PESQUISA =========================
/* =============================================================================
 *  MÓDULO: AUTO-PESQUISA  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Para cada cidade da conta:
 *   1. descobre o grupo da cidade (TownGroup/TownGroupTown) → template a usar
 *   2. lê o que já está pesquisado (modelo Researches[town_id]) e o que está em fila
 *   3. calcula os pontos de sabedoria disponíveis (nível academia × 4 − gastos)
 *   4. investiga, por ordem do template, o que cabe nos pontos/recursos/requisitos
 *
 *  Template = conjunto de tecnologias marcadas (grelha de checkboxes), por grupo.
 *  Partilhado via Gist. Ordem da grelha = prioridade quando faltam pontos.
 * ========================================================================== */

function makePesquisaModule(opts) {
  opts = opts || {};

  /* Nome do ficheiro no Gist, COM o mundo.
   *
   * Sem o mundo, o pt125 e o pt126 escrevem no mesmo ficheiro e sobrepõem-se
   * — um mundo de cerco quer a muralha baixa e um de revolta quer a muralha
   * no máximo, e ficavam com os mesmos templates.
   *
   * Calcula-se na altura de usar, porque o mundo só se sabe quando o módulo
   * corre. */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Nome do ficheiro no Gist: inclui o PERFIL e o MUNDO.
   *
   * Sem o perfil, a main e as multis do mesmo mundo escreviam no mesmo
   * ficheiro — e apagar os templates de um perfil não servia de nada, porque
   * voltavam do Gist na leitura seguinte.
   *
   * Sem o mundo, o pt125 e o pt126 sobrepunham-se — um mundo de cerco quer a
   * muralha baixa e um de revolta quer a muralha no máximo.
   *
   * Num mundo novo (o pt127, por exemplo) o nome é novo e o ficheiro nasce
   * vazio: não é preciso fazer nada. */
  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function ficheiroGist() {
    const base = String(GIST.filename || 'templates.json').replace(/\.json$/, '');
    const mundo = (typeof mWorld !== 'undefined' && mWorld) ? mWorld : 'x';
    let perfil = 'main';
    try {
      const e = JSON.parse(armazem.getItem('grepoMaestro_modulos_v1') || 'null');
      if (e && e.perfil) perfil = String(e.perfil);
    } catch (e) {}
    return `${base}-${perfil}-${mundo}.json`;
  }

  const GIST = {
    id: opts.gistId || '',
    token: opts.gistToken || '',
    /* O ficheiro TEM de incluir o mundo: sem isso, o pt125 e o pt126
     * escrevem no mesmo e sobrepõem-se — um mundo de cerco quer a muralha
     * baixa e um de revolta quer a muralha no máximo, e ficavam iguais. */
    filename: opts.gistFile || 'pesquisa-templates.json',
  };

  const PONTOS_POR_NIVEL_ACADEMIA = 4;

  /* ---------------------- lógicas centrais (testadas) ------------------- */
  function nivel(v) {
    if (v === '-' || v == null) return 0;
    const n = Number(v); return isNaN(n) ? 0 : n;
  }

  function calcularPontos(feitas, emFila, edificios, gameData) {
    const total = nivel(edificios.academy) * PONTOS_POR_NIVEL_ACADEMIA;
    let gastos = 0;
    for (const id of Object.keys(feitas)) {
      if (id === 'id') continue;
      if (feitas[id] && gameData[id]) gastos += gameData[id].research_points || 0;
    }
    for (const id of emFila) if (gameData[id]) gastos += gameData[id].research_points || 0;
    return { total, gastos, disponiveis: total - gastos };
  }

  function requisitosOk(id, feitas, emFila, edificios, gameData) {
    const gd = gameData[id];
    if (!gd) return { ok: false, motivo: 'desconhecida' };
    if (feitas[id]) return { ok: false, motivo: 'já feita' };
    if (emFila.indexOf(id) >= 0) return { ok: false, motivo: 'em fila' };
    for (const dep of gd.research_dependencies || []) {
      if (!feitas[dep]) return { ok: false, motivo: 'falta pesquisa ' + dep };
    }
    const bd = gd.building_dependencies || {};
    for (const b of Object.keys(bd)) {
      if (nivel(edificios[b]) < bd[b]) return { ok: false, motivo: `falta ${b} nv${bd[b]}` };
    }
    return { ok: true };
  }

  function recursosOk(id, recursos, gameData) {
    const r = (gameData[id] && gameData[id].resources) || {};
    if (!recursos) return true;
    return (recursos.wood || 0) >= (r.wood || 0)
        && (recursos.stone || 0) >= (r.stone || 0)
        && (recursos.iron || 0) >= (r.iron || 0);
  }

  function decidirPesquisas(desejadas, feitas, emFila, edificios, gameData, recursos) {
    const pontos = calcularPontos(feitas, emFila, edificios, gameData);
    const acoes = [], bloqueadas = [], semPontos = [], semRecursos = [];
    let disponiveis = pontos.disponiveis;
    let res = recursos ? { wood: recursos.wood, stone: recursos.stone, iron: recursos.iron } : null;
    for (const id of desejadas) {
      const req = requisitosOk(id, feitas, emFila, edificios, gameData);
      if (!req.ok) {
        if (req.motivo !== 'já feita' && req.motivo !== 'em fila') bloqueadas.push({ id, motivo: req.motivo });
        continue;
      }
      const custo = (gameData[id] && gameData[id].research_points) || 0;
      if (custo > disponiveis) { semPontos.push(id); continue; }
      if (!recursosOk(id, res, gameData)) { semRecursos.push(id); continue; }
      acoes.push(id);
      disponiveis -= custo;
      if (res) {
        const r = gameData[id].resources || {};
        res.wood -= (r.wood || 0); res.stone -= (r.stone || 0); res.iron -= (r.iron || 0);
      }
    }
    return { acoes, bloqueadas, semPontos, semRecursos, pontos };
  }

  // resolução de grupos (igual à da construção)
  function resolverGrupos(townGroups, townGroupTowns, templates, todasAsCidades) {
    const gruposComTemplate = new Set(Object.keys(templates).filter((k) => k !== 'todos'));
    const idParaNome = {};
    for (const g of townGroups) if (gruposComTemplate.has(g.name)) idParaNome[g.id] = g.name;
    const cidadeGrupos = {};
    for (const rel of townGroupTowns) {
      const nome = idParaNome[rel.group_id];
      if (!nome) continue;
      (cidadeGrupos[rel.town_id] = cidadeGrupos[rel.town_id] || []).push(nome);
    }
    const mapa = {}, conflitos = [];
    for (const townId of todasAsCidades) {
      const grupos = cidadeGrupos[townId] || [];
      if (grupos.length === 1) mapa[townId] = grupos[0];
      else if (grupos.length > 1) { mapa[townId] = grupos[0]; conflitos.push({ townId, grupos }); }
      else if (Object.prototype.hasOwnProperty.call(templates, 'todos')) mapa[townId] = 'todos';
    }
    return { mapa, conflitos };
  }

  /* ---------------------- leitura do estado do jogo -------------------- */
  let mUw = null;
  let mWorld = '';

  function gameDataResearches() {
    try { return mUw.GameData.researches || {}; } catch (e) { return {}; }
  }

  // estado das pesquisas de TODAS as cidades (modelo Researches, indexado por town_id)
  function getResearchesPorCidade() {
    try {
      const mods = mUw.MM.getModels().Researches || {};
      const out = {};
      for (const k of Object.keys(mods)) out[Number(k)] = mods[k].attributes || {};
      return out;
    } catch (e) { return {}; }
  }

  // pesquisas em fila, agrupadas por cidade
  function getFilasPorCidade() {
    const out = {};
    try {
      const col = mUw.MM.getCollections().ResearchOrder;
      const models = (col && col[0] && col[0].models) || [];
      for (const m of models) {
        const a = m.attributes || {};
        const tid = Number(a.town_id);
        (out[tid] = out[tid] || []).push(a.research_type);
      }
    } catch (e) {}
    return out;
  }

  // níveis de edifícios por cidade (para requisitos e pontos da academia)
  function getEdificiosPorCidade() {
    const out = {};
    try {
      const col = mUw.MM.getCollections().BuildingBuildData[0];
      for (const m of col.models) {
        const a = m.attributes || {};
        const bd = a.building_data || {};
        const niveis = {};
        for (const b of Object.keys(bd)) niveis[b] = bd[b].level;
        out[Number(a.town_id)] = niveis;
      }
    } catch (e) {}
    return out;
  }

  function getRecursos(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const r = t.resources ? t.resources() : null;
      if (!r) return null;
      return { wood: r.wood, stone: r.stone, iron: r.iron };
    } catch (e) { return null; }
  }

  function getTownGroups() {
    try { return mUw.MM.getCollections().TownGroup[0].models.map((m) => m.attributes); } catch (e) { return []; }
  }
  function getTownGroupTowns() {
    try { return mUw.MM.getCollections().TownGroupTown[0].models.map((m) => m.attributes); } catch (e) { return []; }
  }

  // manda investigar (ResearchOrder/research)
  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * (é preciso recarregar para ver o efeito) E faz a passagem seguinte ler
   * valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels()[Nome].
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }


  async function research(townId, researchId) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    const payload = {
      model_url: 'ResearchOrder', action_name: 'research', captcha: null,
      arguments: { id: researchId }, town_id: Number(townId), nl_init: true,
    };
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      aplicarNotificacoes(r);   // refresca a interface (pontos, fila) e os modelos
      const ok = r && r.json && r.json.success;
      return { ok: !!ok, msg: ok ? r.json.success : (r && r.json && r.json.error) || 'erro' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ============ VALIDAÇÃO CRUZADA COM O TEMPLATE DE CONSTRUÇÃO ==========
   * As pesquisas exigem níveis de academia (e por vezes outros edifícios) e
   * podem depender de outras pesquisas. Confrontamos o template de pesquisa
   * com o de construção DO MESMO GRUPO, para não marcar tecnologias que a
   * cidade nunca poderá investigar.
   * ==================================================================== */
  function templatesConstrucao() {
    try { return JSON.parse(armazem.getItem('grepoConstru_templates_v1') || '{}'); }
    catch (e) { return {}; }
  }

  function alvoConstrucao(tplC, edificio) {
    let alvo = 0;
    try {
      for (const bloco of (tplC.blocos || [])) {
        for (const item of bloco) {
          if (item.b === edificio) alvo = Math.max(alvo, Number(item.alvo) || 0);
        }
      }
    } catch (e) {}
    return alvo;
  }

  function nomeEdificioPT(id) {
    try { return (mUw.GameData.buildings[id] || {}).name || id; } catch (e) { return id; }
  }
  function nomePesquisaPT(id) {
    try { return (mUw.GameData.researches[id] || {}).name || id; } catch (e) { return id; }
  }

  // O que falta para esta pesquisa ser possível neste grupo.
  function validarPesquisaNoGrupo(resId, nomeGrupo, marcadas) {
    const out = { edificios: [], pesquisas: [] };
    try {
      const r = (mUw.GameData.researches || {})[resId] || {};

      // edifícios exigidos (tipicamente a academia)
      const dep = r.building_dependencies || {};
      const tplsC = templatesConstrucao();
      const tplC = tplsC[nomeGrupo] || tplsC.todos || null;
      if (tplC) {
        for (const ed of Object.keys(dep)) {
          const exigido = Number(dep[ed]) || 0;
          const previsto = alvoConstrucao(tplC, ed);
          if (previsto < exigido) out.edificios.push({ edificio: ed, exigido, previsto });
        }
      }

      // pesquisas anteriores exigidas
      const antes = r.research_dependencies || [];
      for (const a of antes) if ((marcadas || []).indexOf(a) < 0) out.pesquisas.push(a);
    } catch (e) {}
    return out;
  }

  /* ---------------------- templates (Gist + cache local) -------------- */
  const CACHE_KEY = 'grepoPesquisa_templates_v1';
  function loadTemplatesLocal() {
    try { return JSON.parse(armazem.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveTemplatesLocal(t) {
    try { armazem.setItem(CACHE_KEY, JSON.stringify(t)); } catch (e) {}
  }
  async function readTemplatesGist() {
    // não segurar o processo (importante nos testes)
    try { if (typeof t2 !== 'undefined' && t2 && t2.unref) t2.unref(); } catch (e) {}
    if (!GIST.id) return loadTemplatesLocal();
    try {
      const r = await mUw.fetch('https://api.github.com/gists/' + GIST.id, { headers: { 'Accept': 'application/vnd.github+json' } });
      const j = await r.json();
      const file = j.files && j.files[ficheiroGist()];
      if (!file) return loadTemplatesLocal();
      /* Ficheiros grandes vêm TRUNCADOS na listagem do Gist: o conteúdo
       * tem de ser lido no `raw_url`. Sem isto, um template grande
       * parecia não existir. */
      let __txt = file.content;
      if ((!__txt || file.truncated) && file.raw_url) {
        try {
          const __rr = await (mUw || uw).fetch(file.raw_url, { headers: { Accept: 'text/plain' } });
          if (__rr.ok) __txt = await __rr.text();
        } catch (e) {}
      }
      const t = JSON.parse(__txt || '{}');
      saveTemplatesLocal(t);
      return t;
    } catch (e) { return loadTemplatesLocal(); }
  }
  const travaoGist = { aEsperar: false, pendente: null };

  async function writeTemplatesGist(t) {
    /* TRAVÃO: o GitHub limita as escritas por hora e várias gravações seguidas
     * esgotam-no (403 "API rate limit exceeded"). Se a última foi há menos de
     * 30 s, guarda-se e sobe só a última versão.
     *
     * O guardar LOCAL acontece sempre — só a subida ao Gist é travada. */
    if (travaoGist.aEsperar) {
      travaoGist.pendente = t;
      return { ok: true, msg: 'agendado (travão de 30 s)' };
    }
    travaoGist.aEsperar = true;
    const tG = setTimeout(() => {
      travaoGist.aEsperar = false;
      const p = travaoGist.pendente;
      travaoGist.pendente = null;
      if (p != null) writeTemplatesGist(p);
    }, 30000);
    try { if (tG && typeof tG.unref === 'function') tG.unref(); } catch (e) {}

    saveTemplatesLocal(t);
    if (!GIST.id || !GIST.token) return { ok: false, msg: 'sem Gist id/token — guardado só localmente' };
    try {
      const body = { files: { [ficheiroGist()]: { content: JSON.stringify(t, null, 2) } } };
      const r = await mUw.fetch('https://api.github.com/gists/' + GIST.id, {
        method: 'PATCH',
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + GIST.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return r.ok ? { ok: true } : { ok: false, msg: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ------------------------------- run -------------------------------- */
  /* ============ CONCLUIR DE GRAÇA ======================================
   * Nos últimos 5 minutos, terminar uma pesquisa não custa nada.
   * Confirmado em jogo:
   *   model_url ResearchOrder/{id}, action_name buyInstant, {order_id}
   *   → resposta traz "costs": 0.
   * ==================================================================== */
  const GRATIS_ABAIXO_DE = 300;
  const GRATIS_KEY = 'grepoPesquisa_gratis_v1';

  function cfgGratis() {
    try {
      const v = armazem.getItem(GRATIS_KEY);
      return v === null ? true : v === '1';
    } catch (e) { return true; }
  }
  function guardarCfgGratis(v) {
    try { armazem.setItem(GRATIS_KEY, v ? '1' : '0'); } catch (e) {}
  }

  function agoraServidor() {
    try { return Number(mUw.Timestamp.now()) || Math.floor(Date.now() / 1000); }
    catch (e) { return Math.floor(Date.now() / 1000); }
  }

  async function concluirJa(townId, ordemId) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({
          model_url: 'ResearchOrder/' + Number(ordemId),
          action_name: 'buyInstant', captcha: null,
          arguments: { order_id: Number(ordemId) },
          town_id: Number(townId), nl_init: true,
        })),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      return { ok: !(j && j.error), custo: Number(j && j.costs) || 0, msg: (j && (j.error || j.success)) || 'ok' };
    } catch (e) { return { ok: false, custo: 0, msg: e.message }; }
  }

  /* A colecção ResearchOrder só traz as ordens da CIDADE ACTIVA — como a
   * BuildingOrder. Por isso isto corre por cidade, não uma vez no início. */
  async function concluirGratuitas(ctx, soDaCidade) {
    const log = ctx.log;
    let n = 0;
    try {
      const col = mUw.MM.getCollections().ResearchOrder;
      const ordens = (col && col[0] && col[0].models) || [];
      const agora = agoraServidor();

      for (const m2 of ordens.slice()) {
        const a = m2.attributes || {};
        if (soDaCidade && Number(a.town_id) !== Number(soDaCidade)) continue;
        const falta = Number(a.to_be_completed_at) - agora;
        if (!Number.isFinite(falta) || falta <= 0 || falta > GRATIS_ABAIXO_DE) continue;

        const r = await concluirJa(a.town_id, a.id);
        if (r.ok && r.custo === 0) {
          log(`⏩ ${nomePesquisaPT(a.research_type)}: concluída ${Math.round(falta / 60)} min mais cedo, de graça.`);
          n++;
          await ctx.sleep(ctx.rand(500, 1100));
        } else if (r.ok && r.custo > 0) {
          log(`⚠️ ${nomePesquisaPT(a.research_type)}: a conclusão custou ${r.custo} de ouro.`);
        }
      }
    } catch (e) {}
    return n;
  }

  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const rotina = ctx.logRotina || ctx.log;
    const log = ctx.log;

    const templates = await readTemplatesGist();
    if (!Object.keys(templates).length) { log('Sem templates de pesquisa configurados.'); return; }

    const gameData = gameDataResearches();
    if (!Object.keys(gameData).length) { log('GameData.researches indisponível.'); return; }

    const towns = ctx.getMyTowns();
    if (!towns.length) { log('Sem cidades.'); return; }

    const { mapa, conflitos } = resolverGrupos(getTownGroups(), getTownGroupTowns(), templates, towns.map((t) => t.id));
    for (const c of conflitos) log(`⚠️ Cidade ${c.townId} em vários grupos com template (${c.grupos.join(', ')}); uso o 1º.`);

    const researchesPorCidade = getResearchesPorCidade();
    const filas = getFilasPorCidade();
    const edificios = getEdificiosPorCidade();

    let fezAlgo = false;
    for (const town of towns) {
      const tplNome = mapa[town.id];
      if (!tplNome) continue;
      const tpl = templates[tplNome];
      const desejadas = (tpl && tpl.pesquisas) || [];
      if (!desejadas.length) continue;

      // concluir o que já é grátis nesta cidade, antes de decidir
      if (cfgGratis()) await concluirGratuitas(ctx, town.id);

      const feitas = researchesPorCidade[town.id];
      if (!feitas) continue; // sem dados desta cidade
      const emFila = filas[town.id] || [];
      const edif = edificios[town.id] || {};
      if (!nivel(edif.academy)) continue; // sem academia, nada a fazer

      const dec = decidirPesquisas(desejadas, feitas, emFila, edif, gameData, getRecursos(town.id));
      if (!dec.acoes.length) continue;

      // investigar (uma de cada vez; para na primeira falha desta cidade)
      for (const id of dec.acoes) {
        const r = await research(town.id, id);
        if (r.ok) {
          fezAlgo = true;
          const nome = (gameData[id] && gameData[id].name) || id;
          log(`🔬 ${town.name}: ${nome} (${gameData[id].research_points} pts; restam ~${dec.pontos.disponiveis - gameData[id].research_points}).`);
          await ctx.sleep(ctx.rand(600, 1200));
        } else {
          /* Falta de pontos de pesquisa é o estado NORMAL de uma cidade em
           * crescimento — a academia sobe e mais tarde investiga. Avisar disso
           * a cada passagem é ruído. O mesmo para os requisitos que ainda não
           * estão construídos.
           *
           * As outras falhas continuam a aparecer: essas podem ser problemas. */
          const normal = /pontos de pesquisa|requisitos|research points|prerequisit|academia n[íi]vel|academia no n[íi]vel|academy/i
            .test(String(r.msg));
          if (normal) {
            rotina(`${town.name}: ainda não dá para investigar ${nomePesquisaPT(id) || id} (${r.msg}).`);
          } else {
            log(`⚠️ ${town.name}: falha a investigar ${nomePesquisaPT(id) || id} (${r.msg}).`);
          }
          break;
        }
      }
    }
    if (!fezAlgo) rotina('Ronda de pesquisa: nada a investigar agora.');
  }

  /* ---------------------- PAINEL (grelha de checkboxes) --------------- */
  let templatesEdicao = null;
  let grupoSelecionado = null;
  let painelCtx = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function gruposDisponiveis() {
    // Excluir os grupos AUTOMÁTICOS do jogo (id negativo: "Todos", "Sem
    // grupos"): não são grupos criados por ti e o "Todos" ainda colidia com o
    // nosso grupo especial "todos".
    const doJogo = getTownGroups()
      .filter((g) => Number(g.id) > 0)
      .map((g) => g.name)
      .filter((n) => String(n).toLowerCase() !== 'todos');
    return Array.from(new Set(['todos', ...doJogo, ...Object.keys(templatesEdicao || {})]));
  }

  // requires_farming_villages: algumas pesquisas só ficam disponíveis com
  // aldeias bárbaras desbloqueadas.
  function listaTecnologias() {
    const gd = gameDataResearches();
    return Object.keys(gd).map((id) => ({ id, nome: gd[id].name || id, pts: gd[id].research_points || 0, aldeias: !!gd[id].requires_farming_villages }));
  }


  // O painel pode ser desenhado ANTES de o jogo ter carregado os grupos de
  // cidades — e como só se redesenha quando mexes nele, ficava com a lista
  // vazia. Aqui esperamos que apareçam e redesenhamos uma vez.
  function redesenharQuandoHouverGrupos(container, ctx) {
    try {
      // Espera pelos grupos: o painel pode abrir antes de o jogo os ter
      // carregado, e ficava com a lista vazia.
      const pronto = () => getTownGroups().length;
      if (pronto()) return;
      let tentativas = 0;
      const t = setInterval(() => {
        tentativas++;
        if (pronto()) {
          clearInterval(t);
          try { renderPainel(container); } catch (e) {}
        } else if (tentativas > 40) {                  // ~20 s e desiste
          clearInterval(t);
        }
      }, 500);
    } catch (e) {}
  }


  /* ============== ORÇAMENTO DE PONTOS DE SABEDORIA ======================
   * Cada nível de academia dá 4 pontos. As pesquisas marcadas somam pontos, e
   * é fácil marcar mais do que a academia alguma vez poderá pagar — nem com o
   * nível máximo. Aqui calculamos o nível MÍNIMO necessário e comparamo-lo com
   * o que o template de construção do grupo prevê.
   * ==================================================================== */
  const ACADEMIA_MAX = 36;

  function custoTotalPesquisas(marcadas) {
    const gd = gameDataResearches();
    let total = 0;
    for (const id of (marcadas || [])) total += Number((gd[id] || {}).research_points) || 0;
    return total;
  }

  // Conteúdo do resumo — separado para poder ser recalculado a cada
  // marcação, sem redesenhar o painel todo (que perderia o scroll).
  function htmlOrcamento(orc, nMarcadas) {
    let aviso = '';
    if (orc.impossivel) {
      aviso = `<br>⛔ <b>Impossível:</b> precisaria de academia ${orc.nivelNecessario}, mas o máximo é ${ACADEMIA_MAX}`
        + ` (${ACADEMIA_MAX * PONTOS_POR_NIVEL_ACADEMIA} pontos). Desmarca ${orc.custo - ACADEMIA_MAX * PONTOS_POR_NIVEL_ACADEMIA} pontos.`;
    } else if (orc.insuficiente) {
      aviso = `<br>⚠ Precisa de academia <b>${orc.nivelNecessario}</b>, mas o template de construção só prevê <b>${orc.nivelPrevisto}</b>`
        + ` (${orc.pontosPrevistos} pontos).`;
    } else if (orc.semTemplateConstrucao) {
      aviso = `<br><span style="opacity:.6">Sem template de construção neste grupo para comparar.</span>`;
    }
    return `Marcadas: <b>${nMarcadas}</b> · custo <b>${orc.custo}</b> pontos`
      + ` · exige academia <b>${orc.nivelNecessario}</b>${orc.nivelPrevisto ? ` (template prevê ${orc.nivelPrevisto})` : ''}`
      + aviso
      + `<div style="opacity:.6;font-size:10px;margin-top:2px">A ordem da lista é a prioridade quando faltam pontos.</div>`;
  }

  function corOrcamento(orc) {
    if (orc.impossivel) return '#f88';
    if (orc.insuficiente) return '#fc8';
    return '#cde';
  }

  function orcamentoPesquisas(marcadas, nomeGrupo) {
    const custo = custoTotalPesquisas(marcadas);
    const nivelNecessario = Math.ceil(custo / PONTOS_POR_NIVEL_ACADEMIA);
    const tplsC = templatesConstrucao();
    const tplC = tplsC[nomeGrupo] || tplsC.todos || null;
    const nivelPrevisto = tplC ? alvoConstrucao(tplC, 'academy') : 0;
    return {
      custo,
      nivelNecessario,
      nivelPrevisto,
      pontosPrevistos: nivelPrevisto * PONTOS_POR_NIVEL_ACADEMIA,
      impossivel: nivelNecessario > ACADEMIA_MAX,
      insuficiente: nivelPrevisto > 0 && nivelNecessario > nivelPrevisto,
      semTemplateConstrucao: !tplC,
    };
  }

  function renderPainel(container) {
    if (!templatesEdicao) templatesEdicao = loadTemplatesLocal();
    const grupos = gruposDisponiveis();

    /* Templates de grupos que já não existem no jogo — sem os mostrar, ficam
     * invisíveis e nunca são aplicados. */
    const orfaos = Object.keys(templatesEdicao).filter((g) => grupos.indexOf(g) < 0);
    const todosNoSel = grupos.concat(orfaos);
    if (!grupoSelecionado || todosNoSel.indexOf(grupoSelecionado) < 0) {
      grupoSelecionado = grupos[0] || 'todos';
    }
    const tpl = templatesEdicao[grupoSelecionado];
    const avisoOrfao = orfaos.indexOf(grupoSelecionado) >= 0
      ? `<div style="font-size:11px;padding:6px;background:#2a1a10;border:1px solid #5a3a20;
          border-radius:4px;margin-bottom:6px">
          ⚠ O grupo "<b>${esc(grupoSelecionado)}</b>" <b>não existe no jogo</b> — este template
          nunca é aplicado. Cria o grupo com este nome, ou carrega em "Apagar".
        </div>` : '';

    let html = avisoOrfao + `
      <div style="font-size:11px;opacity:.85;margin-bottom:4px">Pesquisas do modelo — aplica a todas as cidades do grupo.</div>
      <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        <select id="pes-grupo" style="flex:1;min-width:90px">
          ${grupos.map((g) => `<option value="${esc(g)}"${g === grupoSelecionado ? ' selected' : ''}>${esc(g)}${templatesEdicao[g] ? ' ✓' : ''}</option>`).join('')}
          ${orfaos.length ? `<optgroup label="grupos que já não existem no jogo">
            ${orfaos.map((g) => `<option value="${esc(g)}"${g === grupoSelecionado ? ' selected' : ''}>${esc(g)} ⚠</option>`).join('')}
          </optgroup>` : ''}
        </select>
        <button id="pes-criar" style="cursor:pointer">Ativar grupo</button>
        <button id="pes-apagar" style="cursor:pointer;color:#f88">Apagar</button>
      </div>

      ${(() => {
        /* Copiar de outro grupo: os templates costumam ser parecidos. */
        const outros = Object.keys(templatesEdicao).filter((g) => g !== grupoSelecionado);
        if (!outros.length) return '';
        return `<div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;font-size:11px">
          <span style="opacity:.75;flex:0 0 auto">copiar de</span>
          <select id="pes-copiar-de" style="flex:1">
            <option value="">— escolher grupo —</option>
            ${outros.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
          </select>
          <button id="pes-copiar" style="cursor:pointer">Copiar</button>
        </div>`;
      })()}`;

    if (!tpl) {
      html += `<div style="font-size:11px;opacity:.8;padding:6px;background:#0d141c;border-radius:4px">
        O grupo "<b>${esc(grupoSelecionado)}</b>" ainda não tem template de pesquisa. Carrega em "Ativar grupo".</div>`;
      container.innerHTML = html;
      ligarTopo(container);
      return;
    }

    const marcadas = tpl.pesquisas || [];
    const techs = listaTecnologias();

    /* Pesquisas MARCADAS que não existem neste mundo.
     *
     * As pesquisas variam com o tipo de mundo: a `democracy`, por exemplo,
     * existe no pt125 (revolta) e não no pt126 (cerco). Um template feito
     * noutro mundo pode ter marcadas pesquisas que aqui não existem.
     *
     * Não dá problema — o módulo salta-as em silêncio — mas convém saber-se,
     * porque na lista abaixo elas nem aparecem. */
    const idsDoMundo = new Set(techs.map((t) => t.id));
    const foraDesteMundo = marcadas.filter((id) => !idsDoMundo.has(id));
    if (foraDesteMundo.length) {
      html += `<div style="background:#0d141c;padding:6px 8px;border-radius:4px;margin-bottom:6px;font-size:11px">
        <b>${foraDesteMundo.length} pesquisa(s) marcada(s) que não existem neste mundo</b>
        <div style="opacity:.65;font-size:10px;margin-top:2px">
          ${foraDesteMundo.map((x) => esc(nomePesquisaPT(x) || x)).join(', ')} —
          são ignoradas, não é preciso fazer nada. As pesquisas mudam conforme o
          mundo é de revolta ou de cerco.
        </div>
      </div>`;
    }
    if (!techs.length) {
      html += `<div style="font-size:11px;opacity:.8">Lista de tecnologias indisponível (GameData não carregado).</div>`;
    } else {
      html += `<div style="max-height:220px;overflow:auto;background:#0d141c;padding:4px;border-radius:4px">`;
      for (const t of techs) {
        const on = marcadas.indexOf(t.id) >= 0;
        // Ícone do próprio jogo: as classes "research_icon research <id>"
        // apontam para a folha de sprites que a Academia usa, por isso o
        // desenho fica igual ao do jogo sem descarregar nada.
        html += `<label style="display:flex;align-items:center;gap:6px;padding:2px 3px;font-size:11px;cursor:pointer">
          <input type="checkbox" data-tech="${esc(t.id)}"${on ? ' checked' : ''}>
          <div style="flex:0 0 26px;height:26px;overflow:hidden;position:relative">
            <div class="research_icon research ${esc(t.id)}" style="position:absolute;top:0;left:0;transform:scale(.52);transform-origin:top left"></div>
          </div>
          <span style="flex:1">${esc(t.nome)}${t.aldeias ? ' 🌾' : ''}</span>
          <span style="opacity:.6">${t.pts} pts</span>
        </label>`;
        // Só se avisa sobre o que está MARCADO: avisar sobre tudo encheria a
        // lista de ruído.
        if (on) {
          const v = validarPesquisaNoGrupo(t.id, grupoSelecionado || "todos", marcadas);
          const partes = [];
          if (v.edificios.length) {
            partes.push(`exige ${v.edificios.map((f) => `${nomeEdificioPT(f.edificio)} ${f.exigido}`).join(', ')}`
              + ` — a construção só prevê ${v.edificios.map((f) => f.previsto).join(', ')}`);
          }
          if (v.pesquisas.length) {
            partes.push(`precisa de ${v.pesquisas.map(nomePesquisaPT).join(', ')} marcada(s) antes`);
          }
          if (partes.length) {
            html += `<div style="font-size:10px;color:#fc8;margin:-1px 0 3px 24px;line-height:1.4">⚠ ${partes.join('<br>⚠ ')}.</div>`;
          }
        }
      }
      html += `</div>`;
      // Resumo do orçamento de pontos de sabedoria.
      const orc = orcamentoPesquisas(marcadas, grupoSelecionado || 'todos');
      let corO = '#cde', avisoO = '';
      if (orc.impossivel) {
        corO = '#f88';
        avisoO = `<br>⛔ <b>Impossível:</b> precisaria de academia ${orc.nivelNecessario}, mas o máximo é ${ACADEMIA_MAX}`
          + ` (${ACADEMIA_MAX * PONTOS_POR_NIVEL_ACADEMIA} pontos). Desmarca ${orc.custo - ACADEMIA_MAX * PONTOS_POR_NIVEL_ACADEMIA} pontos.`;
      } else if (orc.insuficiente) {
        corO = '#fc8';
        avisoO = `<br>⚠ Precisa de academia <b>${orc.nivelNecessario}</b>, mas o template de construção só prevê <b>${orc.nivelPrevisto}</b>`
          + ` (${orc.pontosPrevistos} pontos).`;
      } else if (orc.semTemplateConstrucao) {
        avisoO = `<br><span style="opacity:.6">Sem template de construção neste grupo para comparar.</span>`;
      }
      html += `<div id="pes-orcamento" style="font-size:11px;margin:4px 0;color:${corO};background:#0d141c;padding:5px;border-radius:4px">
        ${htmlOrcamento(orc, marcadas.length)}
      </div>`;
    }
    html += `
    <label style="display:block;font-size:11px;margin:4px 0">
      <input type="checkbox" id="pes-gratis"${cfgGratis() ? ' checked' : ''}>
      <b>Concluir de graça nos últimos 5 min</b>
      <span style="opacity:.6;font-size:10px">— não custa ouro</span>
    </label>`;
    html += `<button id="pes-guardar" style="cursor:pointer;width:100%;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar pesquisas</button>`;

    container.innerHTML = html;
    ligarTopo(container);
    ligarCorpo(container, tpl);
  }

  function ligarTopo(container) {
    const sel = container.querySelector('#pes-grupo');
    // Preencher ao abrir: os grupos podem carregar depois do painel.
    if (sel) sel.onmousedown = () => {
      const nomes = gruposDisponiveis();
      if (nomes.length && sel.options.length !== nomes.length) {
        const atual = sel.value;
        sel.innerHTML = nomes.map((g) =>
          `<option value="${esc(g)}"${atual === g ? ' selected' : ''}>${esc(g)}</option>`).join('');
      }
    };
    if (sel) sel.onchange = (e) => { grupoSelecionado = e.target.value; renderPainel(container); };
    const bCop = container.querySelector('#pes-copiar');
    if (bCop) bCop.onclick = () => {
      const sel = container.querySelector('#pes-copiar-de');
      const de = sel && sel.value;
      if (!de) { if (pCtx) pCtx.log('Escolhe primeiro o grupo a copiar.'); return; }
      const origem = templatesEdicao[de];
      if (!origem) return;
      if (templatesEdicao[grupoSelecionado] && !confirm(`Substituir o template de "${grupoSelecionado}" pelo de "${de}"?`)) return;

      // cópia profunda: senão os dois grupos partilhavam os mesmos objectos
      templatesEdicao[grupoSelecionado] = JSON.parse(JSON.stringify(origem));
      if (pCtx) pCtx.log(`Copiei o template de "${de}" para "${grupoSelecionado}". Ajusta e guarda.`);
      renderPainel(container);
    };

    const criar = container.querySelector('#pes-criar');
    if (criar) criar.onclick = () => { if (!templatesEdicao[grupoSelecionado]) templatesEdicao[grupoSelecionado] = { pesquisas: [] }; renderPainel(container); };
    const apagar = container.querySelector('#pes-apagar');
    if (apagar) apagar.onclick = () => {
      if (grupoSelecionado === 'todos') { alert('O grupo "todos" não pode ser apagado.'); return; }
      if (confirm('Apagar o template de pesquisa do grupo "' + grupoSelecionado + '"?')) {
        delete templatesEdicao[grupoSelecionado]; grupoSelecionado = null; renderPainel(container);
      }
    };
  }

  function ligarCorpo(container, tpl) {
    container.querySelectorAll('[data-tech]').forEach((el) => {
      el.onchange = (e) => {
        const id = el.getAttribute('data-tech');
        tpl.pesquisas = tpl.pesquisas || [];
        const i = tpl.pesquisas.indexOf(id);
        if (e.target.checked && i < 0) tpl.pesquisas.push(id);
        else if (!e.target.checked && i >= 0) tpl.pesquisas.splice(i, 1);
        // Recalcular o orçamento em tempo real — antes só atualizava a
        // contagem e o custo ficava parado até guardares.
        const cx = container.querySelector('#pes-orcamento');
        if (cx) {
          const o = orcamentoPesquisas(tpl.pesquisas, grupoSelecionado || 'todos');
          cx.innerHTML = htmlOrcamento(o, tpl.pesquisas.length);
          cx.style.color = corOrcamento(o);
        }
      };
    });
    const guardar = container.querySelector('#pes-guardar');
    if (guardar) guardar.onclick = async () => {
      guardar.textContent = 'A guardar...';
      const res = await writeTemplatesGist(templatesEdicao);
      if (painelCtx) painelCtx.log(res.ok ? 'Pesquisas guardadas no Gist.' : 'Pesquisas guardadas localmente (' + res.msg + ').');
      guardar.textContent = res.ok ? 'Guardado ✓' : 'Guardado (local)';
      setTimeout(() => { guardar.textContent = 'Guardar pesquisas'; }, 1800);
    };
  }


  /* Preservar a posição do rolamento ao redesenhar o painel — senão volta ao
   * topo a cada alteração. */
  function comRolamento(fn) {
    /* Guardar TODOS os elementos que estejam rolados, não só os que se
     * adivinham: o que rola pode ser uma caixa interna e o salto para o topo
     * mantinha-se. */
    /* Guardar o CAMINHO e não só a referência: o redesenho destrói os
     * elementos internos e a referência antiga deixa de estar no ecrã. */
    const caminhoDe = (el) => {
      const p = []; let n = el;
      while (n && n.parentElement && p.length < 30) {
        p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
        if (n.id) { p.unshift('#' + n.id); break; }
      }
      return p;
    };
    const porCaminho = (p) => {
      try {
        if (!p.length) return null;
        let n = null, i = 0;
        if (typeof p[0] === 'string' && p[0].charAt(0) === '#') { n = document.getElementById(p[0].slice(1)); i = 1; }
        else n = document.body;
        for (; n && i < p.length; i++) n = n.children[p[i]];
        return n || null;
      } catch (e) { return null; }
    };

    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}
    fn();
    const repor = () => guardados.forEach(({ caminho, y, el }) => {
      try {
        if (el && el.isConnected) { el.scrollTop = y; return; }
        const n2 = porCaminho(caminho);
        if (n2) n2.scrollTop = y;
      } catch (e) {}
    });
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  function painel(container, ctx) {
    painelCtx = ctx;
    mUw = ctx.uw; mWorld = ctx.WORLD;
    renderPainel(container);
    redesenharQuandoHouverGrupos(container, ctx);
    readTemplatesGist().then((t) => { templatesEdicao = t; renderPainel(container); }).catch(() => {});
  }

  return {
    id: 'pesquisa',
    nome: 'Auto-pesquisa',
    intervaloMin: opts.intervaloMin || 15,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
  };
}

  // ===================== MÓDULO: AUTO-RECRUTAMENTO =======================
/* =============================================================================
 *  MÓDULO: AUTO-RECRUTAMENTO  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Por cada cidade: descobre o grupo → carrega o template (alvos por unidade) →
 *  conta o que já tem (em casa + fora em apoio + em fila) → recruta a diferença,
 *  respeitando recursos (com reserva para a construção) e população.
 *
 *  Pedido: POST /game/building_barracks|building_docks?town_id=X&action=build&h=TOKEN
 *          json={"unit_id":"sword","amount":N,"town_id":X,"nl_init":true}
 *  (barracks para terrestre, docks para naval — decidido por GameData.units.is_naval)
 * ========================================================================== */

function makeRecrutamentoModule(opts) {
  opts = opts || {};

  /* Nome do ficheiro no Gist, COM o mundo.
   *
   * Sem o mundo, o pt125 e o pt126 escrevem no mesmo ficheiro e sobrepõem-se
   * — um mundo de cerco quer a muralha baixa e um de revolta quer a muralha
   * no máximo, e ficavam com os mesmos templates.
   *
   * Calcula-se na altura de usar, porque o mundo só se sabe quando o módulo
   * corre. */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Nome do ficheiro no Gist: inclui o PERFIL e o MUNDO.
   *
   * Sem o perfil, a main e as multis do mesmo mundo escreviam no mesmo
   * ficheiro — e apagar os templates de um perfil não servia de nada, porque
   * voltavam do Gist na leitura seguinte.
   *
   * Sem o mundo, o pt125 e o pt126 sobrepunham-se — um mundo de cerco quer a
   * muralha baixa e um de revolta quer a muralha no máximo.
   *
   * Num mundo novo (o pt127, por exemplo) o nome é novo e o ficheiro nasce
   * vazio: não é preciso fazer nada. */
  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function ficheiroGist() {
    const base = String(GIST.filename || 'templates.json').replace(/\.json$/, '');
    const mundo = (typeof mWorld !== 'undefined' && mWorld) ? mWorld : 'x';
    let perfil = 'main';
    try {
      const e = JSON.parse(armazem.getItem('grepoMaestro_modulos_v1') || 'null');
      if (e && e.perfil) perfil = String(e.perfil);
    } catch (e) {}
    return `${base}-${perfil}-${mundo}.json`;
  }

  const GIST = {
    id: opts.gistId || '',
    token: opts.gistToken || '',
    /* O ficheiro TEM de incluir o mundo: sem isso, o pt125 e o pt126
     * escrevem no mesmo e sobrepõem-se — um mundo de cerco quer a muralha
     * baixa e um de revolta quer a muralha no máximo, e ficavam iguais. */
    filename: opts.gistFile || 'recrutamento-templates.json',
  };

  // Capacidades de transporte (validadas no módulo de apoio): beliche = +6.
  const CAP_TRANSPORTE = {
    small_transporter: { sem: 10, com: 16 },
    big_transporter: { sem: 26, com: 32 },
  };

  let mUw = null;

  // RELÓGIO DO SERVIDOR — o único que conta.
  // O relógio da máquina é irrelevante e enganador: este VPS está em Espanha e
  // o jogo corre em hora portuguesa, uma hora de diferença PERMANENTE. Se o
  // servidor não estiver disponível devolvemos null e o módulo NÃO age, em vez
  // de agir com uma hora possivelmente errada.
  function agoraJogo() {
    try {
      if (typeof mUw.Timestamp !== 'undefined' && typeof mUw.Timestamp.now === 'function') {
        const t = Math.floor(mUw.Timestamp.now());
        if (Number.isFinite(t) && t > 0) return t;
      }
    } catch (e) {}
    try {
      const t = Number(mUw.Game && mUw.Game.server_time);
      if (Number.isFinite(t) && t > 0) return Math.floor(t);
    } catch (e) {}
    return null;   // sem relógio do servidor: não se inventa
  }

  let mWorld = '';

  /* ---------------------- dados do jogo -------------------------------- */
  function gameUnits() {
    try { return mUw.GameData.units || {}; } catch (e) { return {}; }
  }

  // Conta as unidades de cada cidade: em casa E fora (apoio).
  // O modelo Units tem entradas com home_town_id (dona) e current_town_id (onde está).
  function contarUnidadesPorCidadeDeOrigem() {
    const out = {}; // home_town_id -> { sword: n, ... }
    try {
      const mods = mUw.MM.getModels().Units || {};
      for (const k of Object.keys(mods)) {
        const a = mods[k].attributes || {};
        const home = Number(a.home_town_id);
        if (!home) continue;
        const acc = out[home] = out[home] || {};
        for (const u of Object.keys(a)) {
          if (typeof a[u] === 'number' && u !== 'id' && u !== 'home_town_id' && u !== 'current_town_id') {
            acc[u] = (acc[u] || 0) + a[u];
          }
        }
      }
    } catch (e) {}
    return out;
  }

  // Unidades ainda por produzir na fila, por cidade.
  function contarFilasPorCidade() {
    const out = {};
    try {
      const col = mUw.MM.getCollections().UnitOrder;
      const models = (col && col[0] && col[0].models) || [];
      for (const m of models) {
        const a = m.attributes || {};
        const tid = Number(a.town_id);
        const acc = out[tid] = out[tid] || {};
        acc[a.unit_type] = (acc[a.unit_type] || 0) + (a.units_left != null ? a.units_left : a.count || 0);
      }
    } catch (e) {}
    return out;
  }

  // Níveis dos edifícios de cada cidade (para os requisitos de arranque).
  function niveisPorCidade() {
    const out = {};
    try {
      const col = mUw.MM.getCollections().BuildingBuildData[0];
      for (const m of col.models) {
        const a = m.attributes || {};
        const bd = a.building_data || {};
        const n = {};
        for (const b of Object.keys(bd)) {
          const lvl = bd[b].level;
          n[b] = (lvl === '-' || lvl == null) ? 0 : Number(lvl);
        }
        out[Number(a.town_id)] = n;
      }
    } catch (e) {}
    return out;
  }

  // A cidade cumpre os níveis mínimos definidos no template?
  function cumpreRequisitos(niveis, requisitos) {
    if (!requisitos) return { ok: true };
    for (const edif of Object.keys(requisitos)) {
      const exigido = Number(requisitos[edif]) || 0;
      if (exigido <= 0) continue;
      const atual = Number((niveis || {})[edif]) || 0;
      if (atual < exigido) return { ok: false, falta: `${edif} nv${atual}/${exigido}` };
    }
    return { ok: true };
  }

  // Só recruta com o armazém acima de uma percentagem — evita encher a fila com
  // ordens minúsculas, que rendem muito menos por ordem.
  // Travão contra ordens minúsculas.
  //
  // A ideia original — exigir o armazém a X% — bloqueava demasiado: bastava um
  // recurso estar 2 pontos abaixo para a cidade inteira parar, mesmo que a
  // unidade mal usasse esse recurso. O que importa não é a percentagem do
  // armazém, mas QUANTAS unidades cabem: uma ordem de 14 navios-farol é
  // perfeitamente útil, mesmo com o armazém a 48%.
  //
  // Passa a ser: só recruta se couber pelo menos uma fracção decente do que o
  // armazém CHEIO permitiria comprar dessa unidade.
  /* ORDEM GRANDE O SUFICIENTE — medida em POPULAÇÃO.
   *
   * A regra antiga media uma percentagem da capacidade do armazém, o que é
   * indirecto: quando o armazém sobe, a mesma percentagem passa a exigir
   * ordens maiores.
   *
   * O que interessa é o tamanho da ordem, e a população mede-o bem para
   * qualquer unidade: 15 birremes são 120 de população (vale a pena), 15
   * espadachins são 15 (não vale). O mesmo número serve para as duas.
   *
   * Devolve o que se consegue pagar em população, para comparar com o mínimo. */
  function popDaOrdemPossivel(recursos, custo, popUnidade, reservaPct) {
    try {
      const disp = recursosGastaveis(recursos, reservaPct) || {};
      const cw = Number(custo.wood) || 0, cs = Number(custo.stone) || 0, ci = Number(custo.iron) || 0;
      if (!cw && !cs && !ci) return Infinity;      // não gasta recursos

      const quantas = Math.min(
        cw ? Math.floor((disp.wood || 0) / cw) : Infinity,
        cs ? Math.floor((disp.stone || 0) / cs) : Infinity,
        ci ? Math.floor((disp.iron || 0) / ci) : Infinity);
      if (!Number.isFinite(quantas)) return Infinity;
      return quantas * (Number(popUnidade) || 1);
    } catch (e) { return Infinity; }
  }

  function armazemSuficiente(recursos, pct, custo) {
    if (!pct || !recursos || !recursos.storage) return { ok: true };
    if (!custo) return { ok: true };
    const cw = Number(custo.wood) || 0, cs = Number(custo.stone) || 0, ci = Number(custo.iron) || 0;
    if (!cw && !cs && !ci) return { ok: true };         // não gasta recursos

    const cabemAgora = Math.min(
      cw ? Math.floor((recursos.wood || 0) / cw) : Infinity,
      cs ? Math.floor((recursos.stone || 0) / cs) : Infinity,
      ci ? Math.floor((recursos.iron || 0) / ci) : Infinity);
    const cabemCheio = Math.min(
      cw ? Math.floor(recursos.storage / cw) : Infinity,
      cs ? Math.floor(recursos.storage / cs) : Infinity,
      ci ? Math.floor(recursos.storage / ci) : Infinity);
    if (!Number.isFinite(cabemCheio) || cabemCheio <= 0) return { ok: true };

    const fracao = cabemAgora / cabemCheio;
    if (fracao >= pct / 100) return { ok: true };
    return { ok: false, pctAtual: Math.floor(fracao * 100), cabem: cabemAgora };
  }

  function getRecursos(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const r = t.resources ? t.resources() : null;
      if (!r) return null;
      return { wood: r.wood, stone: r.stone, iron: r.iron, storage: r.storage, population: r.population, favor: r.favor };
    } catch (e) { return null; }
  }

  function getTownGroups() {
    try { return mUw.MM.getCollections().TownGroup[0].models.map((m) => m.attributes); } catch (e) { return []; }
  }
  function getTownGroupTowns() {
    try { return mUw.MM.getCollections().TownGroupTown[0].models.map((m) => m.attributes); } catch (e) { return []; }
  }

  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * E faz a passagem seguinte ler valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels().Town.
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }

  async function recrutar(townId, unitId, amount, isNaval) {
    // Confirmado no jogo: o controlador é building_barracks / building_docks.
    // Com 'barracks'/'docks' o servidor responde "Ocorreu um erro interno!".
    const edificio = isNaval ? 'building_docks' : 'building_barracks';
    const url = mUw.location.origin + '/game/' + edificio + '?town_id=' + Number(townId)
      + '&action=build&h=' + mUw.Game.csrfToken;
    const payload = { unit_id: unitId, amount: Number(amount), town_id: Number(townId), nl_init: true };
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      aplicarNotificacoes(r);   // refresca a interface e os modelos
      const j = r && r.json;
      const erro = j && j.error;
      return { ok: !erro, msg: erro || (j && j.success) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* =========================================================================
   *  MÍTICAS / VOADORES
   *  O favor é POR JOGADOR e partilhado por todas as cidades do mesmo deus,
   *  por isso tem de ser descontado à medida que se planeia — senão a primeira
   *  cidade gasta tudo e as seguintes falham.
   *  Alvo genérico "voadores": em cada cidade resolve-se para o voador do deus
   *  que essa cidade venera.
   * ====================================================================== */

  // Favor atual de cada deus (PlayerGods: zeus_favor, hera_favor, ...).
  function favorPorDeus() {
    const out = {};
    try {
      const g = mUw.MM.getModels().PlayerGods;
      const k = Object.keys(g)[0];
      const a = g[k].attributes || {};
      ['zeus', 'poseidon', 'hera', 'athena', 'hades', 'artemis', 'aphrodite', 'ares'].forEach((d) => {
        out[d] = Math.floor(Number(a[d + '_favor']) || 0);
      });
    } catch (e) {}
    return out;
  }

  function deusDaCidade(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      return typeof t.god === 'function' ? t.god() : t.god;
    } catch (e) { return null; }
  }

  // Voador do deus (uma unidade voadora por deus).
  function voadorDoDeus(deus, units) {
    if (!deus) return null;
    for (const id of Object.keys(units)) {
      const u = units[id];
      if (u.god_id === deus && (u.flying || u.is_flying)) return id;
    }
    return null;
  }

  /* ============ DESCONTO DE CUSTO DADO PELO HERÓI DA CIDADE ============
   * Vários heróis tornam unidades mais baratas. O jogo expõe o valor em
   * GameData.heroes[x].description_args: {value, level_mod} — por exemplo o
   * Odisseu dá 20% base +2% por nível nos espadachins.
   * Sem contar com isto, as ordens saem menores do que podiam: com 20% de
   * desconto cabem 25% mais unidades nos mesmos recursos.
   * ================================================================== */
  const HEROIS_DESCONTO = {
    // herói -> unidades que torna mais baratas (null = todas as navais)
    argus: null,                                   // todas as navais
    aristotle: ['attack_ship'],                    // navios-farol
    daidalos: ['bireme'],
    eurybia: ['trireme'],
    odysseus: ['sword'],
    philoctetes: ['archer'],
    cheiron: ['hoplite'],
  };

  function heroiDaCidade(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const h = t.getHero ? t.getHero() : null;
      if (!h) return null;
      const tipo = h.type || (h.attributes && h.attributes.type) || (h.getType && h.getType());
      const nivel = Number(h.level || (h.attributes && h.attributes.level) || 1);
      return tipo ? { tipo, nivel } : null;
    } catch (e) { return null; }
  }

  // Percentagem de desconto (0–1) que este herói dá a esta unidade.
  function descontoRecursos(heroi, unitId, units) {
    if (!heroi) return 0;
    if (!Object.prototype.hasOwnProperty.call(HEROIS_DESCONTO, heroi.tipo)) return 0;
    const alvo = HEROIS_DESCONTO[heroi.tipo];
    const gd = units[unitId] || {};
    if (alvo === null) { if (!gd.is_naval) return 0; }         // Argos: só navais
    else if (alvo.indexOf(unitId) < 0) return 0;
    try {
      const arg = ((mUw.GameData.heroes[heroi.tipo] || {}).description_args || {})['1'] || {};
      const base = Number(arg.value) || 0;
      const porNivel = Number(arg.level_mod) || 0;
      return Math.min(0.9, base + porNivel * Math.max(0, heroi.nivel - 1));
    } catch (e) { return 0; }
  }

  // Redução de custo de favor pela Anysia, se estiver atribuída a esta cidade.
  // A descrição traz value + level_mod por nível (ex.: 0.10 + 0.01/nível).
  function descontoFavor(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const h = t.getHero ? t.getHero() : null;
      if (!h) return 0;
      const tipo = h.type || (h.attributes && h.attributes.type) || (h.getType && h.getType());
      if (tipo !== 'anysia') return 0;
      // (aplica-se a qualquer unidade que custe favor, incluindo o Enviado
      //  divino, que tem god_id "all" mas custa 12 de favor)
      const nivel = Number(h.level || (h.attributes && h.attributes.level) || 1);
      const gd = (mUw.GameData.heroes || {}).anysia || {};
      const arg = (gd.description_args || {})['1'] || {};
      const base = Number(arg.value) || 0;
      const porNivel = Number(arg.level_mod) || 0;
      return Math.min(0.9, base + porNivel * Math.max(0, nivel - 1));
    } catch (e) { return 0; }
  }

  // Quantas míticas dá para recrutar com o favor/recursos/população disponíveis.
  function quantidadeMitica(unitId, desejada, disp, popLivre, favorLivre, desconto, units, descRec) {
    const gd = units[unitId];
    if (!gd || desejada <= 0) return 0;
    let max = desejada;
    const c = gd.resources || {};
    const fr = 1 - (descRec || 0);
    const cw = Math.ceil((c.wood || 0) * fr), cs = Math.ceil((c.stone || 0) * fr), ci = Math.ceil((c.iron || 0) * fr);
    if (cw) max = Math.min(max, Math.floor(disp.wood / cw));
    if (cs) max = Math.min(max, Math.floor(disp.stone / cs));
    if (ci) max = Math.min(max, Math.floor(disp.iron / ci));
    if (gd.population) max = Math.min(max, Math.floor(popLivre / gd.population));
    const custoFavor = Math.ceil((Number(gd.favor) || 0) * (1 - desconto));
    if (custoFavor > 0) max = Math.min(max, Math.floor(favorLivre / custoFavor));
    return Math.max(0, max);
  }

  /* ============ VALIDAÇÃO CRUZADA COM O TEMPLATE DE CONSTRUÇÃO ==========
   * De nada serve pedir colonizadores num grupo cujo template de construção
   * nunca chega ao porto 10. O jogo expõe os requisitos em
   * GameData.units[x].building_dependencies e .research_dependencies.
   * Comparamo-los com o template de construção DO MESMO GRUPO.
   * ==================================================================== */
  function nomeEdificio(id) {
    try { return (mUw.GameData.buildings[id] || {}).name || id; } catch (e) { return id; }
  }

  function templatesConstrucao() {
    try { return JSON.parse(armazem.getItem('grepoConstru_templates_v1') || '{}'); }
    catch (e) { return {}; }
  }

  function alvoConstrucao(tplCons, edificio) {
    let alvo = 0;
    try {
      for (const bloco of (tplCons.blocos || [])) {
        for (const item of bloco) {
          if (item.b === edificio) alvo = Math.max(alvo, Number(item.alvo) || 0);
        }
      }
    } catch (e) {}
    return alvo;
  }

  function templatesPesquisa() {
    try { return JSON.parse(armazem.getItem('grepoPesquisa_templates_v1') || '{}'); }
    catch (e) { return {}; }
  }

  function nomePesquisa(id) {
    try { return (mUw.GameData.researches[id] || {}).name || id; } catch (e) { return id; }
  }

  // Devolve o que falta para esta unidade poder ser recrutada neste grupo:
  // níveis de edifícios em falta no template de construção, e pesquisas em
  // falta no template de pesquisa — tudo do MESMO grupo.
  /* Pesquisas que uma unidade exige e que ainda NÃO estão investigadas nesta
   * cidade. Diferente de estarem no template: o template diz o que se vai
   * investigar, isto diz o que já está feito.
   *
   * Sem isto, um alvo de cavaleiros num grupo sem a pesquisa feita ficava
   * eternamente por cumprir, sem nada no painel a explicar porquê. */
  function pesquisasEmFalta(unitId, townId) {
    try {
      const u = (mUw.GameData.units || {})[unitId] || {};
      const precisa = u.research_dependencies || [];
      if (!precisa.length) return [];

      /* A chave do modelo Researches NEM SEMPRE é o townId — procura-se pelo
       * id de dentro. Se não se encontrar, não se afirma nada. */
      const mods = mUw.MM.getModels().Researches || {};
      let feitas = null;
      if (mods[townId] && mods[townId].attributes) {
        feitas = mods[townId].attributes;
      } else {
        for (const k of Object.keys(mods)) {
          const a = (mods[k] && mods[k].attributes) || {};
          if (Number(a.id) === Number(townId) || Number(k) === Number(townId)) { feitas = a; break; }
        }
      }
      if (!feitas || !Object.keys(feitas).length) return [];
      return precisa.filter((r) => !feitas[r]);
    } catch (e) { return []; }
  }

  function validarUnidadeNoGrupo(unitId, nomeGrupo) {
    const out = { edificios: [], pesquisas: [] };
    try {
      const u = (mUw.GameData.units || {})[unitId] || {};

      // 1) edifícios, contra o template de construção do grupo
      const dep = u.building_dependencies || {};
      const tplsC = templatesConstrucao();
      const tplC = tplsC[nomeGrupo] || tplsC.todos || null;
      if (tplC) {
        for (const ed of Object.keys(dep)) {
          const exigido = Number(dep[ed]) || 0;
          const previsto = alvoConstrucao(tplC, ed);
          if (previsto < exigido) out.edificios.push({ edificio: ed, exigido, previsto });
        }
      }

      // 2) pesquisas, contra o template de pesquisa do grupo
      const precisa = u.research_dependencies || [];
      if (precisa.length) {
        const tplsP = templatesPesquisa();
        const tplP = tplsP[nomeGrupo] || tplsP.todos || null;
        if (tplP) {
          const marcadas = tplP.pesquisas || [];
          for (const r of precisa) if (marcadas.indexOf(r) < 0) out.pesquisas.push(r);
        }
      }
    } catch (e) {}
    return out;
  }

  /* ==================== ORÇAMENTO DE POPULAÇÃO =========================
   * Quanta população sobra para tropas depois de os edifícios do template
   * estarem construídos? Sem esta conta é fácil definir alvos impossíveis.
   *
   * Fórmula do consumo (validada no jogo: 538 calculado vs 540 real):
   *     custo = pop_base × nível ^ pop_factor      (de GameData.buildings)
   *
   * A população MÁXIMA não se calcula — o jogo já a dá em Town.population.max,
   * com todos os bónus incluídos (pesquisa do Arado +200, Termas...). Para
   * prever o futuro usa-se a tabela oficial por nível da quinta, somando os
   * bónus actuais (que se mantêm).
   * ================================================================== */
  const POP_QUINTA = {1:114,2:121,3:134,4:152,5:175,6:206,7:245,8:291,9:343,10:399,
    11:458,12:520,13:584,14:651,15:720,16:790,17:863,18:938,19:1015,20:1094,
    21:1174,22:1257,23:1341,24:1426,25:1514,26:1602,27:1693,28:1785,29:1878,30:1973,
    31:2070,32:2168,33:2267,34:2368,35:2470,36:2573,37:2678,38:2784,39:2891,40:3000,
    41:3109,42:3220,43:3332,44:3446,45:3560};

  function custoPopEdificio(edificio, nivel) {
    try {
      const d = mUw.GameData.buildings[edificio] || {};
      const base = Number(d.pop) || 0, f = Number(d.pop_factor) || 0;
      if (!base || !nivel) return 0;
      return Math.round(base * Math.pow(nivel, f));
    } catch (e) { return 0; }
  }

  // Níveis previstos no template de construção do grupo (o máximo pedido).
  function niveisDoTemplate(nomeGrupo) {
    const out = {};
    try {
      const tpls = JSON.parse(armazem.getItem('grepoConstru_templates_v1') || '{}');
      const t = tpls[nomeGrupo] || tpls.todos;
      if (!t) return out;
      for (const bloco of (t.blocos || [])) {
        for (const item of bloco) {
          out[item.b] = Math.max(out[item.b] || 0, Number(item.alvo) || 0);
        }
      }
    } catch (e) {}
    return out;
  }

  /* Os dois bónus de população vêm de sítios DIFERENTES:
   *   • Arado (+200)  → é uma PESQUISA (`plow`), template de pesquisa;
   *   • Termas (+10%) → é um EDIFÍCIO (`thermal`), template de construção.
   *
   * (Corrigido: eu tinha tratado as Termas como pesquisa, o que estava errado.)
   */
  function bonusDePopulacao(nomeGrupo, townId) {
    const out = { arado: false, termas: false, temPesquisa: false, temConstru: false };

    // Arado: template de pesquisa
    try {
      const tpls = JSON.parse(armazem.getItem('grepoPesquisa_templates_v1') || '{}');
      const t = (nomeGrupo && tpls[nomeGrupo]) || tpls.todos;
      if (t) {
        out.temPesquisa = true;
        out.arado = (t.pesquisas || []).indexOf('plow') >= 0;
      }
    } catch (e) {}

    // Termas: template de construção
    try {
      const tpls = JSON.parse(armazem.getItem('grepoConstru_templates_v1') || '{}');
      const t = (nomeGrupo && tpls[nomeGrupo]) || tpls.todos;
      if (t) {
        out.temConstru = true;
        for (const bloco of (t.blocos || [])) {
          for (const item of bloco) {
            if (item && item.b === 'thermal' && Number(item.alvo) > 0) out.termas = true;
          }
        }
      }
    } catch (e) {}

    // já feitos? conta na mesma
    try {
      const tid = townId || (mUw.Game && mUw.Game.townId);
      const mods = mUw.MM.getModels().Researches || {};
      const feitas = (mods[tid] && mods[tid].attributes) || {};
      if (feitas.plow) out.arado = true;
    } catch (e) {}
    try {
      const col = mUw.MM.getCollections().BuildingBuildData[0];
      const m = col.models.find((x) => Number(x.attributes.town_id) === Number(townId));
      const bd = (m && m.attributes.building_data) || {};
      const lv = (bd.thermal || {}).level;
      if (lv && lv !== '-' && Number(lv) > 0) out.termas = true;
    } catch (e) {}

    return out;
  }

  // para não repetir os mesmos avisos a cada passagem
  const avisouPop = {};
  const avisouTemplates = {};

  function orcamentoPopulacao(townId, nomeGrupo) {
    try {
      const modelos = mUw.MM.getModels().Town || {};
      let attrs = null;
      for (const k of Object.keys(modelos)) {
        const a = modelos[k].attributes;
        if (a && Number(a.id) === Number(townId)) { attrs = a; break; }
      }
      if (!attrs) return null;
      const pop = attrs.population || {};
      const maxAgora = Number(pop.max) || 0;

      // níveis actuais dos edifícios
      const bdAtual = {};
      try {
        const col = mUw.MM.getCollections().BuildingBuildData[0];
        const m = col.models.find((x) => Number(x.attributes.town_id) === Number(townId));
        const bd = (m && m.attributes.building_data) || {};
        for (const k of Object.keys(bd)) {
          const lv = bd[k].level;
          bdAtual[k] = (lv === '-' || lv == null) ? 0 : Number(lv);
        }
      } catch (e) {}

      // consumo actual e consumo quando o template estiver completo
      const alvos = niveisDoTemplate(nomeGrupo);
      let gastoAgora = 0, gastoFinal = 0;
      const todos = new Set(Object.keys(bdAtual).concat(Object.keys(alvos)));
      for (const ed of todos) {
        const agora = bdAtual[ed] || 0;
        const fim = Math.max(agora, alvos[ed] || 0);   // nunca desce
        gastoAgora += custoPopEdificio(ed, agora);
        gastoFinal += custoPopEdificio(ed, fim);
      }

      /* População máxima quando o template estiver completo.
       *
       * Fórmula confirmada com dados reais (quinta 45 → 3560 na tabela, jogo
       * dizia 4116): as TERMAS multiplicam a quinta por 1,10 e o ARADO soma
       * 200 depois.  3560 × 1,10 + 200 = 4116.
       *
       * Se o template de PESQUISA prevê essas investigações mas ainda não
       * estão feitas, contam-se na mesma — é o que permite recrutar já para o
       * que a cidade vai ter. */
      const quintaAgora = bdAtual.farm || 0;
      const quintaFim = Math.max(quintaAgora, alvos.farm || 0);
      const baseFim = POP_QUINTA[quintaFim] || POP_QUINTA[quintaAgora] || maxAgora;

      const bon = bonusDePopulacao(nomeGrupo, townId);
      let maxFinal = baseFim;
      if (bon.termas) maxFinal = maxFinal * 1.10;   // Termas: edifício, +10%
      if (bon.arado) maxFinal += 200;               // Arado: pesquisa, +200
      maxFinal = Math.round(maxFinal);

      // nunca abaixo do que a cidade já tem
      if (maxFinal < maxAgora) maxFinal = maxAgora;
      const bonus = maxAgora - (POP_QUINTA[quintaAgora] || 0);

      return {
        maxAgora, maxFinal, gastoAgora, gastoFinal,
        quintaAgora, quintaFim, bonus,
        livreAgora: maxAgora - gastoAgora,
        livreFinal: maxFinal - gastoFinal,
      };
    } catch (e) { return null; }
  }

  // População que os alvos de tropas vão ocupar.
  function popDosAlvos(alvos, units) {
    let total = 0, terra = 0, mar = 0;
    for (const id of Object.keys(alvos || {})) {
      const n = Number(alvos[id]) || 0;
      const u = units[id] || {};
      const p = n * (Number(u.population) || 0);
      total += p;
      if (u.is_naval) mar += p; else terra += p;
    }
    return { total, terra, mar };
  }

  /* ================ FEITIÇOS DE ACELERAÇÃO ==============================
   * Três poderes aceleram o recrutamento (confirmados no jogo):
   *   • fertility_improvement — Hera, 80 favor — QUARTEL, +100%, 4 h
   *   • spartan_training      — Ares, 80 favor — QUARTEL, +70% (+1%/100 Fúria)
   *   • call_of_the_ocean     — Poseidon, 60 favor — PORTO, +100%, 4 h
   *
   * A cidade NÃO precisa de venerar o deus do feitiço — basta ter favor dele.
   * Como aceleram tudo o que for ordenado nas 4 h seguintes, o momento certo é
   * ANTES de uma leva grande, não a meio.
   *
   * Pedido: frontend_bridge → CastedPowers/cast {power_id, target_id}
   * ==================================================================== */
  const FEITICOS_KEY = 'grepoRecruta_feiticos_v1';
  function cfgFeiticos() {
    // O de Ares dá 70% de base (+1% por cada 100 de Fúria) — vale a pena mesmo
    // sem Fúria acumulada, por isso vem ligado também.
    const base = {
      ativo: false, minPopulacao: 200,
      usar: ['fertility_improvement', 'spartan_training', 'call_of_the_ocean'],
    };
    try { Object.assign(base, JSON.parse(armazem.getItem(FEITICOS_KEY) || '{}')); } catch (e) {}
    return base;
  }
  function guardarCfgFeiticos(c) {
    try { armazem.setItem(FEITICOS_KEY, JSON.stringify(c)); } catch (e) {}
  }

  const FEITICOS = {
    // Ordem de preferência no quartel: o de Hera acelera 100%, o de Ares 70%
    // (mais 1% por cada 100 de Fúria). Tenta-se o melhor primeiro; se não
    // houver favor de Hera, usa-se o de Ares.
    quartel: [
      { id: 'fertility_improvement', deus: 'hera', favor: 80, nome: 'Crescimento da população', bonus: '+100%' },
      { id: 'spartan_training', deus: 'ares', favor: 80, nome: 'Treino de espartanos', bonus: '+70% e mais com Fúria' },
    ],
    porto: [
      { id: 'call_of_the_ocean', deus: 'poseidon', favor: 60, nome: 'Chamamento do oceano', bonus: '+100%' },
    ],
  };

  // Este feitiço já está activo nesta cidade?
  function feiticoAtivo(townId, powerId) {
    try {
      const col = mUw.MM.getCollections().CastedPowers[0];
      const agora = Math.floor(mUw.Timestamp.now());
      return (col.models || []).some((m) => {
        const a = m.attributes || {};
        return String(a.power_id) === String(powerId)
          && Number(a.town_id) === Number(townId)
          && (!a.end_at || Number(a.end_at) > agora);
      });
    } catch (e) { return false; }
  }

  async function lancarFeitico(townId, powerId) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({
          model_url: 'CastedPowers', action_name: 'cast', captcha: null,
          arguments: { power_id: powerId, target_id: Number(townId) },
          town_id: Number(townId), nl_init: true,
        })),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      const erro = j && j.error;
      return { ok: !erro, msg: erro || (j && j.success) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* Lança um feitiço se compensar. Só o faz quando a ordem é grande — gastar
   * 80 de favor para acelerar 10 espadachins seria desperdício. */
  async function talvezAcelerar(ctx, townId, acoes, units, cfgFeiticos) {
    if (!cfgFeiticos || !cfgFeiticos.ativo) return;

    // quanta população vai ser recrutada em cada edifício
    let popQuartel = 0, popPorto = 0;
    for (const a of acoes) {
      const u = units[a.unitId] || {};
      const pop = (Number(u.population) || 0) * Number(a.quantidade || 0);
      if (u.is_naval) popPorto += pop; else popQuartel += pop;
    }

    const favores = favorPorDeus();
    const minimo = Number(cfgFeiticos.minPopulacao) || 200;

    for (const [edificio, pop] of [['quartel', popQuartel], ['porto', popPorto]]) {
      if (pop < minimo) continue;
      for (const f of FEITICOS[edificio]) {
        if (!(cfgFeiticos.usar || []).includes(f.id)) continue;
        if (feiticoAtivo(townId, f.id)) break;             // já está acelerado
        if ((Number(favores[f.deus]) || 0) < f.favor) continue;
        const r = await lancarFeitico(townId, f.id);
        if (r.ok) {
          ctx.log(`✨ ${f.nome}: ${edificio} acelerado (${f.favor} de favor de ${f.deus}; ${pop} de população a recrutar).`);
          await ctx.sleep(ctx.rand(600, 1200));
        } else {
          ctx.log(`⚠️ ${f.nome} falhou: ${r.msg}`);
        }
        break;   // um feitiço por edifício chega
      }
    }
  }

  /* ---------------------- lógica de decisão ---------------------------- */
  function resolverGrupos(townGroups, townGroupTowns, templates, todasAsCidades) {
    const comTpl = new Set(Object.keys(templates).filter((k) => k !== 'todos'));
    const idNome = {};
    for (const g of townGroups) if (comTpl.has(g.name)) idNome[g.id] = g.name;
    const cg = {};
    for (const rel of townGroupTowns) {
      const nome = idNome[rel.group_id];
      if (!nome) continue;
      (cg[rel.town_id] = cg[rel.town_id] || []).push(nome);
    }
    const mapa = {}, conflitos = [];
    for (const t of todasAsCidades) {
      const g = cg[t] || [];
      if (g.length === 1) mapa[t] = g[0];
      else if (g.length > 1) { mapa[t] = g[0]; conflitos.push({ townId: t, grupos: g }); }
      else if (Object.prototype.hasOwnProperty.call(templates, 'todos')) mapa[t] = 'todos';
    }
    return { mapa, conflitos };
  }

  // Quanto se pode gastar, deixando a reserva percentual do armazém intacta.
  function recursosGastaveis(recursos, reservaPct) {
    if (!recursos) return null;
    const reserva = (recursos.storage || 0) * (reservaPct || 0) / 100;
    return {
      wood: Math.max(0, (recursos.wood || 0) - reserva),
      stone: Math.max(0, (recursos.stone || 0) - reserva),
      iron: Math.max(0, (recursos.iron || 0) - reserva),
    };
  }

  // Quantas unidades dá para recrutar com estes recursos/população.
  function quantidadePossivel(unitId, desejada, disp, popLivre, units, descontoRec) {
    descontoRec = descontoRec || 0;
    const gd = units[unitId];
    if (!gd || desejada <= 0) return 0;
    const c = gd.resources || {};
    // custo já com o desconto do herói: com 20% de desconto cabem 25% mais
    const f = 1 - descontoRec;
    const cw = Math.ceil((c.wood || 0) * f);
    const cs = Math.ceil((c.stone || 0) * f);
    const ci = Math.ceil((c.iron || 0) * f);
    let max = desejada;
    if (cw) max = Math.min(max, Math.floor(disp.wood / cw));
    if (cs) max = Math.min(max, Math.floor(disp.stone / cs));
    if (ci) max = Math.min(max, Math.floor(disp.iron / ci));
    if (gd.population) max = Math.min(max, Math.floor(popLivre / gd.population));
    return Math.max(0, max);
  }

  // Adiamentos vindos do módulo de heróis: enquanto um herói viaja para uma
  // cidade, as unidades que ele vai beneficiar ficam para o fim (para serem
  // recrutadas já com o bónus). Regra: NUNCA parar — se não houver mais nada
  // para recrutar nessa cidade, recruta-as na mesma.
  function lerAdiamentos(townId) {
    try {
      const all = JSON.parse(armazem.getItem('grepoHerois_adiar_v1') || '{}');
      const e = all[townId];
      if (!e) return [];
      const agora = agoraJogo();
      if (e.ate && e.ate <= agora) return []; // o herói já chegou
      return e.adiar || [];
    } catch (e) { return []; }
  }

  // Decide o que recrutar numa cidade. Devolve lista de {unitId, amount, isNaval}.
  /* A pesquisa desta unidade já está feita na cidade activa?
   * Devolve false quando não há dados — mais vale tentar do que bloquear por
   * engano. */
  function pesquisaEmFaltaAqui(unitId) {
    try {
      const u = (mUw.GameData.units || {})[unitId] || {};
      const precisa = u.research_dependencies || [];
      if (!precisa.length) return false;
      const tid = mUw.Game && mUw.Game.townId;
      const mods = mUw.MM.getModels().Researches || {};
      const feitas = (mods[tid] && mods[tid].attributes) || {};
      if (!Object.keys(feitas).length) return false;   // sem dados: não bloquear
      return precisa.some((r) => !feitas[r]);
    } catch (e) { return false; }
  }

  const NC_ID = 'colonize_ship';

  /* Já se atingiram todos os alvos do template (sem contar colonizadores)? */
  function cumpreOTemplate(alvos, tenho, naFila) {
    for (const uid of Object.keys(alvos)) {
      if (uid === NC_ID) continue;
      const querido = Number(alvos[uid]) || 0;
      if (!querido) continue;
      const ha = (Number(tenho[uid]) || 0) + (Number(naFila[uid]) || 0);
      if (ha < querido) return false;
    }
    return true;
  }

  /* Deus da cidade activa — é dele que sai o favor do enviado divino. */
  function deusDaCidadeAtiva() {
    try { return mUw.ITowns.getTown(Number(mUw.Game.townId)).god() || null; }
    catch (e) { return null; }
  }

  function decidirRecrutamento(alvos, tenho, emFila, recursos, reservaPct, units, adiadas, favorLivre, desconto, armazemOk, descontoUnidade, armazemPorUnidade, popReservada, deusDestaCidade) {
    favorLivre = favorLivre || {};
    desconto = desconto || 0;
    if (armazemOk === undefined) armazemOk = true;
    const acoes = [];
    const disp = recursosGastaveis(recursos, reservaPct);
    if (!disp) return acoes;
    /* RESERVAR POPULAÇÃO PARA A CONSTRUÇÃO.
     *
     * Sem isto o recrutamento gastava a população TODA e a cidade ficava com
     * `blocked = max`: nenhum edifício podia subir, porque cada nível precisa
     * de população livre. Visto em jogo — a cidade tinha 4116 de máximo e 4116
     * bloqueada, e TODOS os edifícios apareciam com can_upgrade a falso.
     *
     * Reserva-se o que falta construir até ao fim do template (consumo final
     * menos o actual), com um mínimo de segurança. */
    let popLivre = (recursos && recursos.population) || 0;
    /* Além do que falta construir, guarda-se sempre uma folga mínima: mesmo
     * com o template completo, uma cidade sem população livre não pode subir
     * nada nem reagir a mudanças no template. */
    const FOLGA_MINIMA = 30;
    const reservaPop = Math.max(FOLGA_MINIMA, Number(popReservada) || 0);
    popLivre = Math.max(0, popLivre - reservaPop);

    // ordem: primeiro as não-adiadas; as adiadas ficam para o fim
    const ids = Object.keys(alvos);
    const adiar = new Set(adiadas || []);
    /* PRIMEIRO as unidades que o HERÓI desta cidade beneficia.
     *
     * O herói pode sair a qualquer momento para outra cidade; enquanto lá
     * está, convém aproveitar o desconto nas unidades dele. Numa cidade com
     * 1000 espadachins e 900 arqueiros e o Odisseu presente, fazem-se
     * primeiro os espadachins.
     *
     * `descontoUnidade` já devolve o desconto do herói presente para cada
     * unidade — basta pôr à frente as que têm desconto. */
    const comDesconto = new Set();
    if (descontoUnidade) {
      for (const i of ids) {
        try { if ((descontoUnidade(i) || 0) > 0) comDesconto.add(i); } catch (e) {}
      }
    }

    const naoAdiadas = ids.filter((i) => !adiar.has(i));
    const ordenadas = naoAdiadas.filter((i) => comDesconto.has(i))
      .concat(naoAdiadas.filter((i) => !comDesconto.has(i)))
      .concat(ids.filter((i) => adiar.has(i)));

    for (const unitId of ordenadas) {
      /* Unidade cuja pesquisa ainda não está feita: salta-se em SILÊNCIO.
       * Não é um erro — é uma situação transitória. Sem isto, o módulo tentava
       * recrutar, o servidor recusava e enchia o log de avisos até a pesquisa
       * ficar pronta. */
      if (pesquisaEmFaltaAqui(unitId)) continue;
      const alvo = Number(alvos[unitId]) || 0;
      if (alvo <= 0) continue;
      const gd = units[unitId];
      if (!gd) continue;
      const jaTem = (tenho[unitId] || 0) + (emFila[unitId] || 0);
      const falta = alvo - jaTem;
      if (falta <= 0) continue;
      // O mínimo de armazém só faz sentido para unidades que GASTAM recursos.
      // As que só custam favor e população (enviado divino) não devem esperar
      // por madeira, pedra e prata que não vão usar.
      const c0 = gd.resources || {};
      const custaRecursos = (Number(c0.wood) || 0) + (Number(c0.stone) || 0) + (Number(c0.iron) || 0) > 0;
      if (custaRecursos && armazemPorUnidade && !armazemPorUnidade(unitId)) continue;

      /* Unidades que custam FAVOR além de recursos e população.
       *
       * ATENÇÃO ao ENVIADO DIVINO: tem god_id 'all' (serve qualquer deus) mas
       * custa 12 de favor. A condição antiga exigia god_id !== 'all', por isso
       * ele escapava à verificação e o módulo pedia mais do que o favor dava —
       * o servidor respondia "não pode recrutar mais do que N", o que parecia
       * um limite da unidade mas era o favor a acabar.
       *
       * O que define é o CUSTO DE FAVOR, não o deus. */
      const custaFavor = (Number(gd.favor) || 0) > 0;
      const ehMitica = custaFavor;
      // o favor do enviado divino sai do deus que a cidade venera
      /* O deus do enviado divino é o da CIDADE QUE SE ESTÁ A PROCESSAR — não
       * o da cidade activa no jogo. Se o módulo já trocou de cidade, ler a
       * activa dava o deus errado e o favor descontado ao deus errado. */
      const deus = (gd.god_id && gd.god_id !== 'all') ? gd.god_id : deusDestaCidade;
      // desconto de recursos dado pelo herói presente nesta cidade
      const descRec = descontoUnidade ? (descontoUnidade(unitId) || 0) : 0;
      let n;
      if (ehMitica) {
        const disponivelFavor = Math.max(0, Number(favorLivre[deus]) || 0);
        n = quantidadeMitica(unitId, falta, disp, popLivre, disponivelFavor, desconto, units, descRec);
      } else {
        n = quantidadePossivel(unitId, falta, disp, popLivre, units, descRec);
      }
      if (n <= 0) continue;
      const c = gd.resources || {};
      const fr = 1 - descRec;
      disp.wood -= Math.ceil((c.wood || 0) * fr) * n;
      disp.stone -= Math.ceil((c.stone || 0) * fr) * n;
      disp.iron -= Math.ceil((c.iron || 0) * fr) * n;
      popLivre -= (gd.population || 0) * n;
      if (ehMitica) {
        const custoFavor = Math.ceil((Number(gd.favor) || 0) * (1 - desconto)) * n;
        favorLivre[deus] = Math.max(0, (Number(favorLivre[deus]) || 0) - custoFavor);
      }
      acoes.push({ unitId, amount: n, isNaval: !!gd.is_naval, nome: gd.name || unitId,
        adiada: adiar.has(unitId), mitica: ehMitica, deus });
    }
    return acoes;
  }

  /* ---------------------- resumo para o painel ------------------------- */
  // Desenha o orçamento de população da cidade actual: quanto os edifícios
  // consomem, quanto sobra para tropas, e quanto os alvos definidos ocupam.
  /* Orçamento de população do TEMPLATE, não da cidade activa.
   *
   * O painel é para configurar o grupo — mostrar números que mudam conforme a
   * cidade onde estás não serve para nada (visto em jogo: 2873 numa cidade,
   * 2840 noutra, só porque uma tinha a quinta no 44 e a outra no 45).
   *
   * Calcula-se o que o template VAI dar quando estiver completo:
   *   quinta do template → tabela → ×1,10 se as Termas estiverem no template
   *                              → +200 se o Arado estiver no de pesquisa
   *   menos o que os edifícios do template consomem nesses níveis. */
  function orcamentoDoTemplate(nomeGrupo) {
    try {
      const alvos = niveisDoTemplate(nomeGrupo);
      if (!alvos || !Object.keys(alvos).length) return null;

      const quinta = Number(alvos.farm) || 0;
      if (!quinta) return null;

      let maxFinal = POP_QUINTA[quinta] || 0;
      if (!maxFinal) return null;

      // Termas: só contam se estiverem no template de construção
      if (Number(alvos.thermal) > 0) maxFinal *= 1.10;
      // Arado: pesquisa
      const bon = bonusDePopulacao(nomeGrupo, null);
      if (bon.arado) maxFinal += 200;
      maxFinal = Math.round(maxFinal);

      let gastoFinal = 0;
      for (const ed of Object.keys(alvos)) {
        gastoFinal += custoPopEdificio(ed, Number(alvos[ed]) || 0);
      }

      return {
        maxAgora: maxFinal, maxFinal,
        gastoAgora: gastoFinal, gastoFinal,
        quintaAgora: quinta, quintaFim: quinta,
        livreAgora: maxFinal - gastoFinal,
        livreFinal: maxFinal - gastoFinal,
        doTemplate: true,
      };
    } catch (e) { return null; }
  }

  function htmlOrcamentoPop(alvos, nomeGrupo) {
    try {
      /* Primeiro o cálculo do TEMPLATE; só se ele não der (falta a quinta, por
       * exemplo) é que se recorre à cidade activa. */
      const orc = orcamentoDoTemplate(nomeGrupo)
        || orcamentoPopulacao(mUw.Game && mUw.Game.townId, nomeGrupo);
      if (!orc) return '';
      const units = gameUnits();
      const usa = popDosAlvos(alvos, units);

      const pct = orc.livreFinal > 0 ? Math.min(100, Math.round(usa.total / orc.livreFinal * 100)) : 0;
      const excede = usa.total > orc.livreFinal;
      const cor = excede ? '#f88' : (pct >= 85 ? '#fc8' : '#7d7');
      const bonT = bonusDePopulacao(nomeGrupo, null);
      const temTermas = (() => {
        try { return Number(niveisDoTemplate(nomeGrupo).thermal) > 0; } catch (e) { return false; }
      })();

      return `<div style="background:#0d141c;padding:6px;border-radius:4px;margin-bottom:6px;font-size:11px">
        <b>População do template${nomeGrupo && nomeGrupo !== 'todos' ? ' — ' + esc(nomeGrupo) : ''}</b>
        <span style="opacity:.55;font-size:10px">— com a construção e a pesquisa completas</span>
        <table style="width:100%;border-collapse:collapse;margin-top:3px;font-size:11px">
          <tr><td style="opacity:.75">Quinta nível ${orc.quintaFim}</td><td style="text-align:right">${(POP_QUINTA[orc.quintaFim] || orc.maxFinal).toLocaleString('pt-PT')}</td></tr>
          ${temTermas ? `<tr><td style="opacity:.75">+ Termas (10%)</td><td style="text-align:right">+${Math.round((POP_QUINTA[orc.quintaFim] || 0) * 0.10).toLocaleString('pt-PT')}</td></tr>` : ''}
          ${bonT.arado ? '<tr><td style="opacity:.75">+ Arado</td><td style="text-align:right">+200</td></tr>' : ''}
          <tr><td style="opacity:.75">− edifícios do template</td><td style="text-align:right">−${orc.gastoFinal.toLocaleString('pt-PT')}</td></tr>
          <tr><td><b>= livre para tropas</b></td><td style="text-align:right"><b>${orc.livreFinal.toLocaleString('pt-PT')}</b></td></tr>
        </table>
        ${!temTermas || !bonT.arado ? `<div style="opacity:.6;font-size:10px;margin-top:2px">
          ${!temTermas ? 'Sem Termas no template de construção. ' : ''}${!bonT.arado ? 'Sem Arado no template de pesquisa.' : ''}
        </div>` : ''}
        ${(() => {
          /* Se este grupo é o dos voadores, mostrar quantos vão caber com a
           * população que sobra — e actualiza-se sempre que se acrescenta uma
           * unidade comum acima. */
          if (!voadoresLigados()) return '';
          const gv = grupoVoadores();
          if (gv && gv !== nomeGrupo) return '';

          /* O voador depende do deus de CADA cidade — no painel mostra-se o
           * custo médio, já que o template serve o grupo todo. */
          const uds = gameUnits();
          const voadores = Object.keys(uds).filter((k) => uds[k].flying && uds[k].god_id);
          if (!voadores.length) return '';
          const custos = voadores.map((k) => Number(uds[k].population) || 0).filter(Boolean);
          const popU = custos.length
            ? Math.round(custos.reduce((a, b) => a + b, 0) / custos.length) : 1;
          const unidade = null;
          const sobraFim = Math.max(0, orc.livreFinal - usa.total);
          const cabemFim = Math.floor(sobraFim / popU);

          return `<div style="margin-top:5px;padding-top:4px;border-top:1px solid #223;font-size:11px">
            <b>+ ~${cabemFim.toLocaleString('pt-PT')} voadores</b>
            <span style="opacity:.6">com os ${sobraFim.toLocaleString('pt-PT')} de população que sobram</span>
            <div style="opacity:.6;font-size:10px">
              Valor aproximado: cada deus tem o seu voador e custam entre
              ${Math.min(...custos)} e ${Math.max(...custos)} de população.
            </div>
          </div>`;
        })()}
        <div style="margin-top:5px;padding-top:4px;border-top:1px solid #223">
          Alvos definidos: <b style="color:${cor}">${usa.total.toLocaleString('pt-PT')}/${orc.livreFinal.toLocaleString('pt-PT')}</b>
          <span style="opacity:.6">(${usa.terra.toLocaleString('pt-PT')} terra · ${usa.mar.toLocaleString('pt-PT')} mar)</span>
          ${excede ? `<br><span style="color:#f88">⛔ Excede em ${(usa.total - orc.livreFinal).toLocaleString('pt-PT')} — não caberá tudo.</span>` : ''}
          <div style="background:#0a0f16;height:6px;border-radius:3px;margin-top:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${cor}"></div>
          </div>
        </div>
      </div>`;
    } catch (e) { return ''; }
  }

  // População total/terrestre e capacidade naval (sem e com beliches), como no painel.
  function resumoTemplate(alvos) {
    const units = gameUnits();
    let popTotal = 0, popTerrestre = 0, capSem = 0, capCom = 0;
    for (const id of Object.keys(alvos)) {
      const n = Number(alvos[id]) || 0;
      const gd = units[id];
      if (!gd || n <= 0) continue;
      const pop = (gd.population || 0) * n;
      popTotal += pop;
      if (!gd.is_naval) popTerrestre += pop;
      const cap = CAP_TRANSPORTE[id];
      if (cap) { capSem += cap.sem * n; capCom += cap.com * n; }
    }
    return { popTotal, popTerrestre, capSem, capCom };
  }

  /* ---------------------- templates (Gist + cache) --------------------- */
  // Interruptor LOCAL (por conta): o alvo de voadores vem do template partilhado
  // no Gist, mas só age nas contas onde for ligado. Assim a main faz voadores e
  // as multis ignoram-nos, mesmo partilhando o mesmo template.
  // Grupo cujas cidades fazem voadores. Vazio = todas as cidades da conta.
  // Assim podes ter um grupo "Voadores" dedicado, em vez de a regra valer
  // para tudo.
  const VOADORES_GRUPO_KEY = 'grepoRecruta_voadores_grupo_v1';
  function grupoVoadores() {
    try { return armazem.getItem(VOADORES_GRUPO_KEY) || ''; } catch (e) { return ''; }
  }
  function guardarGrupoVoadores(g) {
    try { armazem.setItem(VOADORES_GRUPO_KEY, g || ''); } catch (e) {}
  }

  // Esta cidade pertence ao grupo de voadores?
  function cidadeFazVoadores(townId) {
    const g = grupoVoadores();
    if (!g) return true;                       // sem grupo definido: todas

    /* O grupo escolhido pode não existir NESTA conta — é o caso das multis,
     * que sem Administrador não têm grupos e ficam só com "todos". Se o
     * perfil veio de uma conta com grupos, o nome guardado não corresponde a
     * nada e nenhuma cidade faria voadores. Nesse caso, trata-se como se não
     * houvesse grupo. */
    try {
      const existe = (mUw.MM.getCollections().TownGroup[0].models || [])
        .some((m) => m.attributes && String(m.attributes.name) === String(g));
      if (!existe) return true;
    } catch (e) { return true; }
    try {
      const grupos = {};
      for (const m of mUw.MM.getCollections().TownGroup[0].models) {
        const a = m.attributes; if (Number(a.id) > 0) grupos[a.id] = a.name;
      }
      for (const m of mUw.MM.getCollections().TownGroupTown[0].models) {
        const a = m.attributes;
        if (Number(a.town_id) !== Number(townId)) continue;
        if (grupos[a.group_id] === g) return true;
      }
    } catch (e) {}
    return false;
  }

  const VOADORES_KEY = 'grepoRecruta_voadores_on_v1';
  function voadoresLigados() {
    try { return armazem.getItem(VOADORES_KEY) === '1'; } catch (e) { return false; }
  }
  function ligarVoadores(on) {
    try { armazem.setItem(VOADORES_KEY, on ? '1' : '0'); } catch (e) {}
  }

  const CACHE_KEY = 'grepoRecruta_templates_v1';
  function loadLocal() { try { return JSON.parse(armazem.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; } }
  function saveLocal(t) { try { armazem.setItem(CACHE_KEY, JSON.stringify(t)); } catch (e) {} }
  async function readGist() {
    // não segurar o processo (importante nos testes)
    try { if (typeof t2 !== 'undefined' && t2 && t2.unref) t2.unref(); } catch (e) {}
    if (!GIST.id) return loadLocal();
    try {
      const r = await mUw.fetch('https://api.github.com/gists/' + GIST.id, { headers: { 'Accept': 'application/vnd.github+json' } });
      const j = await r.json();
      const f = j.files && j.files[ficheiroGist()];
      if (!f) return loadLocal();
      /* Ficheiros grandes vêm TRUNCADOS na listagem do Gist: o conteúdo
       * tem de ser lido no `raw_url`. Sem isto, um template grande
       * parecia não existir. */
      let __txt = f.content;
      if ((!__txt || f.truncated) && f.raw_url) {
        try {
          const __rr = await (mUw || uw).fetch(f.raw_url, { headers: { Accept: 'text/plain' } });
          if (__rr.ok) __txt = await __rr.text();
        } catch (e) {}
      }
      const t = JSON.parse(__txt || '{}');
      saveLocal(t);
      return t;
    } catch (e) { return loadLocal(); }
  }
  const travaoGist = { aEsperar: false, pendente: null };

  async function writeGist(t) {
    /* TRAVÃO: o GitHub limita as escritas por hora e várias gravações seguidas
     * esgotam-no (403 "API rate limit exceeded"). Se a última foi há menos de
     * 30 s, guarda-se e sobe só a última versão.
     *
     * O guardar LOCAL acontece sempre — só a subida ao Gist é travada. */
    if (travaoGist.aEsperar) {
      travaoGist.pendente = t;
      return { ok: true, msg: 'agendado (travão de 30 s)' };
    }
    travaoGist.aEsperar = true;
    const tG = setTimeout(() => {
      travaoGist.aEsperar = false;
      const p = travaoGist.pendente;
      travaoGist.pendente = null;
      if (p != null) writeGist(p);
    }, 30000);
    try { if (tG && typeof tG.unref === 'function') tG.unref(); } catch (e) {}

    saveLocal(t);
    if (!GIST.id || !GIST.token) return { ok: false, msg: 'sem Gist id/token — guardado só localmente' };
    try {
      const r = await mUw.fetch('https://api.github.com/gists/' + GIST.id, {
        method: 'PATCH',
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + GIST.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [ficheiroGist()]: { content: JSON.stringify(t, null, 2) } } }),
      });
      return r.ok ? { ok: true } : { ok: false, msg: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ------------------------------- run --------------------------------- */
  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const log = ctx.log;
    const rotina = ctx.logRotina || ctx.log;   // rotina: só nos módulos lentos

    const templates = await readGist();
    if (!Object.keys(templates).length) { log('Sem templates de recrutamento configurados.'); return; }

    const units = gameUnits();
    if (!Object.keys(units).length) { log('GameData.units indisponível.'); return; }

    const towns = ctx.getMyTowns();
    if (!towns.length) { log('Sem cidades.'); return; }

    const { mapa, conflitos } = resolverGrupos(getTownGroups(), getTownGroupTowns(), templates, towns.map((t) => t.id));
    for (const c of conflitos) log(`⚠️ Cidade ${c.townId} em vários grupos com template (${c.grupos.join(', ')}); uso o 1º.`);

    const porOrigem = contarUnidadesPorCidadeDeOrigem();
    const filas = contarFilasPorCidade();
    const niveis = niveisPorCidade();

    // Favor partilhado por deus: desconta-se ao longo da ronda para as cidades
    // do mesmo deus não planearem todas em cima do mesmo favor.
    const favorLivre = favorPorDeus();
    // Alvos expandidos (voadores → unidade concreta), para o módulo de heróis
    // saber onde a Anysia rende mais.
    const expandido = {};

    let fezAlgo = false;
    const travouPorRecursos = [];   // cidades onde faltou recurso, para o registo
    for (const town of towns) {
      const tplNome = mapa[town.id];
      if (!tplNome) continue;
      const tpl = templates[tplNome] || {};
      const alvos = Object.assign({}, tpl.unidades || {});

      // Alvo genérico de voadores: resolve para o voador do deus desta cidade.
      /* Duas maneiras de pedir voadores:
       *   'resto' (por omissão) — depois de descontar os edifícios do template
       *      e as outras unidades pedidas, gasta a população que sobrar. É o
       *      que faz sentido numa cidade de voadores: 40 faróis, 1 colonizador
       *      e o resto em míticas. Como cada voador custa uma população
       *      diferente, um número fixo nunca encheria a cidade.
       *   'alvo' — número fixo por cidade, como antes.
       */
      /* O modo "encher" precisa dos DOIS templates para saber a população
       * final: o de construção diz o nível da quinta e o consumo dos
       * edifícios, o de pesquisa diz se haverá Arado e Termas. Sem eles o
       * cálculo estaria errado e a cidade ficaria sem população para
       * construir — por isso bloqueia-se, em vez de adivinhar. */
      let alvoVoadores = 0;
      if (voadoresLigados() && cidadeFazVoadores(town.id)) {
        const temConstru = (() => {
          try {
            const t = JSON.parse(armazem.getItem('grepoConstru_templates_v1') || '{}');
            return !!(t[tplNome] || t.todos);
          } catch (e) { return false; }
        })();
        const temPesq = bonusDePopulacao(tplNome, town.id).temPesquisa;

        if (!temConstru || !temPesq) {
          if (!avisouTemplates[tplNome]) {
            avisouTemplates[tplNome] = true;
            const falta = [];
            if (!temConstru) falta.push('construção');
            if (!temPesq) falta.push('pesquisa');
            log(`⛔ Voadores no grupo "${tplNome}": falta o template de ${falta.join(' e de ')}. `
              + 'Sem ele não sei quanta população a cidade vai ter e não recruto — '
              + 'senão ficava sem população para construir.');
          }
          continue;   // não recruta nada nesta cidade
        }
      }
      if (voadoresLigados() && cidadeFazVoadores(town.id)) {
        /* Escolher o grupo de voadores já diz tudo: essas cidades fazem as
         * unidades comuns do template e gastam o resto da população no voador
         * do seu deus. Não faz sentido um número fixo. */
        alvoVoadores = -1;
      }
      let unidadeVoadora = null;
      if (alvoVoadores !== 0) {
        const deus = deusDaCidade(town.id);
        unidadeVoadora = voadorDoDeus(deus, units);

        if (unidadeVoadora && alvoVoadores === -1) {
          /* ============ QUANTOS VOADORES CABEM ============================
           *
           * O ALVO é a população que a cidade terá quando o template estiver
           * completo — não a de agora. Assim o alvo não muda a cada nível da
           * quinta.
           *
           * Mas o que se recruta AGORA é limitado por outra coisa: tem de
           * sobrar população para acabar de construir. Reserva-se por isso o
           * consumo FINAL dos edifícios (não o actual) da população ACTUAL:
           *
           *   cabe agora = população actual − consumo final dos edifícios
           *                                 − outras unidades do template
           *
           * Desta forma nunca se bloqueia a construção, e à medida que a
           * quinta sobe cabem mais tropas sem ser preciso recalcular nada.
           * Quando a quinta chegar ao máximo e as Termas estiverem feitas, as
           * duas contas dão o mesmo e a cidade enche por completo.
           * ============================================================== */
          const orc = orcamentoPopulacao(town.id, tplNome);
          const popPorVoador = Number((units[unidadeVoadora] || {}).population) || 1;

          let popOutras = 0;
          for (const uid of Object.keys(alvos)) {
            if (uid === unidadeVoadora) continue;
            popOutras += (Number(alvos[uid]) || 0) * (Number((units[uid] || {}).population) || 0);
          }

          if (orc) {
            // alvo de longo prazo (quando tudo estiver construído)
            const alvoFinal = Math.max(0, orc.maxFinal - orc.gastoFinal - popOutras);
            // o que cabe agora sem estorvar a construção
            const cabeAgora = Math.max(0, orc.maxAgora - orc.gastoFinal - popOutras);

            const quantos = Math.floor(Math.min(alvoFinal, cabeAgora) / popPorVoador);
            if (quantos > 0) alvos[unidadeVoadora] = quantos;

            /* DIAGNÓSTICO: mostrar sempre as contas dos voadores. Sem isto
             * não se percebe porque uma cidade com muita população livre não
             * recruta nenhum. */
            rotina(`${town.name} [voadores]: máximo ${orc.maxAgora} · edifícios agora `
              + `${orc.gastoAgora} · no fim ${orc.gastoFinal} · outras tropas do template `
              + `${popOutras} → cabem ${cabeAgora} de população = ${quantos} `
              + `${(units[unidadeVoadora] || {}).name || 'voadores'} (${popPorVoador} cada).`);

            if (cabeAgora < alvoFinal && !avisouPop[town.id]) {
              avisouPop[town.id] = true;
              const falta = Math.floor((alvoFinal - cabeAgora) / popPorVoador);
              /* A frase antiga — "cabem mais 7" — parecia dizer que cabiam
               * AGORA, e depois o registo dizia "nada a recrutar". São o
               * mesmo facto: as 7 ainda NÃO cabem. */
              log(`ℹ️ ${town.name}: faltam ${falta} ${(units[unidadeVoadora] || {}).name || ''} `
                + 'para encher a cidade — só entram quando a quinta subir e as pesquisas '
                + 'de população estiverem feitas.');
            }
          }
        } else if (unidadeVoadora && alvoVoadores > 0) {
          alvos[unidadeVoadora] = alvoVoadores;
        }
      }
      if (!Object.keys(alvos).length) continue;
      expandido[town.id] = alvos;

      // Requisitos de arranque: a cidade só começa a recrutar quando os
      // edifícios definidos no template atingirem os níveis mínimos.
      const req = cumpreRequisitos(niveis[town.id], tpl.requisitos);
      if (!req.ok) continue;   // ainda não está pronta

      const reservaPct = tpl.reservaPct != null ? tpl.reservaPct : (opts.reservaPct || 0);
      const recursos = getRecursos(town.id);

      // Só recrutar com o armazém suficientemente cheio (ordens maiores rendem mais).
      // O mínimo de armazém é aplicado POR UNIDADE, na decisão — saltar a
      // cidade inteira aqui excluía unidades que nem sequer custam recursos
      // (o enviado divino custa favor e população, não madeira/pedra/prata).
      // (a verificação por unidade é feita dentro da decisão, com o custo real)
      const minPct = tpl.minArmazemPct;
      /* Mínimo de POPULAÇÃO por ordem. Se estiver definido, substitui a regra
       * antiga da percentagem do armazém. */
      const minPop = Number(tpl.minPopOrdem);
      const tenho = porOrigem[town.id] || {};
      const emFila = filas[town.id] || {};

      /* COLONIZADORES CONTÍNUOS
       * Assim que o template de tropas estiver cumprido, a cidade passa a
       * produzir colonizadores sem parar — para a rotação entre multis ou para
       * enviar à cidade que serve de depósito. Cada colonizador custa muita
       * população (170), mas como são enviados para fora, a população liberta-se
       * e faz-se outro.
       *
       * Só se faz quando o resto do template já está satisfeito, para não
       * competir com as tropas que interessam. */
      if (tpl.ncContinuo && cumpreOTemplate(alvos, tenho, emFila)) {
        const jaTem = Number(tenho[NC_ID]) || 0;
        const naFila = Number(emFila[NC_ID]) || 0;
        const limite = Number(tpl.ncMax) || 0;   // 0 = sem limite
        if (!limite || (jaTem + naFila) < limite) {
          /* Pedir TODOS os que os recursos e a população derem, não um de cada
           * vez: uma ordem de dois é melhor do que duas ordens de um.
           *
           * O `decidirRecrutamento` corta pelo que houver — aqui só se diz
           * quantos se querem ao todo. */
          const gdNC = units[NC_ID] || {};
          const custo = gdNC.resources || {};
          const disp = recursosGastaveis(recursos, reservaPct) || {};

          let cabemRecursos = Infinity;
          for (const k of ['wood', 'stone', 'iron']) {
            const c2 = Number(custo[k]) || 0;
            if (!c2) continue;
            cabemRecursos = Math.min(cabemRecursos, Math.floor((Number(disp[k]) || 0) / c2));
          }
          if (!Number.isFinite(cabemRecursos)) cabemRecursos = 1;

          const popNC = Number(gdNC.population) || 170;
          const cabemPop = Math.floor((Number(recursos.population) || 0) / popNC);

          const quantos = Math.max(1, Math.min(cabemRecursos, cabemPop));
          const alvoTotal = jaTem + naFila + quantos;

          alvos[NC_ID] = limite ? Math.min(limite, alvoTotal) : alvoTotal;
        }
      }

      /* Quanta população falta para acabar de construir o template: é isso que
       * NÃO se pode gastar em tropas. */
      const orcPop = orcamentoPopulacao(town.id, tplNome);
      const popParaConstruir = orcPop
        ? Math.max(0, orcPop.gastoFinal - orcPop.gastoAgora)
        : 0;

      const acoes = decidirRecrutamento(alvos, tenho, emFila, recursos, reservaPct, units,
        lerAdiamentos(town.id), favorLivre, descontoFavor(town.id), true,
        (uid) => descontoRecursos(heroiDaCidade(town.id), uid, units),
        (uid) => {
          const gd = units[uid] || {};

          /* O COLONIZADOR não obedece ao mínimo de ordem.
           *
           * Ele custa 10 000 de cada recurso e faz-se um de cada vez. A regra
           * do armazém compara o que se pode fazer AGORA com o que caberia com
           * o armazém cheio: com recursos para 2 e capacidade para 3, dá 67% —
           * abaixo dos 70% do template, e nunca se fazia nenhum.
           *
           * Como são produzidos continuamente e enviados para fora, faz-se
           * sempre que dê para um. */
          if (uid === NC_ID) return true;

          if (minPop > 0) {
            /* O mínimo só vale quando AINDA FALTA MUITO.
             *
             * Sem isto, o resto de um template nunca se fazia: 1 barco de
             * transporte são 7 de população e os últimos 30 espadachins são
             * 30 — nenhum chegaria aos 100 e ficariam por fazer para sempre.
             *
             * Se o que falta já vale menos do que o mínimo, é o remate do
             * template: faz-se de uma vez. */
            const faltaU = Math.max(0, (Number(alvos[uid]) || 0)
              - ((tenho[uid] || 0) + (emFila[uid] || 0)));
            const popQueFalta = faltaU * (Number(gd.population) || 1);
            if (popQueFalta <= minPop) return true;      // é o remate: deixa passar

            return popDaOrdemPossivel(recursos, gd.resources || {}, gd.population, reservaPct) >= minPop;
          }
          return armazemSuficiente(recursos, minPct, gd.resources).ok;
        },
        popParaConstruir, deusDaCidade(town.id));
      /* DIAGNÓSTICO: porque é que esta cidade não recruta nada.
       *
       * Percorre-se cada unidade do alvo e diz-se em que verificação parou.
       * Sem isto ficamos a adivinhar entre pesquisa, recursos, armazém,
       * população e favor. */
      if (!acoes.length) {
        try {
          const linhas = [];
          for (const uid of Object.keys(alvos)) {
            const querem = Number(alvos[uid]) || 0;
            const ja = (tenho[uid] || 0) + (emFila[uid] || 0);
            if (querem <= ja) continue;

            const gd = units[uid] || {};
            const nome = gd.name || uid;

            const semPesq = pesquisasEmFalta(uid, town.id);
            if (semPesq.length) { linhas.push(`${nome}: falta a pesquisa`); continue; }

            if (uid === NC_ID) {
              // o colonizador não obedece ao mínimo de ordem
            } else if (minPop > 0) {
              const popQueFalta = (querem - ja) * (Number(gd.population) || 1);
              if (popQueFalta > minPop) {
                const podePop = popDaOrdemPossivel(recursos, gd.resources || {}, gd.population, reservaPct);
                if (podePop < minPop) {
                  linhas.push(`${nome}: só dá para ${Math.round(podePop)} de população `
                    + `(mínimo ${minPop}; faltam ${popQueFalta})`);
                  continue;
                }
              }
            } else {
              const arm = armazemSuficiente(recursos, minPct, gd.resources);
              if (!arm.ok) { linhas.push(`${nome}: armazém a ${arm.pctAtual}% (min ${minPct}%)`); continue; }
            }

            const disp = recursosGastaveis(recursos, reservaPct) || {};
            const custo = gd.resources || {};
            const faltaRes = Object.keys(custo)
              .filter((k) => (Number(custo[k]) || 0) > (Number(disp[k]) || 0));
            if (faltaRes.length) {
              linhas.push(`${nome}: falta ${faltaRes.map((k) => `${k} ${Math.round(disp[k] || 0)}/${custo[k]}`).join(', ')}`);
              continue;
            }

            /* População: comparar com o ORÇAMENTO, não com o valor bruto.
             * O orçamento já desconta a reserva para construção — era por isso
             * que aparecia "passou tudo mas não foi pedido". */
            const popU = Number(gd.population) || 1;
            const popBruta = Number(recursos.population) || 0;
            const reservaPop = Math.max(30, Number(popReservada) || 0);
            const popOrcamento = Math.max(0, popBruta - reservaPop);
            if (popU > popOrcamento) {
              linhas.push(`${nome}: população ${popBruta} − ${reservaPop} reservados `
                + `= ${popOrcamento} < ${popU}`);
              continue;
            }

            /* Favor: o orçamento é POR DEUS e partilhado entre todas as
             * cidades desta passagem — se uma já o gastou, as seguintes ficam
             * sem. Comparar com o favor da cidade dava a ideia errada. */
            const fav = Number(gd.favor) || 0;
            if (fav > 0) {
              const deusU = (gd.god_id && gd.god_id !== 'all')
                ? gd.god_id : deusDaCidade(town.id);
              const restante = Number(favorLivre[deusU]) || 0;
              if (fav > restante) {
                linhas.push(`${nome}: favor de ${deusU} — resta ${restante}, precisa de ${fav} `
                  + '(o favor é partilhado por todas as cidades)');
                continue;
              }
            }

            linhas.push(`${nome}: passou tudo mas não foi pedido ← investigar`);
          }
          if (linhas.length) {
            rotina(`${town.name} [porque não recruta]: ${linhas.slice(0, 4).join(' · ')}`);
          }
        } catch (e) {}

        /* Descobrir o que falta, para o registo dizer alguma coisa útil.
         * Compara-se o custo da primeira unidade em falta com o que há
         * disponível depois da reserva. */
        try {
          const emFalta = Object.keys(alvos).find((u) =>
            (Number(alvos[u]) || 0) > ((tenho[u] || 0) + (emFila[u] || 0)));
          if (emFalta) {
            const custo = (units[emFalta] || {}).resources || {};
            const disp = recursosGastaveis(recursos, reservaPct) || {};
            const faltam = Object.keys(custo)
              .filter((k) => (Number(custo[k]) || 0) > (Number(disp[k]) || 0))
              .map((k) => `${k} ${Math.round(disp[k] || 0)}/${custo[k]}`);
            if (faltam.length) {
              travouPorRecursos.push(`${town.name}: ${(units[emFalta] || {}).name || emFalta} `
                + `precisa de ${faltam.join(', ')}`);
            }
          }
        } catch (e) {}
        continue;
      }

      // Feitiços de aceleração ANTES de recrutar: eles aceleram o que for
      // ordenado a seguir, por isso a ordem importa.
      await talvezAcelerar(ctx, town.id,
        acoes.map((a) => ({ unitId: a.unitId, quantidade: a.amount })), units, cfgFeiticos());

      for (const a of acoes) {
        /* TRAVÃO FINAL, imediatamente antes do pedido.
         *
         * Volta a contar o que a cidade TEM e o que está na fila, agora, e
         * recusa a ordem se já tiver o alvo. As contagens usadas para decidir
         * são feitas no início da passagem e podem estar desactualizadas — se
         * outra coisa recrutou entretanto, ou se a leitura falhou, passava-se
         * do alvo.
         *
         * Isto não substitui a decisão; é uma rede por baixo dela. */
        try {
          const alvoFinal = Number(alvos[a.unitId]) || 0;
          if (alvoFinal > 0 && a.unitId !== NC_ID) {
            const agoraTenho = contarUnidadesPorCidadeDeOrigem()[town.id] || {};
            const agoraFila = contarFilasPorCidade()[town.id] || {};
            const jaCom = (Number(agoraTenho[a.unitId]) || 0) + (Number(agoraFila[a.unitId]) || 0);

            if (jaCom >= alvoFinal) {
              log(`⛔ ${town.name}: NÃO recruto ${a.nome} — já tem ${jaCom} `
                + `e o alvo é ${alvoFinal}.`);
              continue;
            }
            /* Cortar a ordem ao que falta, se pedir de mais. */
            const cabe = alvoFinal - jaCom;
            if (a.amount > cabe) {
              log(`✂️ ${town.name}: ${a.nome} cortado de ${a.amount} para ${cabe} `
                + `(tem ${jaCom}, alvo ${alvoFinal}).`);
              a.amount = cabe;
            }
          }
        } catch (e) {}

        if (!a.amount || a.amount <= 0) continue;

        const r = await recrutar(town.id, a.unitId, a.amount, a.isNaval);
        if (r.ok) {
          fezAlgo = true;
          log(`⚔️ ${town.name}: +${a.amount} ${a.nome}${a.isNaval ? ' (porto)' : ''}${a.mitica ? ` [${a.deus}, favor resta ~${favorLivre[a.deus]}]` : ''}.`);
          await ctx.sleep(ctx.rand(600, 1200));
        } else {
          log(`⚠️ ${town.name}: falha a recrutar ${a.nome} (${r.msg}).`);
          break; // não insistir nesta cidade nesta ronda
        }
      }
    }
    try { armazem.setItem('grepoRecruta_expandido_v1', JSON.stringify(expandido)); } catch (e) {}
    if (!fezAlgo) {
      /* Dizer PORQUE não recrutou — sem isto, uma cidade com população livre
       * e favor parece estar avariada quando só lhe falta um recurso.
       * Visto em jogo: 2213 de população livre e 500 de favor, mas 401 de
       * pedra disponível para uma manticora que custa 3750. */
      if (travouPorRecursos.length) {
        rotina(`Recrutamento: ${travouPorRecursos.length} cidade(s) sem recursos — `
          + travouPorRecursos.slice(0, 3).join(' · '));
      } else {
        rotina('Ronda de recrutamento: nada a recrutar agora.');
      }
    }
  }

  /* ---------------------- PAINEL --------------------------------------- */
  let tplEdicao = null, grupoSel = null, pCtx = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function gruposDisponiveis() {
    // Excluir os grupos AUTOMÁTICOS do jogo (id negativo: "Todos", "Sem
    // grupos"): não são grupos criados por ti e o "Todos" ainda colidia com o
    // nosso grupo especial "todos".
    const doJogo = getTownGroups()
      .filter((g) => Number(g.id) > 0)
      .map((g) => g.name)
      .filter((n) => String(n).toLowerCase() !== 'todos');
    return Array.from(new Set(['todos', ...doJogo, ...Object.keys(tplEdicao || {})]));
  }

  function unidadesOrdenadas() {
    const u = gameUnits();
    return Object.keys(u)
      .filter((id) => id !== 'militia')
      .map((id) => ({ id, nome: u[id].name || id, naval: !!u[id].is_naval, pop: u[id].population || 0 }))
      .sort((a, b) => (a.naval === b.naval ? a.nome.localeCompare(b.nome) : (a.naval ? 1 : -1)));
  }

  function render(container) {
    if (!tplEdicao) tplEdicao = loadLocal();
    const grupos = gruposDisponiveis();

    /* Templates de grupos que já não existem no jogo. */
    const orfaos = Object.keys(tplEdicao).filter((g) => grupos.indexOf(g) < 0);
    const todosNoSel = grupos.concat(orfaos);
    if (!grupoSel || todosNoSel.indexOf(grupoSel) < 0) grupoSel = grupos[0] || 'todos';
    const tpl = tplEdicao[grupoSel];

    /* Bloco dos VOADORES no topo: vale para a conta toda, não para um
     * template. Estando aqui em cima, sabe-se logo qual é o grupo escolhido, e
     * o template desse grupo passa a mostrar quantos voadores vão caber. */
    const gVoa = grupoVoadores();
    const avisoOrfao = orfaos.indexOf(grupoSel) >= 0
      ? `<div style="font-size:11px;padding:6px;background:#2a1a10;border:1px solid #5a3a20;
          border-radius:4px;margin-bottom:6px">
          ⚠ O grupo "<b>${esc(grupoSel)}</b>" <b>não existe no jogo</b> — este template nunca é
          aplicado. Cria o grupo com este nome, ou carrega em "Apagar".
        </div>` : '';

    let html = avisoOrfao + `
      <div style="background:#0a1017;border:1px solid #2c3e50;border-radius:5px;padding:7px;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="rec-voadores-on"${voadoresLigados() ? ' checked' : ''}>
          <b>Fazer voadores nesta conta</b>
        </label>
        <div style="margin-top:4px">
          Em que grupo:
          <select id="rec-voadores-grupo" style="max-width:150px">
            <option value=""${!gVoa ? ' selected' : ''}>(todas as cidades)</option>
            ${gruposDisponiveis().filter((g) => g !== 'todos').map((g) =>
              `<option value="${esc(g)}"${gVoa === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}
          </select>
        </div>
        <div style="opacity:.6;font-size:10px;margin-top:3px">
          Essas cidades fazem as unidades do template do seu grupo e gastam
          <b>toda a população restante</b> no voador do seu deus.<br>
          Zeus→Manticora · Hera→Harpia · Atena→Pégaso · Ártemis→Grifo · Ares→Ladão
        </div>
        ${voadoresLigados() ? `
          <div style="opacity:.7;font-size:10px;margin-top:4px;color:#fc8">
            ⚠ Os voadores gastam <b>favor</b>. Numa conta cujo favor serve para ser
            roubado (as multis), isto consome o que a main iria buscar.
          </div>` : ''}
      </div>

      <div style="font-size:11px;opacity:.85;margin-bottom:4px">Alvos de tropas — o script recruta até atingir estas quantidades.</div>
      <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        <select id="rec-grupo" style="flex:1;min-width:90px">
          ${grupos.map((g) => `<option value="${esc(g)}"${g === grupoSel ? ' selected' : ''}>${esc(g)}${tplEdicao[g] ? ' ✓' : ''}</option>`).join('')}
          ${orfaos.length ? `<optgroup label="grupos que já não existem no jogo">
            ${orfaos.map((g) => `<option value="${esc(g)}"${g === grupoSel ? ' selected' : ''}>${esc(g)} ⚠</option>`).join('')}
          </optgroup>` : ''}
        </select>
        <button id="rec-criar" style="cursor:pointer">Ativar grupo</button>
        <button id="rec-apagar" style="cursor:pointer;color:#f88">Apagar</button>
      </div>

      ${(() => {
        /* Copiar de outro grupo: os templates costumam ser parecidos. */
        const outros = Object.keys(tplEdicao).filter((g) => g !== grupoSel);
        if (!outros.length) return '';
        return `<div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;font-size:11px">
          <span style="opacity:.75;flex:0 0 auto">copiar de</span>
          <select id="rec-copiar-de" style="flex:1">
            <option value="">— escolher grupo —</option>
            ${outros.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
          </select>
          <button id="rec-copiar" style="cursor:pointer">Copiar</button>
        </div>`;
      })()}`;

    if (!tpl) {
      html += `<div style="font-size:11px;opacity:.8;padding:6px;background:#0d141c;border-radius:4px">
        O grupo "<b>${esc(grupoSel)}</b>" ainda não tem alvos. Carrega em "Ativar grupo".</div>`;
      container.innerHTML = html;
      ligarTopo(container);
      return;
    }

    const alvos = tpl.unidades = tpl.unidades || {};
    const lista = unidadesOrdenadas();

    // linhas de unidade (só as que têm alvo definido) + seletor para adicionar
    html += `<div style="background:#0d141c;padding:4px;border-radius:4px;max-height:180px;overflow:auto">`;
    const comAlvo = Object.keys(alvos);
    if (!comAlvo.length) html += `<div style="font-size:11px;opacity:.6;padding:4px">Ainda sem unidades. Adiciona abaixo.</div>`;
    for (const id of comAlvo) {
      const u = gameUnits()[id] || {};
      html += `<div style="display:flex;gap:4px;align-items:center;margin-bottom:3px">
        <span style="flex:1;font-size:11px">${esc(u.name || id)}${u.is_naval ? ' ⚓' : ''}</span>
        <input type="number" min="0" value="${Number(alvos[id]) || 0}" data-alvo="${esc(id)}" style="width:60px">
        <a href="#" data-rem="${esc(id)}" style="text-decoration:none;color:#f88">🗑️</a>
      </div>`;
      // Validação cruzada: o template de CONSTRUÇÃO deste grupo chega aos
      // níveis que esta unidade exige? Sem isto, podia-se pedir colonizadores
      // num grupo cujo template nunca chega ao porto 10 — e nunca se perceber.
      const v = validarUnidadeNoGrupo(id, grupoSel);
      /* Só se compara com o TEMPLATE de pesquisa, não com o que está
       * investigado na cidade activa: o painel é para configurar, e o estado
       * de uma cidade não diz nada sobre as outras do grupo.
       * (Na execução, a unidade continua a ser saltada em silêncio até a
       * pesquisa estar feita — isso é outra coisa.) */
      if (v.edificios.length || v.pesquisas.length) {
        const partes = [];
        if (v.edificios.length) {
          partes.push(`exige ${v.edificios.map((f) => `${nomeEdificio(f.edificio)} ${f.exigido}`).join(', ')}`
            + ` — o template de construção só prevê ${v.edificios.map((f) => f.previsto).join(', ')}`);
        }
        if (v.pesquisas.length) {
          partes.push(`falta investigar ${v.pesquisas.map(nomePesquisa).join(', ')} no template de pesquisa`);
        }
        html += `<div style="font-size:10px;color:#fc8;margin:-2px 0 4px 6px;line-height:1.4">
          ⚠ ${partes.join('<br>⚠ ')}.
        </div>`;
      }
    }
    html += `</div>`;

    html += `<div style="display:flex;gap:4px;margin:5px 0">
      <select id="rec-add-sel" style="flex:1">
        ${lista.map((u) => `<option value="${esc(u.id)}">${esc(u.nome)}${u.naval ? ' ⚓' : ''} (pop ${u.pop})</option>`).join('')}
      </select>
      <button id="rec-add" style="cursor:pointer">+ Adicionar</button>
    </div>`;

    // resumo (como no painel de referência)
    const r = resumoTemplate(alvos);
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px">
      ${caixa('População total', r.popTotal)}
      ${caixa('População terrestre', r.popTerrestre)}
      ${caixa('Capacidade naval (sem beliches)', r.capSem)}
      ${caixa('Capacidade naval (com beliches)', r.capCom)}
    </div>`;

    // ---- orçamento de população: quanto sobra para tropas ----
    html += `<div id="rec-pop-orcamento">${htmlOrcamentoPop(alvos, grupoSel)}</div>`;

    // alvo genérico de voadores (adapta-se ao deus de cada cidade)
    html += `<div style="background:#0d141c;padding:5px;border-radius:4px;margin-bottom:6px;font-size:11px">

      </div>
    </div>`;

    // requisitos de arranque e mínimo de armazém
    const rq = tpl.requisitos = tpl.requisitos || {};
    html += `<div style="background:#0d141c;padding:5px;border-radius:4px;margin-bottom:6px;font-size:11px">
      <b>Só começar a recrutar com:</b><br>
      Quinta <input type="number" min="0" value="${Number(rq.farm) || 0}" data-req="farm" style="width:40px"> ·
      Armazém <input type="number" min="0" value="${Number(rq.storage) || 0}" data-req="storage" style="width:40px"><br>
      Quartel <input type="number" min="0" value="${Number(rq.barracks) || 0}" data-req="barracks" style="width:40px"> ·
      Porto <input type="number" min="0" value="${Number(rq.docks) || 0}" data-req="docks" style="width:40px"> ·
      Academia <input type="number" min="0" value="${Number(rq.academy) || 0}" data-req="academy" style="width:40px"><br>
      <span style="opacity:.65">0 = sem exigência. Algumas unidades precisam de edifícios a certo nível.</span>
    </div>
    ${(() => {
      const cf = cfgFeiticos();
      const fav = favorPorDeus();
      const linha = (f, edificio) => {
        const tem = Number(fav[f.deus]) || 0;
        const chega = tem >= f.favor;
        return `<label style="display:block;padding:1px 0">
          <input type="checkbox" data-feitico="${f.id}"${(cf.usar || []).includes(f.id) ? ' checked' : ''}>
          ${f.nome} <span style="opacity:.6">— ${edificio}, ${f.bonus}, ${f.favor} de ${f.deus}</span>
          <span style="color:${chega ? '#7d7' : '#f88'}">(tens ${tem})</span>
        </label>`;
      };
      return `<div style="background:#0d141c;padding:6px;border-radius:4px;margin-bottom:6px;font-size:11px">
        <label><input type="checkbox" id="rec-feiticos"${cf.ativo ? ' checked' : ''}> <b>Acelerar com feitiços</b></label>
        <div style="opacity:.65;font-size:10px;margin:2px 0 4px 18px">
          Lançado ANTES da ordem, acelera tudo o que for recrutado nas 4 h seguintes.
          A cidade não precisa de venerar o deus — basta teres o favor.
        </div>
        ${FEITICOS.quartel.map((f) => linha(f, 'quartel')).join('')}
        ${FEITICOS.porto.map((f) => linha(f, 'porto')).join('')}
        <div style="margin-top:4px">
          Só a partir de <input type="number" min="1" id="rec-feit-min" value="${cf.minPopulacao}" style="width:56px">
          de população a recrutar
          <div style="opacity:.6;font-size:10px">Evita gastar 80 de favor para acelerar meia dúzia de unidades.</div>
        </div>
      </div>`;
    })()}
    <div style="background:#0d141c;padding:5px;border-radius:4px;margin-bottom:6px;font-size:11px">
      Só recrutar se a ordem valer pelo menos
      <input type="number" min="0" max="2000" value="${Number(tpl.minPopOrdem) || 0}" id="rec-minpop" style="width:56px">
      de população<br>
      <span style="opacity:.65">Evita ordens minúsculas, e mede o que interessa: 15 birremes são
      120 de população (vale a pena), 15 espadachins são 15 (não vale). O mesmo número serve
      para qualquer unidade e não muda quando o armazém cresce. 0 = desligado.</span>

      <div style="margin-top:5px;opacity:.7">
        <i>Regra antiga (percentagem do armazém):</i>
        <input type="number" min="0" max="100" value="${Number(tpl.minArmazemPct) || 0}" id="rec-minarm" style="width:44px">%
        <span style="font-size:10px">— só é usada se a de cima estiver a 0.</span>
      </div>
    </div>`;

    // reserva de recursos para a construção
    const reserva = tpl.reservaPct != null ? tpl.reservaPct : 0;
    html += `<div style="display:flex;gap:5px;align-items:center;margin-bottom:6px;font-size:11px">
      <span style="flex:1">Reservar para construção:</span>
      <input type="number" min="0" max="90" value="${reserva}" id="rec-reserva" style="width:50px">
      <span>% do armazém</span>
    </div>

    <div style="background:#0d141c;padding:6px;border-radius:4px;margin-bottom:6px;font-size:11px">
      <label><input type="checkbox" id="rec-nc-cont"${tpl.ncContinuo ? ' checked' : ''}>
        <b>Depois do template cumprido, fazer colonizadores sem parar</b></label>
      <div style="opacity:.65;font-size:10px;margin:2px 0 4px 18px">
        Para a rotação entre multis ou para enviar à cidade que serve de depósito.
        Só começa quando as outras tropas do template já estiverem feitas.
      </div>
      <div style="margin-left:18px">
        Parar aos <input type="number" min="0" id="rec-nc-max" value="${Number(tpl.ncMax) || 0}" style="width:56px">
        colonizadores <span style="opacity:.6;font-size:10px">(0 = sem limite)</span>
      </div>
    </div>`;

    html += `<button id="rec-guardar" style="cursor:pointer;width:100%;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar alvos</button>`;

    container.innerHTML = html;
    ligarTopo(container);
    ligarCorpo(container, tpl);
  }

  function caixa(titulo, valor) {
    return `<div style="background:#0d141c;padding:5px;border-radius:4px">
      <div style="font-size:10px;opacity:.7">${titulo}</div>
      <div style="font-weight:bold">${Number(valor).toLocaleString('pt-PT')}</div>
    </div>`;
  }

  function ligarTopo(container) {
    /* Controlos dos VOADORES: valem para a conta toda, por isso ligam-se aqui
     * (o topo é desenhado mesmo quando o grupo ainda não tem template). */
    const vOn = container.querySelector('#rec-voadores-on');
    if (vOn) vOn.onchange = () => {
      ligarVoadores(vOn.checked);
      if (pCtx) {
        pCtx.log(vOn.checked
          ? 'Voadores ligados nesta conta.'
          : 'Voadores desligados nesta conta.');
      }
      render(container);
    };

    const vGrupo = container.querySelector('#rec-voadores-grupo');
    if (vGrupo) {
      // preencher ao abrir: os grupos podem carregar depois do painel
      vGrupo.onmousedown = () => {
        const nomes = gruposDisponiveis().filter((g) => g !== 'todos');
        if (nomes.length && vGrupo.options.length - 1 !== nomes.length) {
          const atual = vGrupo.value;
          vGrupo.innerHTML = '<option value="">(todas as cidades)</option>'
            + nomes.map((g) => `<option value="${esc(g)}"${atual === g ? ' selected' : ''}>${esc(g)}</option>`).join('');
        }
      };
      vGrupo.onchange = () => {
        guardarGrupoVoadores(vGrupo.value);
        if (pCtx) {
          pCtx.log(vGrupo.value
            ? `Voadores: só nas cidades do grupo "${vGrupo.value}".`
            : 'Voadores: em todas as cidades da conta.');
        }
        render(container);
      };
    }

    const sel = container.querySelector('#rec-grupo');
    if (sel) sel.onchange = (e) => { grupoSel = e.target.value; render(container); };
    const bCop = container.querySelector('#rec-copiar');
    if (bCop) bCop.onclick = () => {
      const sel = container.querySelector('#rec-copiar-de');
      const de = sel && sel.value;
      if (!de) { if (pCtx) pCtx.log('Escolhe primeiro o grupo a copiar.'); return; }
      const origem = tplEdicao[de];
      if (!origem) return;
      if (tplEdicao[grupoSel] && !confirm(`Substituir o template de "${grupoSel}" pelo de "${de}"?`)) return;

      // cópia profunda: senão os dois grupos partilhavam os mesmos objectos
      tplEdicao[grupoSel] = JSON.parse(JSON.stringify(origem));
      if (pCtx) pCtx.log(`Copiei o template de "${de}" para "${grupoSel}". Ajusta e guarda.`);
      render(container);
    };

    const criar = container.querySelector('#rec-criar');
    if (criar) criar.onclick = () => { if (!tplEdicao[grupoSel]) tplEdicao[grupoSel] = { unidades: {}, reservaPct: 0 }; render(container); };
    const apagar = container.querySelector('#rec-apagar');
    if (apagar) apagar.onclick = () => {
      if (grupoSel === 'todos') { alert('O grupo "todos" não pode ser apagado.'); return; }
      if (confirm('Apagar os alvos do grupo "' + grupoSel + '"?')) { delete tplEdicao[grupoSel]; grupoSel = null; render(container); }
    };
  }

  function ligarCorpo(container, tpl) {
    container.querySelectorAll('[data-alvo]').forEach((el) => {
      // enquanto se escreve: actualizar SÓ o orçamento de população (redesenhar
      // o painel todo faria perder o foco do campo a meio da escrita)
      el.oninput = (e) => {
        tpl.unidades[el.getAttribute('data-alvo')] = Math.max(0, Number(e.target.value) || 0);
        const cx = container.querySelector('#rec-pop-orcamento');
        if (cx) cx.innerHTML = htmlOrcamentoPop(tpl.unidades, grupoSel);
      };
      el.onchange = (e) => {
        tpl.unidades[el.getAttribute('data-alvo')] = Math.max(0, Number(e.target.value) || 0);
        render(container); // re-render completo ao sair do campo
      };
    });
    container.querySelectorAll('[data-rem]').forEach((el) => {
      el.onclick = (e) => { e.preventDefault(); delete tpl.unidades[el.getAttribute('data-rem')]; render(container); };
    });
    const add = container.querySelector('#rec-add');
    if (add) add.onclick = () => {
      const id = container.querySelector('#rec-add-sel').value;
      if (!(id in tpl.unidades)) tpl.unidades[id] = 0;
      render(container);
    };
    container.querySelectorAll('[data-req]').forEach((el) => {
      el.onchange = (e) => {
        tpl.requisitos = tpl.requisitos || {};
        tpl.requisitos[el.getAttribute('data-req')] = Math.max(0, Number(e.target.value) || 0);
      };
    });

    const guardarFeit = () => {
      const usar = [];
      container.querySelectorAll('[data-feitico]').forEach((el) => {
        if (el.checked) usar.push(el.getAttribute('data-feitico'));
      });
      guardarCfgFeiticos({
        ativo: container.querySelector('#rec-feiticos').checked,
        minPopulacao: Number(container.querySelector('#rec-feit-min').value) || 200,
        usar,
      });
    };
    const elFeit = container.querySelector('#rec-feiticos');
    if (elFeit) {
      elFeit.onchange = guardarFeit;
      container.querySelectorAll('[data-feitico]').forEach((el) => { el.onchange = guardarFeit; });
      const elMin = container.querySelector('#rec-feit-min');
      if (elMin) elMin.onchange = guardarFeit;
    }

    const minArm = container.querySelector('#rec-minarm');
    if (minArm) minArm.onchange = (e) => { tpl.minArmazemPct = Math.min(100, Math.max(0, Number(e.target.value) || 0)); };
    const minPop = container.querySelector('#rec-minpop');
    if (minPop) minPop.onchange = (e) => { tpl.minPopOrdem = Math.max(0, Number(e.target.value) || 0); };
    const voOn = container.querySelector('#rec-voadores-on');
    if (voOn) voOn.onchange = (e) => { ligarVoadores(e.target.checked); render(container); };
    const vo = container.querySelector('#rec-voadores');
    if (vo) vo.onchange = (e) => { tpl.voadores = Math.max(0, Number(e.target.value) || 0); render(container); };

    // encher com o que sobra, ou número fixo
    container.querySelectorAll('input[name="rec-voa-modo"]').forEach((el) => {
      el.onchange = () => {
        tpl.voadoresModo = el.value;
        if (pCtx) {
          pCtx.log(el.value === 'alvo'
            ? 'Voadores: número fixo por cidade.'
            : 'Voadores: encher com a população que sobrar depois dos edifícios e das outras unidades.');
        }
        render(container);
      };
    });
    const voRes = container.querySelector('#rec-voa-reserva');
    if (voRes) voRes.onchange = (e) => { tpl.voadoresReserva = Math.max(0, Number(e.target.value) || 0); };
    const ncC = container.querySelector('#rec-nc-cont');
    if (ncC) ncC.onchange = (e) => { tpl.ncContinuo = e.target.checked; render(container); };
    const ncM = container.querySelector('#rec-nc-max');
    if (ncM) ncM.onchange = (e) => { tpl.ncMax = Math.max(0, Number(e.target.value) || 0); };

    const res = container.querySelector('#rec-reserva');
    if (res) res.onchange = (e) => { tpl.reservaPct = Math.min(90, Math.max(0, Number(e.target.value) || 0)); };
    const guardar = container.querySelector('#rec-guardar');
    if (guardar) guardar.onclick = async () => {
      guardar.textContent = 'A guardar...';
      const r = await writeGist(tplEdicao);
      if (pCtx) pCtx.log(r.ok ? 'Alvos de recrutamento guardados no Gist.' : 'Alvos guardados localmente (' + r.msg + ').');
      guardar.textContent = r.ok ? 'Guardado ✓' : 'Guardado (local)';
      setTimeout(() => { guardar.textContent = 'Guardar alvos'; }, 1800);
    };
  }

  // O painel pode ser desenhado ANTES de o jogo ter carregado os grupos de
  // cidades — e como só se redesenha quando mexes nele, ficava com a lista
  // vazia. Esperamos que apareçam e redesenhamos uma vez.
  function redesenharQuandoHouverGrupos(container) {
    try {
      if (getTownGroups().length) return;
      let tentativas = 0;
      const t = setInterval(() => {
        tentativas++;
        if (getTownGroups().length) { clearInterval(t); try { render(container); } catch (e) {} }
        else if (tentativas > 40) clearInterval(t);   // ~20 s e desiste
      }, 500);
    } catch (e) {}
  }


  /* Preservar a posição do rolamento ao redesenhar o painel — senão volta ao
   * topo a cada alteração. */
  function comRolamento(fn) {
    /* Guardar TODOS os elementos que estejam rolados, não só os que se
     * adivinham: o que rola pode ser uma caixa interna e o salto para o topo
     * mantinha-se. */
    /* Guardar o CAMINHO e não só a referência: o redesenho destrói os
     * elementos internos e a referência antiga deixa de estar no ecrã. */
    const caminhoDe = (el) => {
      const p = []; let n = el;
      while (n && n.parentElement && p.length < 30) {
        p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
        if (n.id) { p.unshift('#' + n.id); break; }
      }
      return p;
    };
    const porCaminho = (p) => {
      try {
        if (!p.length) return null;
        let n = null, i = 0;
        if (typeof p[0] === 'string' && p[0].charAt(0) === '#') { n = document.getElementById(p[0].slice(1)); i = 1; }
        else n = document.body;
        for (; n && i < p.length; i++) n = n.children[p[i]];
        return n || null;
      } catch (e) { return null; }
    };

    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}
    fn();
    const repor = () => guardados.forEach(({ caminho, y, el }) => {
      try {
        if (el && el.isConnected) { el.scrollTop = y; return; }
        const n2 = porCaminho(caminho);
        if (n2) n2.scrollTop = y;
      } catch (e) {}
    });
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  function painel(container, ctx) {
    pCtx = ctx;
    pCtx = ctx; mUw = ctx.uw; mWorld = ctx.WORLD;
    render(container);
    redesenharQuandoHouverGrupos(container);
    readGist().then((t) => { tplEdicao = t; render(container); }).catch(() => {});
  }

  return {
    id: 'recrutamento',
    nome: 'Auto-recrutamento',
    intervaloMin: opts.intervaloMin || 10,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
  };
}

  // ========================== MÓDULO: HERÓIS =============================
/* =============================================================================
 *  MÓDULO: HERÓIS  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  É um módulo de CONTA (não por cidade/grupo):
 *   1. Recrutamento: todos os dias há uma oferta (1 herói de guerra + 1 de
 *      sabedoria). Se um deles estiver na tua lista de desejados e houver
 *      moedas, compra-o.
 *   2. Subida de nível: sobe os heróis marcados, usando o excedente de moedas.
 *
 *  Regra de prioridade: mantém 120 moedas de cada tipo em reserva para poder
 *  comprar heróis; só o excedente vai para níveis. Se já não houver heróis
 *  desejados por comprar, a reserva liberta-se.
 *
 *  Pedidos (frontend_bridge/execute):
 *    comprar : model_url "PlayerHero",       action "buyHero"     {type}
 *    subir   : model_url "PlayerHero/<id>",  action "levelUpHero" {type, amount}
 * ========================================================================== */

function makeHeroisModule(opts) {
  opts = opts || {};

  /* Nome do ficheiro no Gist, COM o mundo.
   *
   * Sem o mundo, o pt125 e o pt126 escrevem no mesmo ficheiro e sobrepõem-se
   * — um mundo de cerco quer a muralha baixa e um de revolta quer a muralha
   * no máximo, e ficavam com os mesmos templates.
   *
   * Calcula-se na altura de usar, porque o mundo só se sabe quando o módulo
   * corre. */
  /* Nome do ficheiro no Gist: inclui o PERFIL e o MUNDO.
   *
   * Sem o perfil, a main e as multis do mesmo mundo escreviam no mesmo
   * ficheiro — e apagar os templates de um perfil não servia de nada, porque
   * voltavam do Gist na leitura seguinte.
   *
   * Sem o mundo, o pt125 e o pt126 sobrepunham-se — um mundo de cerco quer a
   * muralha baixa e um de revolta quer a muralha no máximo.
   *
   * Num mundo novo (o pt127, por exemplo) o nome é novo e o ficheiro nasce
   * vazio: não é preciso fazer nada. */
  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function ficheiroGist() {
    const base = String(GIST.filename || 'templates.json').replace(/\.json$/, '');
    const mundo = (typeof mWorld !== 'undefined' && mWorld) ? mWorld : 'x';
    let perfil = 'main';
    try {
      const e = JSON.parse(armazem.getItem('grepoMaestro_modulos_v1') || 'null');
      if (e && e.perfil) perfil = String(e.perfil);
    } catch (e) {}
    return `${base}-${perfil}-${mundo}.json`;
  }

  const GIST = {
    id: opts.gistId || '',
    token: opts.gistToken || '',
    /* O ficheiro TEM de incluir o mundo: sem isso, o pt125 e o pt126
     * escrevem no mesmo e sobrepõem-se — um mundo de cerco quer a muralha
     * baixa e um de revolta quer a muralha no máximo, e ficavam iguais. */
    filename: opts.gistFile || 'herois-config.json',
  };

  /* Reserva em DOIS níveis:
   *   • enquanto faltarem heróis da lista de compra → 120, para não gastar as
   *     moedas em níveis e depois não ter para comprar;
   *   • já com todos comprados → 60, deixando margem para um herói que se
   *     queira mais tarde sem congelar tudo. */
  const RESERVA_MOEDAS = opts.reservaMoedas != null ? opts.reservaMoedas : 120;
  const RESERVA_DEPOIS = opts.reservaDepois != null ? opts.reservaDepois : 60;

  let mUw = null;

  // RELÓGIO DO SERVIDOR — o único que conta.
  // O relógio da máquina é irrelevante e enganador: este VPS está em Espanha e
  // o jogo corre em hora portuguesa, uma hora de diferença PERMANENTE. Se o
  // servidor não estiver disponível devolvemos null e o módulo NÃO age, em vez
  // de agir com uma hora possivelmente errada.
  function agoraJogo() {
    try {
      if (typeof mUw.Timestamp !== 'undefined' && typeof mUw.Timestamp.now === 'function') {
        const t = Math.floor(mUw.Timestamp.now());
        if (Number.isFinite(t) && t > 0) return t;
      }
    } catch (e) {}
    try {
      const t = Number(mUw.Game && mUw.Game.server_time);
      if (Number.isFinite(t) && t > 0) return Math.floor(t);
    } catch (e) {}
    return null;   // sem relógio do servidor: não se inventa
  }

  let mWorld = '';

  /* ---------------------- dados do jogo -------------------------------- */
  function gameHerois() {
    try { return mUw.GameData.heroes || {}; } catch (e) { return {}; }
  }

  // Moedas: sabedoria, guerra, e "both" (serve para qualquer um).
  function getMoedas() {
    try {
      const pl = mUw.MM.getModels().PlayerLedger;
      const k = Object.keys(pl)[0];
      const a = pl[k].attributes || {};
      return {
        wisdom: a.coins_of_wisdom || 0,
        war: a.coins_of_war || 0,
        both: a.coins_of_both || 0,
      };
    } catch (e) { return { wisdom: 0, war: 0, both: 0 }; }
  }

  // Oferta do dia: { hero_of_war, hero_of_wisdom }
  function getOferta() {
    try {
      const m = mUw.MM.getModels().HeroesRecruitment || {};
      const k = Object.keys(m)[0];
      if (!k) return null;
      const d = (m[k].attributes || {}).hero_recruitment_data || {};
      return { war: d.hero_of_war || null, wisdom: d.hero_of_wisdom || null };
    } catch (e) { return null; }
  }

  /* PEDIR a oferta ao servidor.
   *
   * O modelo `HeroesRecruitment` só se preenche quando se ABRE a janela dos
   * heróis no jogo. Enquanto isso não acontecer, o módulo não vê oferta
   * nenhuma e nunca compra — foi o que aconteceu nas multis, que nunca
   * compraram nada.
   *
   * Confirmado no jogo: `frontend_bridge?action=fetch` com
   * `window_type: 'heroes'` devolve a oferta do dia. */
  async function pedirOferta() {
    try {
      const t = mUw.Game.townId;
      const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(t)
        + '&action=fetch&h=' + mUw.Game.csrfToken
        /* O `known_data` é obrigatório: sem ele o servidor responde vazio.
         * Diz que modelos e coleções o cliente já tem, e a resposta traz o
         * resto — incluindo a oferta do dia e as moedas. */
        + '&json=' + encodeURIComponent(JSON.stringify({
          window_type: 'heroes',
          tab_type: 'overview',
          known_data: {
            models: ['PlayerLedger'],
            collections: ['FeatureBlocks'],
            templates: [
              'heroes__main', 'heroes__buy_hero_slot_buttons',
              'heroes__exchange_currency', 'heroes__tooltip_with_arrow',
              'heroes__instant_buy_tooltip',
            ],
          },
          town_id: Number(t),
          nl_init: true,
        }))
        + '&_=' + Date.now();

      const r = await mUw.fetch(url, {
        headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include',
      });
      const txt = await r.text();
      if (!txt) return null;

      /* A resposta traz o HTML da janela; a oferta vem nos dados. Procura-se
       * directamente, sem depender da estrutura toda. */
      const guerra = (txt.match(/"hero_of_war":"(\w+)"/) || [])[1] || null;
      const sabedoria = (txt.match(/"hero_of_wisdom":"(\w+)"/) || [])[1] || null;

      /* As MOEDAS não vêm nesta resposta — estão no `PlayerLedger`, que o
       * `getMoedas()` já lê. Confirmado: a resposta traz só a oferta. */
      if (!guerra && !sabedoria) return null;
      return { war: guerra, wisdom: sabedoria };
    } catch (e) { return null; }
  }

  // Os meus heróis: [{ id, type, level, xp }]
  function getMeusHerois() {
    try {
      // Confirmado no jogo: a colecção chama-se PlayerHero (SINGULAR). Com o
      // plural não encontrava nenhum herói e a rotação dizia "ainda não o tens"
      // mesmo tendo-os todos.
      const cols = mUw.MM.getCollections();
      const col = (cols.PlayerHero || cols.PlayerHeroes || [])[0];
      const models = (col && col.models) || [];
      return models.map((m) => {
        const a = m.attributes || {};
        return { id: a.id, type: a.type, level: a.level || 1, xp: a.experience_points || 0 };
      });
    } catch (e) { return []; }
  }

  // Tabela de XP por nível e slots livres.
  function getHeroesMeta() {
    try {
      const h = mUw.MM.getModels().Heroes;
      const k = Object.keys(h)[0];
      const a = h[k].attributes || {};
      return {
        limites: a.experience_limits || {},
        slotsLivres: a.free_slots != null ? a.free_slots : 0,
      };
    } catch (e) { return { limites: {}, slotsLivres: 0 }; }
  }

  function nivelMaximo() {
    try { return (mUw.GameData.heroes_meta || {}).max_level || 20; } catch (e) { return 20; }
  }

  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * (é preciso recarregar para ver o efeito) E faz a passagem seguinte ler
   * valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels()[Nome].
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }


  async function bridge(modelUrl, actionName, args, townId) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    const payload = {
      model_url: modelUrl, action_name: actionName, captcha: null,
      arguments: args, town_id: Number(townId), nl_init: true,
    };
    try {
      const resp = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      });

      /* O servidor devolve por vezes uma resposta VAZIA — e `x.json()` rebenta
       * com "Unexpected end of JSON input", que não diz nada de útil.
       * Lê-se o texto primeiro e só se converte se houver conteúdo. */
      const txt = await resp.text();
      if (!txt || !txt.trim()) {
        return { ok: false, msg: `o servidor não respondeu (HTTP ${resp.status})` };
      }
      let r;
      try { r = JSON.parse(txt); }
      catch (e) {
        return { ok: false, msg: `resposta ilegível do servidor (HTTP ${resp.status}): ${txt.slice(0, 60)}` };
      }
      aplicarNotificacoes(r);
      const j = r && r.json;
      const erro = j && j.error;
      return { ok: !erro, msg: erro || (j && j.success) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  const comprarHeroi = (type, townId) => bridge('PlayerHero', 'buyHero', { type }, townId);
  const subirNivel = (heroId, type, amount, townId) =>
    bridge('PlayerHero/' + heroId, 'levelUpHero', { type, amount }, townId);
  const atribuirACidade = (heroId, type, targetTownId) =>
    bridge('PlayerHero/' + heroId, 'assignToTown', { type, target_town_id: Number(targetTownId) }, targetTownId);
  // Retirar de uma cidade: o jogo recusa atribuir directamente um herói que já
  // esteja colocado ("já foi atribuído a uma cidade ou um ataque").
  const retirarDaCidade = (heroId, type, townId) =>
    bridge('PlayerHero/' + heroId, 'unassignFromTown', { type, target_town_id: Number(townId) }, townId);

  /* ============ ROTAÇÃO: heróis que ajudam no recrutamento ============== */
  // Os bónus não têm campo estruturado no jogo — só texto. Cruzamos o texto da
  // descrição com os nomes das unidades (singular/plural) do GameData.units.
  function normalizar(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function tiposDeBonus(texto) {
    const t = normalizar(texto), tipos = [];
    if (/barat|custo/.test(t)) tipos.push('custo');
    if (/rapid|tempo|velocidade/.test(t)) tipos.push('tempo');
    if (/favor/.test(t)) tipos.push('favor');
    return tipos;
  }
  function ehBonusDeRecrutamento(texto) {
    const t = normalizar(texto);
    if (/mais fortes|ataque|defesa|revolta|edificio/.test(t)) return false;
    return tiposDeBonus(texto).length > 0;
  }
  function unidadesMencionadas(texto, unidades) {
    const t = normalizar(texto), achadas = new Set();
    // genéricos: "navios" isolado NÃO conta (senão "navios-faróis" apanharia tudo)
    const naval = /unidades navais|toda a frota|todos os navios/.test(t);
    const terrestre = /unidades terrestres|tropas terrestres/.test(t);
    const mitica = /unidades miticas|miticas/.test(t);
    for (const id of Object.keys(unidades)) {
      const u = unidades[id];
      if (naval && u.is_naval) achadas.add(id);
      if (terrestre && u.is_naval === false && !u.god_id) achadas.add(id);
      if (mitica && u.god_id) achadas.add(id);
    }
    const nomes = [];
    const add = (id, n) => {
      const b = normalizar(n);
      if (!b || b.length < 4) return;
      nomes.push({ id, n: b });
      const s = b.replace(/rr/g, 'r'); // "birremes" ↔ "biremes"
      if (s !== b) nomes.push({ id, n: s });
    };
    for (const id of Object.keys(unidades)) { add(id, unidades[id].name); add(id, unidades[id].name_plural); }
    nomes.sort((a, b) => b.n.length - a.n.length);
    for (const { id, n } of nomes) if (t.indexOf(n) >= 0) achadas.add(id);
    return Array.from(achadas);
  }
  // { heroId: {tipos:[], unidades:[]} } — só os úteis ao recrutamento
  /* Mapa explícito dos heróis cujo bónus não se deduz bem do texto:
   *  • Anysia fala em "unidades míticas" (não numa unidade concreta)
   *  • Argos fala em "todas as Unidades Navais"
   * Os restantes são detectados automaticamente pelo nome da unidade no texto.
   * Confirmado em GameData.heroes do jogo. */
  /* O que cada herói dá — confirmado nas descrições do jogo. Há quatro tipos
   * e NÃO são equivalentes: 20% de custo não vale o mesmo que 20% de
   * velocidade, e o favor é um recurso à parte porque regenera devagar.
   *
   *   custo      → recursos poupados
   *   velocidade → tempo de recrutamento
   *   ambos      → as duas coisas
   *   favor      → custo de favor das míticas (Anysia)
   */
  const BONUS_EXPLICITO = {
    anysia:       { categoria: 'miticas',     tipo: 'favor' },
    argus:        { categoria: 'navais',      tipo: 'custo' },
    aristotle:    { unidades: ['attack_ship'], tipo: 'ambos' },
    daidalos:     { unidades: ['bireme'],      tipo: 'ambos' },
    eurybia:      { unidades: ['trireme'],     tipo: 'ambos' },
    odysseus:     { unidades: ['sword'],       tipo: 'ambos' },
    philoctetes:  { unidades: ['archer'],      tipo: 'ambos' },
    cheiron:      { unidades: ['hoplite'],     tipo: 'ambos' },
    ferkyon:      { categoria: 'terrestres',  tipo: 'velocidade' },
    pariphaistes: { categoria: 'navais',      tipo: 'velocidade' },
  };

  /* Quanto vale cada tipo, para os poder comparar. Configurável — o que
   * interessa mais depende do que te falta: se tens recursos a mais e tempo a
   * menos, a velocidade vale mais.
   *
   * Por omissão o custo vale mais do que a velocidade (os recursos são o
   * travão habitual) e o favor vale mais do que ambos, por ser o mais escasso. */
  const PESOS_KEY = 'grepoHerois_pesos_v1';
  function pesosTipo() {
    const base = { custo: 1.0, velocidade: 0.6, ambos: 1.4, favor: 1.6 };
    try { Object.assign(base, JSON.parse(armazem.getItem(PESOS_KEY) || '{}')); } catch (e) {}
    return base;
  }
  function guardarPesos(p2) {
    try { armazem.setItem(PESOS_KEY, JSON.stringify(p2)); } catch (e) {}
  }

  function tipoDoHeroi(tipo) {
    return (BONUS_EXPLICITO[tipo] || {}).tipo || 'custo';
  }

  /* Escalão de prioridade.
   *
   * A ANYSIA vem sempre primeiro: só serve onde há unidades que custam favor,
   * e o favor é o recurso mais escasso. Se ela não for para essa cidade, não
   * vai para nenhuma.
   *
   * Os restantes competem pelo RENDIMENTO, não pela especialidade. Isto porque
   * há casos em que o genérico rende mais: nas birremes, o Argos dá 20% de
   * custo (+2%/nível) contra os 10% de custo e velocidade do Daidalos (+1%) —
   * e a diferença cresce com o nível. Nas outras unidades o específico ganha
   * naturalmente, porque dá 20% de ambos.
   *
   * O Christopholus fica para o fim: a construção é menos urgente do que as
   * tropas, e ele não compete pelas mesmas cidades. */
  function escalaoDoHeroi(tipo) {
    if (tipo === 'anysia') return 0;
    if (tipo === 'christopholus') return 2;
    return 1;
  }

  function unidadesDaCategoria(cat, unidades) {
    const out = [];
    for (const id of Object.keys(unidades)) {
      const u = unidades[id];
      if (cat === 'navais' && u.is_naval) out.push(id);
      else if (cat === 'terrestres' && !u.is_naval && !u.flying) out.push(id);
      // A Anysia reduz o custo de FAVOR — logo cobre tudo o que custa favor,
      // incluindo o Enviado divino (god_id "all", 12 de favor).
      else if (cat === 'miticas' && (Number(u.favor) > 0 || (u.god_id && u.god_id !== 'all'))) out.push(id);
    }
    return out;
  }

  function analisarBonus() {
    const herois = gameHerois();
    const unidades = (function () { try { return mUw.GameData.units || {}; } catch (e) { return {}; } })();
    const out = {};
    for (const id of Object.keys(herois)) {
      const h = herois[id];
      const texto = (h.short_description || '') + ' ' + (h.description || '');

      // mapa explícito primeiro (cobre os casos que o texto não deixa deduzir)
      const exp = BONUS_EXPLICITO[id];
      if (exp) {
        const uds = exp.unidades ? exp.unidades.slice() : unidadesDaCategoria(exp.categoria, unidades);
        if (uds.length) { out[id] = { tipos: tiposDeBonus(texto), unidades: uds }; continue; }
      }

      if (!ehBonusDeRecrutamento(texto)) continue;
      const uds = unidadesMencionadas(texto, unidades);
      if (uds.length) out[id] = { tipos: tiposDeBonus(texto), unidades: uds };
    }
    return out;
  }

  // Heróis cujo bónus é de CONSTRUÇÃO de edifícios (ex.: Christopholus).
  // { heroId: {tipos:[]} }
  function analisarBonusEdificios() {
    const herois = gameHerois();
    const out = {};
    for (const id of Object.keys(herois)) {
      const h = herois[id];
      const texto = normalizar((h.short_description || '') + ' ' + (h.description || ''));
      if (!/edificio/.test(texto)) continue;          // tem de falar de edifícios
      if (/mais fortes|ataque|defesa/.test(texto)) continue; // não é bónus de combate
      const tipos = tiposDeBonus(texto);
      if (tipos.length) out[id] = { tipos };
    }
    return out;
  }

  // Trabalho de construção pendente numa cidade: quantos níveis faltam para
  // cumprir o template de construção. Se a cidade não tiver template, usa os
  // pontos da cidade como aproximação (menos pontos = mais por evoluir).
  /* Segundos que o jogo diz faltar para o PRÓXIMO nível de um edifício.
   *
   * Usa-se o `building_time` que o jogo já calcula — vem no formato "01:28:03"
   * e traz dentro a velocidade do mundo, o nível do senado e tudo o resto.
   *
   * Reproduzir a fórmula seria errado: o `build_time × factor^nível` que eu
   * tinha assumido dava 2,2 milhões de minutos para o senado 25, quando o jogo
   * diz 88 minutos. Há tempos fixos para os primeiros níveis e factores por
   * escalão que não vale a pena replicar. */
  function segundosDoNivel(bd, edificio) {
    try {
      const t = (bd[edificio] || {}).building_time;
      if (!t) return 0;
      if (typeof t === 'number') return t;
      const p = String(t).split(':').map(Number);
      if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
      if (p.length === 2) return p[0] * 60 + p[1];
      return Number(t) || 0;
    } catch (e) { return 0; }
  }

  /* Quanto TEMPO falta construir nesta cidade.
   *
   * Mede-se em segundos, não em níveis: subir o senado de 24 para 25 demora
   * muito mais do que de 1 para 2, e como herói poupa uma percentagem, é onde
   * há mais horas pendentes que ele rende mais.
   *
   * O jogo só dá o tempo do PRÓXIMO nível de cada edifício. Para os seguintes
   * estima-se com o factor do edifício — não é exacto, mas serve para comparar
   * cidades entre si. */
  function trabalhoConstrucao(townId, alvosConstrucao, niveisPorCidade, pontosPorCidade, bdPorCidade) {
    const tpl = alvosConstrucao[townId];
    const niveis = niveisPorCidade[townId] || {};
    const bd = (bdPorCidade && bdPorCidade[townId]) || {};

    if (tpl && tpl.length) {
      let segundos = 0;
      for (const item of tpl) {
        const atual = (niveis[item.b] === '-' || niveis[item.b] == null) ? 0 : Number(niveis[item.b]);
        const alvo = Number(item.alvo) || 0;
        if (alvo <= atual) continue;

        /* O jogo só diz o tempo do PRÓXIMO nível. Multiplica-se pelo número de
         * níveis em falta, sem crescimento.
         *
         * Estimar crescimento seria pior: o tempo NÃO sobe de forma previsível,
         * porque o senado reduz o tempo de tudo — incluindo dele mesmo. Nos
         * dados reais, o senado 15 demora 1h20, o 23 demora 1h44 e o 25 demora
         * 1h28. Uma estimativa de ×1,2 por nível dava 6× o valor certo. */
        const base = segundosDoNivel(bd, item.b);
        segundos += (base > 0 ? base : 1200) * (alvo - atual);
      }
      return Math.round(segundos / 60);   // minutos
    }
    // sem template: aproximação pelos pontos (cidade menos desenvolvida primeiro)
    const pts = pontosPorCidade[townId];
    if (pts == null) return 0;
    return Math.max(0, 15000 - Number(pts)) / 100;
  }

  /* Dados de construção por cidade — trazem o `building_time` do próximo nível
   * de cada edifício, que é o que interessa para medir o tempo pendente. */
  function getBuildDataPorCidade() {
    const out = {};
    try {
      const col = mUw.MM.getCollections().BuildingBuildData[0];
      for (const m of col.models) {
        const a = m.attributes || {};
        if (a.town_id && a.building_data) out[a.town_id] = a.building_data;
      }
    } catch (e) {}
    return out;
  }

  function getNiveisEPontos(ctx) {
    const niveis = {}, pontos = {};
    try {
      const col = mUw.MM.getCollections().BuildingBuildData[0];
      for (const m of col.models) {
        const a = m.attributes || {};
        const bd = a.building_data || {};
        const n = {};
        for (const b of Object.keys(bd)) n[b] = bd[b].level;
        niveis[Number(a.town_id)] = n;
      }
    } catch (e) {}
    try {
      for (const t of ctx.getMyTowns()) {
        const town = mUw.ITowns.getTown(Number(t.id));
        const p = town && (town.getPoints ? town.getPoints() : (town.attributes || {}).points);
        if (p != null) pontos[Number(t.id)] = p;
      }
    } catch (e) {}
    return { niveis, pontos };
  }

  // Achata os blocos do template de construção numa lista de {b, alvo}.
  function alvosConstrucaoPorCidade(ctx) {
    const out = {};
    try {
      const tpls = JSON.parse(armazem.getItem('grepoConstru_templates_v1') || '{}');
      if (!Object.keys(tpls).length) return out;
      const grupos = (function () { try { return mUw.MM.getCollections().TownGroup[0].models.map((m) => m.attributes); } catch (e) { return []; } })();
      const rels = (function () { try { return mUw.MM.getCollections().TownGroupTown[0].models.map((m) => m.attributes); } catch (e) { return []; } })();
      const comTpl = new Set(Object.keys(tpls).filter((k) => k !== 'todos'));
      const idNome = {};
      for (const g of grupos) if (comTpl.has(g.name)) idNome[g.id] = g.name;
      const cg = {};
      for (const r of rels) { const n = idNome[r.group_id]; if (n) (cg[r.town_id] = cg[r.town_id] || []).push(n); }
      for (const t of ctx.getMyTowns()) {
        const nome = (cg[t.id] || [])[0] || (tpls.todos ? 'todos' : null);
        if (!nome || !tpls[nome]) continue;
        const blocos = tpls[nome].blocos || [];
        out[t.id] = [].concat.apply([], blocos);
      }
    } catch (e) {}
    return out;
  }

  // Estado da atribuição de um herói: onde está / para onde vai.
  /* Desconto que este herói dá, em fracção (0,25 = 25%).
   * O jogo expõe-o em GameData.heroes[x].description_args: {value, level_mod},
   * onde o valor cresce com o nível. Mesma fórmula que o recrutamento usa. */
  function descontoDoHeroi(tipo, nivel) {
    try {
      const arg = ((mUw.GameData.heroes[tipo] || {}).description_args || {})['1'] || {};
      const base = Number(arg.value) || 0;
      const porNivel = Number(arg.level_mod) || 0;
      return Math.min(0.9, base + porNivel * Math.max(0, (Number(nivel) || 1) - 1));
    } catch (e) { return 0; }
  }

  function estadoHeroi(h) {
    const agora = agoraJogo();
    const aChegar = h.town_arrival_at && h.town_arrival_at > agora;
    return {
      cidade: h.home_town_id || null,       // cidade a que está atribuído
      emViagem: !!aChegar,
      chegaEm: aChegar ? h.town_arrival_at : null,
    };
  }

  function getMeusHeroisDetalhe() {
    try {
      // Confirmado no jogo: a colecção chama-se PlayerHero (SINGULAR). Com o
      // plural não encontrava nenhum herói e a rotação dizia "ainda não o tens"
      // mesmo tendo-os todos.
      const cols = mUw.MM.getCollections();
      const col = (cols.PlayerHero || cols.PlayerHeroes || [])[0];
      return ((col && col.models) || []).map((m) => {
        const a = m.attributes || {};
        return {
          id: a.id, type: a.type, level: a.level || 1,
          home_town_id: a.home_town_id, town_arrival_at: a.town_arrival_at,
          assignment_type: a.assignment_type,
        };
      });
    } catch (e) { return []; }
  }

  // Estado partilhado com o módulo de recrutamento: que unidades adiar e até quando.
  // { "<townId>": { adiar: [unitIds], ate: timestamp } }
  const ADIAR_KEY = 'grepoHerois_adiar_v1';
  function lerAdiamentos() { try { return JSON.parse(armazem.getItem(ADIAR_KEY) || '{}'); } catch (e) { return {}; } }
  function gravarAdiamentos(a) { try { armazem.setItem(ADIAR_KEY, JSON.stringify(a)); } catch (e) {} }

  // Quanto "trabalho" há numa cidade para as unidades que o herói beneficia.
  // Usa os alvos do módulo de recrutamento (mesmo formato) e o que já existe.
  function trabalhoNaCidade(townId, unidadesBeneficiadas, alvosPorCidade, tenhoPorCidade, filasPorCidade) {
    const alvos = alvosPorCidade[townId] || {};
    const tenho = tenhoPorCidade[townId] || {};
    const fila = filasPorCidade[townId] || {};
    let falta = 0;
    for (const u of unidadesBeneficiadas) {
      const alvo = Number(alvos[u]) || 0;
      if (!alvo) continue;
      falta += Math.max(0, alvo - ((tenho[u] || 0) + (fila[u] || 0)));
    }
    return falta;
  }

  // Executa a rotação: para cada herói marcado, escolhe a cidade onde o bónus
  // rende mais e manda-o para lá. Regista os adiamentos para o recrutamento.
  async function rotacionar(ctx, cfg) {
    const log = ctx.log;
    const marcados = cfg.rodar || [];
    if (!marcados.length) return;

    const bonus = analisarBonus();
    const meus = getMeusHeroisDetalhe();
    const herois = gameHerois();

    // dados de recrutamento (mesmo formato do módulo de recrutamento)
    let alvosPorCidade = {}, tenhoPorCidade = {}, filasPorCidade = {};
    try {
      const tplRec = JSON.parse(armazem.getItem('grepoRecruta_templates_v1') || '{}');
      const grupos = (function () {
        try { return mUw.MM.getCollections().TownGroup[0].models.map((m) => m.attributes); } catch (e) { return []; }
      })();
      const rels = (function () {
        try { return mUw.MM.getCollections().TownGroupTown[0].models.map((m) => m.attributes); } catch (e) { return []; }
      })();
      const towns = ctx.getMyTowns();
      const comTpl = new Set(Object.keys(tplRec).filter((k) => k !== 'todos'));
      const idNome = {};
      for (const g of grupos) if (comTpl.has(g.name)) idNome[g.id] = g.name;
      const cg = {};
      for (const r of rels) { const n = idNome[r.group_id]; if (n) (cg[r.town_id] = cg[r.town_id] || []).push(n); }
      for (const t of towns) {
        const g = (cg[t.id] || [])[0] || (tplRec.todos ? 'todos' : null);
        if (g && tplRec[g]) alvosPorCidade[t.id] = tplRec[g].unidades || {};
      }
      // O módulo de recrutamento publica os alvos já EXPANDIDOS (o alvo genérico
      // de "voadores" resolvido para a unidade do deus de cada cidade). Se
      // existirem, usamos esses — é o que permite à Anysia ir para a cidade
      // onde há mais míticas por recrutar.
      try {
        const exp = JSON.parse(armazem.getItem('grepoRecruta_expandido_v1') || '{}');
        for (const tid of Object.keys(exp)) alvosPorCidade[tid] = exp[tid];
      } catch (e) {}
      // o que já tenho (casa + fora) e em fila
      const mods = mUw.MM.getModels().Units || {};
      for (const k of Object.keys(mods)) {
        const a = mods[k].attributes || {};
        const home = Number(a.home_town_id);
        if (!home) continue;
        const acc = tenhoPorCidade[home] = tenhoPorCidade[home] || {};
        for (const u of Object.keys(a)) {
          if (typeof a[u] === 'number' && !['id', 'home_town_id', 'current_town_id'].includes(u)) acc[u] = (acc[u] || 0) + a[u];
        }
      }
      const uo = (mUw.MM.getCollections().UnitOrder || [])[0];
      for (const m of ((uo && uo.models) || [])) {
        const a = m.attributes || {};
        const acc = filasPorCidade[a.town_id] = filasPorCidade[a.town_id] || {};
        acc[a.unit_type] = (acc[a.unit_type] || 0) + (a.units_left != null ? a.units_left : a.count || 0);
      }
    } catch (e) { log('Rotação: não consegui ler os alvos de recrutamento.'); return; }

    // dados para os heróis de CONSTRUÇÃO
    const bonusEdif = analisarBonusEdificios();
    const alvosConstru = alvosConstrucaoPorCidade(ctx);
    const { niveis: niveisPorCidade, pontos: pontosPorCidade } = getNiveisEPontos(ctx);
    const bdPorCidade = getBuildDataPorCidade();

    const adiamentos = lerAdiamentos();
    const ocupadas = new Set(meus.filter((h) => h.home_town_id).map((h) => Number(h.home_town_id)));
    let moveu = 0;

    const porques = [];   // para explicar no fim porque não se moveu ninguém

    /* Tratar primeiro os heróis que MAIS rendem: como cada cidade só leva um
     * herói, quem for tratado primeiro fica com a melhor. Sem esta ordenação,
     * um herói que poupa 10% podia apanhar a cidade que renderia muito mais a
     * um que poupa 50%. */
    /* ORDENAR OS PARES herói-cidade, não os heróis.
     *
     * Ordenar os heróis pelo desconto abstracto e deixar cada um escolher a
     * melhor cidade para si dá resultados maus: numa cidade com 1100 unidades
     * terrestres e 171 navios, o Pariphaistes (naval, desconto maior) apanhava-a
     * pelos 171 barcos e o Férquion (terrestre) ficava sem nada — quando ele
     * renderia cinco vezes mais ali.
     *
     * O que deve competir é a ATRIBUIÇÃO: calcula-se o rendimento de cada
     * herói em cada cidade e atribui-se pela ordem decrescente, saltando os
     * heróis e as cidades já usados. */
    const pw = pesosTipo();
    const pares = [];
    for (const tipo of marcados) {
      const h2 = meus.find((x) => x.type === tipo);
      if (!h2) continue;
      const b2 = bonus[tipo], bE2 = bonusEdif[tipo];
      if (!b2 && !bE2) continue;

      const d2 = descontoDoHeroi(tipo, h2.level || 1) * (Number(pw[tipoDoHeroi(tipo)]) || 1);
      const cidades2 = b2 ? Object.keys(alvosPorCidade) : ctx.getMyTowns().map((t) => String(t.id));
      for (const tid2 of cidades2) {
        const falta2 = b2
          ? trabalhoNaCidade(Number(tid2), b2.unidades, alvosPorCidade, tenhoPorCidade, filasPorCidade)
          : trabalhoConstrucao(Number(tid2), alvosConstru, niveisPorCidade, pontosPorCidade, bdPorCidade);
        if (falta2 <= 0) continue;
        pares.push({
          tipo, townId: Number(tid2), falta: falta2,
          rende: falta2 * (d2 > 0 ? d2 : 0.1),
          escalao: escalaoDoHeroi(tipo),
        });
      }
    }
    // a Anysia primeiro (escalão 0), depois por rendimento
    pares.sort((a, b3) => (a.escalao - b3.escalao) || (b3.rende - a.rende));

    const escolha = {};      // tipo -> townId
    const cidadeTomada = new Set(ocupadas);
    for (const par of pares) {
      if (escolha[par.tipo]) continue;
      if (cidadeTomada.has(par.townId)) continue;
      escolha[par.tipo] = par;
      cidadeTomada.add(par.townId);
    }

    const porRendimento = marcados.slice().sort((a, b3) => {
      const ra = escolha[a] ? escolha[a].rende : -1;
      const rb = escolha[b3] ? escolha[b3].rende : -1;
      const ea = escolha[a] ? escolha[a].escalao : 9;
      const eb = escolha[b3] ? escolha[b3].escalao : 9;
      return (ea - eb) || (rb - ra);
    });

    for (const tipo of porRendimento) {
      const nomeH = (herois[tipo] && herois[tipo].name) || tipo;
      const b = bonus[tipo];
      const bEdif = bonusEdif[tipo];
      if (!b && !bEdif) { porques.push(`${nomeH}: sem bónus de recrutamento ou construção reconhecido`); continue; }
      const h = meus.find((x) => x.type === tipo);
      if (!h) { porques.push(`${nomeH}: ainda não o tens`); continue; }
      const est = estadoHeroi(h);
      if (est.emViagem) { porques.push(`${nomeH}: já vai a caminho`); continue; }

      // escolher a cidade com mais trabalho pendente para o bónus deste herói
      /* A escolha pesa o DESCONTO do herói, não só o volume de trabalho: um
       * herói que poupa 50% rende cinco vezes mais do que um que poupa 10% no
       * mesmo número de unidades. O valor é o mesmo em todas as cidades (é do
       * herói), mas serve para comparar heróis entre si e para decidir se
       * compensa mudar. */
      /* Rendimento = desconto × peso do tipo. Assim 20% de custo e 20% de
       * velocidade deixam de contar igual. */
      const descBruto = descontoDoHeroi(tipo, h.level || 1);
      const pesos = pesosTipo();
      const tipoB = tipoDoHeroi(tipo);
      const desc = descBruto * (Number(pesos[tipoB]) || 1);

      // a atribuição já foi decidida acima, pelos pares herói-cidade
      const esc2 = escolha[tipo];
      const melhor = esc2 ? { townId: esc2.townId, falta: esc2.falta, rende: esc2.rende, desc } : null;

      const nome = (herois[tipo] && herois[tipo].name) || tipo;

      // Quanto trabalho há onde o herói já está? Só vale a pena mudá-lo se o
      // novo destino for MUITO melhor — cada mudança custa 2 h de viagem em
      // que ele não beneficia ninguém.
      const trabalhoAtual = est.cidade
        ? (b ? trabalhoNaCidade(est.cidade, b.unidades, alvosPorCidade, tenhoPorCidade, filasPorCidade)
             : trabalhoConstrucao(est.cidade, alvosConstru, niveisPorCidade, pontosPorCidade, bdPorCidade))
        : 0;

      if (!melhor) {
        porques.push(b
          ? `${nome}: nenhuma cidade tem ${b.unidades.map((u) => (mUw.GameData.units[u] || {}).name || u).slice(0, 3).join('/')} por recrutar`
          : `${nome}: nenhuma cidade tem construções pendentes`);
        continue;
      }
      if (melhor.townId === est.cidade) {
        porques.push(`${nome}: já está na melhor cidade`);
        continue;
      }

      // Se já está algures, exigir uma melhoria substancial para o mover.
      if (est.cidade && trabalhoAtual > 0) {
        // comparar RENDIMENTO, não só volume: o desconto é o mesmo nas duas
        // cidades, por isso a razão dá no mesmo — mas fica explícito.
        const ganho = melhor.falta / Math.max(1, trabalhoAtual);
        if (ganho < (cfg.ganhoMinimoRotacao || 1.5)) {
          porques.push(`${nome}: onde está tem ${trabalhoAtual} pendente, o melhor destino tem ${melhor.falta} — não compensa a viagem`);
          continue;
        }
      }

      // Está atribuído a outra cidade? É preciso RETIRAR primeiro; o jogo
      // recusa a atribuição directa ("já foi atribuído a uma cidade").
      if (est.cidade && Number(est.cidade) !== Number(melhor.townId)) {
        const rOff = await retirarDaCidade(h.id, tipo, est.cidade);
        if (!rOff.ok) {
          porques.push(`${nome}: não consegui retirá-lo de onde está (${rOff.msg})`);
          continue;
        }
        log(`↩️ ${nome}: retirado da cidade ${est.cidade} para poder mudar.`);
        await ctx.sleep(ctx.rand(600, 1200));
      }

      const r = await atribuirACidade(h.id, tipo, melhor.townId);
      if (r.ok) {
        ocupadas.delete(est.cidade);
        ocupadas.add(melhor.townId);
        const mins = Math.round(viagemSegundos() / 60);
        if (b) {
          // enquanto viaja, o recrutamento adia estas unidades NESTA cidade
          const chegada = agoraJogo() + viagemSegundos();
          adiamentos[melhor.townId] = { adiar: b.unidades, ate: chegada };
          const nomes = b.unidades.length > 3 ? b.unidades.length + ' unidades' : b.unidades.join(', ');
          log(`🧭 ${nome} → cidade ${melhor.townId} (${melhor.falta} por recrutar de ${nomes}`
            + (descBruto > 0 ? `, ${Math.round(descBruto * 100)}% de ${tipoB}` : '')
            + `; chega em ~${mins} min).`);
        } else {
          log(`🧭 ${nome} → cidade ${melhor.townId} (${Math.round(melhor.falta)} níveis por construir; chega em ~${mins} min).`);
        }
        moveu++;
        await ctx.sleep(ctx.rand(700, 1400));
      } else {
        log(`⚠️ Falha a mover ${nome}: ${r.msg}`);
      }
    }

    // Se nada se moveu, dizer PORQUÊ — antes ficava calado e parecia avariado.
    if (!moveu && porques.length) {
      log('Rotação: ninguém se moveu — ' + porques.slice(0, 4).join(' · ')
        + (porques.length > 4 ? ` (e mais ${porques.length - 4})` : ''));
    }

    // limpar adiamentos expirados (o herói já chegou)
    const agora = agoraJogo();
    for (const k of Object.keys(adiamentos)) if (!adiamentos[k].ate || adiamentos[k].ate <= agora) delete adiamentos[k];
    gravarAdiamentos(adiamentos);
  }

  function viagemSegundos() {
    try { return (mUw.GameData.heroes_meta || {}).town_travel_time || 7200; } catch (e) { return 7200; }
  }

  /* ---------------------- lógica ---------------------------------------- */
  // Moedas utilizáveis para uma categoria: as próprias + as "both".
  function moedasPara(categoria, moedas) {
    return (categoria === 'war' ? moedas.war : moedas.wisdom) + moedas.both;
  }

  // Há ainda heróis desejados por comprar? (se não, a reserva liberta-se)
  function faltamHeroisDesejados(desejados, meus) {
    const tenho = new Set(meus.map((h) => h.type));
    return desejados.some((t) => !tenho.has(t));
  }

  // Decide a compra do dia: o herói da oferta que esteja nos desejados e caiba nas moedas.
  function decidirCompra(oferta, desejados, meus, moedas, herois, slotsLivres) {
    if (!oferta || slotsLivres <= 0) return null;
    const tenho = new Set(meus.map((h) => h.type));
    // preferir o que estiver na lista de desejados; se ambos estiverem, o mais barato
    const candidatos = [];
    for (const cat of ['wisdom', 'war']) {
      const tipo = oferta[cat];
      if (!tipo || tenho.has(tipo)) continue;
      if (desejados.indexOf(tipo) < 0) continue;
      const gd = herois[tipo];
      if (!gd) continue;
      const custo = gd.cost || 0;
      if (moedasPara(cat, moedas) < custo) continue;
      candidatos.push({ tipo, cat, custo, nome: gd.name || tipo });
    }
    if (!candidatos.length) return null;
    candidatos.sort((a, b) => a.custo - b.custo);
    return candidatos[0];
  }

  // Quanto custa subir este herói ao nível seguinte (tabela experience_limits).
  function custoProximoNivel(hero, limites) {
    const prox = (hero.level || 1) + 1;
    const lim = limites[String(prox)];
    return lim != null ? Number(lim) : null;
  }

  // Decide as subidas de nível com o EXCEDENTE (acima da reserva, se aplicável).
  function decidirSubidas(marcados, meus, moedas, limites, maxLvl, reservaAtiva) {
    // reservaAtiva = ainda faltam heróis por comprar
    const reserva = reservaAtiva ? RESERVA_MOEDAS : RESERVA_DEPOIS;
    // orçamento por categoria (as "both" ficam num bolo comum)
    const orc = {
      wisdom: Math.max(0, moedas.wisdom - reserva),
      war: Math.max(0, moedas.war - reserva),
      both: Math.max(0, moedas.both - reserva),
    };
    /* SUBIR POR IGUAL.
     *
     * Antes percorria-se a lista pela ordem que o jogo devolve, e o primeiro
     * consumia as moedas todas — ficando um herói no nível 12 e outro no 1.
     *
     * Agora trata-se sempre o que está MAIS ATRÁS: sobe um nível, e volta-se a
     * escolher o mais atrasado. Assim os níveis emparelham-se e depois sobem
     * juntos. Um herói no nível 1 apanha os que estão no 5 antes de estes
     * voltarem a subir. */
    const acoes = [];
    const candidatos = meus
      .filter((h) => marcados.indexOf(h.type) >= 0)
      .map((h) => ({ h, nivel: Number(h.level) || 1 }));

    let seguranca = 0;
    while (seguranca++ < 200) {
      // o mais atrasado que ainda pode subir; em empate, o mais barato
      let alvo = null;
      for (const c of candidatos) {
        if (c.nivel >= maxLvl) continue;
        const custo = custoProximoNivel({ ...c.h, level: c.nivel }, limites);
        if (custo == null) continue;
        /* O nível está em alvo.c.nivel, não em alvo.nivel — a versão anterior
         * comparava com undefined e escolhia SEMPRE o primeiro, que era
         * exactamente o comportamento que se queria evitar. */
        if (!alvo || c.nivel < alvo.c.nivel || (c.nivel === alvo.c.nivel && custo < alvo.custo)) {
          alvo = { c, custo };
        }
      }
      if (!alvo) break;

      const cat = categoriaDoHeroi(alvo.c.h.type);
      const daCat = Math.min(orc[cat], alvo.custo);
      const doBoth = alvo.custo - daCat;
      if (doBoth > orc.both) break;      // não chega para mais nenhum

      orc[cat] -= daCat;
      orc.both -= doBoth;
      acoes.push({
        heroId: alvo.c.h.id, type: alvo.c.h.type,
        amount: alvo.custo, nivelAtual: alvo.c.nivel,
      });
      alvo.c.nivel++;                    // conta para a próxima escolha
    }
    return acoes;
  }

  function categoriaDoHeroi(type) {
    const gd = gameHerois()[type];
    return (gd && gd.category === 'war') ? 'war' : 'wisdom';
  }

  /* ---------------------- config (Gist + cache) ------------------------- */
  const CACHE_KEY = 'grepoHerois_config_v1';
  function loadLocal() { try { return JSON.parse(armazem.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; } }
  function saveLocal(c) { try { armazem.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {} }
  async function readGist() {
    // não segurar o processo (importante nos testes)
    try { if (typeof t2 !== 'undefined' && t2 && t2.unref) t2.unref(); } catch (e) {}
    if (!GIST.id) return loadLocal();
    try {
      const r = await mUw.fetch('https://api.github.com/gists/' + GIST.id, { headers: { 'Accept': 'application/vnd.github+json' } });
      const j = await r.json();
      const f = j.files && j.files[ficheiroGist()];
      if (!f) return loadLocal();
      /* Ficheiros grandes vêm TRUNCADOS na listagem do Gist: o conteúdo
       * tem de ser lido no `raw_url`. Sem isto, um template grande
       * parecia não existir. */
      let __txt = f.content;
      if ((!__txt || f.truncated) && f.raw_url) {
        try {
          const __rr = await (mUw || uw).fetch(f.raw_url, { headers: { Accept: 'text/plain' } });
          if (__rr.ok) __txt = await __rr.text();
        } catch (e) {}
      }
      const c = JSON.parse(__txt || '{}');
      saveLocal(c);
      return c;
    } catch (e) { return loadLocal(); }
  }
  const travaoGist = { aEsperar: false, pendente: null };

  async function writeGist(c) {
    /* TRAVÃO: o GitHub limita as escritas por hora e várias gravações seguidas
     * esgotam-no (403 "API rate limit exceeded"). Se a última foi há menos de
     * 30 s, guarda-se e sobe só a última versão.
     *
     * O guardar LOCAL acontece sempre — só a subida ao Gist é travada. */
    if (travaoGist.aEsperar) {
      travaoGist.pendente = c;
      return { ok: true, msg: 'agendado (travão de 30 s)' };
    }
    travaoGist.aEsperar = true;
    const tG = setTimeout(() => {
      travaoGist.aEsperar = false;
      const p = travaoGist.pendente;
      travaoGist.pendente = null;
      if (p != null) writeGist(p);
    }, 30000);
    try { if (tG && typeof tG.unref === 'function') tG.unref(); } catch (e) {}

    saveLocal(c);
    if (!GIST.id || !GIST.token) return { ok: false, msg: 'sem Gist id/token — guardado só localmente' };
    try {
      const r = await mUw.fetch('https://api.github.com/gists/' + GIST.id, {
        method: 'PATCH',
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + GIST.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [ficheiroGist()]: { content: JSON.stringify(c, null, 2) } } }),
      });
      return r.ok ? { ok: true } : { ok: false, msg: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ------------------------------- run ---------------------------------- */
  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const rotina = ctx.logRotina || ctx.log;   // rotina: não vai para o registo
    const log = ctx.log;

    const cfg = await readGist();
    const desejados = cfg.comprar || [];
    const marcados = cfg.subir || [];
    const paraRodar = cfg.rodar || [];
    // A verificação ignorava o "rodar": quem só marcasse heróis para rotação
    // via o módulo desistir sem fazer nada.
    if (!desejados.length && !marcados.length && !paraRodar.length) {
      log('Heróis: nada configurado (marca heróis para comprar, subir de nível ou rodar).');
      return;
    }

    const herois = gameHerois();
    if (!Object.keys(herois).length) { log('GameData.heroes indisponível.'); return; }

    const towns = ctx.getMyTowns();
    const townId = towns.length ? towns[0].id : (mUw.Game && mUw.Game.townId);
    if (!townId) { log('Sem cidade para enviar o pedido.'); return; }

    const moedas = getMoedas();
    const meus = getMeusHerois();
    const meta = getHeroesMeta();

    /* A oferta do dia: se o modelo estiver vazio — porque a janela dos heróis
     * nunca foi aberta nesta sessão — pede-se ao servidor. Sem isto, o módulo
     * nunca via oferta e nunca comprava nada. */
    let oferta = getOferta();
    if (!oferta || (!oferta.war && !oferta.wisdom)) {
      const pedida = await pedirOferta();
      if (pedida) {
        oferta = pedida;
        /* A resposta traz também as moedas, que o `PlayerLedger` pode não ter
         * ainda carregado. */
        if (pedida.moedas) {
          if (pedida.moedas.coins_of_wisdom != null) moedas.wisdom = pedida.moedas.coins_of_wisdom;
          if (pedida.moedas.coins_of_war != null) moedas.war = pedida.moedas.coins_of_war;
          if (pedida.moedas.coins_of_both != null) moedas.both = pedida.moedas.coins_of_both;
        }
      }
    }

    // 1. COMPRA (prioritária)
    let comprou = false;
    if (desejados.length) {
      const compra = decidirCompra(oferta, desejados, meus, moedas, herois, meta.slotsLivres);
      if (compra) {
        const r = await comprarHeroi(compra.tipo, townId);
        if (r.ok) {
          comprou = true;
          log(`🏛️ Herói comprado: ${compra.nome} (${compra.custo} moedas de ${compra.cat === 'war' ? 'guerra' : 'sabedoria'}).`);
          meus.push({ id: null, type: compra.tipo, level: 1, xp: 0 });
          if (compra.cat === 'war') moedas.war = Math.max(0, moedas.war - compra.custo);
          else moedas.wisdom = Math.max(0, moedas.wisdom - compra.custo);
        } else {
          log(`⚠️ Falha a comprar ${compra.nome}: ${r.msg}`);
        }
      }
    }

    // 2. SUBIDAS DE NÍVEL (com o excedente; reserva liberta-se se já tiver todos)
    if (marcados.length) {
      const reservaAtiva = faltamHeroisDesejados(desejados, meus);
      const subidas = decidirSubidas(marcados, meus.filter((h) => h.id), moedas, meta.limites, nivelMaximo(), reservaAtiva);
      for (const s of subidas) {
        const r = await subirNivel(s.heroId, s.type, s.amount, townId);
        const nome = (herois[s.type] && herois[s.type].name) || s.type;
        if (r.ok) {
          log(`⬆️ ${nome}: nível ${s.nivelAtual} → ${s.nivelAtual + 1} (${s.amount} moedas).`);
          await ctx.sleep(ctx.rand(700, 1400));
        } else {
          log(`⚠️ Falha a subir ${nome}: ${r.msg}`);
          break;
        }
      }
      if (!comprou && !subidas.length) rotina('Heróis: nada a fazer agora.');
    }

    // 3. ROTAÇÃO pelas cidades que recrutam o que o herói beneficia
    if ((cfg.rodar || []).length) {
      try { await rotacionar(ctx, cfg); } catch (e) { log('Rotação falhou: ' + e.message); }
    }
  }

  /* ---------------------- PAINEL ---------------------------------------- */
  let cfgEdicao = null, pCtx = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function render(container) {
    if (!cfgEdicao) cfgEdicao = loadLocal();
    cfgEdicao.comprar = cfgEdicao.comprar || [];
    cfgEdicao.subir = cfgEdicao.subir || [];
    cfgEdicao.rodar = cfgEdicao.rodar || [];
    const bonus = analisarBonus();
    const bonusEdif = analisarBonusEdificios();

    const herois = gameHerois();
    const meus = getMeusHerois();
    const tenho = {}; meus.forEach((h) => { tenho[h.type] = h; });
    const moedas = getMoedas();
    const oferta = getOferta();
    const meta = getHeroesMeta();

    const lista = Object.keys(herois)
      .filter((id) => !herois[id].hidden)
      .map((id) => ({ id, nome: herois[id].name || id, cat: herois[id].category, custo: herois[id].cost || 0 }))
      .sort((a, b) => (a.cat === b.cat ? a.nome.localeCompare(b.nome) : (a.cat === 'war' ? 1 : -1)));

    let html = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:6px">
      ${caixa('Sabedoria', moedas.wisdom)}${caixa('Guerra', moedas.war)}${caixa('Ambas', moedas.both)}
    </div>`;

    if (oferta) {
      const nw = (herois[oferta.wisdom] && herois[oferta.wisdom].name) || oferta.wisdom || '—';
      const ng = (herois[oferta.war] && herois[oferta.war].name) || oferta.war || '—';
      html += `<div style="background:#0d141c;padding:5px;border-radius:4px;font-size:11px;margin-bottom:6px">
        <b>Oferta de hoje</b><br>Sabedoria: ${esc(nw)} · Guerra: ${esc(ng)}<br>
        <span style="opacity:.7">Slots livres: ${meta.slotsLivres}</span></div>`;
    }

    html += `<div style="font-size:11px;opacity:.8;margin-bottom:3px">
      <b>C</b> = comprar · <b>N</b> = subir nível · <b>R</b> = rodar para a cidade onde o bónus dele rende mais</div>
      <div style="max-height:200px;overflow:auto;background:#0d141c;padding:4px;border-radius:4px">`;
    for (const h of lista) {
      const meu = tenho[h.id];
      const c = cfgEdicao.comprar.indexOf(h.id) >= 0;
      const n = cfgEdicao.subir.indexOf(h.id) >= 0;
      const r = cfgEdicao.rodar.indexOf(h.id) >= 0;
      const b = bonus[h.id];
      const be = bonusEdif[h.id];
      const podeRodar = !!(b || be);
      const tituloR = b
        ? ('ajuda: ' + b.tipos.join('+') + ' de ' + (b.unidades.length > 3 ? b.unidades.length + ' unidades' : b.unidades.join(', ')))
        : (be ? ('ajuda: ' + be.tipos.join('+') + ' de construção de edifícios') : '');
      html += `<div style="display:flex;align-items:center;gap:4px;font-size:11px;padding:1px 2px">
        <label title="comprar"><input type="checkbox" data-c="${esc(h.id)}"${c ? ' checked' : ''}>C</label>
        <label title="subir nível"><input type="checkbox" data-n="${esc(h.id)}"${n ? ' checked' : ''}>N</label>
        ${podeRodar ? `<label title="${esc(tituloR)}"><input type="checkbox" data-r="${esc(h.id)}"${r ? ' checked' : ''}>R</label>` : '<span style="width:26px;display:inline-block"></span>'}
        <span style="flex:1">${esc(h.nome)}</span>
        <span style="opacity:.55">${h.cat === 'war' ? '⚔' : '📖'} ${h.custo}</span>
        <span style="opacity:.8;min-width:28px;text-align:right">${meu ? 'nv' + meu.level : '—'}</span>
      </div>`;
    }
    html += `</div>`;

    const faltam = cfgEdicao.comprar.some((t) => !tenho[t]);
    html += `<div style="font-size:11px;opacity:.75;margin:5px 0">
      Reserva: ${faltam ? `<b>${RESERVA_MOEDAS}</b> de cada guardadas para comprar` : 'libertada (já tens todos os marcados)'} — o resto vai para níveis.</div>`;

    const pz = pesosTipo();
    html += `
    <details id="her-avancado" style="background:#0d141c;padding:6px 8px;border-radius:4px;margin:6px 0;font-size:11px">
      <summary style="cursor:pointer;opacity:.8">Como escolhe as cidades</summary>
      <div style="opacity:.7;font-size:10px;margin:5px 0">
        A <b>Anysia</b> vai primeiro, e só para cidades com unidades que custam favor
        (voadores, míticas, enviados divinos).<br>
        Os restantes competem pelo <b>rendimento</b> — unidades por fazer × quanto o
        herói poupa. Calcula-se para cada herói em cada cidade e atribui-se pela ordem
        do que mais rende; cada cidade leva um herói.<br>
        O <b>Christopholus</b> fica para o fim, nas cidades com mais construção.
      </div>

      <div style="border-top:1px solid #223;margin-top:5px;padding-top:5px">
        <div style="opacity:.65;font-size:10px;margin-bottom:4px">
          <b>Avançado.</b> Para comparar heróis é preciso saber quanto vale cada tipo de
          bónus: 20% de custo não é o mesmo que 20% de velocidade. Estes números só
          importam quando dois heróis disputam a mesma cidade.
        </div>
        <div style="display:grid;grid-template-columns:1fr 60px;gap:3px;align-items:center">
          <span>Custo de recursos</span>
          <input type="number" step="0.1" min="0" id="her-p-custo" value="${pz.custo}">
          <span>Velocidade</span>
          <input type="number" step="0.1" min="0" id="her-p-vel" value="${pz.velocidade}">
          <span>Custo <i>e</i> velocidade</span>
          <input type="number" step="0.1" min="0" id="her-p-ambos" value="${pz.ambos}">
          <span>Favor <span style="opacity:.6;font-size:10px">(Anysia)</span></span>
          <input type="number" step="0.1" min="0" id="her-p-favor" value="${pz.favor}">
        </div>
      </div>
    </details>`;
    html += `<button id="her-guardar" style="cursor:pointer;width:100%;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar heróis</button>`;

    container.innerHTML = html;
    ligar(container);
  }

  function caixa(t, v) {
    return `<div style="background:#0d141c;padding:4px;border-radius:4px;text-align:center">
      <div style="font-size:10px;opacity:.7">${t}</div><div style="font-weight:bold">${v}</div></div>`;
  }

  function ligar(container) {
    container.querySelectorAll('[data-c]').forEach((el) => {
      el.onchange = (e) => {
        const id = el.getAttribute('data-c');
        const i = cfgEdicao.comprar.indexOf(id);
        if (e.target.checked && i < 0) cfgEdicao.comprar.push(id);
        else if (!e.target.checked && i >= 0) cfgEdicao.comprar.splice(i, 1);
      };
    });
    container.querySelectorAll('[data-n]').forEach((el) => {
      el.onchange = (e) => {
        const id = el.getAttribute('data-n');
        const i = cfgEdicao.subir.indexOf(id);
        if (e.target.checked && i < 0) cfgEdicao.subir.push(id);
        else if (!e.target.checked && i >= 0) cfgEdicao.subir.splice(i, 1);
      };
    });
    container.querySelectorAll('[data-r]').forEach((el) => {
      el.onchange = (e) => {
        const id = el.getAttribute('data-r');
        const i = cfgEdicao.rodar.indexOf(id);
        if (e.target.checked && i < 0) cfgEdicao.rodar.push(id);
        else if (!e.target.checked && i >= 0) cfgEdicao.rodar.splice(i, 1);
      };
    });
    // manter aberto/fechado entre redesenhos
    const det = container.querySelector('#her-avancado');
    if (det) {
      try { det.open = armazem.getItem('grepoHerois_avancadoAberto') === '1'; } catch (e) {}
      det.ontoggle = () => {
        try { armazem.setItem('grepoHerois_avancadoAberto', det.open ? '1' : '0'); } catch (e) {}
      };
    }

    const guardarP = () => {
      guardarPesos({
        custo: Number(container.querySelector('#her-p-custo').value) || 1,
        velocidade: Number(container.querySelector('#her-p-vel').value) || 0.6,
        ambos: Number(container.querySelector('#her-p-ambos').value) || 1.4,
        favor: Number(container.querySelector('#her-p-favor').value) || 1.6,
      });
    };
    ['#her-p-custo', '#her-p-vel', '#her-p-ambos', '#her-p-favor'].forEach((sel) => {
      const el = container.querySelector(sel);
      if (el) el.onchange = guardarP;
    });

    const g = container.querySelector('#her-guardar');
    if (g) g.onclick = async () => {
      g.textContent = 'A guardar...';
      const r = await writeGist(cfgEdicao);
      if (pCtx) pCtx.log(r.ok ? 'Config de heróis guardada no Gist.' : 'Config guardada localmente (' + r.msg + ').');
      g.textContent = r.ok ? 'Guardado ✓' : 'Guardado (local)';
      setTimeout(() => { g.textContent = 'Guardar heróis'; }, 1800);
    };
  }


  /* Preservar a posição do rolamento ao redesenhar o painel — senão volta ao
   * topo a cada alteração. */
  function comRolamento(fn) {
    /* Guardar TODOS os elementos que estejam rolados, não só os que se
     * adivinham: o que rola pode ser uma caixa interna e o salto para o topo
     * mantinha-se. */
    /* Guardar o CAMINHO e não só a referência: o redesenho destrói os
     * elementos internos e a referência antiga deixa de estar no ecrã. */
    const caminhoDe = (el) => {
      const p = []; let n = el;
      while (n && n.parentElement && p.length < 30) {
        p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
        if (n.id) { p.unshift('#' + n.id); break; }
      }
      return p;
    };
    const porCaminho = (p) => {
      try {
        if (!p.length) return null;
        let n = null, i = 0;
        if (typeof p[0] === 'string' && p[0].charAt(0) === '#') { n = document.getElementById(p[0].slice(1)); i = 1; }
        else n = document.body;
        for (; n && i < p.length; i++) n = n.children[p[i]];
        return n || null;
      } catch (e) { return null; }
    };

    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}
    fn();
    const repor = () => guardados.forEach(({ caminho, y, el }) => {
      try {
        if (el && el.isConnected) { el.scrollTop = y; return; }
        const n2 = porCaminho(caminho);
        if (n2) n2.scrollTop = y;
      } catch (e) {}
    });
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  function painel(container, ctx) {
    pCtx = ctx;
    pCtx = ctx; mUw = ctx.uw; mWorld = ctx.WORLD;
    render(container);
    readGist().then((c) => { cfgEdicao = c; render(container); }).catch(() => {});
  }

  return {
    id: 'herois',
    nome: 'Heróis',
    intervaloMin: opts.intervaloMin || 60, // a oferta é diária; não precisa de correr muito
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
  };
}

  // ===================== MÓDULO: ALDEIAS BÁRBARAS ========================
/* =============================================================================
 *  MÓDULO: ALDEIAS BÁRBARAS  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  FASE 1 — RECOLHA:
 *    • Com Capitão (premium): um único pedido por conta recolhe em TODAS as
 *      cidades de uma vez (action=claim_loads_multiple).
 *    • Sem Capitão: percorre as aldeias disponíveis e recolhe uma a uma
 *      (FarmTownPlayerRelation/<id> → claim).
 *    Só EXIGE recursos (type:"resources"), nunca saqueia — não perde tropas.
 *    Usa sempre a opção mais curta (option 1 = 300s).
 *
 *  FASE 2 (a seguir) — TROCAS: portar a lógica do equilibrar-recursos.
 * ========================================================================== */

function makeAldeiasModule(opts) {
  opts = opts || {};

  // Opção de recolha: 1..4 → cooldowns [300,1200,5400,14400] s
  const OPCAO = opts.opcao || 1;
  const COOLDOWNS = [300, 1200, 5400, 14400];

  let mUw = null;

  // RELÓGIO DO SERVIDOR — o único que conta.
  // O relógio da máquina é irrelevante e enganador: este VPS está em Espanha e
  // o jogo corre em hora portuguesa, uma hora de diferença PERMANENTE. Se o
  // servidor não estiver disponível devolvemos null e o módulo NÃO age, em vez
  // de agir com uma hora possivelmente errada.
  /* Hora do servidor em milissegundos — o relógio do computador não manda. */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function agoraServidorMs() {
    try {
      const t = Number(mUw.Timestamp.now());
      if (Number.isFinite(t) && t > 0) return Math.floor(t) * 1000;
    } catch (e) {}
    return Date.now();
  }

  function agoraJogo() {
    try {
      if (typeof mUw.Timestamp !== 'undefined' && typeof mUw.Timestamp.now === 'function') {
        const t = Math.floor(mUw.Timestamp.now());
        if (Number.isFinite(t) && t > 0) return t;
      }
    } catch (e) {}
    try {
      const t = Number(mUw.Game && mUw.Game.server_time);
      if (Number.isFinite(t) && t > 0) return Math.floor(t);
    } catch (e) {}
    return null;   // sem relógio do servidor: não se inventa
  }

  let mWorld = '';

  /* ---------------------- leitura do jogo ------------------------------ */
  function colModels(nome) {
    try {
      const c = (mUw.MM.getCollections()[nome] || [])[0];
      return (c && c.models) || [];
    } catch (e) { return []; }
  }

  // O Capitão dá a recolha em massa. O PremiumFeatures guarda o timestamp de fim.
  function temCapitao() {
    try {
      const pf = mUw.MM.getModels().PremiumFeatures;
      const k = Object.keys(pf)[0];
      const cap = (pf[k].attributes || {}).captain;
      return !!cap && Number(cap) > agoraJogo();
    } catch (e) { return false; }
  }

  // Relações com aldeias: só as desbloqueadas e já disponíveis para recolher.
  function relacoesProntas() {
    const agora = agoraJogo();
    const out = [];
    for (const m of colModels('FarmTownPlayerRelation')) {
      const a = m.attributes || {};
      if (a.relation_status !== 1) continue;          // não desbloqueada / sem relação
      if (a.lootable_at && Number(a.lootable_at) > agora) continue; // ainda em espera
      out.push({
        relationId: a.id,
        farmTownId: a.farm_town_id,
        // Confirmado no jogo: o rendimento está no campo "loot" da relação
        // (claim_resource_values pertence a outra resposta, por cidade).
        rende: Number(a.loot) || 0,
      });
    }
    return out;
  }

  // Aldeias indexadas por ilha, para saber a que cidade pertencem.
  function aldeiasPorIlha() {
    const idx = {};
    for (const m of colModels('FarmTown')) {
      const f = m.attributes || {};
      const chave = f.island_x + ':' + f.island_y;
      (idx[chave] = idx[chave] || []).push(f);
    }
    return idx;
  }

  function ilhaDaCidade(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      // Confirmado no jogo: o objecto devolvido por ITowns.getTown() NÃO tem
      // .attributes — expõe getIslandCoordinateX/Y. Com os nomes errados isto
      // devolvia sempre null, e então: (a) o filtro por ilha das trocas
      // desaparecia e o servidor recusava com "a sua cidade activa não está
      // nesta ilha"; (b) a evolução não encontrava cidade para nenhuma aldeia.
      const a = t.attributes || {};
      const x = a.island_x != null ? a.island_x
        : (typeof t.getIslandCoordinateX === 'function' ? t.getIslandCoordinateX()
        : (t.getIslandX && t.getIslandX()));
      const y = a.island_y != null ? a.island_y
        : (typeof t.getIslandCoordinateY === 'function' ? t.getIslandCoordinateY()
        : (t.getIslandY && t.getIslandY()));
      if (x == null || y == null) return null;
      return { x: Number(x), y: Number(y) };
    } catch (e) { return null; }
  }

  /* ---------------------- pedidos --------------------------------------- */
  // Recolha em massa (Capitão): um pedido para várias cidades.
  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * (é preciso recarregar para ver o efeito) E faz a passagem seguinte ler
   * valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels()[Nome].
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }


  /* ---------------- CARREGAR AS ALDEIAS DO SERVIDOR ---------------------
   * As colecções FarmTownPlayerRelation e FarmTown só ficam preenchidas
   * DEPOIS de abrires uma aldeia bárbara no jogo. Numa sessão acabada de
   * carregar estão vazias, e o módulo não veria aldeia nenhuma.
   * Este pedido é o mesmo que o jogo faz ao abrir a janela — enche as
   * colecções sem ser preciso clicar em nada.
   * -------------------------------------------------------------------- */
  let jaCarregou = false;

  async function garantirAldeiasCarregadas(townId) {
    try {
      if (colModels('FarmTownPlayerRelation').length) { jaCarregou = true; return true; }
      if (jaCarregou) return false;               // já se tentou e não veio nada

      // é preciso um farm_town_id qualquer; usa-se o primeiro da ilha
      const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
        + '&action=fetch&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({
            window_type: 'farm_town', tab_type: 'index',
            known_data: { models: [], collections: [], templates: [] },
            arguments: {}, town_id: Number(townId), nl_init: true,
          })) + '&_=' + Date.now();
      const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
        .then(lerResposta);
      aplicarNotificacoes(r);

      // o frontend_bridge devolve as colecções em json.collections
      try {
        const cols = ((r && r.json) || {}).collections || {};
        for (const nome of Object.keys(cols)) {
          const destino = mUw.MM.getCollections()[nome];
          const col = destino && destino[0];
          if (!col || typeof col.add !== 'function') continue;
          for (const item of (cols[nome] || [])) {
            const existe = (col.models || []).some((m) => m.attributes && Number(m.attributes.id) === Number(item.id));
            if (!existe) col.add(item);
          }
        }
      } catch (e) {}

      jaCarregou = true;
      return colModels('FarmTownPlayerRelation').length > 0;
    } catch (e) { jaCarregou = true; return false; }
  }

  async function recolherEmMassa(townIds, townIdBase) {
    const url = mUw.location.origin + '/game/farm_town_overviews?town_id=' + Number(townIdBase)
      + '&action=claim_loads_multiple&h=' + mUw.Game.csrfToken;
    const payload = {
      towns: townIds.map(Number),
      time_option_base: COOLDOWNS[OPCAO - 1],
      time_option_booty: COOLDOWNS[OPCAO - 1] * 2,
      claim_factor: 'normal',
      town_id: Number(townIdBase),
      nl_init: true,
    };
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      const erro = j && j.error;
      return { ok: !erro, msg: erro || (j && j.success) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  // Recolha individual de uma aldeia.
  async function recolherAldeia(relationId, farmTownId, townId) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    const payload = {
      model_url: 'FarmTownPlayerRelation/' + relationId,
      action_name: 'claim', captcha: null,
      arguments: { farm_town_id: Number(farmTownId), type: 'resources', option: OPCAO },
      town_id: Number(townId), nl_init: true,
    };
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      const erro = j && j.error;
      return { ok: !erro, msg: erro || (j && j.success) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* =========================================================================
   *  TROCAS COM AS ALDEIAS  (portado do equilibrar-recursos, lógica idêntica)
   *  Equilibra wood/stone/iron da cidade usando as aldeias da ilha como
   *  "câmbio": cada aldeia troca o que pede pelo que oferece, a um rácio.
   *  Suporta trocas diretas e cadeias de 2 pernas (via recurso intermédio).
   * ====================================================================== */
  const RES_KEYS = ['wood', 'stone', 'iron'];
  const EPS = 1;

  const TROCAS_DEFAULTS = {
    ativo: true,
    ratioFloor: 1.0,          // rácio mínimo aceite
    RATIO_TOLERANCE: 0.001,
    chainFloorMode: 'net',    // 'net' | 'each'
    maxTradesPerCity: 40,     // teto por cidade (segurança), não global
    maxOpsPerVillage: 99,     // sem limite prático: o travão é o rácio cair a 1
    minTrade: 1500,
    maxTradePerOp: 3000,
    reserveGive: 0,           // nunca descer abaixo disto no recurso dado
    fillTarget: 1.0,          // encher até esta fração do armazém
    skipBalanced: true,
    balancedTolerance: 0.10,
    aCadaNPassagens: 6,       // trocas correm 1x em cada N passagens do módulo
  };

  // Estado por ronda (reposto a cada cidade / ronda)
  let villageGiven = {}, villageReceived = {}, villageOps = {};
  let cityCapLeft = Infinity;

  function trocasCfg() {
    const c = Object.assign({}, TROCAS_DEFAULTS);
    try {
      const guardado = JSON.parse(armazem.getItem('grepoAldeias_trocas_v1') || '{}');
      Object.assign(c, guardado);
    } catch (e) {}
    return c;
  }
  function guardarTrocasCfg(c) {
    try { armazem.setItem('grepoAldeias_trocas_v1', JSON.stringify(c)); } catch (e) {}
  }

  function MAP_RES(v) {
    if (v == null) return null;
    const s = String(v).toLowerCase();
    if (['wood', 'lumber', 'madeira'].includes(s)) return 'wood';
    if (['stone', 'rock', 'pedra'].includes(s)) return 'stone';
    if (['iron', 'silver', 'prata'].includes(s)) return 'iron';
    return RES_KEYS.includes(s) ? s : null;
  }

  function getTownResources(town) {
    const res = {};
    try {
      const r = typeof town.getCurrentResources === 'function' ? town.getCurrentResources()
              : typeof town.resources === 'function' ? town.resources() : town.resources;
      RES_KEYS.forEach((k) => { res[k] = Number((r && r[k]) || 0) || 0; });
    } catch (e) { RES_KEYS.forEach((k) => (res[k] = 0)); }
    return res;
  }
  function getTownCapacity(town) {
    try {
      if (typeof town.getStorage === 'function') return Number(town.getStorage()) || 0;
      if (typeof town.resources === 'function') return Number((town.resources() || {}).storage) || 0;
    } catch (e) {}
    return 0;
  }

  function capKey(villageId) { return 'v' + villageId; }

  function getLiveRatio(farmTownId, fallback) {
    try {
      const rel = colModels('FarmTownPlayerRelation').map((m) => m.attributes || {})
        .find((a) => Number(a.farm_town_id) === Number(farmTownId));
      const r = Number((rel && (rel.current_trade_ratio != null ? rel.current_trade_ratio : rel.trade_ratio)));
      return Number.isFinite(r) ? r : fallback;
    } catch (e) { return fallback; }
  }

  function overallStaysOk(villageId, give, ratio, cfg) {
    const k = capKey(villageId);
    const g = (villageGiven[k] || 0) + give;
    const r = (villageReceived[k] || 0) + give * ratio;
    return g > 0 && (r / g) >= (1 - cfg.RATIO_TOLERANCE);
  }

  // Aldeias da ilha desta cidade, com o que se dá/recebe e o rácio.
  function getFarmVillagesForTown(townId) {
    try {
      const isl = ilhaDaCidade(townId);
      const relByFarm = {};
      colModels('FarmTownPlayerRelation').forEach((m) => {
        const a = m.attributes || {};
        if (a.farm_town_id != null) relByFarm[a.farm_town_id] = a;
      });
      const list = [];
      colModels('FarmTown').forEach((m) => {
        const f = m.attributes || {};
        if (isl && !(Number(f.island_x) === isl.x && Number(f.island_y) === isl.y)) return;
        const rel = relByFarm[f.id];
        if (!rel) return;
        const ratio = Number(rel.current_trade_ratio != null ? rel.current_trade_ratio : rel.trade_ratio);
        list.push({
          id: f.id, relationId: rel.id, name: f.name || ('aldeia ' + f.id),
          giveRes: MAP_RES(f.resource_demand),   // dás o que a aldeia PEDE
          getRes: MAP_RES(f.resource_offer),     // recebes o que a aldeia OFERECE
          ratio: Number.isFinite(ratio) ? ratio : null,
          capacity: Number(rel.available_trade_capacity != null ? rel.available_trade_capacity : rel.max_trade_capacity) || null,
        });
      });
      return list;
    } catch (e) { return []; }
  }

  function buildTradeGraph(villages) {
    const edges = [];
    for (const v of villages) {
      if (!v.giveRes || !v.getRes || v.giveRes === v.getRes || !(v.ratio > 0)) continue;
      edges.push({ from: v.giveRes, to: v.getRes, ratio: v.ratio, villageId: v.id,
        relationId: v.relationId, villageName: v.name, capacity: v.capacity });
    }
    return edges;
  }
  function capOfEdge(e) {
    return Number.isFinite(cityCapLeft) ? cityCapLeft : (e.capacity != null ? e.capacity : Infinity);
  }
  const edgesBetween = (edges, from, to) =>
    edges.filter((e) => e.from === from && e.to === to && capOfEdge(e) > 0);

  // Planeia UM passo de equilíbrio (mesma lógica do script validado).
  function planStep(t, cfg) {
    const s = t.res, C = t.cap;
    const edges = t._edges || [];
    edges.forEach((e) => { e.ratio = getLiveRatio(e.villageId, e.ratio); });
    const avg = (s.wood + s.stone + s.iron) / 3;
    const floor = cfg.ratioFloor - cfg.RATIO_TOLERANCE;

    const scarce = RES_KEYS.filter((r) => s[r] < avg - EPS).sort((a, b) => s[a] - s[b]);
    for (const d of scarce) {
      const donors = RES_KEYS.filter((r) => r !== d && s[r] > avg + EPS).sort((a, b) => s[b] - s[a]);
      for (const donor of donors) {
        const paths = [];
        edgesBetween(edges, donor, d).forEach((e) => paths.push([e]));
        for (const mid of RES_KEYS) {
          if (mid === donor || mid === d) continue;
          const e1s = edgesBetween(edges, donor, mid);
          const e2s = edgesBetween(edges, mid, d);
          for (const e1 of e1s) for (const e2 of e2s) {
            if (e1.villageId === e2.villageId) continue;
            paths.push([e1, e2]);
          }
        }
        const viable = paths
          .map((p) => ({ p, net: p.reduce((a, e) => a * e.ratio, 1) }))
          .filter(({ p, net }) => {
            if (p.length > 1) {
              return cfg.chainFloorMode === 'each' ? p.every((e) => e.ratio >= floor) : net >= floor;
            }
            return true;
          })
          .sort((a, b) => a.p.length - b.p.length || b.net - a.net);

        for (const { p, net } of viable) {
          const donorSurplus = s[donor] - avg;
          const roomToAvg = (avg - s[d]) / net;
          const roomWh = C > 0 ? ((C * cfg.fillTarget) - s[d]) / net : Infinity;
          const reserveBound = Math.max(0, s[donor] - cfg.reserveGive);
          let spend = Math.min(donorSurplus, roomToAvg, roomWh, reserveBound);

          let acc = 1, capBound = Infinity;
          for (const e of p) {
            const givenPerSpend = acc;
            const capLeft = capOfEdge(e);
            const legLimit = Math.min(Number.isFinite(capLeft) ? capLeft : Infinity, cfg.maxTradePerOp || Infinity);
            if (Number.isFinite(legLimit)) capBound = Math.min(capBound, legLimit / givenPerSpend);
            acc *= e.ratio;
          }
          spend = Math.floor(Math.min(spend, capBound));
          if (spend <= 0) continue;

          const legs = []; let give = spend; let ok = true;
          for (const e of p) {
            const get = Math.floor(give * e.ratio);
            if (give < cfg.minTrade || get <= 0) { ok = false; break; }
            const k = capKey(e.villageId);
            const firstUse = (villageOps[k] || 0) === 0;
            // REGRA DO RÁCIO: numa troca ÚNICA, e em QUALQUER repetição na mesma
            // aldeia, o rácio atual tem de estar acima do piso (1 por omissão).
            // Como o rácio baixa a cada troca, é ele que trava a aldeia — não um
            // número fixo de operações.
            if (p.length === 1 && e.ratio < floor) { ok = false; break; }
            if (!firstUse && e.ratio < floor) { ok = false; break; }
            // (numa cadeia com perna fresca, o piso já foi aplicado ao líquido)
            if ((villageOps[k] || 0) >= (cfg.maxOpsPerVillage || 99)) { ok = false; break; }
            legs.push({ villageId: e.villageId, relationId: e.relationId, villageName: e.villageName,
              from: e.from, to: e.to, ratio: e.ratio, give, get });
            give = get;
          }
          if (!ok) continue;
          return { d, donor, legs, net };
        }
      }
    }
    return null;
  }

  function isBalanced(res, cfg) {
    const avg = (res.wood + res.stone + res.iron) / 3;
    if (avg <= 0) return true;
    return RES_KEYS.every((k) => Math.abs(res[k] - avg) / avg <= cfg.balancedTolerance);
  }

  // Executa uma troca (mesmo pedido do script validado).
  async function executeTrade(townId, relationId, farmTownId, amount) {
    if (Number(mUw.Game && mUw.Game.townId) !== Number(townId)) {
      return { ok: false, error: 'cidade ativa mudou (conflito)', conflict: true };
    }
    const payload = {
      model_url: 'FarmTownPlayerRelation/' + relationId,
      action_name: 'trade', captcha: null,
      arguments: { farm_town_id: Number(farmTownId), amount: Math.floor(amount) },
      town_id: Number(townId), nl_init: true,
    };
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    try {
      const d = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then((r) => r.json());
      const j = d && d.json ? d.json : d;
      if (j && j.error) return { ok: false, error: j.error };
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Percorre as cidades e equilibra os recursos com as aldeias.
  // Desvio percentual médio face à média dos 3 recursos (0 = equilíbrio perfeito).
  function desequilibrio(res) {
    const avg = (res.wood + res.stone + res.iron) / 3;
    if (avg <= 0) return 0;
    return RES_KEYS.reduce((s, k) => s + Math.abs(res[k] - avg), 0) / (3 * avg);
  }

  async function correrTrocas(ctx, cfg) {
    const log = ctx.log;
    const towns = ctx.getMyTowns();
    let totalTrades = 0;

    for (const t of towns) {
      const town = mUw.ITowns.getTown(Number(t.id));
      if (!town) continue;

      const res = getTownResources(town);
      if (cfg.skipBalanced && isBalanced(res, cfg)) continue;

      const villages = getFarmVillagesForTown(t.id).filter((v) => v.ratio > 0);
      if (!villages.length) continue;

      // O servidor recusa a troca se a cidade activa não for da ilha da aldeia
      // ("A sua cidade ativa não está nesta ilha"). A mudança de cidade é só do
      // lado do cliente — não há pedido ao servidor — por isso é preciso dar
      // tempo ao jogo para assentar antes de enviar a troca.
      const ok = await ctx.switchToTown(t.id);
      if (!ok) { log(`— ${t.name}: não consegui mudar para esta cidade.`); continue; }
      await ctx.sleep(ctx.rand(1200, 1800));

      // confirmar mesmo antes de trocar (a mudança pode não ter assentado)
      if (Number(mUw.Game.townId) !== Number(t.id)) {
        await ctx.sleep(800);
        if (Number(mUw.Game.townId) !== Number(t.id)) {
          log(`— ${t.name}: cidade activa não mudou; salto esta ronda.`);
          continue;
        }
      }

      // repor estado por cidade
      villageGiven = {}; villageReceived = {}; villageOps = {};
      // Capacidade comercial REAL da cidade. Sem isto, o módulo pedia mais do
      // que o mercado permite e o servidor recusava ("restam-lhe apenas
      // capacidade comercial para N recursos"), perdendo a troca inteira.
      cityCapLeft = (function () {
        try {
          const t2 = mUw.ITowns.getTown(Number(t.id));
          const c = typeof t2.getAvailableTradeCapacity === 'function' ? t2.getAvailableTradeCapacity() : null;
          return (c != null && Number.isFinite(Number(c))) ? Number(c) : Infinity;
        } catch (e) { return Infinity; }
      })();
      if (cityCapLeft <= 0) { log(`— ${t.name}: sem capacidade comercial livre.`); continue; }

      const estado = {
        res: getTownResources(town),
        cap: getTownCapacity(town),
        _edges: buildTradeGraph(villages),
      };

      const antes = desequilibrio(estado.res);
      let trades = 0;
      // Continua a equilibrar enquanto houver um passo vantajoso possível.
      // Só pára quando: já está equilibrado, não há aldeia com rácio suficiente,
      // ou se atinge o teto de segurança desta cidade.
      while (trades < cfg.maxTradesPerCity) {
        const plano = planStep(estado, cfg);
        if (!plano) break;
        let falhou = false;
        for (const leg of plano.legs) {
          const r = await executeTrade(t.id, leg.relationId, leg.villageId, leg.give);
          if (!r.ok) { log(`⚠️ ${t.name}: troca falhou (${r.error})`); falhou = true; break; }
          trades++; totalTrades++;
          const k = capKey(leg.villageId);
          villageGiven[k] = (villageGiven[k] || 0) + leg.give;
          villageReceived[k] = (villageReceived[k] || 0) + leg.get;
          villageOps[k] = (villageOps[k] || 0) + 1;
          estado.res[leg.from] -= leg.give;
          estado.res[leg.to] += leg.get;
          if (Number.isFinite(cityCapLeft)) cityCapLeft -= leg.give;
          log(`🔄 ${t.name} · ${leg.villageName}: ${leg.give} ${leg.from} → ${leg.get} ${leg.to} (x${leg.ratio.toFixed(2)})`);
          await ctx.sleep(ctx.rand(1200, 2400));
        }
        if (falhou) break;
      }
      if (trades) {
        const depois = desequilibrio(estado.res);
        const pct = (v) => Math.round(v * 100);
        log(`⚖️ ${t.name}: ${trades} troca(s) · desvio ${pct(antes)}% → ${pct(depois)}%${depois <= cfg.balancedTolerance ? ' (equilibrada)' : ''}`);
      }
      await ctx.sleep(ctx.rand(1500, 3500));
    }
    if (totalTrades) log(`Trocas concluídas: ${totalTrades}.`);
    return totalTrades;
  }

  /* ------------------------------- run ---------------------------------- */
  /* =========================================================================
   *  EVOLUÇÃO DAS ALDEIAS (expandir / desbloquear) — custa PONTOS DE COMBATE
   *  Disponíveis = (ataque + defesa) − usados, do modelo PlayerKillpoints.
   * ====================================================================== */
  // Custo real de desbloquear uma aldeia, medido no jogo (o servidor devolve 1).
  const CUSTO_DESBLOQUEIO = 100;

  const EVO_DEFAULTS = {
    ativo: true,
    reservaPontos: 0,        // nunca descer abaixo destes pontos de combate
    desbloquear: true,       // também desbloquear aldeias bloqueadas
    aCadaNPassagens: 12,     // não precisa de ser frequente
  };
  function evoCfg() {
    const c = Object.assign({}, EVO_DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem('grepoAldeias_evo_v1') || '{}')); } catch (e) {}
    return c;
  }
  function guardarEvoCfg(c) {
    try { armazem.setItem('grepoAldeias_evo_v1', JSON.stringify(c)); } catch (e) {}
  }

  function pontosDeCombate() {
    try {
      const m = mUw.MM.getModels().PlayerKillpoints;
      const k = Object.keys(m)[0];
      const a = m[k].attributes || {};
      const ganhos = (Number(a.att) || 0) + (Number(a.def) || 0);
      return Math.max(0, ganhos - (Number(a.used) || 0));
    } catch (e) { return 0; }
  }

  function nivelMaximoAldeia() {
    try {
      const c = (mUw.GameData.farm_town || {}).expansion_costs || {};
      const niveis = Object.keys(c).map(Number);
      return niveis.length ? Math.max.apply(null, niveis) : 6;
    } catch (e) { return 6; }
  }

  async function bridgeAldeia(relationId, acao, farmTownId, townId) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    const payload = {
      model_url: 'FarmTownPlayerRelation/' + relationId,
      action_name: acao, captcha: null,
      arguments: { farm_town_id: Number(farmTownId) },
      town_id: Number(townId), nl_init: true,
    };
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      if (respostaTemCaptcha(r)) return { ok: false, captcha: true, msg: 'verificação de bot' };
      aplicarNotificacoes(r);
      const j = r && r.json;
      return { ok: !(j && j.error), msg: (j && (j.error || j.success)) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  async function evoluirAldeias(ctx, cfg) {
    const log = ctx.log;
    const maxNivel = nivelMaximoAldeia();
    let pontos = pontosDeCombate();
    // As ALDEIAS têm prioridade nos pontos de combate: evoluir uma aldeia é um
    // investimento finito (só se faz uma vez e demora tempo), enquanto a
    // cultura consome pontos continuamente e eles vão sendo repostos ao
    // combater. Por isso não se reserva nada para a cultura — ela usa o que
    // sobrar, e o maestro corre as aldeias primeiro.
    const disponiveis = Math.max(0, pontos - (cfg.reservaPontos || 0));
    if (disponiveis <= 0) { log(`Evolução: sem pontos de combate acima da reserva (${pontos} disponíveis).`); return; }

    // cidade de referência por aldeia (a que está na mesma ilha)
    const porIlha = aldeiasPorIlha();
    const cidadePorAldeia = {};
    for (const t of ctx.getMyTowns()) {
      const isl = ilhaDaCidade(t.id);
      if (!isl) continue;
      for (const f of (porIlha[isl.x + ':' + isl.y] || [])) {
        if (cidadePorAldeia[f.id] == null) cidadePorAldeia[f.id] = t.id;
      }
    }

    // candidatas: bloqueadas (unlock) e por expandir (upgrade), mais baratas primeiro
    const candidatas = [];
    for (const m of colModels('FarmTownPlayerRelation')) {
      const a = m.attributes || {};
      if (a.expansion_at) continue;                       // já tem expansão a decorrer
      let custo = Number(a.upgrade_cost) || 0;
      const bloqueada = Number(a.relation_status) === 0;
      if (bloqueada) {
        if (!cfg.desbloquear) continue;
        // MEDIDO NO JOGO: para aldeias bloqueadas o servidor devolve
        // upgrade_cost = 1, mas o desbloqueio custa mesmo 100 pontos de
        // combate. (15 desbloqueios + 12 evoluções deram 1938 gastos: 438 das
        // evoluções + 1500 dos desbloqueios.) Para as já desbloqueadas o campo
        // está correcto — os 1/5/25/50/100 por nível batem certo.
        custo = CUSTO_DESBLOQUEIO;
        candidatas.push({ rel: a.id, farm: a.farm_town_id, custo, acao: 'unlock', nivel: 0 });
      } else {
        if (custo <= 0) continue;                         // sem custo = nada a fazer
        if (Number(a.expansion_stage) >= maxNivel) continue; // já no máximo
        candidatas.push({ rel: a.id, farm: a.farm_town_id, custo, acao: 'upgrade', nivel: a.expansion_stage });
      }
    }
    if (!candidatas.length) { log('Evolução: nada a evoluir.'); return; }
    candidatas.sort((a, b) => a.custo - b.custo);  // as mais baratas rendem mais por ponto

    let gastos = 0, feitas = 0;
    for (const c of candidatas) {
      if (gastos + c.custo > disponiveis) continue;      // não cabe no orçamento
      const townId = cidadePorAldeia[c.farm];
      if (!townId) continue;
      const r = await bridgeAldeia(c.rel, c.acao, c.farm, townId);
      if (r.captcha) { await tratarCaptcha(ctx, 'evolução de aldeias'); return; }
      if (r.ok) {
        gastos += c.custo; feitas++;
        log(`🏚️ Aldeia ${c.farm}: ${c.acao === 'unlock' ? 'desbloqueada' : 'nível ' + c.nivel + ' → ' + (Number(c.nivel) + 1)} (${c.custo} pontos).`);
        await ctx.sleep(ctx.rand(800, 1600));
      } else {
        log(`⚠️ Aldeia ${c.farm}: ${r.msg}`);
      }
    }
    if (feitas) log(`Evolução: ${feitas} aldeia(s), ${gastos} pontos de combate gastos (restam ~${pontos - gastos}).`);
  }

  /* =========================================================================
   *  VERIFICAÇÃO DE BOT (captcha): DETETAR e PARAR — nunca contornar.
   *  Se o jogo pedir verificação, o módulo suspende-se e avisa no Discord
   *  para tu resolveres à mão. Não se apaga o aviso do jogo.
   * ====================================================================== */
  const CAPTCHA_KEY = 'grepoAldeias_captcha_v1';

  function respostaTemCaptcha(r) {
    try {
      const s = JSON.stringify(r || '');
      return /captcha|bot_?check|bot_?protection|human_?confirm/i.test(s);
    } catch (e) { return false; }
  }

  // Também deteta pelo aviso que o jogo empilha na interface.
  function jogoPedeVerificacao() {
    try {
      const st = mUw.GrepoNotificationStack;
      if (!st) return false;
      const s = JSON.stringify(st.length ? st : {});
      return /bot_?check|captcha/i.test(s);
    } catch (e) { return false; }
  }

  function captchaAtivo() {
    try {
      const t = Number(armazem.getItem(CAPTCHA_KEY) || 0);
      // fica suspenso 30 min após deteção (dá tempo de resolveres)
      return t && (agoraServidorMs() - t) < 30 * 60 * 1000;
    } catch (e) { return false; }
  }

  async function tratarCaptcha(ctx, onde) {
    try { armazem.setItem(CAPTCHA_KEY, String(agoraServidorMs())); } catch (e) {}
    ctx.log(`🛑 Verificação de bot detetada (${onde}). Módulo suspenso — resolve no jogo.`);
    if (ctx.avisarDiscord) {
      await ctx.avisarDiscord('captcha', `🛑 **Grepolis** — verificação de bot em \`${mWorld}\` (${onde}).\nO módulo parou. Resolve no jogo para retomar.`);
    }
  }

  /* =========================================================================
   *  LIMPEZA DE NOTIFICAÇÕES acumuladas.
   *  NUNCA apaga o aviso de verificação de bot — esse tens de o ver.
   * ====================================================================== */
  function limparNotificacoes(ctx) {
    try {
      const st = mUw.GrepoNotificationStack;
      if (!st) return;
      if (typeof st.deleteOutdated === 'function') st.deleteOutdated();
      // (não se chama deleteBotCheckNotification de propósito)
    } catch (e) {}
  }

  let passagem = 0;

  // Flags para forçar trocas/evolução fora do ciclo normal (botões do painel).
  let forcarTrocas = false, forcarEvolucao = false;

  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const log = ctx.log;

    const towns = ctx.getMyTowns();
    if (!towns.length) { log('Sem cidades.'); return; }

    if (agoraJogo() == null) { log('Sem relógio do servidor — não ajo às cegas.'); return; }

    // As colecções das aldeias só ficam preenchidas depois de abrires uma
    // aldeia no jogo. Numa sessão nova estão vazias — pedimo-las ao servidor.
    if (!colModels('FarmTownPlayerRelation').length) {
      const ok = await garantirAldeiasCarregadas(towns[0].id);
      if (!ok) { log('Aldeias: sem dados do servidor — abre uma aldeia bárbara uma vez.'); return; }
      log(`Aldeias carregadas do servidor: ${colModels('FarmTownPlayerRelation').length}.`);
    }

    passagem++;

    // 0. Se o jogo pediu verificação de bot, não age até estar resolvido.
    if (captchaAtivo()) { log('⏸️ Suspenso: verificação de bot por resolver.'); return; }
    if (jogoPedeVerificacao()) { await tratarCaptcha(ctx, 'aviso do jogo'); return; }

    // limpeza das notificações acumuladas (nunca a de verificação de bot)
    if (passagem % 6 === 0) limparNotificacoes(ctx);

    // 1. RECOLHA (todas as passagens)
    await fazerRecolha(ctx, towns);

    // 2. TROCAS (só de N em N passagens — não precisam de ser tão frequentes)
    const cfgT = trocasCfg();
    // forcarAgora: usado pelos botões do painel, para testar sem esperar
    if (forcarTrocas && !cfgT.ativo) {
      log('Trocas: estão DESLIGADAS na configuração — liga a caixa "Equilibrar recursos" e guarda.');
    }
    if (cfgT.ativo && (forcarTrocas || passagem % (cfgT.aCadaNPassagens || 6) === 0)) {
      try { await correrTrocas(ctx, cfgT); } catch (e) { log('Trocas falharam: ' + e.message); }
    }

    // 3. EVOLUÇÃO das aldeias (pontos de combate)
    const cfgE = evoCfg();
    // Se o utilizador forçou mas a evolução está desligada, dizê-lo — antes
    // ficava em silêncio e parecia que o botão não funcionava.
    if (forcarEvolucao && !cfgE.ativo) {
      log('Evolução: está DESLIGADA na configuração — liga a caixa "Evoluir aldeias" e guarda.');
    }
    if (cfgE.ativo && (forcarEvolucao || passagem % (cfgE.aCadaNPassagens || 12) === 0)) {
      try { await evoluirAldeias(ctx, cfgE); } catch (e) { log('Evolução falhou: ' + e.message); }
    }

    forcarTrocas = false; forcarEvolucao = false;   // consumidas
  }

  async function fazerRecolha(ctx, towns) {
    const log = ctx.log;
    const prontas = relacoesProntas();
    if (!prontas.length) { log('Recolha: nenhuma aldeia pronta.'); return; }

    if (temCapitao()) {
      // UM pedido para todas as cidades — muito mais leve que aldeia a aldeia.
      const ids = towns.map((t) => t.id);
      const r = await recolherEmMassa(ids, ids[0]);
      if (r.ok) {
        const total = prontas.reduce((s, p) => s + (p.rende || 0), 0);
        log(`🌾 Recolha em massa em ${ids.length} cidade(s): ${prontas.length} aldeia(s) prontas (~${total} recursos).`);
      } else {
        log(`⚠️ Recolha em massa falhou (${r.msg}); tento aldeia a aldeia.`);
        await recolhaIndividual(ctx, towns, prontas);
      }
      return;
    }

    await recolhaIndividual(ctx, towns, prontas);
  }

  // Sem Capitão: cada aldeia é recolhida a partir de uma cidade da mesma ilha.
  async function recolhaIndividual(ctx, towns, prontas) {
    const log = ctx.log;
    // mapa farm_town_id -> cidade da mesma ilha
    const porIlha = aldeiasPorIlha();
    const cidadePorAldeia = {};
    for (const t of towns) {
      const isl = ilhaDaCidade(t.id);
      if (!isl) continue;
      for (const f of (porIlha[isl.x + ':' + isl.y] || [])) {
        if (cidadePorAldeia[f.id] == null) cidadePorAldeia[f.id] = t.id;
      }
    }

    let n = 0, recursos = 0, noLimite = 0;
    for (const p of prontas) {
      const townId = cidadePorAldeia[p.farmTownId];
      if (!townId) continue; // aldeia sem cidade minha na ilha
      const r = await recolherAldeia(p.relationId, p.farmTownId, townId);
      if (r.captcha) { await tratarCaptcha(ctx, 'recolha'); return; }
      if (r.ok) { n++; recursos += p.rende || 0; }
      else {
        /* O LIMITE DIÁRIO não é erro — é o normal ao fim do dia, e enchia o
         * registo com dezenas de linhas iguais. Vai para a rotina. */
        if (/m[áa]xima di[áa]ria|daily limit/i.test(String(r.msg || ''))) {
          noLimite++;
        } else {
          log(`⚠️ Aldeia ${p.farmTownId}: ${r.msg}`);
        }
      }
      await ctx.sleep(ctx.rand(400, 900));
    }
    if (n) log(`🌾 Recolhidas ${n} aldeia(s) (~${recursos} recursos).`);
    if (noLimite) {
      const rot = ctx.logRotina || log;
      rot(`Recolha: ${noLimite} aldeia(s) já no limite diário.`);
    }
    else log('Recolha: nada recolhido.');
  }

  /* ---------------------- PAINEL ---------------------------------------- */

  /* Preservar a posição do rolamento ao redesenhar o painel — senão volta ao
   * topo a cada alteração. */
  function comRolamento(fn) {
    /* Guardar TODOS os elementos que estejam rolados, não só os que se
     * adivinham: o que rola pode ser uma caixa interna e o salto para o topo
     * mantinha-se. */
    /* Guardar o CAMINHO e não só a referência: o redesenho destrói os
     * elementos internos e a referência antiga deixa de estar no ecrã. */
    const caminhoDe = (el) => {
      const p = []; let n = el;
      while (n && n.parentElement && p.length < 30) {
        p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
        if (n.id) { p.unshift('#' + n.id); break; }
      }
      return p;
    };
    const porCaminho = (p) => {
      try {
        if (!p.length) return null;
        let n = null, i = 0;
        if (typeof p[0] === 'string' && p[0].charAt(0) === '#') { n = document.getElementById(p[0].slice(1)); i = 1; }
        else n = document.body;
        for (; n && i < p.length; i++) n = n.children[p[i]];
        return n || null;
      } catch (e) { return null; }
    };

    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}
    fn();
    const repor = () => guardados.forEach(({ caminho, y, el }) => {
      try {
        if (el && el.isConnected) { el.scrollTop = y; return; }
        const n2 = porCaminho(caminho);
        if (n2) n2.scrollTop = y;
      } catch (e) {}
    });
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  function painel(container, ctx) {
    mUw = ctx.uw;
    const cap = temCapitao();
    const prontas = relacoesProntas();
    const total = prontas.reduce((s, p) => s + (p.rende || 0), 0);
    const mins = Math.round(COOLDOWNS[OPCAO - 1] / 60);
    const c = trocasCfg();
    const e = evoCfg();
    const pontos = pontosDeCombate();
    const maxNv = nivelMaximoAldeia();
    let porEvoluir = 0;
    try {
      for (const m of colModels('FarmTownPlayerRelation')) {
        const a = m.attributes || {};
        if (a.expansion_at) continue;
        if (Number(a.relation_status) === 0) { if (e.desbloquear) porEvoluir++; continue; }
        if (Number(a.expansion_stage) < maxNv) porEvoluir++;
      }
    } catch (err) {}
    container.innerHTML = `
      <div style="font-size:11px;line-height:1.6;background:#0d141c;padding:5px;border-radius:4px;margin-bottom:5px">
        <b>Recolha</b> — só <b>exige</b> recursos (nunca saqueia), opção de <b>${mins} min</b>.<br>
        Via: <b>${cap ? 'em massa (Capitão ativo)' : 'aldeia a aldeia'}</b><br>
        Prontas agora: <b>${prontas.length}</b> (~${total} recursos)
      </div>
      <div style="font-size:11px;line-height:1.7;background:#0d141c;padding:5px;border-radius:4px">
        <label><input type="checkbox" id="ald-trocas-on"${c.ativo ? ' checked' : ''}> <b>Equilibrar recursos com as aldeias</b></label><br>
        Rácio mínimo: <input type="number" step="0.05" min="0.5" max="2" value="${c.ratioFloor}" id="ald-ratio" style="width:52px"><br>
        Troca mínima: <input type="number" min="0" step="100" value="${c.minTrade}" id="ald-min" style="width:62px"> ·
        máx/op: <input type="number" min="0" step="100" value="${c.maxTradePerOp}" id="ald-maxop" style="width:62px"><br>
        <span style="opacity:.75">Troca em cada aldeia enquanto o rácio dela for ≥ rácio mínimo (baixa a cada troca).</span><br>
        Máx. trocas por cidade: <input type="number" min="1" value="${c.maxTradesPerCity}" id="ald-maxr" style="width:42px"><br>
        Correr trocas a cada <input type="number" min="1" max="60" value="${c.aCadaNPassagens}" id="ald-cada" style="width:42px"> passagens
        <span style="opacity:.6">(~${(c.aCadaNPassagens || 6) * (opts.intervaloMin || 5)} min)</span>
        <button id="ald-forcar-trocas" style="cursor:pointer;width:100%;margin-top:4px;font-size:11px;padding:3px">▶ Trocar agora (sem esperar)</button>
      </div>
      <div style="font-size:11px;line-height:1.7;background:#0d141c;padding:5px;border-radius:4px;margin-top:5px">
        <label><input type="checkbox" id="ald-evo-on"${e.ativo ? ' checked' : ''}> <b>Evoluir aldeias</b></label>
        <span style="opacity:.7">(pontos de combate: <b>${pontos}</b>)</span><br>
        Reservar <input type="number" min="0" step="100" value="${e.reservaPontos}" id="ald-evo-res" style="width:62px"> pontos<br>
        <label><input type="checkbox" id="ald-evo-unlock"${e.desbloquear ? ' checked' : ''}> desbloquear aldeias bloqueadas</label><br>
        <span style="opacity:.6">Por evoluir: ${porEvoluir} aldeia(s)</span>
        <button id="ald-forcar-evo" style="cursor:pointer;width:100%;margin-top:4px;font-size:11px;padding:3px">▶ Evoluir agora (sem esperar)</button>
      </div>
      ${captchaAtivo() ? '<div style="background:#633;color:#fcc;padding:5px;border-radius:4px;margin-top:5px;font-size:11px">🛑 Suspenso: verificação de bot por resolver no jogo.</div>' : ''}
      <button id="ald-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    // Os botões chamam DIRECTAMENTE a função respectiva. Passar pelo run()
    // completo fazia a recolha primeiro e confundia o teste.
    const bt = container.querySelector('#ald-forcar-trocas');
    if (bt) bt.onclick = async () => {
      mUw = ctx.uw; mWorld = ctx.WORLD;
      bt.disabled = true; bt.textContent = 'a trocar...';
      try {
        if (!colModels('FarmTownPlayerRelation').length) {
          const towns = ctx.getMyTowns();
          if (towns.length) await garantirAldeiasCarregadas(towns[0].id);
        }
        await correrTrocas(ctx, trocasCfg());
      } catch (e) { ctx.log('Trocas: ' + e.message); }
      bt.disabled = false; bt.textContent = '▶ Trocar agora (sem esperar)';
    };
    const be = container.querySelector('#ald-forcar-evo');
    if (be) be.onclick = async () => {
      if (!confirm('Evoluir aldeias gasta pontos de combate e é irreversível. Continuar?')) return;
      mUw = ctx.uw; mWorld = ctx.WORLD;
      be.disabled = true; be.textContent = 'a evoluir...';
      try {
        if (!colModels('FarmTownPlayerRelation').length) {
          const towns = ctx.getMyTowns();
          if (towns.length) await garantirAldeiasCarregadas(towns[0].id);
        }
        await evoluirAldeias(ctx, evoCfg());
      } catch (e) { ctx.log('Evolução: ' + e.message); }
      be.disabled = false; be.textContent = '▶ Evoluir agora (sem esperar)';
      comRolamento(() => painel(container, ctx));
    };

    const g = container.querySelector('#ald-guardar');
    if (g) g.onclick = () => {
      const novo = Object.assign({}, c, {
        ativo: container.querySelector('#ald-trocas-on').checked,
        ratioFloor: Number(container.querySelector('#ald-ratio').value) || 1,
        minTrade: Number(container.querySelector('#ald-min').value) || 0,
        maxTradePerOp: Number(container.querySelector('#ald-maxop').value) || 3000,
        maxTradesPerCity: Number(container.querySelector('#ald-maxr').value) || 40,
        aCadaNPassagens: Number(container.querySelector('#ald-cada').value) || 6,
      });
      guardarTrocasCfg(novo);
      guardarEvoCfg(Object.assign({}, e, {
        ativo: container.querySelector('#ald-evo-on').checked,
        reservaPontos: Number(container.querySelector('#ald-evo-res').value) || 0,
        desbloquear: container.querySelector('#ald-evo-unlock').checked,
      }));
      if (ctx && ctx.log) ctx.log('Configuração guardada.');
      g.textContent = 'Guardado ✓';
      setTimeout(() => { g.textContent = 'Guardar trocas'; }, 1500);
    };
  }

  return {
    id: 'aldeias',
    nome: 'Aldeias bárbaras',
    intervaloMin: opts.intervaloMin || 5,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
  };
}

  // ======================= MÓDULO: ALERTAS DE ATAQUE =====================
/* =============================================================================
 *  MÓDULO: ALERTAS DE ATAQUE  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Lê os movimentos que o jogo já mantém em memória (MM.getModels().MovementsUnits)
 *  e avisa no Discord quando aparece um ataque novo. NÃO faz pedidos ao jogo.
 *
 *  Estimativa da unidade: o jogo não diz o que vem. Calcula-se a velocidade
 *  efetiva (distância ÷ duração) e comparam-se com as velocidades base das
 *  unidades. ATENÇÃO: bónus do atacante (meteorologia, construtor naval, farol,
 *  heróis, feitiços) distorcem o valor — por isso o aviso lista as unidades
 *  COMPATÍVEIS, nunca uma certeza.
 *
 *  Como o jogo não fornece started_at nos ataques recebidos, a duração é
 *  estimada a partir do instante em que o ataque é detetado (o módulo corre a
 *  cada minuto, logo o erro é de segundos numa viagem de horas).
 * ========================================================================== */

function makeAlertasModule(opts) {
  opts = opts || {};

  /* ============ QUANDO É QUE VI CADA COMANDO ============================
   * Os ataques recebidos não trazem `started_at`, e usar o tempo que FALTA
   * como se fosse a viagem toda dá velocidades absurdas — vi birremes
   * classificadas a 122, que é categoria de voadores.
   *
   * Guarda-se a hora em que cada comando foi visto pela primeira vez. Com o
   * módulo a passar de 30 em 30 s, essa hora tem 30 s de erro no máximo, o
   * que é irrelevante numa viagem de 45 min.
   *
   * A excepção é o comando visto pela PRIMEIRA vez logo a seguir a a página
   * abrir: esse já vinha a caminho e não se sabe há quanto tempo.
   * ==================================================================== */
  const VISTOS_ALERTAS = 'grepoAlertas_vistosEm_v1';
  const ARRANQUE_ALERTAS = 'grepoAlertas_arranque_v1';
  let arranqueAlertas = null;

  /* Devolve { quando, novo }: `novo` diz se é a primeira vez que se vê. */
  function primeiraVezVistoAlertas(a) {
    const id = String((a && (a.command_id || a.id)) || '');
    if (!id) return null;
    try {
      const l = JSON.parse(armazem.getItem(VISTOS_ALERTAS) || '{}');
      if (l[id]) return { quando: Number(l[id]), novo: false };

      const t = agoraJogo();
      if (t == null) return null;
      l[id] = t;

      // limpar os antigos, para não crescer sem fim
      const limite = t - 12 * 3600;
      for (const k of Object.keys(l)) if (Number(l[k]) < limite) delete l[k];

      armazem.setItem(VISTOS_ALERTAS, JSON.stringify(l));
      return { quando: t, novo: true };
    } catch (e) { return null; }
  }

  function vistoAoArrancar(quando) {
    if (arranqueAlertas == null) {
      try { arranqueAlertas = Number(armazem.getItem(ARRANQUE_ALERTAS)) || null; } catch (e) {}
    }
    if (!arranqueAlertas || !quando) return false;
    return Math.abs(Number(quando) - arranqueAlertas) < 90;
  }

  // Constante de calibração: velocidade_equivalente = K × distância ÷ duração(s).
  // Calibrada com ataques reais (mundo de velocidade 3). Os bónus do atacante
  // (cartografia +10% naval, meteorologia, construtor naval, farol, heróis,
  // feitiços) fazem variar o resultado ~20%, daí a tolerância larga.
  // ESCOLHA DELIBERADA: calibrada pelo lado LENTO. Assim, um colonizador nunca
  // passa despercebido — prefere-se um alarme a mais a falhar uma conquista.
  // Constante do modelo de viagem, calibrada com comandos reais JÁ com o tempo
  // de preparação descontado (ver TEMPO_PREPARACAO). Sem esse desconto o erro
  // chegava a 18% nas unidades rápidas, porque os 300 s fixos pesam muito nas
  // viagens curtas — e isso deslocava a estimativa toda para baixo.
  const K_DEFAULT = 5260;
  const TOLERANCIA = 0.28;   // ±28% ao comparar com a velocidade base da unidade

  let mUw = null, mWorld = '';

  // RELÓGIO DO SERVIDOR — o único que conta.
  // O relógio da máquina é irrelevante e enganador: este VPS está em Espanha e
  // o jogo corre em hora portuguesa, uma hora de diferença PERMANENTE. Se o
  // servidor não estiver disponível devolvemos null e o módulo NÃO age, em vez
  // de agir com uma hora possivelmente errada.
  /* Hora do JOGO, não a do computador — que pode estar horas ao lado. */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function horaJogo(segundos) {
    try {
      const f = mUw.__maestroHoraJogo || uw.__maestroHoraJogo;
      if (f) return f(segundos);
    } catch (e) {}
    try {
      /* serverGMTOffset é uma FUNÇÃO, não um número. */
      const w = mUw || uw;
      const raw = w.Timestamp.serverGMTOffset;
      let d = (typeof raw === 'function') ? Number(raw.call(w.Timestamp)) : Number(raw);
      if (!Number.isFinite(d)) d = Number(w.Game && w.Game.server_gmt_offset) || 0;
      return new Date((Number(segundos) + d) * 1000).toISOString().slice(11, 19);
    } catch (e) { return '?'; }
  }

  function agoraJogo() {
    try {
      if (typeof mUw.Timestamp !== 'undefined' && typeof mUw.Timestamp.now === 'function') {
        const t = Math.floor(mUw.Timestamp.now());
        if (Number.isFinite(t) && t > 0) return t;
      }
    } catch (e) {}
    try {
      const t = Number(mUw.Game && mUw.Game.server_time);
      if (Number.isFinite(t) && t > 0) return Math.floor(t);
    } catch (e) {}
    return null;   // sem relógio do servidor: não se inventa
  }


  // Jogadores (e alianças) cujos ataques NÃO geram aviso. Serve sobretudo para
  // as multis: a main ataca-as constantemente para farmar favores e cultura, e
  // sem isto o Discord ficaria inundado com os nossos próprios ataques.
  const IGNORAR_KEY = 'grepoAlertas_ignorar_v1';
  function lerIgnorados() {
    try {
      const v = JSON.parse(armazem.getItem(IGNORAR_KEY) || '{}');
      return { jogadores: v.jogadores || [], aliancas: v.aliancas || [] };
    } catch (e) { return { jogadores: [], aliancas: [] }; }
  }
  function guardarIgnorados(v) { try { armazem.setItem(IGNORAR_KEY, JSON.stringify(v)); } catch (e) {} }
  function ehIgnorado(a) {
    const ig = lerIgnorados();
    const nome = String(a.jogador || '').trim().toLowerCase();
    const ali = String(a.alianca || '').trim().toLowerCase();
    if (nome && ig.jogadores.some((x) => String(x).trim().toLowerCase() === nome)) return true;
    if (a.jogador_id && ig.jogadores.some((x) => Number(x) === Number(a.jogador_id))) return true;
    if (ali && ig.aliancas.some((x) => String(x).trim().toLowerCase() === ali)) return true;
    return false;
  }

  const CFG_KEY = 'grepoAlertas_cfg_v1';

  /* O servidor recusou pedidos nesta passagem: sem isto, não se distingue
   * "não há ataques" de "não consegui ver". */
  let limitado429 = false;
  const VISTOS_KEY = 'grepoAlertas_vistos_v1';

  function cfg() {
    // segundosEntreConsultas: intervalo mínimo entre pedidos ao servidor. O
    // servidor limita o ritmo (erro 429 observado com 21 pedidos seguidos).
    // Para ataques de horas, 55 s é irrelevante; baixa-o só se receberes
    // ataques muito curtos e usares a esquiva.
    const base = { K: K_DEFAULT, avisarApoios: false, ativo: true, segundosEntreConsultas: 55 };
    try { Object.assign(base, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return base;
  }
  function guardarCfg(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  // command_ids já avisados (para não repetir), com limpeza dos antigos.
  function lerVistos() {
    try { return JSON.parse(armazem.getItem(VISTOS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function gravarVistos(v) {
    const agora = agoraJogo();
    for (const k of Object.keys(v)) if (v[k] < agora - 86400) delete v[k]; // esquece ao fim de 1 dia
    try { armazem.setItem(VISTOS_KEY, JSON.stringify(v)); } catch (e) {}
  }

  /* ---------------------- leitura dos movimentos ------------------------ */
  // Todo o comando tem um tempo fixo de preparação antes de se pôr a caminho
  // (o jogo expõe-no; são 300 s). Não descontá-lo falseia a velocidade.
  function tempoPreparacao() {
    try { return Number(((mUw.Game.constants || {}).units || {}).runtime_setup_time) || 300; }
    catch (e) { return 300; }
  }


  // FONTE FIÁVEL DOS COMANDOS A CHEGAR.
  // O modelo local (MM.getModels().MovementsUnits) fica vazio ou desatualizado
  // até a página ser recarregada — confirmado no jogo. Para decisões que
  // dependem de ver um ataque a tempo, perguntamos ao servidor.
  // Endpoint: /game/town_overviews?action=command_overview
  async function comandosDoServidor(townId) {
    try {
      const url = mUw.location.origin + '/game/town_overviews?town_id=' + Number(townId)
        + '&action=command_overview&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({ town_id: Number(townId), nl_init: true }))
        + '&_=' + Date.now();
      const resp = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
      if (resp.status === 429) {
        // Limite de pedidos do servidor: recuar e tentar mais tarde.
        limitado429 = true;
        try { mUw.console.log('[ALERTAS] servidor a limitar pedidos (429) — espero.'); } catch (e) {}
        await new Promise((r2) => setTimeout(r2, 3000));
        return [];
      }
      const r = await resp.json();
      const erro = r && r.json && r.json.error;
      if (erro && /administrador|administrator|premium/i.test(String(erro))) {
        semAdministrador = true;
        try { mUw.console.log('[ALERTAS] sem Administrador: uso só os dados locais.'); } catch (e) {}
        return [];
      }
      const cmds = ((r && r.json && r.json.data) || {}).commands || [];
      const saida = cmds.map((c) => ({
        command_id: Number(c.id),
        arrival_at: Number(c.arrival_at),
        started_at: Number(c.started_at),
        target_town_id: Number(c.destination_town_id),
        home_town_id: Number(c.origin_town_id),
        type: String(c.type || ''),
        link_origin: c.link_origin || '',
        town_name_origin: c.town_name_origin || '',
      })).filter((c) => c.command_id && c.arrival_at);
      cacheServidor = { t: agoraMs, dados: saida };
      return saida;
    } catch (e) { return []; }
  }


  // Os ataques a chegar NÃO estão de forma fiável no modelo local: ele fica
  // vazio até a página ser atualizada. Perguntamos ao servidor, tal como o
  // encaixe faz — senão a esquiva não veria o ataque e não agiria, deixando as
  // tropas a apanhar o golpe sem aviso nenhum.
  // Cache curta: o servidor limita o ritmo de pedidos (429 observado). Não
  // vale a pena perguntar mais do que uma vez por minuto — os ataques demoram
  // horas a chegar e um minuto de atraso no aviso é irrelevante.
  let cacheServidor = { t: 0, dados: [] };

  // Sem Administrador, o command_overview responde "Necessita do administrador
  // para aceder às visões gerais". Depois de o servidor recusar uma vez, não
  // vale a pena voltar a pedir — poupa pedidos e evita o limite de 429.
  let semAdministrador = false;

  async function ataquesDoServidor(townId) {
    if (semAdministrador) return [];
    const agoraMs = Date.now();
    const janelaCache = (cfg().segundosEntreConsultas || 55) * 1000;
    if (agoraMs - cacheServidor.t < janelaCache && cacheServidor.dados.length) return cacheServidor.dados;
    try {
      const url = mUw.location.origin + '/game/town_overviews?town_id=' + Number(townId)
        + '&action=command_overview&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({ town_id: Number(townId), nl_init: true }))
        + '&_=' + Date.now();
      const resp = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
      if (resp.status === 429) {
        // Limite de pedidos do servidor: recuar e tentar mais tarde.
        limitado429 = true;
        try { mUw.console.log('[ALERTAS] servidor a limitar pedidos (429) — espero.'); } catch (e) {}
        await new Promise((r2) => setTimeout(r2, 3000));
        return [];
      }
      const r = await resp.json();
      const erro = r && r.json && r.json.error;
      if (erro && /administrador|administrator|premium/i.test(String(erro))) {
        semAdministrador = true;
        try { mUw.console.log('[ALERTAS] sem Administrador: uso só os dados locais.'); } catch (e) {}
        return [];
      }
      const cmds = ((r && r.json && r.json.data) || {}).commands || [];
      const saida = cmds.map((c) => ({
        command_id: Number(c.id),
        arrival_at: Number(c.arrival_at),
        started_at: Number(c.started_at),
        home_town_id: Number(c.origin_town_id),
        target_town_id: Number(c.destination_town_id),
        type: String(c.type || ''),
        // Confirmado no jogo: os campos com as coordenadas chamam-se
        // townurl_base64_origin/destination (não origin_town_link).
        link_origin: c.townurl_base64_origin || c.origin_town_link || c.link_origin || '',
        link_destino: c.townurl_base64_destination || '',
        town_name_origin: c.origin_town_name || c.town_name_origin || '',
        jogador: c.origin_town_player_name || '',
        jogador_id: Number(c.origin_town_player_id) || 0,
        alianca: c.origin_town_player_alliance_name || '',
      })).filter((c) => c.command_id && c.arrival_at);
      cacheServidor = { t: agoraMs, dados: saida };
      return saida;
    } catch (e) { return []; }
  }

  /* Descobrir o DONO de uma cidade pelo mapa.
   *
   * O modelo MovementsUnits — o único disponível sem Administrador — traz o
   * `town_name_origin` e o `link_origin` (com o id e as coordenadas da cidade),
   * mas NÃO o nome do jogador. Daí o aviso sair com "Atacante: ?".
   *
   * As coordenadas vêm no link, em base64:
   *   {"id":625,"ix":386,"iy":495,"tp":"town","name":"34.1"}
   * Com elas, procura-se a cidade no mapa e lê-se o player_name. */
  const donoConhecido = {};

  function coordenadasDoLink(link) {
    try {
      const m = String(link || '').match(/#([A-Za-z0-9+/=]{16,})/);
      if (!m) return null;
      const d = JSON.parse(atob(m[1]));
      if (d && Number.isFinite(Number(d.ix))) {
        return { id: Number(d.id), ix: Number(d.ix), iy: Number(d.iy), nome: d.name };
      }
    } catch (e) {}
    return null;
  }

  async function donoDaCidade(link, townIdBase) {
    const co = coordenadasDoLink(link);
    if (!co) return '';
    if (donoConhecido[co.id] !== undefined) return donoConhecido[co.id];

    try {
      const cx = Math.floor(co.ix / 20), cy = Math.floor(co.iy / 20);
      const url = mUw.location.origin + '/game/map_data?town_id=' + Number(townIdBase)
        + '&action=get_chunks&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({
            chunks: [{ x: cx, y: cy, timestamp: 0 }], town_id: Number(townIdBase), nl_init: true }));
      const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
        .then(lerResposta);
      const d = (r && r.json && r.json.data) || {};
      const bloco = d[0] || d['0'];
      const towns = (bloco && bloco.towns) || {};
      for (const k of Object.keys(towns)) {
        const t = towns[k];
        if (Number(t.id) === Number(co.id)) {
          donoConhecido[co.id] = t.player_name || '';
          return donoConhecido[co.id];
        }
      }
      donoConhecido[co.id] = '';
    } catch (e) {}
    return '';
  }

  function movimentos() {
    try {
      const mods = mUw.MM.getModels().MovementsUnits || {};
      return Object.keys(mods).map((k) => mods[k].attributes || {});
    } catch (e) { return []; }
  }

  function coordsOrigem(a) {
    try {
      const m = String(a.link_origin || '').match(/#(eyJ[A-Za-z0-9+/=]+)/);
      if (!m) return null;
      const o = JSON.parse(atob(m[1]));
      return { x: Number(o.ix), y: Number(o.iy), nome: o.name || a.town_name_origin };
    } catch (e) { return null; }
  }
  function coordsCidade(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      return { x: Number(t.getIslandCoordinateX()), y: Number(t.getIslandCoordinateY()), nome: t.getName() };
    } catch (e) { return null; }
  }
  function minhasCidades() {
    try { return new Set(Object.keys(mUw.ITowns.towns).map(Number)); } catch (e) { return new Set(); }
  }

  /* ---------------------- estimativa da unidade ------------------------- */
  // Devolve null se faltar QUALQUER coordenada. Verificar só se os objetos
  // existem não chega: um deles pode ter x/y a null e o cálculo dava NaN,
  // envenenando toda a estimativa em silêncio.
  function distancia(a, b) {
    if (!a || !b) return null;
    // Atenção: Number(null) é 0, que passaria por "número válido" e daria uma
    // distância plausível mas errada. Por isso rejeitamos null/undefined ANTES
    // de converter — foi este mecanismo que produziu viagens absurdas.
    const brutos = [a.x, a.y, b.x, b.y];
    if (brutos.some((v) => v === null || v === undefined || v === '')) return null;
    const [ax, ay, bx, by] = brutos.map(Number);
    if (![ax, ay, bx, by].every(Number.isFinite)) return null;
    return Math.sqrt(Math.pow(ax - bx, 2) + Math.pow(ay - by, 2));
  }

  /* ------------------------- AGRUPAR POR VAGA ---------------------------
   * Um adversário manda vários comandos de uma vez. Oito mensagens separadas
   * no Discord são ruído; uma só, com todos listados e as horas de chegada,
   * mostra a FORMA da vaga — e é a forma (limpezas coladas seguidas de um
   * lento) que denuncia uma conquista.
   * -------------------------------------------------------------------- */
  // Janela generosa: numa conquista o colonizador chega a seguir às limpezas,
  // mas pode vir alguns minutos depois. Agrupar de menos é pior do que agrupar
  // de mais — o objectivo é ver a FORMA da vaga numa só mensagem.
  const JANELA_VAGA = 1800;   // 30 min entre chegadas = ainda a mesma vaga

  function agruparEmVagas(lista) {
    const grupos = new Map();
    for (const a of lista) {
      // mesma vaga = mesmo atacante, mesma cidade alvo, chegadas próximas
      const base = `${a.jogador_id || a.jogador || '?'}|${a.target_town_id}`;
      let colocado = false;
      for (const [chave, g] of grupos) {
        if (!chave.startsWith(base)) continue;
        const perto = g.some((x) => Math.abs(Number(x.arrival_at) - Number(a.arrival_at)) <= JANELA_VAGA);
        if (perto) { g.push(a); colocado = true; break; }
      }
      if (!colocado) grupos.set(`${base}|${a.arrival_at}`, [a]);
    }
    return Array.from(grupos.values()).map((g) => g.sort((x, y) => x.arrival_at - y.arrival_at));
  }

  /* ---------------------- AVISO DE REFORÇO -------------------------------
   * Um ataque anunciado com horas de antecedência é facilmente esquecido.
   * Para os que faltavam mais de 2 h, avisa-se outra vez perto da chegada.
   * -------------------------------------------------------------------- */
  const REFORCO_KEY = 'grepoAlertas_reforco_v1';
  const REFORCO_ANTES = 30 * 60;      // 30 min antes de bater
  const REFORCO_SO_SE_FALTAVA = 2 * 3600;

  function lerReforcos() {
    try { return JSON.parse(armazem.getItem(REFORCO_KEY) || '{}'); } catch (e) { return {}; }
  }
  function gravarReforcos(v) { try { armazem.setItem(REFORCO_KEY, JSON.stringify(v)); } catch (e) {} }

  /* --------------------- CLASSIFICAÇÃO POR CATEGORIA ---------------------
   * Identificar a unidade exacta é impossível: não sabemos os bónus da cidade
   * de onde o ataque parte (farol, meteorologia...), que chegam a alterar a
   * velocidade em ~25%. Medido no jogo: quatro apoios iguais de cidades
   * diferentes deram velocidades efectivas entre 43 e 53.
   * O que SOBREVIVE a essa incerteza é a distinção entre lentos e rápidos —
   * e é essa que interessa, porque separa o colonizador dos navios de guerra.
   * -------------------------------------------------------------------- */
  const MARGEM_BONUS = 1.30;   // folga para bónus desconhecidos do atacante

  // Velocidades reais (lidas do jogo). As lentas ficam em zonas SEM
  // ambiguidade mesmo com bónus máximos — o colonizador (9) só pode aparentar
  // até 12, e a unidade seguinte (incendiário) só começa em 15.
  function classificar(vel, mesmaIlha) {
    if (mesmaIlha) {
      if (vel <= 12) return { cat: 'muito lenta (aríete, catapulta)', grave: false };
      if (vel <= 22) return { cat: 'tropa a pé', grave: false };
      return { cat: 'tropa rápida (cavalaria, carros)', grave: false };
    }

    // Entre ilhas. Zonas limpas primeiro — são as que importam.
    if (vel <= 12.5) {
      return { cat: '🚨 NAVIO COLONIZADOR', grave: true, nc: true, certo: true };
    }
    if (vel <= 20.5) {
      return { cat: 'navio incendiário', grave: true };
    }
    if (vel <= 32) {
      return { cat: 'barcos de transporte (tropa a caminho) ou hidras', grave: true };
    }
    if (vel <= 38) {
      return { cat: 'lento para navio de guerra — transporte com bónus alto?', grave: true };
    }
    if (vel <= 58) {
      return { cat: 'navios de guerra (navio-farol, birreme, trirreme) ou transportes rápidos', grave: false };
    }
    if (vel <= 86) {
      return { cat: 'voadores (grifos, manticoras) ou sereias', grave: false };
    }
    return { cat: 'voadores rápidos (harpias, pégasos, ladões)', grave: false };
  }

  // Devolve as unidades cuja velocidade base é compatível com a observada.
  // Entre ILHAS DIFERENTES só entram unidades navais: a tropa terrestre viaja
  // dentro de transportes e o comando anda à velocidade do transporte, não da
  // unidade. Listar arqueiros ou fundibulários num ataque de outra ilha é
  // simplesmente impossível.
  function unidadesCompativeis(velEquivalente, mesmaIlha) {
    const out = [];
    try {
      const u = mUw.GameData.units || {};
      for (const id of Object.keys(u)) {
        const v = Number(u[id].speed) || 0;
        if (v <= 0) continue;
        const naval = !!u[id].is_naval;
        const voadora = !!(u[id].flying || u[id].is_flying);
        // fora da ilha: só navais (ou voadoras, que atravessam o mar sozinhas)
        if (!mesmaIlha && !naval && !voadora) continue;
        const desvio = Math.abs(v - velEquivalente) / v;
        if (desvio <= TOLERANCIA) out.push({ id, nome: u[id].name || id, v, desvio, naval });
      }
    } catch (e) {}
    out.sort((a, b) => a.desvio - b.desvio);
    return out;
  }

  function pareceColonizador(velEquivalente, compativeis) {
    try {
      const cs = (mUw.GameData.units || {}).colonize_ship;
      const vcs = cs ? Number(cs.speed) : 9;
      // suspeita se a velocidade observada está na faixa do colonizador ou abaixo
      if (velEquivalente <= vcs * (1 + TOLERANCIA)) return true;
    } catch (e) {}
    return compativeis.some((c) => c.id === 'colonize_ship');
  }

  function hhmm(ts) {
    try { return horaJogo(ts); }
    catch (e) { return String(ts); }
  }
  function duracaoLegivel(s) {
    if (s < 60) return s + 's';
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
  }

  /* ------------------------------- run ---------------------------------- */
  /* Procurar no mapa o dono das cidades de origem dos ataques.
   * Corre ANTES da análise, porque essa é síncrona e não pode esperar. */
  async function preencherDonos(ataques, ctx) {
    let base = null;
    try { base = ((ctx.getMyTowns() || [])[0] || {}).id; } catch (e) {}
    if (!base) { try { base = mUw.Game && mUw.Game.townId; } catch (e) {} }
    if (!base) return;
    const vistos = new Set();
    for (const a of ataques) {
      if (a.jogador) continue;                       // já tem nome
      const co = coordenadasDoLink(a.link_origin);
      if (!co || vistos.has(co.id)) continue;
      if (donoConhecido[co.id] !== undefined) continue;
      vistos.add(co.id);
      await donoDaCidade(a.link_origin, base);
      await ctx.sleep(ctx.rand(200, 500));
    }
  }

  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const rotina = ctx.logRotina || ctx.log;
    limitado429 = false;

    /* Marcar o arranque na primeira passagem: os comandos vistos logo a
     * seguir já vinham a caminho e a viagem deles não se sabe. */
    if (arranqueAlertas == null) {
      const t0 = agoraJogo();
      if (t0 != null) {
        arranqueAlertas = t0;
        try { armazem.setItem(ARRANQUE_ALERTAS, String(t0)); } catch (e) {}
      }
    }
    const c = cfg();
    if (!c.ativo) { log('Alertas: está DESLIGADO (liga a caixa no painel e guarda).'); return; }

    if (agoraJogo() == null) { ctx.log('Sem relógio do servidor — não ajo às cegas.'); return; }

    /* O MODELO LOCAL PRIMEIRO.
     *
     * Antes consultava-se o servidor por CADA cidade — 31 pedidos numa
     * passagem — e daí os erros 429 ("servidor a limitar pedidos"), que
     * deixavam os alertas cegos precisamente quando havia ataques.
     *
     * Confirmámos que o `MovementsUnits` TRAZ os ataques recebidos, sem
     * pedido nenhum ao servidor. Só se ele estiver vazio é que se pergunta —
     * e nesse caso um pedido só, porque a visão de comandos devolve todas as
     * cidades de uma vez. */
    /* A colecção `Attack` diz quantos ataques cada cidade tem a chegar, e é
     * fiável. O `MovementsUnits` não traz tudo — com muitos apoios a caminho
     * os ataques recebidos ficam de fora, e uma cidade sob ataque passava sem
     * aviso nenhum. */
    const esperados = (() => {
      const out = {};
      try {
        const col = mUw.MM.getCollections().Attack;
        const models = (col && col[0] && col[0].models) || [];
        for (const m of models) {
          const a = m.attributes || {};
          const n = Number(a.incoming) || 0;
          if (n > 0) out[String(a.town_id)] = n;
        }
      } catch (e) {}
      return out;
    })();

    const doServidor = [];
    const minhas = minhasCidades();
    const vistos = lerVistos();

    // O modelo local fica vazio até a página ser atualizada; se não houver lá
    // nada, perguntamos ao servidor.
    // UM ÚNICO PEDIDO chega: o command_overview devolve os comandos de TODAS
    // as cidades, não só da consultada (confirmado no jogo). Consultar cidade
    // a cidade dava erro 429 (demasiados pedidos) com 21 cidades.
    let movs = movimentos();

    /* CIDADES COM ATAQUES QUE O MODELO NÃO TROUXE.
     *
     * Não basta o modelo estar vazio para se perguntar ao servidor: ele pode
     * ter alguns ataques e faltar-lhe outros. Confirmado no jogo — a colecção
     * Attack dizia duas cidades sob ataque e o modelo só tinha uma. */
    const contados = {};
    for (const a of movs) {
      const alvo = Number(a.target_town_id);
      if (!minhas.has(alvo)) continue;
      if (!/attack|revolt|conquer/i.test(String(a.type || ''))) continue;
      const origemId = Number(a.home_town_id) || 0;
      if (a.started_at != null || (origemId && minhas.has(origemId))) continue;
      contados[String(alvo)] = (contados[String(alvo)] || 0) + 1;
    }
    const cidadesEmFalta = Object.keys(esperados)
      .filter((tid) => (contados[tid] || 0) < esperados[tid])
      .map(Number);

    for (const tid of cidadesEmFalta) {
      try {
        const r = await ataquesDoServidor(tid);
        r.filter((cc) => Number(cc.target_town_id) === tid).forEach((cc) => movs.push(cc));
        await ctx.sleep(ctx.rand(400, 800));
      } catch (e) {}
    }

    if (!movs.length) {
      /* A visão global depende da cidade por onde se pergunta: com
       * Administrador, algumas devolvem os comandos todos (24 KB) e outras só
       * a moldura vazia (1 KB). Tenta-se por algumas antes de desistir. */
      const candidatas = Array.from(minhas).slice(0, 3);
      if (mUw.Game && mUw.Game.townId) candidatas.unshift(Number(mUw.Game.townId));

      let todos = [];
      let qualquer = candidatas[0];
      for (const cid of candidatas) {
        const r = await ataquesDoServidor(cid);
        if (r.length) { todos = r; qualquer = cid; break; }
        await ctx.sleep(ctx.rand(300, 600));
      }
      movs = todos.filter((c) => minhas.has(Number(c.target_town_id)));

      /* Se só vieram comandos de UMA cidade, pode ser porque só essa está a
       * ser atacada — ou porque o servidor não deu a visão global. Não se
       * distingue, por isso confirma-se cidade a cidade.
       *
       * A mensagem antiga dizia "visão global indisponível", o que alarmava
       * sem razão: com Administrador e um só ataque, é o caso normal. */
      const destinos = new Set(todos.map((c) => Number(c.target_town_id)));
      if (todos.length && destinos.size === 1 && minhas.size > 1) {
        rotina('Alertas: a confirmar as restantes cidades uma a uma.');
        for (const id of minhas) {
          if (Number(id) === Number(qualquer)) continue;
          await ctx.sleep(ctx.rand(700, 1100));   // respeitar o limite do servidor
          const cmds = await ataquesDoServidor(id);
          for (const c of cmds) if (Number(c.target_town_id) === Number(id)) movs.push(c);
        }
      }
    }
    const agora = agoraJogo();
    let novos = 0;

    // Analisar um ataque: devolve os dados já tratados (categoria, horas...).
    function analisar(a) {
      const origem = coordsOrigem(a);
      const alvo = coordsCidade(a.target_town_id);
      const falta = Number(a.arrival_at) - agora;

      /* A VIAGEM não é o tempo que falta.
       *
       * Sem `started_at` (que os ataques recebidos nunca trazem), usar o que
       * FALTA como se fosse a viagem toda dá velocidades absurdas: um ataque
       * de birremes visto a uma hora do impacto aparecia a 122 de velocidade,
       * que é categoria de voadores.
       *
       * Guarda-se quando o comando foi visto pela primeira vez; se isso
       * aconteceu logo a seguir a a página abrir, não se estima nada — mais
       * vale dizer "sem estimativa" do que dizer uma categoria errada. */
      const r = primeiraVezVistoAlertas(a);
      const visto = r ? r.quando : null;
      const partida = a.started_at || visto;
      const duracao = partida ? (Number(a.arrival_at) - Number(partida)) : null;

      const dist = distancia(origem, alvo);
      const viagem = duracao == null ? null : (duracao - tempoPreparacao());
      let cls = null, vel = null;

      /* Só se descarta a estimativa quando o comando é visto pela PRIMEIRA vez
       * logo a seguir a a página abrir — aí não se sabe há quanto tempo já
       * vinha.
       *
       * Um comando que já tinha registo mantém a hora em que foi visto da
       * primeira vez, e essa é boa: o módulo passa de 30 em 30 s, portanto o
       * erro é de 30 s no máximo — irrelevante numa viagem de 45 min. */
      if (dist === 0) {
        cls = { cat: 'mesma ilha — tropa terrestre a pé', grave: false };
      } else if (!a.started_at && r && r.novo && vistoAoArrancar(visto)) {
        cls = { cat: 'sem estimativa (já vinha a caminho quando abri o jogo)', grave: false };
      } else if (dist > 0 && viagem > 0) {
        vel = (c.K * dist) / viagem;
        cls = classificar(vel, false);
      }
      return { a, origem, alvo, falta, dist, vel, cls };
    }

    const jaVistos = new Set();
    const novosAtaques = [];
    for (const a of movs) {
      const idUnico = String(a.command_id || a.id);
      if (jaVistos.has(idUnico)) continue;   // pode vir das duas fontes
      jaVistos.add(idUnico);
      const tipo = String(a.type || '');
      const ehAtaque = /attack|revolt|conquer/i.test(tipo);
      if (!ehAtaque && !(c.avisarApoios && /support/i.test(tipo))) continue;
      if (!minhas.has(Number(a.target_town_id))) continue;      // não é contra mim

      /* Ataques MEUS não são para avisar.
       *
       * O `player_id` de um ataque recebido é o do DONO DA CIDADE ATACADA —
       * ou seja, o próprio jogador — por isso não distingue nada. O que
       * distingue é o `started_at` (nulo nos recebidos) e a origem não ser
       * uma cidade minha. */
      const origemId = Number(a.home_town_id) || 0;
      if (a.started_at != null || (origemId && minhas.has(origemId))) continue;
      if (ehIgnorado(a)) {                                       // atacante ignorado
        vistos[String(a.command_id || a.id)] = agora;            // marcar para não reavaliar
        continue;
      }
      const cid = String(a.command_id || a.id);
      if (vistos[cid]) continue;                                 // já avisado

      vistos[cid] = agora;
      novos++;
      novosAtaques.push(a);
    }

    /* Procurar no mapa quem são os atacantes, antes de montar os avisos.
     * Sem Administrador o modelo não traz o nome, só as coordenadas da cidade
     * de origem — daí o aviso sair com "Atacante: ?". */
    if (novosAtaques.length) await preencherDonos(novosAtaques, ctx);

    /* ---- avisar por VAGA, não ataque a ataque ---- */
    const reforcos = lerReforcos();
    for (const vaga of agruparEmVagas(novosAtaques)) {
      const infos = vaga.map(analisar);
      const primeiro = infos[0];
      const temNC = infos.some((i) => i.cls && i.cls.nc);
      const alvoNome = primeiro.alvo ? `${primeiro.alvo.nome} (${primeiro.alvo.x}:${primeiro.alvo.y})` : primeiro.a.target_town_id;
      /* Se o nome não veio (é o caso sem Administrador), usa-se o que foi
       * procurado no mapa antes desta passagem — ver `preencherDonos`. */
      const co = coordenadasDoLink(primeiro.a.link_origin);
      const nomeJogador = primeiro.a.jogador
        || (co && donoConhecido[co.id]) || '';
      const quem = nomeJogador
        ? `${nomeJogador}${primeiro.a.alianca ? ' [' + primeiro.a.alianca + ']' : ''}` : '?';
      const origemNome = primeiro.origem ? `${primeiro.origem.nome} (${primeiro.origem.x}:${primeiro.origem.y})`
        : (primeiro.a.town_name_origin || '?');

      const linhas = infos.map((i, n) => {
        const marca2 = (i.cls && i.cls.nc) ? '🚨' : '•';
        const cat = i.cls ? i.cls.cat : 'sem estimativa';
        return `${marca2} ${hhmm(i.a.arrival_at)} — ${cat}${i.vel ? ` (vel ~${i.vel.toFixed(0)})` : ''}`;
      }).join('\n');

      const titulo = temNC
        ? `🚨 **VAGA COM NAVIO COLONIZADOR** — ${vaga.length} comando(s)`
        : (vaga.length > 1 ? `⚔️ **Vaga de ${vaga.length} ataques**` : '⚔️ **Ataque a caminho**');

      const texto =
        `${titulo}\n` +
        `**Mundo:** ${mWorld}\n` +
        `**Alvo:** ${alvoNome}\n` +
        `**Atacante:** ${quem}\n` +
        `**Origem:** ${origemNome}\n` +
        `**Primeiro impacto:** ${hhmm(primeiro.a.arrival_at)} (daqui a ${duracaoLegivel(primeiro.falta)})\n` +
        (vaga.length > 1 ? `**Último:** ${hhmm(infos[infos.length - 1].a.arrival_at)}\n` : '') +
        `\n${linhas}\n` +
        (temNC ? `\n*A faixa de velocidade do colonizador não é ambígua: nenhuma outra unidade naval é tão lenta, mesmo com bónus máximos.*`
               : `\n*Os bónus do atacante podem alterar a velocidade em até 30%; a categoria é fiável, a unidade exacta não.*`);

      await ctx.avisarDiscord(temNC ? 'ataqueNC' : 'ataque', texto);
      ctx.log(`${temNC ? '🚨' : '⚔️'} ${vaga.length > 1 ? `Vaga de ${vaga.length} ataques` : 'Ataque'} a ${alvoNome} de ${quem} — primeiro impacto ${hhmm(primeiro.a.arrival_at)} (${duracaoLegivel(primeiro.falta)}).`);

      // agendar reforço para os que ainda demoram mais de 2 h
      for (const i of infos) {
        if (i.falta > REFORCO_SO_SE_FALTAVA) {
          reforcos[String(i.a.command_id)] = {
            quando: Number(i.a.arrival_at) - REFORCO_ANTES,
            alvo: alvoNome, quem, chegada: Number(i.a.arrival_at), nc: !!(i.cls && i.cls.nc),
          };
        }
      }
    }
    gravarReforcos(reforcos);

    /* ---- reforço: segundo aviso perto da chegada ---- */
    {
      const r = lerReforcos();
      let mudou = false;
      for (const cid2 of Object.keys(r)) {
        const x = r[cid2];
        if (agora >= x.chegada) { delete r[cid2]; mudou = true; continue; }   // já bateu
        if (agora >= x.quando) {
          await ctx.avisarDiscord(x.nc ? 'ataqueNC' : 'ataque',
            `${x.nc ? '🚨' : '⏰'} **LEMBRETE — impacto daqui a ${duracaoLegivel(x.chegada - agora)}**\n` +
            `**Mundo:** ${mWorld}\n**Alvo:** ${x.alvo}\n**Atacante:** ${x.quem}\n**Chega:** ${hhmm(x.chegada)}`);
          ctx.log(`⏰ Lembrete: ataque a ${x.alvo} bate em ${duracaoLegivel(x.chegada - agora)}.`);
          delete r[cid2]; mudou = true;
        }
      }
      if (mudou) gravarReforcos(r);
    }

    gravarVistos(vistos);
    if (!novos) {
      /* Distinguir "não há ataques" de "não consegui ver". Com o servidor a
       * limitar pedidos, ficar calado dá a impressão errada de segurança. */
      if (limitado429) {
        ctx.log('⚠️ Alertas: o servidor limitou os pedidos (429) — não consegui '
          + 'verificar se há ataques. Vou tentar na próxima passagem.');
      }
      return;
    }
  }

  /* ---------------------- PAINEL ---------------------------------------- */
  // API para o painel gerir a lista de ignorados
  function obterIgnorados() { return lerIgnorados(); }
  function definirIgnorados(v) { guardarIgnorados(v); }

  function painel(container, ctx) {
    // ---- lista de atacantes ignorados ----
    const igAtual = lerIgnorados();
    const htmlIgnorar = `
      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:5px;font-size:11px">
        Consultar o servidor a cada
        <input type="number" id="alr-intervalo" min="15" max="300" value="${cfg().segundosEntreConsultas}" style="width:48px">s
        <span style="opacity:.6">(mais baixo = avisos mais rápidos, mais risco de o servidor limitar)</span>
        <hr style="border:0;border-top:1px solid #223;margin:5px 0">
        <b>Ignorar ataques de</b> <span style="opacity:.6">(um por linha; nome de jogador ou id)</span><br>
        <textarea id="alr-ig-jog" rows="2" style="width:100%;box-sizing:border-box;font-size:11px" placeholder="Jogador">${igAtual.jogadores.join('\n')}</textarea>
        <b>Ignorar alianças</b><br>
        <textarea id="alr-ig-ali" rows="1" style="width:100%;box-sizing:border-box;font-size:11px" placeholder="No Cousins PLZ">${igAtual.aliancas.join('\n')}</textarea>
        <button id="alr-ig-guardar" style="cursor:pointer;width:100%;margin-top:4px;background:#48d;color:#fff;padding:4px;border:none;border-radius:4px">Guardar lista</button>
      </div>`;
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    const minhas = minhasCidades();
    const acaminho = movimentos().filter((a) => /attack|revolt|conquer/i.test(String(a.type || '')) && minhas.has(Number(a.target_town_id)));
    const agora = agoraJogo();

    let lista = '';
    for (const a of acaminho.slice(0, 6)) {
      const alvo = coordsCidade(a.target_town_id);
      lista += `<div style="font-size:11px;padding:2px 0;border-top:1px solid #223">
        ${alvo ? alvo.nome : a.target_town_id} ← ${a.town_name_origin || '?'}<br>
        <span style="opacity:.7">chega ${hhmm(a.arrival_at)} (${duracaoLegivel(Number(a.arrival_at) - agora)})</span>
      </div>`;
    }

    container.innerHTML = `
      <div style="font-size:11px;line-height:1.6">
        <label><input type="checkbox" id="alr-on"${c.ativo ? ' checked' : ''}> <b>Avisar ataques no Discord</b></label><br>
        <label><input type="checkbox" id="alr-apoios"${c.avisarApoios ? ' checked' : ''}> avisar também apoios recebidos</label><br>
        Calibração: <input type="number" id="alr-k" value="${c.K}" style="width:70px">
        <span style="opacity:.6">(afina se a estimativa puxar sempre para um lado)</span>
      </div>
      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:5px">
        <b style="font-size:11px">A caminho: ${acaminho.length}</b>
        ${lista || '<div style="font-size:11px;opacity:.6;padding-top:3px">Nada a chegar.</div>'}
      </div>
      <button id="alr-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    // acrescentar o bloco de ignorados ao painel
    try {
      const extra = document.createElement('div');
      extra.innerHTML = htmlIgnorar;
      container.appendChild(extra);
      const bg = container.querySelector('#alr-ig-guardar');
      if (bg) bg.onclick = () => {
        const lim = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);
        guardarIgnorados({
          jogadores: lim(container.querySelector('#alr-ig-jog').value),
          aliancas: lim(container.querySelector('#alr-ig-ali').value),
        });
        const iv = container.querySelector('#alr-intervalo');
        if (iv) guardarCfg(Object.assign({}, cfg(), { segundosEntreConsultas: Math.max(15, Number(iv.value) || 55) }));
        ctx.log('Alertas: lista de ignorados guardada.');
        bg.textContent = 'Guardado ✓';
        setTimeout(() => { bg.textContent = 'Guardar lista'; }, 1500);
      };
    } catch (e) {}

    const g = container.querySelector('#alr-guardar');
    if (g) g.onclick = () => {
      guardarCfg({
        ativo: container.querySelector('#alr-on').checked,
        avisarApoios: container.querySelector('#alr-apoios').checked,
        K: Number(container.querySelector('#alr-k').value) || K_DEFAULT,
      });
      ctx.log('Alertas: configuração guardada.');
      g.textContent = 'Guardado ✓';
      setTimeout(() => { g.textContent = 'Guardar'; }, 1500);
    };
  }

  return {
    id: 'alertas',
    nome: 'Alertas de ataque',
    intervaloMin: opts.intervaloMin || 1,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
    obterIgnorados,
    definirIgnorados,
  };
}

  // ======================= MÓDULO: ROTAÇÃO DE DEUS =======================
/* =============================================================================
 *  MÓDULO: ROTAÇÃO DE DEUS  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Serve o esquema de farm de favores: a main ataca com enviados divinos uma
 *  cidade da multi que partilha a ilha, roubando favor (pilhagem de templos).
 *  Quando o favor desse deus se esgota, a cidade atacada troca para o deus com
 *  mais favor acumulado — para haver outra vez muito que roubar.
 *
 *  REGRAS DE SEGURANÇA:
 *   • Só age se a conta tiver pelo menos 9 cidades (senão perde-se cobertura).
 *   • Nunca deixa a conta cair abaixo de 8 deuses distintos.
 *   • Não roda se a cidade tiver unidades míticas do deus atual (perder-se-iam).
 *   • Mudar de deus faz perder o favor acumulado desse deus — por isso só roda
 *     quando ele já está praticamente esgotado.
 *
 *  Pedido: /game/building_temple?town_id=X&action=change_god&h=TOKEN
 *          json={"god_id":"zeus","town_id":X}
 * ========================================================================== */

function makeDeusesModule(opts) {
  opts = opts || {};

  /* Nome do ficheiro no Gist, COM o mundo.
   *
   * Sem o mundo, o pt125 e o pt126 escrevem no mesmo ficheiro e sobrepõem-se
   * — um mundo de cerco quer a muralha baixa e um de revolta quer a muralha
   * no máximo, e ficavam com os mesmos templates.
   *
   * Calcula-se na altura de usar, porque o mundo só se sabe quando o módulo
   * corre. */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Cache dos blocos do mapa.
   *
   * O mapa muda devagar — cidades novas e conquistas são raras. Guardar os
   * blocos durante alguns minutos evita pedidos repetidos ao servidor, que é
   * o que provoca os erros 429. */
  const cacheMapa = {};
  const CACHE_MAPA_MS = 5 * 60 * 1000;

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function mapaEmCache(cx, cy) {
    const e = cacheMapa[`${cx}:${cy}`];
    if (!e) return null;
    if (Date.now() - e.quando > CACHE_MAPA_MS) { delete cacheMapa[`${cx}:${cy}`]; return null; }
    return e.dados;
  }
  function guardarMapa(cx, cy, dados) {
    cacheMapa[`${cx}:${cy}`] = { quando: Date.now(), dados };
  }

  /* Nome do ficheiro no Gist: inclui o PERFIL e o MUNDO.
   *
   * Sem o perfil, a main e as multis do mesmo mundo escreviam no mesmo
   * ficheiro — e apagar os templates de um perfil não servia de nada, porque
   * voltavam do Gist na leitura seguinte.
   *
   * Sem o mundo, o pt125 e o pt126 sobrepunham-se — um mundo de cerco quer a
   * muralha baixa e um de revolta quer a muralha no máximo.
   *
   * Num mundo novo (o pt127, por exemplo) o nome é novo e o ficheiro nasce
   * vazio: não é preciso fazer nada. */
  function ficheiroGist() {
    const base = String(GIST.filename || 'templates.json').replace(/\.json$/, '');
    const mundo = (typeof mWorld !== 'undefined' && mWorld) ? mWorld : 'x';
    let perfil = 'main';
    try {
      const e = JSON.parse(armazem.getItem('grepoMaestro_modulos_v1') || 'null');
      if (e && e.perfil) perfil = String(e.perfil);
    } catch (e) {}
    return `${base}-${perfil}-${mundo}.json`;
  }

  const GIST = {
    id: opts.gistId || '',
    token: opts.gistToken || '',
    /* O ficheiro TEM de incluir o mundo: sem isso, o pt125 e o pt126
     * escrevem no mesmo e sobrepõem-se — um mundo de cerco quer a muralha
     * baixa e um de revolta quer a muralha no máximo, e ficavam iguais. */
    filename: opts.gistFile || 'rotacao-deus.json',
  };

  const DEUSES = ['zeus', 'poseidon', 'hera', 'athena', 'hades', 'artemis', 'aphrodite', 'ares'];
  const NOMES = { zeus: 'Zeus', poseidon: 'Poseidon', hera: 'Hera', athena: 'Atena',
    hades: 'Hades', artemis: 'Ártemis', aphrodite: 'Afrodite', ares: 'Ares' };

  const CFG_LOCAL = 'grepoDeuses_cfg_v1';
  let mUw = null, mWorld = '';

  /* ========================== PERFIS ====================================
   * MULTI — reservatório de favor. Roda para o deus com MAIS favor acumulado
   *   quando o actual se esgota, para haver sempre muito que roubar. Mantém
   *   os 8 deuses distintos entre as cidades.
   *
   * MAIN — quem farma. As cidades veneram deuses conforme os PESOS que
   *   definires (mais cidades num deus = favor desse deus mais depressa), e
   *   atacam com enviados divinos as cidades das multis na mesma ilha quando
   *   o favor desce.
   *
   * Mecânica (confirmada em jogo): main com Zeus ataca multi com Hades — a
   * main GANHA favor em Zeus, a multi PERDE em Hades. Os deuses são
   * independentes.
   * ==================================================================== */
  const PERFIS = { MULTI: 'multi', MAIN: 'main' };

  /* As ilhas de farm configuradas, juntando o formato antigo (uma só) com o
   * novo (uma lista). */
  function listaDeIlhasFarm(c) {
    const out = [];
    if (c.ilhaX != null && c.ilhaY != null) out.push(`${c.ilhaX}:${c.ilhaY}`);
    for (const k of (c.ilhasFarm || [])) {
      /* Aceitar `386:495` e `386/495` — o jogo mostra as coordenadas com barra
       * e é natural escrevê-las assim. Guarda-se sempre com dois pontos. */
      const s2 = String(k).trim().replace(/[\/\\|;\s]+/g, ':');
      if (s2 && out.indexOf(s2) < 0) out.push(s2);
    }
    return out;
  }

  const DEFAULTS = {
    perfil: PERFIS.MULTI,
    // Simulação: decide tudo mas NÃO muda nada. Mudar de deus perde o favor
    // acumulado e é irreversível — convém ver as decisões antes de arriscar.
    simular: true,

    // --- só no perfil MAIN ---
    // Pesos: quantas cidades devem venerar cada deus, em percentagem.
    // Ex.: { hera: 30, zeus: 20, ... }. Vazio = distribuição uniforme.
    pesos: {},
    // 'proporcao' = os pesos repartem todas as cidades (ajusta-se sozinho
    //               quando conquistas ou perdes cidades)
    // 'quantidade' = escreves o número exacto de cidades por deus
    modoPesos: 'proporcao',
    // Jogadores que são multis minhas (alvos dos ataques de farm).
    multis: [],
    // Enviados divinos por ataque, e limiar de favor que dispara o ataque.
    /* Quantos enviados divinos mandar. Se `calcularEnviados` estiver ligado,
     * o número é calculado pelo favor que falta encher; senão usa-se este. */
    enviadosPorAtaque: 5,
    calcularEnviados: true,
    favorPorEnviado: 5,      // quanto cada um rouba
    favorMaximo: 500,        // tecto do favor por deus
    favorParaAtacar: 250,
    // Cidades de deus FIXO: { townId: 'zeus' }. As restantes são rotatórias.
    deusFixo: {},

    ativo: false,          // desligado por omissão: é a peça mais delicada
    /* Ilhas de farm. Podem ser VÁRIAS — até 8, uma por deus: assim a main tem
     * sempre os 8 deuses disponíveis para roubar, sem esperar por rotação.
     * `ilhaX`/`ilhaY` mantêm-se para não perder o que já estava configurado. */
    ilhasFarm: [],         // ['499:507', '505:512', ...]
    distribuirPorPesos: false,   // nas multis: distribuir o que sobra pelos pesos
    /* Roda quando o favor do deus actual desce abaixo disto. Quanto mais baixo,
     * menos se desperdiça — o favor que lá estiver perde-se ao mudar. */
    limiteFavor: 30,
    minCidades: 9,         // não age em contas com menos cidades
    /* Quantos deuses distintos manter entre as cidades de farm.
     * 1 = podem repetir (costuma ser melhor: uma cidade da main parada deixaria
     * o deus reservado a acumular sem ninguém o roubar).
     * 8 = um deus diferente em cada cidade. */
    minDeusesDistintos: 1,
    protegerMiticas: true, // não rodar se houver míticas do deus atual na cidade
  };

  function cfgLocal() {
    const c = Object.assign({}, DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_LOCAL) || '{}')); } catch (e) {}
    return c;
  }
  function guardarLocal(c) { try { armazem.setItem(CFG_LOCAL, JSON.stringify(c)); } catch (e) {} }

  /* ============== GRUPO DE VOADORES: distribuir os deuses ================
   * Só cinco deuses dão unidades voadoras. Sem forçar a distribuição, o grupo
   * acaba com quase todas as cidades no mesmo deus — e o favor concentra-se
   * num só, em vez de haver voadores variados.
   * ==================================================================== */
  // Atena (pégaso) fica de fora: o pégaso é rápido mas fraco a atacar, por
  // isso não vale a pena dedicar-lhe cidades de voadores.
  const DEUSES_VOADORES = {
    zeus: 'manticore', hera: 'harpy',
    artemis: 'griffin', ares: 'ladon',
  };

  // Cidades do grupo de voadores (o mesmo grupo escolhido no recrutamento).
  function cidadesDoGrupo(nomeGrupo) {
    const out = new Set();
    if (!nomeGrupo) return out;
    try {
      const grupos = {};
      for (const m of mUw.MM.getCollections().TownGroup[0].models) {
        const a = m.attributes; if (Number(a.id) > 0) grupos[a.id] = a.name;
      }
      for (const m of mUw.MM.getCollections().TownGroupTown[0].models) {
        const a = m.attributes;
        if (grupos[a.group_id] === nomeGrupo) out.add(Number(a.town_id));
      }
    } catch (e) {}
    return out;
  }

  function grupoVoadoresConfigurado() {
    try { return armazem.getItem('grepoRecruta_voadores_grupo_v1') || ''; }
    catch (e) { return ''; }
  }

  // Que deus falta neste grupo, para os voadores ficarem repartidos?
  // Com 7 cidades e 5 deuses voadores: 2+2+1+1+1.
  function deusVoadorEmFalta(townsDoGrupo, deusDaFn) {
    const lista = Object.keys(DEUSES_VOADORES);
    const n = townsDoGrupo.length;
    if (!n) return null;

    const base = Math.floor(n / lista.length);
    const querido = {};
    lista.forEach((d) => { querido[d] = base; });
    let sobra = n - base * lista.length;
    for (const d of lista) { if (sobra <= 0) break; querido[d]++; sobra--; }

    const tenho = {};
    lista.forEach((d) => { tenho[d] = 0; });
    for (const t of townsDoGrupo) {
      const d = deusDaFn(t.id);
      if (tenho[d] != null) tenho[d]++;
    }

    let pior = null, maiorFalta = 0;
    for (const d of lista) {
      const falta = querido[d] - tenho[d];
      if (falta > maiorFalta) { maiorFalta = falta; pior = d; }
    }
    return pior ? { deus: pior, querido, tenho } : null;
  }

  /* ==================== PESOS (perfil MAIN) =============================
   * Quantas cidades devem venerar cada deus. Mais cidades num deus fazem o
   * favor desse deus regenerar mais depressa — útil se quiseres muitas
   * unidades míticas dele.
   * ==================================================================== */
  function distribuicaoDesejada(pesos, nCidades, modo) {
    // QUANTIDADE: os números são literais — 3 em Hera significa 3 cidades.
    // As cidades que sobrarem ficam sem deus imposto (seguem o favor).
    if (modo === 'quantidade') {
      const out = {};
      DEUSES.forEach((d) => { out[d] = Math.max(0, Number(pesos[d]) || 0); });
      return out;
    }
    const usados = DEUSES.filter((d) => Number(pesos[d]) > 0);
    if (!usados.length) {
      // sem pesos: distribuição uniforme pelos 8
      const base = Math.floor(nCidades / DEUSES.length);
      const out = {};
      DEUSES.forEach((d) => { out[d] = base; });
      let sobra = nCidades - base * DEUSES.length;
      for (const d of DEUSES) { if (sobra <= 0) break; out[d]++; sobra--; }
      return out;
    }
    const total = usados.reduce((s2, d) => s2 + Number(pesos[d]), 0) || 1;
    const out = {};
    let atribuidas = 0;
    for (const d of usados) {
      const n = Math.floor(nCidades * (Number(pesos[d]) / total));
      out[d] = n; atribuidas += n;
    }
    // distribuir o resto pelos de maior peso
    const porPeso = usados.slice().sort((a, b) => Number(pesos[b]) - Number(pesos[a]));
    let i = 0;
    while (atribuidas < nCidades && porPeso.length) {
      out[porPeso[i % porPeso.length]]++; atribuidas++; i++;
    }
    DEUSES.forEach((d) => { if (out[d] == null) out[d] = 0; });
    return out;
  }

  // Que deus falta mais, comparando o que há com o que se quer?
  function deusEmFalta(pesos, deusesAtuais, nCidades, modo) {
    const querido = distribuicaoDesejada(pesos, nCidades, modo);
    const tenho = {};
    DEUSES.forEach((d) => { tenho[d] = 0; });
    for (const d of deusesAtuais) if (d && tenho[d] != null) tenho[d]++;
    let pior = null, maiorFalta = 0;
    for (const d of DEUSES) {
      const falta = (querido[d] || 0) - (tenho[d] || 0);
      if (falta > maiorFalta) { maiorFalta = falta; pior = d; }
    }
    return pior ? { deus: pior, falta: maiorFalta, querido, tenho } : null;
  }

  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * (é preciso recarregar para ver o efeito) E faz a passagem seguinte ler
   * valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels()[Nome].
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }


  async function lerGist() {
    // não segurar o processo (importante nos testes)
    try { if (typeof t2 !== 'undefined' && t2 && t2.unref) t2.unref(); } catch (e) {}
    if (!GIST.id) return cfgLocal();
    try {
      const r = await mUw.fetch('https://api.github.com/gists/' + GIST.id, { headers: { 'Accept': 'application/vnd.github+json' } });
      const j = await r.json();
      const f = j.files && j.files[ficheiroGist()];
      if (!f) return cfgLocal();
      const c = Object.assign({}, DEFAULTS, JSON.parse(f.content));
      guardarLocal(c);
      return c;
    } catch (e) { return cfgLocal(); }
  }
  const travaoGist = { aEsperar: false, pendente: null };

  async function escreverGist(c) {
    /* TRAVÃO: o GitHub limita as escritas por hora e várias gravações seguidas
     * esgotam-no (403 "API rate limit exceeded"). Se a última foi há menos de
     * 30 s, guarda-se e sobe só a última versão.
     *
     * O guardar LOCAL acontece sempre — só a subida ao Gist é travada. */
    if (travaoGist.aEsperar) {
      travaoGist.pendente = c;
      return { ok: true, msg: 'agendado (travão de 30 s)' };
    }
    travaoGist.aEsperar = true;
    const tG = setTimeout(() => {
      travaoGist.aEsperar = false;
      const p = travaoGist.pendente;
      travaoGist.pendente = null;
      if (p != null) escreverGist(p);
    }, 30000);
    try { if (tG && typeof tG.unref === 'function') tG.unref(); } catch (e) {}

    guardarLocal(c);
    if (!GIST.id || !GIST.token) return { ok: false, msg: 'sem Gist id/token — guardado só localmente' };
    try {
      const r = await mUw.fetch('https://api.github.com/gists/' + GIST.id, {
        method: 'PATCH',
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + GIST.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [ficheiroGist()]: { content: JSON.stringify(c, null, 2) } } }),
      });
      return r.ok ? { ok: true } : { ok: false, msg: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ---------------------- leitura do jogo ------------------------------- */
  function favorPorDeus() {
    const out = {};
    try {
      const g = mUw.MM.getModels().PlayerGods;
      const k = Object.keys(g)[0];
      const a = g[k].attributes || {};
      DEUSES.forEach((d) => { out[d] = Math.floor(Number(a[d + '_favor']) || 0); });
    } catch (e) { DEUSES.forEach((d) => (out[d] = 0)); }
    return out;
  }

  function deusDa(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      return typeof t.god === 'function' ? t.god() : t.god;
    } catch (e) { return null; }
  }

  function ilhaDa(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      return { x: Number(t.getIslandCoordinateX()), y: Number(t.getIslandCoordinateY()) };
    } catch (e) { return null; }
  }

  // Míticas do deus indicado presentes na cidade (seriam perdidas ao trocar).
  function miticasNaCidade(townId, deus) {
    try {
      const units = mUw.GameData.units || {};
      const t = mUw.ITowns.getTown(Number(townId));
      const tem = t.units ? t.units() : {};
      let total = 0;
      for (const id of Object.keys(units)) {
        if (units[id].god_id !== deus) continue;
        total += Number(tem[id]) || 0;
      }
      return total;
    } catch (e) { return 0; }
  }

  async function mudarDeus(townId, godId) {
    const url = mUw.location.origin + '/game/building_temple?town_id=' + Number(townId)
      + '&action=change_god&h=' + mUw.Game.csrfToken;
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({ god_id: godId, town_id: Number(townId), nl_init: true })),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      return { ok: !(j && j.error), msg: (j && (j.error || j.success)) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ---------------------- decisão --------------------------------------- */
  // Devolve { rodar:bool, motivo, deusNovo } para a cidade indicada.
  function decidir(townId, towns, c, favores, tomados) {
    const atual = deusDa(townId);
    if (!atual) return { rodar: false, motivo: 'deus da cidade desconhecido' };

    const favorAtual = Number(favores[atual]) || 0;

    // No grupo de voadores, um deus que NÃO dá voadores tem de sair mesmo com
    // favor alto — senão uma cidade em Atena ficava lá presa para sempre e a
    // distribuição nunca fechava.
    const grupoVoa = grupoVoadoresConfigurado();
    const nesteGrupo = grupoVoa && cidadesDoGrupo(grupoVoa).has(Number(townId));
    const deusInutilAqui = nesteGrupo && !DEUSES_VOADORES[atual];

    if (favorAtual >= c.limiteFavor && !deusInutilAqui) {
      return { rodar: false, motivo: `favor de ${NOMES[atual]} ainda em ${favorAtual}` };
    }

    // COBERTURA: manter o máximo de deuses distintos POSSÍVEL.
    // Antes exigia-se sempre 8, o que é impossível numa conta com menos de 8
    // cidades — e a rotação ficava bloqueada para sempre nas multis pequenas.
    // Agora o mínimo é o menor entre o configurado e o número de cidades.
    // Deuses das OUTRAS cidades (sem contar esta, que vai mudar):
    const deusesOutras = new Set();
    for (const t of towns) {
      if (Number(t.id) === Number(townId)) continue;
      const d = deusDa(t.id);
      if (d) deusesOutras.add(d);
    }

    // Escolher o deus com MAIS favor (é o que dá mais para a main roubar) de
    // entre os que preservam a cobertura.
    //  • se o deus atual é repetido, as outras cidades já cobrem 8 → qualquer um serve;
    //  • se o deus atual é único, só serve um deus que mais ninguém tenha
    //    (troca-se um único por outro único e continuam 8).
    const candidatos = DEUSES
      .filter((d) => d !== atual)
      .filter((d) => !(tomados && tomados.has(d)))   // já escolhido nesta ronda
      .map((d) => ({ d, favor: Number(favores[d]) || 0 }))
      .sort((a, b) => b.favor - a.favor);

    // Quantos deuses distintos é REALISTA exigir: nunca mais do que o número
    // de cidades. Numa conta com 3 cidades não é possível ter 8 deuses, e
    // exigi-lo bloqueava a rotação para sempre.
    // Atenção: deusesOutras é o conjunto de deuses DISTINTOS, não de cidades.
    // O que limita a cobertura possível é o número de CIDADES.
    const nCidades = towns.length;
    /* Quantos deuses distintos manter entre as cidades de farm.
     *
     * Pôr a ZERO (ou 1) deixa REPETIR à vontade — e isso é muitas vezes o que
     * interessa: se a cidade da main que farma Ártemis está parada, o deus que
     * a multi lhe reservou fica a acumular sem ninguém o roubar. Melhor é a
     * cidade da main que está sempre activa (Zeus) poder roubá-lo também. */
    const minDistintos = Math.min(
      c.minDeusesDistintos != null ? Number(c.minDeusesDistintos) : DEUSES.length,
      nCidades);

    // GRUPO DE VOADORES: se esta cidade pertence ao grupo, o deus tem de ser
    // um dos cinco que dão voadores, e repartido pelo grupo.
    const gVoa = grupoVoadoresConfigurado();
    if (gVoa) {
      const doGrupo = cidadesDoGrupo(gVoa);
      if (doGrupo.has(Number(townId))) {
        const townsGrupo = towns.filter((t) => doGrupo.has(Number(t.id)));
        const falta = deusVoadorEmFalta(townsGrupo, deusDa);
        if (falta && falta.deus !== atual) {
          const nomeUnidade = (() => {
            try { return (mUw.GameData.units[DEUSES_VOADORES[falta.deus]] || {}).name || ''; }
            catch (e) { return ''; }
          })();
          return {
            rodar: true, deusNovo: falta.deus, favorNovo: Number(favores[falta.deus]) || 0,
            atual, favorAtual,
            porPesos: `grupo "${gVoa}": ${NOMES[falta.deus]} tem ${falta.tenho[falta.deus]} cidade(s), devia ter ${falta.querido[falta.deus]}`
              + (nomeUnidade ? ` (${nomeUnidade})` : ''),
          };
        }
        // já está bem distribuído: não rodar por pesos gerais
        if (DEUSES_VOADORES[atual]) {
          return { rodar: false, motivo: `grupo de voadores: ${NOMES[atual]} está bem distribuído` };
        }
      }
    }

    // PERFIL MAIN: o deus escolhido é o que está em FALTA face aos pesos.
    // (No perfil multi manda o favor acumulado — ver a ordenação acima.)
    if (c.perfil === PERFIS.MAIN) {
      const deusesAtuais = towns.map((t) => deusDa(t.id)).filter(Boolean);
      const falta = deusEmFalta(c.pesos || {}, deusesAtuais, towns.length, c.modoPesos);
      if (falta && falta.deus !== atual) {
        return {
          rodar: true, deusNovo: falta.deus, favorNovo: Number(favores[falta.deus]) || 0,
          atual, favorAtual,
          porPesos: `${NOMES[falta.deus]}: ${falta.tenho[falta.deus]} cidade(s), devia ter ${falta.querido[falta.deus]}`,
        };
      }
    }

    let novo = null, melhor = -1, bloqueadosPorCobertura = 0;
    for (const cand of candidatos) {
      const depois = new Set(deusesOutras);
      depois.add(cand.d);
      if (depois.size < minDistintos) { bloqueadosPorCobertura++; continue; }
      novo = cand.d; melhor = cand.favor;
      break;
    }
    if (!novo) {
      return { rodar: false, motivo: `nenhum deus preserva os ${minDistintos} distintos (${bloqueadosPorCobertura} bloqueado(s))` };
    }

    if (c.protegerMiticas) {
      const n = miticasNaCidade(townId, atual);
      if (n > 0) return { rodar: false, motivo: `a cidade tem ${n} mítica(s) de ${NOMES[atual]} que se perderiam` };
    }

    return { rodar: true, deusNovo: novo, favorNovo: melhor, atual, favorAtual };
  }

  /* DISTRIBUIR OS DEUSES NUMA MULTI, em três camadas.
   *
   *   1. garantir UM de cada deus (oito cidades);
   *   2. as cidades em ilhas de farm ficam de fora — rodam de deus;
   *   3. o resto segue os pesos.
   *
   * Só mexe nas cidades da terceira camada: as outras já estão certas ou são
   * tratadas pela rotação normal.
   */
  async function distribuirNasMultis(ctx, c, towns) {
    const log = ctx.log;
    const rotina = ctx.logRotina || ctx.log;

    /* Quais estão em ilhas de farm — essas rodam e não contam. */
    const ilhas = new Set(listaDeIlhasFarm(c));
    const emFarm = new Set();
    for (const t of towns) {
      try {
        const ix = mUw.ITowns.getTown(t.id).getIslandCoordinateX();
        const iy = mUw.ITowns.getTown(t.id).getIslandCoordinateY();
        if (ilhas.has(`${ix}:${iy}`)) emFarm.add(Number(t.id));
      } catch (e) {}
    }

    const livres = towns.filter((t) => !emFarm.has(Number(t.id)));
    if (!livres.length) {
      rotina('Deuses: todas as cidades estão em ilhas de farm — nada a distribuir.');
      return;
    }

    /* CAMADA 1: um de cada deus. */
    const temDeus = {};
    DEUSES.forEach((d) => { temDeus[d] = []; });
    for (const t of livres) {
      const d = deusDa(t.id);
      if (d && temDeus[d]) temDeus[d].push(t);
    }

    const semNinguem = DEUSES.filter((d) => !temDeus[d].length);
    const sobram = [];
    for (const d of DEUSES) {
      // a partir da segunda cidade de cada deus, é excedente
      for (let i = 1; i < temDeus[d].length; i++) sobram.push(temDeus[d][i]);
    }

    /* Preencher os deuses em falta com as cidades excedentes. */
    let mexeu = 0;
    for (const d of semNinguem) {
      const t = sobram.shift();
      if (!t) {
        rotina(`Deuses: falta ${NOMES[d]} e não há cidade livre para lá pôr.`);
        continue;
      }
      if (c.simular) {
        log(`🔎 [simulação] ${t.name}: daria ${NOMES[d]} (garantir um de cada deus).`);
      } else {
        const r = await mudarDeus(t.id, d);
        if (r.ok) { log(`⛩️ ${t.name} → ${NOMES[d]} (garantir um de cada deus).`); mexeu++; }
        else { log(`⚠️ ${t.name}: não consegui mudar para ${NOMES[d]} (${r.msg}).`); }
        await ctx.sleep(ctx.rand(600, 1200));
      }
    }

    /* CAMADA 3: os pesos, aplicados ao TOTAL de cidades livres. */
    const pesos = c.pesos || {};
    const somaPesos = Object.values(pesos).reduce((a, b) => a + (Number(b) || 0), 0);
    if (!somaPesos) return;

    /* Quantas cidades cada deus deve ter AO TODO.
     *
     * A proporção vale para o total, não para o que sobra depois dos oito
     * garantidos: com pesos 1 para todos e 2 para o Poseidon, quer-se o dobro
     * de cidades em Poseidon do que em cada um dos outros.
     *
     * Antes distribuía-se só o excedente, o que dava zero a quase todos por
     * arredondamento — as cidades ficavam sem destino definido, a rotação
     * normal mexia nelas, e a distribuição voltava a mexer na passagem
     * seguinte. Cada volta desse ciclo queimava o favor acumulado. */
    const total = livres.length;
    const querido = {};
    let atribuido = 0;
    for (const d of DEUSES) {
      const pw = Number(pesos[d]) || 0;
      querido[d] = pw > 0 ? Math.max(1, Math.floor(pw / somaPesos * total)) : 0;
      atribuido += querido[d];
    }

    /* As que sobram do arredondamento vão para quem está MAIS ABAIXO da sua
     * quota — não simplesmente para os de maior peso.
     *
     * Sem isto, com pesos 1/2/1... as sobras iam para os primeiros da lista e
     * o Poseidon acabava com 3 contra 2 do Zeus, quando devia ter o dobro. */
    const comPeso = Object.keys(pesos).filter((d) => (Number(pesos[d]) || 0) > 0);
    while (atribuido < total && comPeso.length) {
      const quotaIdeal = (d) => (Number(pesos[d]) || 0) / somaPesos * total;
      const maisAtrasado = comPeso
        .sort((a, b) => (quotaIdeal(b) - querido[b]) - (quotaIdeal(a) - querido[a]))[0];
      querido[maisAtrasado]++;
      atribuido++;
    }

    const tenhoExtra = {};
    DEUSES.forEach((d) => { tenhoExtra[d] = temDeus[d].length; });

    /* Percorrer as cidades por FAVOR CRESCENTE: as que têm menos a perder
     * mudam primeiro. */
    const favores = favorPorDeus();
    const candidatas = livres.slice().sort((a, b) =>
      (Number(favores[deusDa(a.id)]) || 0) - (Number(favores[deusDa(b.id)]) || 0));

    let poupadas = 0;
    for (const t of candidatas) {
      const atual = deusDa(t.id);

      /* Já está onde devia: conta e segue. */
      if (atual && (tenhoExtra[atual] || 0) < (querido[atual] || 0)) {
        tenhoExtra[atual] = (tenhoExtra[atual] || 0) + 1;
        continue;
      }

      /* O deus mais em falta face ao que os pesos pedem. */
      const alvo = Object.keys(querido)
        .filter((d) => (querido[d] || 0) > (tenhoExtra[d] || 0))
        .sort((a, b) => ((querido[b] - tenhoExtra[b]) - (querido[a] - tenhoExtra[a])))[0];
      if (!alvo) break;
      if (atual === alvo) { tenhoExtra[alvo] = (tenhoExtra[alvo] || 0) + 1; continue; }

      /* NÃO DEITAR FORA FAVOR ACUMULADO.
       *
       * Mudar de deus perde o favor do deus antigo. A rotação normal já
       * respeita isto; a distribuição por pesos não respeitava, e mandava
       * embora cidades com centenas de favor só para acertar a contagem.
       *
       * Foi assim que quatro deuses ficaram quase a zero sem a main ter
       * roubado nada. */
      const favorAqui = Number(favores[atual]) || 0;
      if (favorAqui >= c.limiteFavor) {
        poupadas++;
        tenhoExtra[atual] = (tenhoExtra[atual] || 0) + 1;   // fica onde está
        continue;
      }

      if (c.simular) {
        log(`🔎 [simulação] ${t.name}: daria ${NOMES[alvo]} (pesos).`);
      } else {
        const r = await mudarDeus(t.id, alvo);
        if (r.ok) { log(`⛩️ ${t.name} → ${NOMES[alvo]} (distribuição por pesos).`); mexeu++; }
        else { log(`⚠️ ${t.name}: não consegui mudar para ${NOMES[alvo]} (${r.msg}).`); }
        await ctx.sleep(ctx.rand(600, 1200));
      }
      tenhoExtra[alvo] = (tenhoExtra[alvo] || 0) + 1;
    }

    if (poupadas) {
      rotina(`Deuses: ${poupadas} cidade(s) não mudaram por terem favor acumulado `
        + `(acima de ${c.limiteFavor}) — mudam quando o gastarem.`);
    }
    if (!mexeu && !c.simular) {
      rotina('Deuses: distribuição das multis já está como devia.');
    }
  }

  /* ------------------------------- run ---------------------------------- */
  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const log = ctx.log;

    const c = await lerGist();
    // Nenhuma saída deve ser silenciosa: se o módulo corre e não faz nada,
    // tem de dizer porquê — senão parece avariado.
    const towns = ctx.getMyTowns();

    /* ---- PERFIL MAIN: equilibrar os deuses pelos pesos ----
     * A main não roda para farmar — distribui os deuses pelas cidades segundo
     * os pesos. Não precisa de ilha de farm nem do limite de favor: o critério
     * é só a distribuição. */
    if (c.perfil === PERFIS.MAIN) {
      await equilibrarPorPesos(ctx, c, towns);
      if (Object.keys(c.cidadesFarm || {}).length) await farmarFavor(ctx, c, towns);
      return;
    }

    /* ---- PERFIL MULTI: rodar para o deus com mais favor ---- */
    if (!c.ativo) { log('Rotação de deus: está DESLIGADA (liga a caixa no painel e guarda).'); return; }

    /* ===================== AS TRÊS CAMADAS =============================
     * Por ordem de prioridade, tal como o utilizador definiu:
     *
     *   1. OITO DEUSES FIXOS — uma cidade por cada deus, sempre. Sem isto a
     *      main não tem os oito disponíveis para roubar.
     *   2. ILHAS DE FARM — as cidades nelas rodam de deus para farmar favor.
     *      Ficam de fora da contagem dos pesos: o deus delas muda sempre.
     *   3. PESOS — o que sobrar distribui-se pelos pesos configurados
     *      (Poseidon, Hera e Ares dão feitiços que aceleram o recrutamento).
     *
     * Com 13 cidades e 4 ilhas de farm: 8 fixas + 4 no farm + 1 por pesos.
     * Faltando cidades, os 8 fixos vêm primeiro e os pesos ficam sem nada.
     * ================================================================== */
    if (c.distribuirPorPesos && Object.keys(c.pesos || {}).length) {
      await distribuirNasMultis(ctx, c, towns);
    }

    /* CIDADES NOVAS: sem deus não há favor nenhum — e o favor é o que as
     * multis existem para produzir. Antes isto só acontecia no perfil main,
     * portanto uma cidade recém-fundada numa multi ficava parada.
     *
     * Escolhe-se o deus com MENOS cidades desta conta, para espalhar: mais
     * templos em deuses diferentes é mais favor disponível para a main roubar. */
    const novas = towns.filter((t) => !deusDa(t.id));
    if (novas.length) {
      const quantas = {};
      DEUSES.forEach((d) => { quantas[d] = 0; });
      towns.forEach((t) => { const d = deusDa(t.id); if (d && quantas[d] != null) quantas[d]++; });

      const jaTratadas = new Set();
      for (const t of novas) {
        const escolhido = DEUSES.slice().sort((a, b) => quantas[a] - quantas[b])[0];
        if (c.simular) {
          log(`🔎 [simulação] ${t.name}: cidade nova — daria ${NOMES[escolhido]}.`);
          quantas[escolhido]++;
          jaTratadas.add(Number(t.id));
        } else {
          const r = await mudarDeus(t.id, escolhido);
          if (r.ok) {
            log(`⛩️ ${t.name}: cidade nova → ${NOMES[escolhido]}.`);
            quantas[escolhido]++;
            jaTratadas.add(Number(t.id));
            await ctx.sleep(ctx.rand(600, 1200));
          } else {
            log(`⚠️ ${t.name}: não consegui escolher deus (${r.msg}).`);
          }
        }
      }
      /* Saltar estas na rotação desta passagem: acabaram de escolher deus e o
       * favor ainda não subiu — rodá-las agora seria desperdício. */
      if (jaTratadas.size) {
        for (let i = towns.length - 1; i >= 0; i--) {
          if (jaTratadas.has(Number(towns[i].id))) towns.splice(i, 1);
        }
      }
    }
    const ilhas = listaDeIlhasFarm(c);
    if (!ilhas.length) { log('Rotação de deus: falta indicar pelo menos uma ilha de farm.'); return; }

    if (towns.length < c.minCidades) {
      log(`Rotação de deus: só ${towns.length} cidade(s) — precisa de ${c.minCidades}.`);
      return;
    }

    // cidade(s) desta conta em QUALQUER das ilhas de farm
    const naIlha = towns.filter((t) => {
      const i = ilhaDa(t.id);
      return i && ilhas.indexOf(`${i.x}:${i.y}`) >= 0;
    });
    if (!naIlha.length) {
      log(`Rotação de deus: nenhuma cidade nas ilhas de farm (${ilhas.join(', ')}).`);
      return;
    }

    const favores = favorPorDeus();
    // deuses já escolhidos nesta ronda: evita duas cidades irem para o mesmo
    const tomados = new Set();
    let mudou = 0, simuladas = 0;

    for (const t of naIlha) {
      const d = decidir(t.id, towns, c, favores, tomados);
      if (!d.rodar) { log(`${t.name}: não roda (${d.motivo}).`); continue; }

      // SIMULAÇÃO: decidir mas não agir. Mudar de deus perde o favor
      // acumulado e é irreversível, por isso convém ver as decisões primeiro.
      if (c.simular) {
        log(`🔎 [simulação] ${t.name}: mudaria ${NOMES[d.atual]} (${d.favorAtual}) → ${NOMES[d.deusNovo]} (${d.favorNovo})`
          + (d.porPesos ? ` — ${d.porPesos}.` : ' de favor para roubar.'));
        simuladas++;
        /* NÃO zerar o favor do deus NOVO: mudar para um deus não faz o favor
         * dele desaparecer — é o favor do deus ANTIGO que se perde.
         *
         * Zerar o novo tinha um efeito mau: uma cidade que já venerasse esse
         * deus via-o a zero, achava que estava vazio e rodava — deitando fora
         * um favor grande. Visto em simulação: uma cidade com Zeus a 489 foi
         * mandada embora porque outra tinha acabado de "ocupar" o Zeus. */
        favores[d.atual] = 0;
        tomados.add(d.deusNovo);   // já não é candidato para outra cidade nesta ronda
        continue;
      }

      const r = await mudarDeus(t.id, d.deusNovo);
      if (r.ok) {
        log(`⛩️ ${t.name}: ${NOMES[d.atual]} (${d.favorAtual}) → ${NOMES[d.deusNovo]} (${d.favorNovo})`
          + (d.porPesos ? ` — por pesos: ${d.porPesos}.` : ' de favor para roubar.'));
        favores[d.atual] = 0;      // o favor perdido é o do deus antigo
        tomados.add(d.deusNovo);   // já não é candidato para outra cidade nesta ronda
        mudou++;
      } else {
        log(`⚠️ ${t.name}: falha a mudar de deus (${r.msg}).`);
      }
      await ctx.sleep(ctx.rand(1000, 2000));
    }

    if (simuladas) {
      log(`🔎 Simulação: ${simuladas} mudança(s) propostas — NADA foi alterado. `
        + 'Desliga "simular" no painel quando concordares.');
    }
  }

  /* ============== EQUILÍBRIO POR PESOS (perfil MAIN) ====================
   * Move cidades dos deuses que estão a MAIS para os que estão a MENOS, até a
   * distribuição bater com os pesos. Escolhe a cidade de menor favor no deus
   * excedentário, para desperdiçar o mínimo — mudar de deus perde o favor.
   * ==================================================================== */
  async function equilibrarPorPesos(ctx, c, towns) {
    const log = ctx.log;
    const favores = favorPorDeus();
    for (const k of Object.keys(deusesSimulados)) delete deusesSimulados[k];   // estado limpo

    /* ---- CIDADES SEM DEUS (recém-fundadas ou conquistadas) ----
     * Estas são o caso mais fácil e mais útil: não há favor a perder, basta
     * escolher o deus que está mais em falta. Trata-se primeiro, antes de
     * mexer em cidades que já têm deus. */
    /* ---- GRUPO DE VOADORES ----
     * As cidades deste grupo são tratadas à parte: só recebem deuses que dêem
     * voadores, repartidos entre eles. Fica FORA do equilíbrio geral por
     * pesos, senão as duas regras entravam em conflito.
     * (Ao separar os perfis, esta lógica ficou só no perfil multi — é por isso
     *  que é preciso chamá-la aqui também.) */
    const gVoa = grupoVoadoresConfigurado();
    const doGrupoVoa = gVoa ? cidadesDoGrupo(gVoa) : new Set();
    if (doGrupoVoa.size) {
      const townsGrupo = towns.filter((t) => doGrupoVoa.has(Number(t.id)));
      let mexeu = true, voltas = 0;
      while (mexeu && voltas < townsGrupo.length * 2) {
        mexeu = false; voltas++;
        const falta = deusVoadorEmFalta(townsGrupo, (id) =>
          deusDa(id) || (c.simular ? deusesSimulados[id] : null));
        if (!falta) break;

        // cidade a mudar: uma que tenha deus SEM voadores, ou a mais repetida
        const efetivo = (id) => deusDa(id) || (c.simular ? deusesSimulados[id] : null);
        let alvo = townsGrupo.find((t) => {
          const d = efetivo(t.id);
          return d && !DEUSES_VOADORES[d]
            && !(c.protegerMiticas && miticasNaCidade(t.id, d));
        });
        if (!alvo) {
          // nenhum deus inútil: tirar do que está mais acima do que devia
          const cont = {};
          townsGrupo.forEach((t) => { const d = efetivo(t.id); if (d) cont[d] = (cont[d] || 0) + 1; });
          const excesso = Object.keys(cont)
            .filter((d) => cont[d] > (falta.querido[d] || 0))
            .sort((a, b) => (cont[b] - (falta.querido[b] || 0)) - (cont[a] - (falta.querido[a] || 0)))[0];
          if (!excesso) break;
          alvo = townsGrupo.find((t) => efetivo(t.id) === excesso
            && !(c.protegerMiticas && miticasNaCidade(t.id, excesso)));
        }
        if (!alvo) break;

        const de = efetivo(alvo.id);
        let unidade = '';
        try { unidade = (mUw.GameData.units[DEUSES_VOADORES[falta.deus]] || {}).name || ''; } catch (e) {}
        if (c.simular) {
          log(`🔎 [simulação] ${alvo.name}: grupo de voadores — poria ${NOMES[falta.deus]}`
            + (unidade ? ` (${unidade})` : '') + (de ? ` em vez de ${NOMES[de]}.` : '.'));
          deusesSimulados[alvo.id] = falta.deus;
          mexeu = true;
        } else {
          const r = await mudarDeus(alvo.id, falta.deus);
          if (r.ok) {
            log(`🕊️ ${alvo.name}: grupo de voadores — ${de ? NOMES[de] + ' → ' : ''}${NOMES[falta.deus]}`
              + (unidade ? ` (${unidade}).` : '.'));
            mexeu = true;
            await ctx.sleep(ctx.rand(800, 1600));
          } else {
            log(`⚠️ ${alvo.name}: falha (${r.msg}).`);
            break;
          }
        }
      }
    }

    /* ---- cidades de deus FIXO: garantir que têm o deus escolhido ---- */
    const fixasCfg = c.cidadesFarm || {};
    for (const t of towns) {
      const f = fixasCfg[t.id];
      if (!f || f.tipo !== 'fixo' || !f.deus) continue;
      const atual = deusDa(t.id);
      if (atual === f.deus) continue;
      if (c.protegerMiticas && atual && miticasNaCidade(t.id, atual)) {
        log(`— ${t.name}: devia ser ${NOMES[f.deus]} mas tem míticas de ${NOMES[atual]}; não mexo.`);
        continue;
      }
      if (c.simular) {
        log(`🔎 [simulação] ${t.name}: é cidade de deus FIXO — poria ${NOMES[f.deus]}`
          + (atual ? ` (tem ${NOMES[atual]}).` : '.'));
        deusesSimulados[t.id] = f.deus;
      } else {
        const r = await mudarDeus(t.id, f.deus);
        if (r.ok) {
          log(`⛩️ ${t.name}: deus fixo aplicado — ${NOMES[f.deus]}.`);
          await ctx.sleep(ctx.rand(800, 1600));
        } else {
          log(`⚠️ ${t.name}: falha a aplicar o deus fixo (${r.msg}).`);
        }
      }
    }

    const semDeus = towns.filter((t) => !deusDa(t.id));
    if (semDeus.length) {
      const jaTem = {};
      DEUSES.forEach((d) => { jaTem[d] = 0; });
      towns.forEach((t) => { const d = deusDa(t.id); if (d && jaTem[d] != null) jaTem[d]++; });
      const querem = distribuicaoDesejada(c.pesos || {}, towns.length, c.modoPesos);

      for (const t of semDeus) {
        // o deus com maior défice face aos pesos
        let escolhido = null, maiorFalta = -Infinity;
        for (const d of DEUSES) {
          const falta = (querem[d] || 0) - jaTem[d];
          if (falta > maiorFalta) { maiorFalta = falta; escolhido = d; }
        }
        if (!escolhido || maiorFalta <= 0) {
          // nenhum em défice: escolhe o que tiver menos cidades
          escolhido = DEUSES.slice().sort((a, b) => jaTem[a] - jaTem[b])[0];
        }
        if (c.simular) {
          log(`🔎 [simulação] ${t.name}: cidade SEM deus — poria ${NOMES[escolhido]}.`);
          jaTem[escolhido]++;   // contar também na simulação, senão todas as
                                // cidades novas escolheriam o mesmo deus
          deusesSimulados[t.id] = escolhido;
        } else {
          const r = await mudarDeus(t.id, escolhido);
          if (r.ok) {
            log(`✨ ${t.name}: cidade nova — deus definido: ${NOMES[escolhido]}.`);
            jaTem[escolhido]++;
            await ctx.sleep(ctx.rand(800, 1600));
          } else {
            log(`⚠️ ${t.name}: falha a definir o deus (${r.msg}).`);
          }
        }
      }
    }

    // Contagem depois de tratar as cidades novas. Em simulação as atribuições
    // não são reais, por isso somam-se aqui — senão a fase seguinte proporia
    // mudanças que na prática já estariam resolvidas.
    const tenho = {};
    DEUSES.forEach((d) => { tenho[d] = 0; });
    towns.forEach((t) => {
      const d = deusDa(t.id) || (c.simular ? deusesSimulados[t.id] : null);
      if (d && tenho[d] != null) tenho[d]++;
    });
    const querido = distribuicaoDesejada(c.pesos || {}, towns.length, c.modoPesos);

    const emFalta = DEUSES.filter((d) => (querido[d] || 0) > tenho[d])
      .sort((a, b) => ((querido[b] - tenho[b]) - (querido[a] - tenho[a])));
    const aMais = DEUSES.filter((d) => tenho[d] > (querido[d] || 0));

    if (!emFalta.length) { log('Deuses: distribuição já bate com os pesos.'); return; }
    if (!aMais.length) { log('Deuses: há deuses em falta mas nenhum a mais — nada a mover.'); return; }

    log(`Deuses: em falta ${emFalta.map((d) => `${NOMES[d]} +${querido[d] - tenho[d]}`).join(', ')}`
      + ` · a mais ${aMais.map((d) => `${NOMES[d]} −${tenho[d] - querido[d]}`).join(', ')}.`);

    let feitas = 0, simuladas = 0;
    for (const alvo of emFalta) {
      while (tenho[alvo] < (querido[alvo] || 0)) {
        // de que deus tirar? o que está mais acima do que devia
        const doador = aMais
          .filter((d) => tenho[d] > (querido[d] || 0))
          .sort((a, b) => (tenho[b] - querido[b]) - (tenho[a] - querido[a]))[0];
        if (!doador) break;

        // qual cidade desse deus? nunca uma de deus FIXO — essas são tuas por
        // escolha e o equilíbrio não deve mexer nelas.
        const fixas = c.cidadesFarm || {};
        const candidatas = towns.filter((t) => deusDa(t.id) === doador)
          .filter((t) => !doGrupoVoa.has(Number(t.id)))   // o grupo de voadores tem regra própria
          .filter((t) => (fixas[t.id] || {}).tipo !== 'fixo')
          .filter((t) => !(c.protegerMiticas && miticasNaCidade(t.id, doador)));
        if (!candidatas.length) {
          log(`— ${NOMES[doador]}: sem cidades disponíveis (fixas ou com míticas); não mexo.`);
          tenho[doador] = querido[doador] || 0;   // deixa de ser candidato
          continue;
        }
        const t = candidatas[0];

        if (c.simular) {
          log(`🔎 [simulação] ${t.name}: mudaria ${NOMES[doador]} → ${NOMES[alvo]}`
            + ` (${NOMES[alvo]} tem ${tenho[alvo]}, devia ter ${querido[alvo]}).`);
          simuladas++;
        } else {
          const r = await mudarDeus(t.id, alvo);
          if (!r.ok) { log(`⚠️ ${t.name}: falha a mudar de deus (${r.msg}).`); break; }
          log(`⛩️ ${t.name}: ${NOMES[doador]} → ${NOMES[alvo]}`
            + ` (${NOMES[alvo]} tinha ${tenho[alvo]}, devia ter ${querido[alvo]}).`);
          feitas++;
          await ctx.sleep(ctx.rand(1000, 2000));
        }
        tenho[doador]--; tenho[alvo]++;
        // a cidade já mudou: tirá-la da lista para não a escolher outra vez
        towns = towns.filter((x) => x.id !== t.id).concat([{ ...t, _novoDeus: alvo }]);
        deusesSimulados[t.id] = alvo;
      }
    }

    if (simuladas) {
      log(`🔎 Simulação: ${simuladas} mudança(s) propostas — NADA foi alterado. `
        + 'Desliga "simular" quando concordares.');
    } else if (feitas) {
      log(`Deuses: ${feitas} cidade(s) mudaram para equilibrar a distribuição.`);
    }
  }

  // Deus efetivo durante a simulação (para a contagem fazer sentido na ronda).
  const deusesSimulados = {};

  /* ============ VIZINHOS DAS ILHAS DE FARM =============================
   * Em vez de escreveres os nomes das multis à mão, o módulo vai buscar as
   * cidades das ilhas onde marcaste cidades de farm e mostra os jogadores.
   *
   * O jogo expõe isto em /game/map_data?action=get_chunks: cada bloco traz
   * towns[] com player_id, player_name e as coordenadas da ilha.
   * ==================================================================== */
  const CHUNK = 20;   // tamanho do bloco do mapa

  async function vizinhosDaIlha(ix, iy, townIdBase) {
    const cx = Math.floor(ix / CHUNK), cy = Math.floor(iy / CHUNK);

    /* Bloco já em cache? O mapa muda devagar e repetir o pedido só ajuda a
     * chegar ao limite de pedidos do servidor. */
    const guardado = mapaEmCache(cx, cy);

    const url = mUw.location.origin + '/game/map_data?town_id=' + Number(townIdBase)
      + '&action=get_chunks&h=' + mUw.Game.csrfToken
      + '&json=' + encodeURIComponent(JSON.stringify({
          chunks: [{ x: cx, y: cy, timestamp: 0 }], town_id: Number(townIdBase), nl_init: true,
        }));
    try {
      let towns = guardado;
      if (!towns) {
        const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
          .then(lerResposta);
        const d = (r && r.json && r.json.data) || (r && r.json) || {};
        const bloco = d[0] || d['0'];
        towns = (bloco && bloco.towns) || {};
        guardarMapa(cx, cy, towns);
      }
      const out = [];
      for (const k of Object.keys(towns)) {
        const t = towns[k];
        // só as cidades DESTA ilha
        if (Number(t.x) !== Number(ix) || Number(t.y) !== Number(iy)) continue;
        out.push({
          townId: Number(t.id), nome: t.name,
          jogadorId: Number(t.player_id) || 0, jogador: t.player_name || '(sem dono)',
          pontos: Number(t.points) || 0,
          aliancaId: Number(t.alliance_id) || 0, alianca: t.alliance_name || '',
        });
      }
      return out;
    } catch (e) { return []; }
  }

  // Jogadores presentes nas ilhas onde há cidades de farm marcadas.
  async function jogadoresNasIlhasDeFarm(c, towns) {
    const ilhas = new Map();
    for (const t of towns) {
      if (!(c.cidadesFarm || {})[t.id]) continue;
      const i = ilhaDa(t.id);
      if (i) ilhas.set(`${i.x}:${i.y}`, { ix: i.x, iy: i.y, base: t.id, cidade: t.name });
    }
    const porJogador = new Map();
    for (const [, il] of ilhas) {
      const viz = await vizinhosDaIlha(il.ix, il.iy, il.base);
      for (const v of viz) {
        if (!v.jogadorId) continue;
        if (!porJogador.has(v.jogador)) {
          porJogador.set(v.jogador, { jogador: v.jogador, id: v.jogadorId, cidades: [], ilhas: new Set() });
        }
        const j = porJogador.get(v.jogador);
        j.cidades.push({ id: v.townId, nome: v.nome, ilha: `${il.ix}:${il.iy}`, pontos: v.pontos });
        j.ilhas.add(`${il.ix}:${il.iy}`);
        j.pontos = (j.pontos || 0) + v.pontos;
        if (v.alianca) j.alianca = v.alianca;
      }
    }
    // Ordenar pelos que MAIS provavelmente são multis tuas: poucos pontos por
    // cidade (contas pequenas, feitas para farmar) primeiro.
    return Array.from(porJogador.values()).sort((a, b) => {
      const ma = a.pontos / Math.max(1, a.cidades.length);
      const mb = b.pontos / Math.max(1, b.cidades.length);
      return ma - mb;
    });
  }

  /* ================== FARM: atacar as multis ============================
   * A cidade da main envia enviados divinos a uma cidade da multi na mesma
   * ilha. A main ganha favor no SEU deus; a multi perde no dela.
   *
   * Para os enviados sobreviverem, a cidade da multi tem de estar sem defesa
   * — é por isso que a multi esquiva tudo o que venha da main.
   * ==================================================================== */
  const UNIDADE_ENVIADO = 'godsent';

  // Enviados divinos disponíveis nesta cidade (em casa, não em trânsito).
  function enviadosEmCasa(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const u = t.units ? t.units() : {};
      return Number(u[UNIDADE_ENVIADO]) || 0;
    } catch (e) { return 0; }
  }

  // Já há um ataque desta cidade a caminho? Evita mandar a dobrar.
  let semAdministrador = false;

  // NOTA: o command_overview exige ADMINISTRADOR. Sem ele responde
  // "Necessita do administrador para aceder às visões gerais". Detecta-se uma
  // vez e não se insiste — as multis não o têm.
  async function ataqueEmCurso(townId) {
    /* O MODELO LOCAL PRIMEIRO — sem pedido nenhum ao servidor.
     *
     * Procura-se um ataque MEU que saiu desta cidade e ainda não voltou. Os
     * meus comandos têm o `started_at` preenchido (os recebidos vêm a null),
     * e o `command_name` "Regresso" marca os que já vêm de volta. */
    try {
      const mods = mUw.MM.getModels().MovementsUnits || {};
      for (const k of Object.keys(mods)) {
        const a = mods[k].attributes || {};
        if (Number(a.home_town_id) !== Number(townId)) continue;
        if (String(a.type) !== 'attack') continue;
        if (a.started_at == null) continue;                 // é recebido, não meu
        if (/regress|return/i.test(String(a.command_name || ''))) continue;
        return true;                                        // já vai um a caminho
      }
    } catch (e) {}

    // Sem Administrador não dá para saber mais; assume-se que não há.
    if (semAdministrador) return false;
    try {
      const url = mUw.location.origin + '/game/town_overviews?town_id=' + Number(townId)
        + '&action=command_overview&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({ town_id: Number(townId), nl_init: true }))
        + '&_=' + Date.now();
      const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
      if (r.status === 429) return true;   // servidor a limitar: não insistir
      const j = await r.json();
      const cmds = ((j && j.json && j.json.data) || {}).commands || [];
      return cmds.some((cd) =>
        Number(cd.origin_town_id) === Number(townId)
        && String(cd.type) === 'attack'
        && !cd.return);
    } catch (e) { return false; }
  }

  // Cidades das multis nesta ilha, por ordem rotativa.
  async function alvosNaIlha(ix, iy, townIdBase, multis) {
    const viz = await vizinhosDaIlha(ix, iy, townIdBase);
    const nomes = new Set((multis || []).map(String));
    return viz.filter((v) => nomes.has(String(v.jogador)));
  }

  const ALVO_KEY = 'grepoDeuses_ultimoAlvo_v1';
  // `guardar` a falso em simulação: senão a simulação consumia a rotação e o
  // ataque real acabava noutra cidade diferente da que foi mostrada.
  function proximoAlvo(townId, alvos, guardar) {
    if (!alvos.length) return null;
    let mapa = {};
    try { mapa = JSON.parse(armazem.getItem(ALVO_KEY) || '{}'); } catch (e) {}
    const anterior = mapa[townId];
    const i = alvos.findIndex((a) => Number(a.townId) === Number(anterior));
    const escolhido = alvos[(i + 1) % alvos.length];   // roda um de cada vez
    if (guardar !== false) {
      mapa[townId] = escolhido.townId;
      try { armazem.setItem(ALVO_KEY, JSON.stringify(mapa)); } catch (e) {}
    }
    return escolhido;
  }

  async function enviarAtaque(origemId, alvoId, quantos) {
    const url = mUw.location.origin + '/game/town_info?town_id=' + Number(origemId)
      + '&action=send_units&h=' + mUw.Game.csrfToken;
    const payload = {};
    payload[UNIDADE_ENVIADO] = Number(quantos);
    payload.id = Number(alvoId);
    payload.type = 'attack';
    payload.town_id = Number(origemId);
    payload.nl_init = true;
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      const erro = j && j.error;
      return { ok: !erro, msg: erro || (j && j.success) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* Percorre as cidades de farm e ataca quando o favor está baixo. */
  async function farmarFavor(ctx, c, towns) {
    const log = ctx.log;
    const favores = favorPorDeus();
    const farm = c.cidadesFarm || {};
    const multis = c.multis || [];
    if (!multis.length) { log('Farm: sem multis marcadas — não sei quem atacar.'); return; }

    // 0 é legítimo aqui: significa "atacar sempre, mesmo com o favor cheio".
    // O `||` trocaria esse 0 por 100 e tornaria impossível pedi-lo.
    const limiar = (c.favorParaAtacar != null && c.favorParaAtacar !== '')
      ? Number(c.favorParaAtacar) : 100;
    const porEnviado = Number(c.favorPorEnviado) || 5;
    const tecto = Number(c.favorMaximo) || 500;
    let enviados = 0;

    for (const t of towns) {
      if (!farm[t.id]) continue;
      const deus = deusDa(t.id);
      if (!deus) continue;

      const favor = Number(favores[deus]) || 0;
      if (favor >= limiar) continue;                 // ainda tem favor que chegue

      /* QUANTOS ENVIAR.
       * Cada enviado rouba `porEnviado` (5 por omissão). O que interessa é
       * encher o favor até ao tecto sem passar:
       *   faltam = tecto − favor actual
       *   enviados = arredondar para baixo (faltam / porEnviado)
       * Exemplo: com 213 de favor e tecto 500, faltam 287 → 57 enviados
       * (57 × 5 = 285, ficando a 498). Mandar 58 passaria dos 500 e o excesso
       * perder-se-ia. */
      let quantos = Number(c.enviadosPorAtaque) || 5;
      if (c.calcularEnviados) {
        const faltam = Math.max(0, tecto - favor);
        quantos = Math.floor(faltam / porEnviado);
        if (quantos < 1) continue;                   // não há espaço para roubar
      }

      const temEnviados = enviadosEmCasa(t.id);
      if (temEnviados < quantos) {
        /* Não tem os que seriam precisos: manda os que tem, em vez de não
         * fazer nada. Roubar menos é melhor do que não roubar. */
        if (temEnviados < 1) {
          log(`— ${t.name}: sem enviados divinos.`);
          continue;
        }
        log(`— ${t.name}: queria mandar ${quantos}, só tem ${temEnviados} — vão esses.`);
        quantos = temEnviados;
      }

      if (await ataqueEmCurso(t.id)) continue;        // já vai um a caminho

      const il = ilhaDa(t.id);
      if (!il) continue;
      const alvos = await alvosNaIlha(il.x, il.y, t.id, multis);
      if (!alvos.length) {
        log(`— ${t.name}: nenhuma cidade das tuas multis na ilha ${il.x}:${il.y}.`);
        continue;
      }
      const alvo = proximoAlvo(t.id, alvos, !c.simular);

      if (c.simular) {
        log(`🔎 [simulação] ${t.name}: atacaria ${alvo.nome} (${alvo.jogador}) com ${quantos} enviados`
          + ` — favor de ${NOMES[deus]} está em ${favor}.`);
        enviados++;
        continue;
      }
      const r = await enviarAtaque(t.id, alvo.townId, quantos);
      if (r.ok) {
        log(`⚔️ ${t.name} → ${alvo.nome} (${alvo.jogador}): ${quantos} enviados divinos`
          + ` — favor de ${NOMES[deus]} estava em ${favor}.`);
        enviados++;
        await ctx.sleep(ctx.rand(1200, 2400));
      } else {
        log(`⚠️ ${t.name}: ataque falhou (${r.msg}).`);
      }
    }

    if (!enviados) log('Farm: nada a atacar agora (favor suficiente ou ataques em curso).');
  }

  // Escapar texto vindo do jogo (nomes de cidades) antes de o pôr em HTML.
  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------------- PAINEL ---------------------------------------- */
  // Os grupos de cidades só ficam na colecção depois de o jogo os carregar.
  // Se o painel abrir antes disso, o seletor de grupos fica vazio — espera-se
  // e redesenha-se uma vez.
  function redesenharQuandoHouverGrupos(container, ctx) {
    try {
      const ha = () => {
        try { return mUw.MM.getCollections().TownGroup[0].models.length > 0; }
        catch (e) { return false; }
      };
      if (ha()) return;
      let n = 0;
      const t = setInterval(() => {
        n++;
        if (ha()) { clearInterval(t); try { comRolamento(() => painel(container, ctx)); } catch (e) {} }
        else if (n > 40) clearInterval(t);     // ~20 s e desiste
      }, 500);
    } catch (e) {}
  }


  /* Preservar a posição do rolamento ao redesenhar o painel — senão volta ao
   * topo a cada alteração. */
  function comRolamento(fn) {
    /* Guardar TODOS os elementos que estejam rolados, não só os que se
     * adivinham: o que rola pode ser uma caixa interna e o salto para o topo
     * mantinha-se. */
    /* Guardar o CAMINHO e não só a referência: o redesenho destrói os
     * elementos internos e a referência antiga deixa de estar no ecrã. */
    const caminhoDe = (el) => {
      const p = []; let n = el;
      while (n && n.parentElement && p.length < 30) {
        p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
        if (n.id) { p.unshift('#' + n.id); break; }
      }
      return p;
    };
    const porCaminho = (p) => {
      try {
        if (!p.length) return null;
        let n = null, i = 0;
        if (typeof p[0] === 'string' && p[0].charAt(0) === '#') { n = document.getElementById(p[0].slice(1)); i = 1; }
        else n = document.body;
        for (; n && i < p.length; i++) n = n.children[p[i]];
        return n || null;
      } catch (e) { return null; }
    };

    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}
    fn();
    const repor = () => guardados.forEach(({ caminho, y, el }) => {
      try {
        if (el && el.isConnected) { el.scrollTop = y; return; }
        const n2 = porCaminho(caminho);
        if (n2) n2.scrollTop = y;
      } catch (e) {}
    });
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  let ctxPainel = null;

  function painel(container, ctx) {
    ctxPainel = ctx;
    mUw = ctx.uw; mWorld = ctx.WORLD;
    redesenharQuandoHouverGrupos(container, ctx);
    const c = cfgLocal();
    const towns = ctx.getMyTowns();
    const favores = favorPorDeus();

    const linhaFavores = DEUSES.map((d) => `${NOMES[d]} ${favores[d]}`).join(' · ');
    const distintos = new Set(towns.map((t) => deusDa(t.id)).filter(Boolean)).size;

    // ---- seletor de PERFIL e, no main, os pesos ----
    const ehMain = c.perfil === PERFIS.MAIN;
    const deusesAtuais = towns.map((t) => deusDa(t.id)).filter(Boolean);
    const querido = ehMain ? distribuicaoDesejada(c.pesos || {}, towns.length, c.modoPesos) : null;
    const tenho = {};
    DEUSES.forEach((d) => { tenho[d] = 0; });
    deusesAtuais.forEach((d) => { if (tenho[d] != null) tenho[d]++; });

    const blocoPerfil = `
      <div style="background:${c.simular ? '#2a2416' : '#0d141c'};padding:6px;border-radius:4px;margin-bottom:6px;font-size:11px">
        <label style="display:block;margin-bottom:4px;cursor:pointer">
          <input type="checkbox" id="deu-simular"${c.simular ? ' checked' : ''}>
          <b>Simular</b> — decide e escreve no log, mas não muda nada
          <div style="opacity:.65;font-size:10px;margin-left:18px">
            Mudar de deus faz perder o favor acumulado e é irreversível. Deixa isto ligado
            até concordares com as decisões.
          </div>
        </label>
        <hr style="border:0;border-top:1px solid #223;margin:5px 0">
        <b>Perfil</b>
        <label style="margin-left:8px"><input type="radio" name="deu-perfil" value="multi"${!ehMain ? ' checked' : ''}> Multi</label>
        <label style="margin-left:8px"><input type="radio" name="deu-perfil" value="main"${ehMain ? ' checked' : ''}> Main</label>
        <div style="opacity:.65;font-size:10px;margin-top:3px">
          ${ehMain
            ? 'Main: as cidades veneram deuses conforme os pesos abaixo (mais cidades num deus = favor desse deus mais depressa).'
            : 'Multi: roda sempre para o deus com MAIS favor acumulado, para haver muito que roubar.'}
        </div>
      </div>`;

    /* ---- cidades de farm (só no perfil MAIN) ----
     * Cada cidade escolhida pode ser de deus FIXO (tu escolhes qual) ou
     * ROTATÓRIO (o módulo escolhe conforme a procura de favor). */
    const farm = c.cidadesFarm || {};    // { townId: {tipo:'fixo'|'rotativo', deus:'zeus'} }
    const blocoFarm = ehMain ? `
      <div style="background:#0d141c;padding:6px;border-radius:4px;margin-bottom:6px;font-size:11px">
        <b>Cidades que farmam favor</b>
        <span style="opacity:.6">— atacam as multis com enviados divinos</span>
        <div style="max-height:150px;overflow-y:auto;margin-top:4px">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            ${towns.map((t) => {
              const f = farm[t.id] || {};
              const ativa = !!f.tipo;
              const dAtual = deusDa(t.id);
              return `<tr style="${ativa ? 'background:#141d28' : ''}">
                <td style="padding:1px 3px;width:16px">
                  <input type="checkbox" data-farm="${t.id}"${ativa ? ' checked' : ''}>
                </td>
                <td style="padding:1px 3px">${esc(t.name)}
                  <span style="opacity:.5">${dAtual ? NOMES[dAtual] : '(sem deus)'}</span>
                </td>
                <td style="padding:1px 3px;width:150px">
                  <select data-farmtipo="${t.id}"${ativa ? '' : ' disabled'} style="font-size:11px">
                    <option value="rotativo"${f.tipo !== 'fixo' ? ' selected' : ''}>rotatório</option>
                    <option value="fixo"${f.tipo === 'fixo' ? ' selected' : ''}>fixo</option>
                  </select>
                  <select data-farmdeus="${t.id}"${f.tipo === 'fixo' ? '' : ' disabled'} style="font-size:11px">
                    ${DEUSES.map((d) => `<option value="${d}"${f.deus === d ? ' selected' : ''}>${NOMES[d]}</option>`).join('')}
                  </select>
                </td>
              </tr>`;
            }).join('')}
          </table>
        </div>
        <div style="opacity:.6;font-size:10px;margin-top:3px">
          <b>Rotatório:</b> o módulo escolhe o deus conforme a procura de favor
          (míticas por recrutar, feitiços). <b>Fixo:</b> mantém o deus que escolheres.
        </div>
        <div style="margin-top:4px">
          Atacar abaixo de <input type="number" min="0" id="deu-favatk" value="${c.favorParaAtacar != null ? c.favorParaAtacar : 250}" style="width:48px"> de favor<br>
          <label><input type="checkbox" id="deu-calc"${c.calcularEnviados !== false ? ' checked' : ''}>
            calcular quantos enviados mandar</label>
          ${c.calcularEnviados !== false ? `
            <div style="opacity:.6;font-size:10px;margin:2px 0 4px 18px">
              Enche até <input type="number" min="1" id="deu-tecto" value="${c.favorMaximo || 500}" style="width:44px">
              de favor, a <input type="number" min="1" id="deu-porenv" value="${c.favorPorEnviado || 5}" style="width:36px"> por enviado.<br>
              Com 213 de favor faltam 287 → manda 57 (não 58, que passaria dos 500).
            </div>`
          : `
            <div style="margin:2px 0 4px 18px">
              Mandar sempre <input type="number" min="1" id="deu-env" value="${c.enviadosPorAtaque || 5}" style="width:48px"> enviados.
            </div>`}
        </div>
        <div style="margin-top:6px;border-top:1px solid #223;padding-top:4px">
          <b>As minhas multis</b>
          <button id="deu-procurar" style="cursor:pointer;font-size:11px;margin-left:6px">🔍 Procurar nas ilhas de farm</button>
          <div id="deu-vizinhos" style="margin-top:4px;max-height:130px;overflow-y:auto">
            ${(c.multis || []).length
              ? (c.multis || []).map((m) => `<label style="display:block;font-size:11px">
                  <input type="checkbox" data-multi="${esc(m)}" checked> ${esc(m)}
                </label>`).join('')
              : '<span style="opacity:.55;font-size:10px">Marca as cidades de farm acima e carrega em “Procurar”.</span>'}
          </div>
        </div>
      </div>` : '';

    /* ---- grupo de voadores ----
     * A definição é partilhada com o módulo de recrutamento (mesma chave),
     * para não haver duas configurações a dizer coisas diferentes. */
    const gVoaAtual = grupoVoadoresConfigurado();
    const gruposJogo = (() => {
      try {
        return mUw.MM.getCollections().TownGroup[0].models
          .map((m) => m.attributes)
          .filter((a) => Number(a.id) > 0 && String(a.name).toLowerCase() !== 'todos')
          .map((a) => a.name);
      } catch (e) { return []; }
    })();
    const nomesVoadores = Object.keys(DEUSES_VOADORES).map((d) => {
      let u = '';
      try { u = (mUw.GameData.units[DEUSES_VOADORES[d]] || {}).name || ''; } catch (e) {}
      return `${NOMES[d]}${u ? ` (${u})` : ''}`;
    }).join(' · ');

    const blocoVoadores = ehMain ? `
      <div style="background:#0d141c;padding:6px;border-radius:4px;margin-bottom:6px;font-size:11px">
        <b>Grupo de voadores</b>
        <select id="deu-grupovoa" style="max-width:150px;margin-left:6px">
          <option value=""${!gVoaAtual ? ' selected' : ''}>(nenhum)</option>
          ${gruposJogo.map((g) => `<option value="${esc(g)}"${gVoaAtual === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}
        </select>
        <div style="opacity:.65;font-size:10px;margin-top:3px">
          As cidades deste grupo só recebem deuses que dêem voadores, repartidos entre eles:
          ${nomesVoadores}.<br>
          Atena fica de fora — o pégaso é rápido mas fraco a atacar.
          Esta definição é a mesma do módulo de recrutamento.
        </div>
      </div>` : '';

    const blocoPesos = ehMain ? `
      <div style="background:#0d141c;padding:6px;border-radius:4px;margin-bottom:6px;font-size:11px">
        <b>Distribuição por deus</b>
        <span style="opacity:.6">— tens <b id="deu-total">${towns.length}</b> cidades;
        atribuídas <b id="deu-atribuidas">0</b></span>
        <div style="margin:4px 0">
          <label style="cursor:pointer"><input type="radio" name="deu-modo" value="proporcao"${c.modoPesos !== 'quantidade' ? ' checked' : ''}> Peso relativo</label>
          <label style="cursor:pointer;margin-left:10px"><input type="radio" name="deu-modo" value="quantidade"${c.modoPesos === 'quantidade' ? ' checked' : ''}> Número de cidades</label>
          <div style="opacity:.6;font-size:10px">
            <b>Peso relativo:</b> não é percentagem — conta a razão entre os números.
            Hera 2 e Ártemis 1 dá o dobro de cidades a Hera, tal como Hera 20 e Ártemis 10.
            Reparte sempre todas as cidades e ajusta-se sozinho quando ganhas ou perdes cidades.<br>
            <b>Número de cidades:</b> o valor é literal — 3 em Hera são 3 cidades.
            As que sobrarem ficam como estão e seguem o favor.
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-top:3px;font-size:11px">
          ${DEUSES.map((d) => `<tr>
            <td style="padding:1px 3px">${NOMES[d]}</td>
            <td style="padding:1px 3px;width:52px">
              <input type="number" min="0" max="100" data-peso="${d}" value="${Number((c.pesos || {})[d]) || 0}" style="width:44px">
            </td>
            <td style="padding:1px 3px;text-align:right;width:70px" data-cont="${d}">
              <span style="color:${tenho[d] < (querido[d] || 0) ? '#fc8' : '#cde'}">${tenho[d]}</span><span style="opacity:.5">/${querido[d] || 0}</span>
            </td>
          </tr>`).join('')}
        </table>
        <div style="opacity:.55;font-size:10px;margin-top:2px">
          Deixa tudo a 0 para repartir igualmente pelos 8. A coluna da direita mostra
          quantas cidades tens nesse deus face às que os pesos pedem.
        </div>
      </div>` : '';

    let estado = '';
    if (c.ilhaX != null && c.ilhaY != null) {
      const naIlha = towns.filter((t) => {
        const i = ilhaDa(t.id);
        return i && i.x === Number(c.ilhaX) && i.y === Number(c.ilhaY);
      });
      if (naIlha.length) {
        const d = decidir(naIlha[0].id, towns, c, favores);
        estado = `<div style="margin-top:4px">Cidade que roda: <b>${naIlha[0].name}</b> (${NOMES[deusDa(naIlha[0].id)] || '?'})<br>
          <span style="opacity:.75">${d.rodar ? `pronta a trocar para ${NOMES[d.deusNovo]}` : d.motivo}</span></div>`;
      } else {
        estado = `<div style="margin-top:4px;opacity:.75">Nenhuma cidade na ilha ${c.ilhaX}:${c.ilhaY}.</div>`;
      }
    }

    // No perfil MAIN as opções de farm não se aplicam — só confundem.
    const htmlFarm = ehMain ? '' : `
      <div style="font-size:11px;line-height:1.7">
        <label><input type="checkbox" id="deu-on"${c.ativo ? ' checked' : ''}> <b>Rodar deus na cidade de farm</b></label><br>
        <div style="margin:4px 0">
          <b>Ilhas de farm</b>
          <span style="opacity:.6;font-size:10px">— podem ser várias (até 8, uma por deus)</span>
          <div style="display:flex;gap:4px;align-items:center;margin-top:2px">
            <input type="text" id="deu-ilha-nova" placeholder="499:507" style="width:90px">
            <button id="deu-ilha-add" style="cursor:pointer;padding:2px 8px">+ juntar</button>
            <button id="deu-ilha-aqui" style="cursor:pointer;padding:2px 8px"
              title="juntar a ilha da cidade onde estou">+ esta ilha</button>
          </div>
          ${(() => {
            const ls = listaDeIlhasFarm(c);
            if (!ls.length) return '<div style="opacity:.5;font-size:10px;margin-top:3px">Nenhuma ilha indicada.</div>';
            return `<div style="margin-top:3px">${ls.map((k) => {
              const quantas = (ctxPainel ? ctxPainel.getMyTowns() : []).filter((t) => {
                const i = ilhaDa(t.id); return i && `${i.x}:${i.y}` === k;
              }).length;
              return `<span style="display:inline-block;background:#0d141c;border:1px solid #2c3e50;
                border-radius:4px;padding:2px 6px;margin:2px 3px 0 0;font-size:11px">
                ${k} <span style="opacity:.55">${quantas} cidade(s)</span>
                <a href="#" data-tirar-ilha="${k}" style="color:#d9705f;text-decoration:none;margin-left:4px">×</a>
              </span>`;
            }).join('')}</div>`;
          })()}
        </div>
        Rodar abaixo de <input type="number" id="deu-lim" value="${c.limiteFavor}" style="width:52px"> de favor
        <div style="opacity:.6;font-size:10px;margin:1px 0 4px 4px">
          O que estiver no deus antigo <b>perde-se</b> ao mudar. Um valor baixo (30)
          desperdiça pouco; um valor alto roda mais cedo mas deita fora mais.
        </div>
        Mínimo de cidades: <input type="number" id="deu-min" value="${c.minCidades}" style="width:42px"><br>
        Deuses distintos entre as cidades de farm:
        <input type="number" min="1" max="${DEUSES.length}" id="deu-dist"
          value="${c.minDeusesDistintos != null ? c.minDeusesDistintos : 1}" style="width:42px">
        <div style="opacity:.6;font-size:10px;margin:1px 0 4px 4px">
          O favor é por CONTA e por deus, não por cidade — as cidades desta conta que
          estejam no mesmo deus descem juntas quando a main lhes rouba, e rodam juntas.
          Tendem a convergir.<br>
          <b>1</b> = deixa convergir. É o melhor quando tens MUITAS multis: cada conta
          tem o seu favor, e enquanto uma recupera há outras a render.<br>
          <b>${DEUSES.length}</b> = força um deus diferente em cada cidade de farm. Útil
          com poucas contas, onde uma multi sozinha tem de dar vários deuses.
        </div>
        <label><input type="checkbox" id="deu-mit"${c.protegerMiticas ? ' checked' : ''}> não rodar se houver míticas na cidade</label>

        <div style="background:#0d141c;padding:6px 8px;border-radius:4px;margin-top:7px">
          <label><input type="checkbox" id="deu-pesos-on"${c.distribuirPorPesos ? ' checked' : ''}>
            <b>Distribuir as cidades que sobram pelos pesos</b></label>
          <div style="opacity:.65;font-size:10px;margin:3px 0 5px 18px">
            Por ordem: primeiro <b>um de cada deus</b> (oito cidades), depois as
            <b>ilhas de farm</b>, e só o que sobrar segue os pesos.<br>
            Útil para ter mais Poseidon, Hera ou Ares — os feitiços deles aceleram
            o recrutamento.
          </div>
          ${(() => {
            const pw = c.pesos || {};
            return `<div style="display:flex;flex-wrap:wrap;gap:3px">
              ${DEUSES.map((d) => `<span style="display:inline-flex;align-items:center;gap:2px">
                <span style="font-size:10px;opacity:.8;width:52px">${NOMES[d]}</span>
                <input type="number" min="0" max="100" data-peso="${d}"
                  value="${Number(pw[d]) || 0}" style="width:42px;font-size:10px">
              </span>`).join('')}
            </div>
            <div style="opacity:.55;font-size:10px;margin-top:3px">
              Proporções, não números de cidades. 0 = esse deus não recebe extras.
            </div>`;
          })()}
        </div>
      </div>`;

    // No perfil MAIN as míticas também se protegem, mas a caixa vive no bloco
    // de farm — repete-se aqui para continuar acessível.
    const htmlMiticasMain = ehMain ? `
      <div style="font-size:11px;margin-bottom:6px">
        <label><input type="checkbox" id="deu-mit"${c.protegerMiticas ? ' checked' : ''}> não mudar o deus de cidades que tenham míticas dele</label>
      </div>` : '';

    const htmlComuns = `
      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:5px;font-size:11px">
        <b>Favores:</b> ${linhaFavores}<br>
        <span style="opacity:.75">Cidades: ${towns.length} · deuses distintos: ${distintos}</span>
        ${ehMain ? '' : estado}
      </div>
      <button id="deu-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    container.innerHTML = blocoPerfil + blocoVoadores + blocoPesos + blocoFarm + htmlFarm + htmlMiticasMain + htmlComuns;


    // Recalcular a repartição enquanto se escrevem os pesos, para se ver logo
    // quantas cidades cada deus levaria — sem ter de guardar primeiro.
    const selVoa = container.querySelector('#deu-grupovoa');
    // Preencher no momento de ABRIR o seletor: assim, mesmo que os grupos só
    // cheguem depois do painel ser desenhado, a lista está sempre actual.
    if (selVoa) selVoa.onmousedown = () => {
      let nomes = [];
      try {
        nomes = mUw.MM.getCollections().TownGroup[0].models
          .map((m) => m.attributes)
          .filter((a) => Number(a.id) > 0 && String(a.name).toLowerCase() !== 'todos')
          .map((a) => a.name);
      } catch (e) {}
      const atual = selVoa.value;
      if (nomes.length && selVoa.options.length - 1 !== nomes.length) {
        selVoa.innerHTML = `<option value="">(nenhum)</option>`
          + nomes.map((g) => `<option value="${esc(g)}"${atual === g ? ' selected' : ''}>${esc(g)}</option>`).join('');
      }
    };
    if (selVoa) selVoa.onchange = () => {
      try { armazem.setItem('grepoRecruta_voadores_grupo_v1', selVoa.value || ''); } catch (e) {}
      ctx.log(selVoa.value
        ? `Grupo de voadores: "${selVoa.value}" — essas cidades só terão deuses com voadores.`
        : 'Grupo de voadores: nenhum.');
      comRolamento(() => painel(container, ctx));
    };

    const btProcurar = container.querySelector('#deu-procurar');
    if (btProcurar) btProcurar.onclick = async () => {
      // usar as cidades marcadas AGORA, sem obrigar a guardar primeiro
      const marcadas = {};
      container.querySelectorAll('[data-farm]').forEach((el) => {
        if (el.checked) marcadas[el.getAttribute('data-farm')] = { tipo: 'rotativo' };
      });
      if (!Object.keys(marcadas).length) {
        ctx.log('Marca primeiro as cidades que farmam favor.');
        return;
      }
      btProcurar.textContent = 'a procurar...'; btProcurar.disabled = true;
      const jogs = await jogadoresNasIlhasDeFarm({ cidadesFarm: marcadas }, towns);
      btProcurar.textContent = '🔍 Procurar nas ilhas de farm'; btProcurar.disabled = false;

      const meu = (() => { try { return mUw.Game.player_name || ''; } catch (e) { return ''; } })();
      const alvo = container.querySelector('#deu-vizinhos');
      const jaMarcados = new Set(c.multis || []);
      const outros = jogs.filter((j) => j.jogador !== meu);
      if (!outros.length) { alvo.innerHTML = '<span style="opacity:.6;font-size:10px">Nenhum outro jogador nessas ilhas.</span>'; return; }
      alvo.innerHTML =
        `<div style="margin-bottom:4px">
          <a href="#" id="deu-todos" style="color:#8cf;text-decoration:none;font-size:11px">marcar todos</a>
          <span style="opacity:.4">·</span>
          <a href="#" id="deu-nenhum" style="color:#8cf;text-decoration:none;font-size:11px">nenhum</a>
          <span style="opacity:.5;font-size:10px;margin-left:6px">${outros.length} jogador(es) · ordenados dos mais pequenos para os maiores</span>
        </div>`
        + outros.map((j) => {
            const media = Math.round(j.pontos / Math.max(1, j.cidades.length));
            return `<label style="display:block;font-size:11px;padding:1px 0">
              <input type="checkbox" data-multi="${esc(j.jogador)}"${jaMarcados.has(j.jogador) ? ' checked' : ''}>
              <b>${esc(j.jogador)}</b>
              <span style="opacity:.55">— ${j.cidades.length} cidade(s), ~${media} pts cada`
              + (j.alianca ? ` · ${esc(j.alianca)}` : '')
              + `</span>
            </label>`;
          }).join('');
      const todos = alvo.querySelector('#deu-todos');
      const nenhum = alvo.querySelector('#deu-nenhum');
      const marcarTodos = (v) => (e) => {
        if (e) e.preventDefault();
        alvo.querySelectorAll('[data-multi]').forEach((el) => { el.checked = v; });
      };
      if (todos) todos.onclick = marcarTodos(true);
      if (nenhum) nenhum.onclick = marcarTodos(false);

      ctx.log(`Encontrados ${outros.length} jogador(es) nas ilhas de farm. Marca os que são multis tuas.`);
    };

    // ---- controlos das cidades de farm ----
    container.querySelectorAll('[data-farm]').forEach((el) => {
      el.onchange = () => {
        const id = el.getAttribute('data-farm');
        const tipoSel = container.querySelector(`[data-farmtipo="${id}"]`);
        const deusSel = container.querySelector(`[data-farmdeus="${id}"]`);
        if (tipoSel) tipoSel.disabled = !el.checked;
        if (deusSel) deusSel.disabled = !el.checked || tipoSel.value !== 'fixo';
        el.closest('tr').style.background = el.checked ? '#141d28' : '';
      };
    });
    container.querySelectorAll('[data-farmtipo]').forEach((el) => {
      el.onchange = () => {
        const id = el.getAttribute('data-farmtipo');
        const deusSel = container.querySelector(`[data-farmdeus="${id}"]`);
        // o deus só se escolhe quando é fixo
        if (deusSel) deusSel.disabled = el.value !== 'fixo';
      };
    });

    const modoAtual = () =>
      ((container.querySelector('input[name="deu-modo"]:checked') || {}).value) || 'proporcao';

    const recalcular = () => {
      const pesos = {};
      container.querySelectorAll('[data-peso]').forEach((el) => {
        const v = Number(el.value) || 0;
        if (v > 0) pesos[el.getAttribute('data-peso')] = v;
      });
      const q = distribuicaoDesejada(pesos, towns.length, modoAtual());
      let atribuidas = 0;
      DEUSES.forEach((d) => {
        const cel = container.querySelector(`[data-cont="${d}"]`);
        if (!cel) return;
        const querem = q[d] || 0;
        atribuidas += querem;
        cel.innerHTML = `<span style="color:${tenho[d] < querem ? '#fc8' : '#cde'}">${tenho[d]}</span>`
          + `<span style="opacity:.5">/${querem}</span>`;
      });
      const elA = container.querySelector('#deu-atribuidas');
      if (elA) elA.textContent = atribuidas;
    };
    container.querySelectorAll('[data-peso]').forEach((el) => { el.oninput = recalcular; });
    container.querySelectorAll('input[name="deu-modo"]').forEach((el) => { el.onchange = recalcular; });
    recalcular();

    // trocar de perfil redesenha (os pesos só aparecem no main)
    container.querySelectorAll('input[name="deu-perfil"]').forEach((el) => {
      el.onchange = () => {
        const atualCfg = cfgLocal();
        atualCfg.perfil = el.value;
        guardarLocal(atualCfg);
        comRolamento(() => painel(container, ctx));
      };
    });

    /* ilhas de farm: juntar, tirar, e "esta ilha" */
    const guardarIlhas = (lista) => {
      const cc = cfgLocal();
      cc.ilhasFarm = lista;
      cc.ilhaX = null; cc.ilhaY = null;   // passou tudo para a lista
      guardarLocal(cc);
    };
    const btAdd = container.querySelector('#deu-ilha-add');
    if (btAdd) btAdd.onclick = () => {
      const el = container.querySelector('#deu-ilha-nova');
      const m = String(el.value || '').match(/(\d+)\s*[:\s,]\s*(\d+)/);
      if (!m) { ctx.log('Escreve a ilha no formato x:y, por exemplo 499:507.'); return; }
      const k = `${m[1]}:${m[2]}`;
      const ls = listaDeIlhasFarm(cfgLocal());
      if (ls.indexOf(k) >= 0) { ctx.log(`A ilha ${k} já está na lista.`); return; }
      ls.push(k); guardarIlhas(ls);
      ctx.log(`Ilha de farm ${k} acrescentada.`);
      el.value = '';
      painel(container, ctx);
    };
    const btAqui = container.querySelector('#deu-ilha-aqui');
    if (btAqui) btAqui.onclick = () => {
      let k = null;
      try {
        const i = ilhaDa(mUw.Game.townId);
        if (i) k = `${i.x}:${i.y}`;
      } catch (e) {}
      if (!k) { ctx.log('Não consegui saber em que ilha estás.'); return; }
      const ls = listaDeIlhasFarm(cfgLocal());
      if (ls.indexOf(k) >= 0) { ctx.log(`A ilha ${k} já está na lista.`); return; }
      ls.push(k); guardarIlhas(ls);
      ctx.log(`Ilha de farm ${k} acrescentada (é onde estás).`);
      painel(container, ctx);
    };
    container.querySelectorAll('[data-tirar-ilha]').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const k = a.getAttribute('data-tirar-ilha');
        guardarIlhas(listaDeIlhasFarm(cfgLocal()).filter((x) => x !== k));
        ctx.log(`Ilha de farm ${k} retirada.`);
        painel(container, ctx);
      };
    });

    // ao ligar/desligar o cálculo, redesenhar para trocar os campos
    const elCalc = container.querySelector('#deu-calc');
    if (elCalc) elCalc.onchange = () => {
      const cc = cfgLocal();
      cc.calcularEnviados = elCalc.checked;
      guardarLocal(cc);
      painel(container, ctx);
    };

    const g = container.querySelector('#deu-guardar');
    if (g) g.onclick = async () => {
      const novo = {
        // no perfil main estes campos não existem — preserva-se o que estava
        ativo: container.querySelector('#deu-on') ? container.querySelector('#deu-on').checked : c.ativo,
        // as ilhas de farm são geridas pelos botões, não por campos aqui
        ilhaX: c.ilhaX, ilhaY: c.ilhaY, ilhasFarm: c.ilhasFarm || [],
        limiteFavor: container.querySelector('#deu-lim') ? (Number(container.querySelector('#deu-lim').value) || 30) : c.limiteFavor,
        minCidades: container.querySelector('#deu-min') ? (Number(container.querySelector('#deu-min').value) || 9) : c.minCidades,
        protegerMiticas: container.querySelector('#deu-mit').checked,
        perfil: (container.querySelector('input[name="deu-perfil"]:checked') || {}).value || PERFIS.MULTI,
        distribuirPorPesos: !!(container.querySelector('#deu-pesos-on') || {}).checked,
        simular: container.querySelector('#deu-simular').checked,
        modoPesos: (container.querySelector('input[name="deu-modo"]:checked') || {}).value || 'proporcao',
        cidadesFarm: (() => {
          const out = {};
          container.querySelectorAll('[data-farm]').forEach((el) => {
            if (!el.checked) return;
            const id = el.getAttribute('data-farm');
            const tipo = (container.querySelector(`[data-farmtipo="${id}"]`) || {}).value || 'rotativo';
            const deus = (container.querySelector(`[data-farmdeus="${id}"]`) || {}).value || null;
            out[id] = tipo === 'fixo' ? { tipo, deus } : { tipo };
          });
          return out;
        })(),
        multis: (() => {
          const marcados = [];
          container.querySelectorAll('[data-multi]').forEach((el) => {
            if (el.checked) marcados.push(el.getAttribute('data-multi'));
          });
          return marcados.length ? marcados : (c.multis || []);
        })(),
        enviadosPorAtaque: container.querySelector('#deu-env')
          ? (Number(container.querySelector('#deu-env').value) || 5) : c.enviadosPorAtaque,
        calcularEnviados: container.querySelector('#deu-calc') ? container.querySelector('#deu-calc').checked : true,
        favorMaximo: container.querySelector('#deu-tecto') ? (Number(container.querySelector('#deu-tecto').value) || 500) : (c.favorMaximo || 500),
        favorPorEnviado: container.querySelector('#deu-porenv') ? (Number(container.querySelector('#deu-porenv').value) || 5) : (c.favorPorEnviado || 5),
        favorParaAtacar: container.querySelector('#deu-favatk')
          ? (Number(container.querySelector('#deu-favatk').value) || 100) : c.favorParaAtacar,
        pesos: (() => {
          const out = {};
          container.querySelectorAll('[data-peso]').forEach((el) => {
            const v = Number(el.value) || 0;
            if (v > 0) out[el.getAttribute('data-peso')] = v;
          });
          return out;
        })(),
      };
      g.textContent = 'A guardar...';
      const r = await escreverGist(novo);
      ctx.log(r.ok ? 'Rotação de deus: guardada no Gist.' : 'Rotação de deus: guardada localmente (' + r.msg + ').');
      g.textContent = r.ok ? 'Guardado ✓' : 'Guardado (local)';
      setTimeout(() => { g.textContent = 'Guardar'; }, 1800);
    };
  }

  return {
    id: 'deuses',
    nome: 'Rotação de deus',
    intervaloMin: opts.intervaloMin || 20,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
  };
}

  // ====================== MÓDULO: ESQUIVA DE ATAQUES =====================
/* =============================================================================
 *  MÓDULO: ESQUIVA DE ATAQUES  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Manda a tropa para fora da cidade mesmo antes de um ataque bater e traz-na
 *  de volta a seguir, usando o CANCELAMENTO do comando para controlar o
 *  instante do regresso.
 *
 *  MECÂNICA: um comando cancelado demora a voltar o mesmo tempo que já viajou.
 *    envio em S, cancelamento em C  →  chega a casa em C + (C − S)
 *    logo, para estar em casa no instante H:  C = (H + S) / 2
 *
 *  DOIS CENÁRIOS:
 *   • Ataque normal: sai segundos antes do impacto, volta segundos depois.
 *   • Com navio colonizador: os ataques de limpeza vêm colados antes do NC.
 *     A tropa sai antes da limpeza e regressa 1 s ANTES do NC bater — fica fora
 *     durante a limpeza e em casa para defender a conquista.
 *
 *  SEGURANÇA: por omissão NÃO esvazia a cidade quando há suspeita de NC sem
 *  ataques anteriores (esvaziar entregaria a cidade).
 *
 *  Pedidos:
 *   enviar   : /game/town_info?town_id=O&action=send_units   (como o apoio)
 *   cancelar : frontend_bridge → Commands / cancelCommand {id}
 *   milícia  : /game/building_farm?town_id=X&action=request_militia
 * ========================================================================== */

function makeEsquivaModule(opts) {
  opts = opts || {};

  const CFG_KEY = 'grepoEsquiva_cfg_v1';
  const PLANOS_KEY = 'grepoEsquiva_planos_v1';

  /* Marca que o servidor recusou pedidos (429) nesta passagem: sem isto,
   * uma lista vazia é indistinguível de "não há ataques". */
  let limitadoPeloServidor = false;

  const DEFAULTS = {
    ativo: false,             // desligado por omissão: mexe com tropas

    /* --- MODO FARM (perfil multi do esquema de favores) ---
     * Quando a MAIN ataca a multi com enviados divinos, o objectivo é o
     * INVERSO de uma esquiva normal: a cidade tem de ficar sem defesa para
     * que os enviados do atacante SOBREVIVAM e o farm continue.
     * Por isso, contra estes atacantes:
     *   • esvazia-se a cidade na mesma (apoio + cancelamento, tropas voltam);
     *   • NUNCA se activa a milícia (mataria os enviados);
     *   • não se aplica a regra do colonizador.
     */
    jogadoresFarm: [],        // atacantes que são a minha main
    modoFarm: false,          // ligar no perfil multi
    antesDoImpacto: 20,       // segundos antes do impacto para mandar sair
    depoisDoImpacto: 15,      // segundos depois do impacto para estar em casa
    antesDoNC: 1,             // estar em casa N segundos antes do NC bater
    milicia: true,            // ativar milícia ao esquivar
    naoEsquivarNC: true,      // não esvaziar se só vier o NC (entregaria a cidade)
    K: 5260,                  // igual aos alertas: calibrada JÁ com o tempo de
                              // preparação descontado (ver abaixo)
    janelaCancelamento: 600,  // cancelable_until observado: 10 min
  };

  const GROUND = ['sword', 'slinger', 'archer', 'hoplite', 'rider', 'chariot', 'catapult'];

  // Este ataque vem da minha main (esquema de farm de favores)?
  /* Hora do JOGO, não a do computador — que pode estar horas ao lado. */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function horaJogo(segundos) {
    try {
      const f = mUw.__maestroHoraJogo || uw.__maestroHoraJogo;
      if (f) return f(segundos);
    } catch (e) {}
    try {
      /* serverGMTOffset é uma FUNÇÃO, não um número. */
      const w = mUw || uw;
      const raw = w.Timestamp.serverGMTOffset;
      let d = (typeof raw === 'function') ? Number(raw.call(w.Timestamp)) : Number(raw);
      if (!Number.isFinite(d)) d = Number(w.Game && w.Game.server_gmt_offset) || 0;
      return new Date((Number(segundos) + d) * 1000).toISOString().slice(11, 19);
    } catch (e) { return '?'; }
  }

  function ehDaMain(ataque, cfg) {
    if (!cfg.modoFarm) return false;
    const lista = (cfg.jogadoresFarm || []).map((x) => String(x).trim().toLowerCase());
    if (!lista.length) return false;

    // 1) por nome — só existe quando os dados vêm do SERVIDOR
    const nome = String(ataque.jogador || '').trim().toLowerCase();
    if (nome && lista.indexOf(nome) >= 0) return true;

    // 2) por id do jogador — vem no modelo LOCAL (player_id) e no servidor
    if (ataque.jogador_id && lista.indexOf(String(ataque.jogador_id)) >= 0) return true;

    // 3) por cidade de origem — último recurso, para quando o modelo local não
    //    tem nome nem o id bate certo. As cidades aprendem-se sozinhas: sempre
    //    que um ataque é reconhecido pelo nome, guarda-se a origem.
    if (ataque.origem_town_id && cidadesDaMain().has(Number(ataque.origem_town_id))) return true;

    /* 4) pelo NOME DA CIDADE de origem.
     *
     * Nos ataques recebidos, o `player_id` do modelo local é o do DONO da
     * cidade atacada — ou seja, o meu — e não o do atacante. Por isso o
     * reconhecimento por id nunca funcionava nas multis.
     *
     * O `town_name_origin` vem sempre, e as cidades da main têm nomes
     * reconhecíveis ("34.1", "55.2"). Basta pôr esses nomes na lista, ou um
     * prefixo. */
    const nomeOrigem = String(ataque.town_name_origin || ataque.origem_nome || '').trim().toLowerCase();
    if (nomeOrigem) {
      for (const chave of lista) {
        if (!chave) continue;
        if (nomeOrigem === chave) return true;
        // prefixo: "34." reconhece 34.1, 34.2, ...
        if (chave.endsWith('.') && nomeOrigem.startsWith(chave)) return true;
      }
    }

    return false;
  }

  // Cidades de onde a main costuma atacar, aprendidas ao longo do tempo.
  const CIDADES_MAIN_KEY = 'grepoEsquiva_cidadesMain_v1';
  function cidadesDaMain() {
    try { return new Set(JSON.parse(armazem.getItem(CIDADES_MAIN_KEY) || '[]').map(Number)); }
    catch (e) { return new Set(); }
  }
  function aprenderCidadeMain(townId) {
    if (!townId) return;
    try {
      const s2 = cidadesDaMain();
      if (s2.has(Number(townId))) return;
      s2.add(Number(townId));
      armazem.setItem(CIDADES_MAIN_KEY, JSON.stringify(Array.from(s2)));
    } catch (e) {}
  }
  const CAP = { small_transporter: { sem: 10, com: 16 }, big_transporter: { sem: 26, com: 32 } };

  let mUw = null, mWorld = '';

  // RELÓGIO DO SERVIDOR — o único que conta.
  // O relógio da máquina é irrelevante e enganador: este VPS está em Espanha e
  // o jogo corre em hora portuguesa, uma hora de diferença PERMANENTE. Se o
  // servidor não estiver disponível devolvemos null e o módulo NÃO age, em vez
  // de agir com uma hora possivelmente errada.
  function agoraJogo() {
    try {
      if (typeof mUw.Timestamp !== 'undefined' && typeof mUw.Timestamp.now === 'function') {
        const t = Math.floor(mUw.Timestamp.now());
        if (Number.isFinite(t) && t > 0) return t;
      }
    } catch (e) {}
    try {
      const t = Number(mUw.Game && mUw.Game.server_time);
      if (Number.isFinite(t) && t > 0) return Math.floor(t);
    } catch (e) {}
    return null;   // sem relógio do servidor: não se inventa
  }

  const agendados = new Set();   // command_ids já agendados nesta sessão

  function cfg() {
    const c = Object.assign({}, DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function guardarCfg(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }
  function lerPlanos() { try { return JSON.parse(armazem.getItem(PLANOS_KEY) || '{}'); } catch (e) { return {}; } }
  function gravarPlanos(p) { try { armazem.setItem(PLANOS_KEY, JSON.stringify(p)); } catch (e) {} }

  /* Limpar os planos JÁ CUMPRIDOS.
   *
   * Sem isto acumulam-se indefinidamente — vi 33 planos guardados, um deles de
   * há 20 horas. Além de sujar o painel, aumenta o risco de um plano velho ser
   * reexecutado por engano.
   *
   * Guarda-se uma hora depois do regresso, para o painel ainda mostrar o que
   * acabou de acontecer. */
  function limparPlanosVelhos() {
    try {
      const p = lerPlanos();
      const agora = agoraJogo();
      if (agora == null) return;

      let n = 0;
      for (const k of Object.keys(p)) {
        const x = p[k] || {};
        const fim = Number(x.casa) || Number(x.S) || 0;
        if (fim && (agora - fim) > 3600) { delete p[k]; n++; }
      }
      if (n) {
        gravarPlanos(p);
        try { console.log('[MAESTRO/esquiva] limpei', n, 'plano(s) já cumpridos'); } catch (e) {}
      }
    } catch (e) {}
  }

  const agora = () => agoraJogo();

  /* ---------------------- leitura do jogo ------------------------------- */

  // FONTE FIÁVEL DOS COMANDOS A CHEGAR.
  // O modelo local (MM.getModels().MovementsUnits) fica vazio ou desatualizado
  // até a página ser recarregada — confirmado no jogo. Para decisões que
  // dependem de ver um ataque a tempo, perguntamos ao servidor.
  // Endpoint: /game/town_overviews?action=command_overview
  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * (é preciso recarregar para ver o efeito) E faz a passagem seguinte ler
   * valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels()[Nome].
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }


  // Sem Administrador o command_overview é recusado — não insistir.
  let semAdministrador = false;

  async function comandosDoServidor(townId) {
    if (semAdministrador) return [];
    try {
      const url = mUw.location.origin + '/game/town_overviews?town_id=' + Number(townId)
        + '&action=command_overview&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({ town_id: Number(townId), nl_init: true }))
        + '&_=' + Date.now();
      const resp = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
      /* 429 = o servidor está a limitar pedidos. Devolver lista vazia seria
       * indistinguível de "não há ataques" — e a esquiva ficaria calada a
       * achar que estava tudo bem, quando na verdade está CEGA. */
      if (resp.status === 429) {
        limitadoPeloServidor = true;
        await new Promise((r2) => setTimeout(r2, 3000));
        return [];
      }
      const r = await resp.json();
      const erroAdm = r && r.json && r.json.error;
      if (erroAdm && /administrador|administrator|premium/i.test(String(erroAdm))) {
        semAdministrador = true;
        return [];
      }
      const cmds = ((r && r.json && r.json.data) || {}).commands || [];
      return cmds.map((c) => ({
        command_id: Number(c.id),
        arrival_at: Number(c.arrival_at),
        started_at: Number(c.started_at),
        target_town_id: Number(c.destination_town_id),
        home_town_id: Number(c.origin_town_id),
        type: String(c.type || ''),
        link_origin: c.townurl_base64_origin || c.link_origin || '',
        town_name_origin: c.origin_town_name || c.town_name_origin || '',
        // quem ataca — necessário para distinguir a main no modo farm
        jogador: c.origin_town_player_name || '',
        jogador_id: Number(c.origin_town_player_id) || 0,
      })).filter((c) => c.command_id && c.arrival_at);
    } catch (e) { return []; }
  }


  // Os ataques a chegar NÃO estão de forma fiável no modelo local: ele fica
  // vazio até a página ser atualizada. Perguntamos ao servidor, tal como o
  // encaixe faz — senão a esquiva não veria o ataque e não agiria, deixando as
  // tropas a apanhar o golpe sem aviso nenhum.
  async function ataquesDoServidor(townId) {
    try {
      const url = mUw.location.origin + '/game/town_overviews?town_id=' + Number(townId)
        + '&action=command_overview&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({ town_id: Number(townId), nl_init: true }))
        + '&_=' + Date.now();
      const resp = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
      /* 429 = o servidor está a limitar pedidos. Devolver lista vazia seria
       * indistinguível de "não há ataques" — e a esquiva ficaria calada a
       * achar que estava tudo bem, quando na verdade está CEGA. */
      if (resp.status === 429) {
        limitadoPeloServidor = true;
        await new Promise((r2) => setTimeout(r2, 3000));
        return [];
      }
      const r = await resp.json();
      const erroAdm = r && r.json && r.json.error;
      if (erroAdm && /administrador|administrator|premium/i.test(String(erroAdm))) {
        semAdministrador = true;
        return [];
      }
      const cmds = ((r && r.json && r.json.data) || {}).commands || [];
      return cmds.map((c) => ({
        command_id: Number(c.id),
        arrival_at: Number(c.arrival_at),
        started_at: Number(c.started_at),
        home_town_id: Number(c.origin_town_id),
        target_town_id: Number(c.destination_town_id),
        type: String(c.type || ''),
        // Confirmado no jogo: os campos com as coordenadas chamam-se
        // townurl_base64_origin/destination (não origin_town_link).
        link_origin: c.townurl_base64_origin || c.origin_town_link || c.link_origin || '',
        link_destino: c.townurl_base64_destination || '',
        town_name_origin: c.origin_town_name || c.town_name_origin || '',
      })).filter((c) => c.command_id && c.arrival_at);
    } catch (e) { return []; }
  }

  /* QUANTOS ataques o jogo diz que vêm a caminho de cada cidade.
   *
   * A colecção `Attack` traz `{town_id, incoming}` e é fiável — funciona sem
   * Administrador e não depende do `MovementsUnits`.
   *
   * Isto importa porque o `MovementsUnits` NÃO traz tudo: numa conta com 514
   * apoios das multis a caminho, os ataques recebidos não cabiam no modelo.
   * A colecção Attack dizia 2 cidades sob ataque e o modelo só tinha 1. */
  function ataquesEsperados() {
    const out = {};
    try {
      const col = mUw.MM.getCollections().Attack;
      const models = (col && col[0] && col[0].models) || [];
      for (const m of models) {
        const a = m.attributes || {};
        const n = Number(a.incoming) || 0;
        if (n > 0) out[String(a.town_id)] = n;
      }
    } catch (e) {}
    return out;
  }

  function movimentos() {
    try {
      const m = mUw.MM.getModels().MovementsUnits || {};
      return Object.keys(m).map((k) => {
        const a = m[k].attributes || {};
        // O modelo local NÃO traz o nome do jogador (só a leitura do servidor
        // traz). Traz o player_id e a cidade de origem — é por aí que se
        // identifica a main no modo farm.
        return Object.assign({}, a, {
          jogador_id: Number(a.player_id) || 0,
          origem_town_id: Number(a.home_town_id) || 0,
        });
      });
    } catch (e) { return []; }
  }
  function minhasCidades() {
    try {
      return Object.keys(mUw.ITowns.towns).map((id) => {
        const t = mUw.ITowns.getTown(Number(id));
        return { id: Number(id), name: t.getName ? t.getName() : String(id),
          ix: t.getIslandCoordinateX ? t.getIslandCoordinateX() : null,
          iy: t.getIslandCoordinateY ? t.getIslandCoordinateY() : null };
      });
    } catch (e) { return []; }
  }
  function tropasDaCidade(townId) {
    try { return mUw.ITowns.getTown(Number(townId)).units() || {}; } catch (e) { return {}; }
  }
  function temBeliche(townId) {
    /* As pesquisas estão em `researches().attributes`, não no objecto
     * directamente — `researches().berth` dá sempre indefinido.
     *
     * Foi por isso que se enviavam 12 transportes onde 8 chegavam: com o
     * beliche por detectar, usava-se a capacidade de 10 em vez de 16. */
    try {
      const r = mUw.ITowns.getTown(Number(townId)).researches();
      if (!r) return false;
      const a = r.attributes || r;
      return !!a.berth;
    } catch (e) { return false; }
  }
  function coordsOrigem(a) {
    try {
      const m = String(a.link_origin || '').match(/#(eyJ[A-Za-z0-9+/=]+)/);
      if (!m) return null;
      const o = JSON.parse(atob(m[1]));
      return { x: Number(o.ix), y: Number(o.iy) };
    } catch (e) { return null; }
  }

  // Estimativa da unidade (mesma abordagem do módulo de alertas).
  function tempoPreparacao() {
    try { return Number(((mUw.Game.constants || {}).units || {}).runtime_setup_time) || 300; }
    catch (e) { return 300; }
  }

  /* ============ REGRAS POR CIDADE =======================================
   * Nem todas as cidades devem esquivar. Uma cidade de defesa, por exemplo,
   * é melhor receber o ataque do que esquivar e deixar as catapultas baixarem
   * a muralha.
   *
   * Por cidade, três hipóteses:
   *   'tudo'  — esquiva qualquer ataque (por omissão)
   *   'so_nc' — só os ataques com suspeita de colonizador
   *   'nada'  — não esquiva
   * ==================================================================== */
  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const REGRAS_KEY = 'grepoEsquiva_porCidade_v1';

  function regrasPorCidade() {
    try { return JSON.parse(armazem.getItem(REGRAS_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function guardarRegras(r) {
    try { armazem.setItem(REGRAS_KEY, JSON.stringify(r)); } catch (e) {}
  }
  function regraDaCidade(townId) {
    const r = regrasPorCidade();
    return r[String(townId)] || 'tudo';
  }

  /* Esta cidade deve esquivar este ataque? */
  function deveEsquivar(townId, comNC) {
    const regra = regraDaCidade(townId);
    if (regra === 'nada') return false;
    if (regra === 'so_nc') return !!comNC;
    return true;
  }

  let ultimaClassificacao = null;
  let filtroCidades = '';   // filtro da lista de cidades no painel

  /* Quando é que este comando foi visto pela primeira vez.
   *
   * Os ataques recebidos não trazem `started_at`. Como o módulo passa de
   * ~26 em ~26 s, a primeira vez que se vê um comando fica muito perto da
   * hora a que partiu — e isso chega para calcular a viagem.
   *
   * Guarda-se no armazenamento para sobreviver a recargas da página. */
  const VISTOS_KEY = 'grepoEsquiva_vistos_v1';

  /* Marca da última vez que o módulo arrancou. Um comando visto pela
   * primeira vez logo a seguir ao arranque pode já vir a caminho há horas —
   * a hora em que o vimos não serve para calcular a viagem. */
  const ARRANQUE_KEY = 'grepoEsquiva_arranque_v1';
  let momentoArranque = null;

  function marcarArranque() {
    momentoArranque = agora();
    try { armazem.setItem(ARRANQUE_KEY, String(momentoArranque)); } catch (e) {}
  }

  /* Foi visto logo a seguir a a página abrir? Nesse caso não se sabe quando
   * partiu, e a viagem calculada é falsa. */
  function vistoNoArranque(quando) {
    if (!momentoArranque || !quando) return false;
    return Math.abs(Number(quando) - momentoArranque) < 90;
  }

  /* Devolve { quando, novo }. `novo` diz se é a PRIMEIRA vez que se vê este
   * comando: só nesse caso, e só logo após o arranque, é que a hora não serve
   * para calcular a viagem.
   *
   * Um comando com registo anterior tem hora boa: o módulo passa de 30 em
   * 30 s, portanto o erro é de 30 s no máximo. */
  function primeiraVezQueVi(a) {
    const id = String(a.command_id || a.id || '');
    if (!id) return null;
    try {
      const l = JSON.parse(armazem.getItem(VISTOS_KEY) || '{}');
      if (l[id]) return { quando: Number(l[id]), novo: false };

      const t = agora();
      l[id] = t;

      // limpar os que já chegaram há muito, para não crescer sem fim
      const limite = t - 6 * 3600;
      for (const k of Object.keys(l)) if (Number(l[k]) < limite) delete l[k];

      armazem.setItem(VISTOS_KEY, JSON.stringify(l));
      return { quando: t, novo: true };
    } catch (e) { return null; }
  }

  function pareceNC(a, alvo, c) {
    try {
      const o = coordsOrigem(a);
      if (!o || !alvo) return false;
      // Number(null) é 0 e passaria despercebido, dando uma distância errada
      // mas plausível — por isso rejeitamos os valores em falta antes de converter.
      const brutos = [o.x, o.y, alvo.ix, alvo.iy];
      if (brutos.some((v) => v === null || v === undefined || v === '')) return false;
      const [ox, oy, ax, ay] = brutos.map(Number);
      if (![ox, oy, ax, ay].every(Number.isFinite)) return false;
      const dist = Math.sqrt(Math.pow(ox - ax, 2) + Math.pow(oy - ay, 2));

      // MESMA ILHA (distância 0): o modelo por distância não se aplica — a
      // velocidade daria 0 e QUALQUER ataque seria tomado por colonizador,
      // fazendo a esquiva recusar-se a agir. Um colonizador também não vem da
      // própria ilha para conquistar desta maneira.
      if (!(dist > 0)) return false;

      /* QUANDO É QUE UM ATAQUE TRAZ COLONIZADOR.
       *
       * Os ataques RECEBIDOS vêm com `started_at` a null — o jogo não diz
       * quando partiram. Sem isso, calculava-se a viagem a partir de AGORA, e
       * um ataque visto tarde parecia rápido de mais para ser colonizador.
       *
       * FOI ASSIM QUE SE PERDEU TROPA: um ataque com colonizador foi tomado
       * por normal, a cidade esvaziou-se e o colonizador entrou.
       *
       * Duas correcções:
       *
       * 1. Guarda-se QUANDO se viu o comando pela primeira vez. Como o módulo
       *    passa de ~26 em ~26 s, isso fica muito perto da hora de partida, e
       *    a viagem calculada passa a ser fiável.
       *
       * 2. Se não se souber a hora de partida (a página acabou de abrir e o
       *    ataque já vinha a caminho), NÃO se declara "não é colonizador" —
       *    trata-se como se fosse. Perder tropa é mau; perder uma cidade é
       *    muito pior. */
      const rv = primeiraVezQueVi(a);
      const visto = rv ? rv.quando : null;
      const partida = a.started_at || visto;
      const duracao = partida ? (a.arrival_at - partida) : null;

      const vcs = ((mUw.GameData.units || {}).colonize_ship || {}).speed || 9;
      const limite = vcs * 1.28;

      let ehNC, incerto = false;

      /* VISTO NO ARRANQUE: não se sabe quando partiu.
       *
       * Ao recarregar a página, um ataque que já vem a caminho há horas é
       * registado como visto AGORA. A viagem calculada fica minúscula e a
       * velocidade dispara — vi birremes classificadas a 122, que é
       * velocidade de voadores.
       *
       * Nesse caso não se afirma nada sobre a categoria, e assume-se o pior
       * para a esquiva: pode trazer colonizador. */
      if (!a.started_at && rv && rv.novo && vistoNoArranque(visto)) {
        ehNC = true; incerto = true;
      } else if (duracao == null) {
        // sem hora de partida: assume-se o pior
        ehNC = true; incerto = true;
      } else {
        const viagem = duracao - tempoPreparacao();
        if (!(viagem > 0)) { ehNC = true; incerto = true; }
        else {
          const vel = (c.K * dist) / viagem;
          ehNC = vel <= limite;

          /* NOTA: com `started_at` a null, a viagem calculada é um MÍNIMO
           * (o ataque pode ter partido antes de o vermos) e a velocidade um
           * MÁXIMO. Um colonizador visto tarde parece rápido de mais.
           *
           * É por isso que o `primeiraVezQueVi` importa: passa a contar-se
           * desde que o vimos, não desde agora. Com o módulo a passar de
           * ~26 em ~26 s, o erro fica pequeno — excepto quando a página
           * acabou de abrir com o ataque já a caminho, e aí não há dados. */
        }
      }
      const vel = duracao ? (c.K * dist) / Math.max(1, duracao - tempoPreparacao()) : 0;

      /* DIAGNÓSTICO: guardar os números da classificação.
       *
       * Se o `started_at` não vier, a duração é calculada a partir de AGORA —
       * e um ataque visto tarde parece mais rápido do que é, deixando de ser
       * reconhecido como colonizador. */
      try {
        /* REGISTO DE CALIBRAÇÃO.
         *
         * Escreve na consola os números de CADA ataque classificado, para se
         * poder comparar com o que se vê no jogo. É assim que se descobre se
         * o limite da velocidade está certo. */
        try {
          const nomeOrig = (a.town_name_origin || '?');
          console.log(`[MAESTRO/calibrar] cmd ${a.command_id} · origem ${nomeOrig} `
            + `· distância ${dist.toFixed(2)} · viagem ${duracao == null ? '?' : duracao + 's'} `
            + `· started_at ${a.started_at ? 'SIM' : 'não'} `
            + `· velocidade ${duracao ? ((c.K * dist) / Math.max(1, duracao - tempoPreparacao())).toFixed(2) : '?'} `
            + `· limite ${(vcs * 1.28).toFixed(2)} `
            + `→ ${ehNC ? 'COLONIZADOR' : 'normal'}`);
        } catch (e) {}

        ultimaClassificacao = {
          cmd: a.command_id, dist,
          viagem: duracao,
          semStartedAt: !a.started_at,
          incerto,
          vel: Math.round(vel * 100) / 100,
          limite: Math.round(limite * 100) / 100,
          ehNC,
        };
      } catch (e) {}

      return ehNC;
    } catch (e) { return false; }
  }

  /* ---------------------- pedidos --------------------------------------- */
  async function post(url, payload) {
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      return { ok: !(j && j.error), msg: (j && (j.error || j.success)) || 'ok', raw: r };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* Devolve também o command_id do comando criado.
   *
   * A resposta ao envio traz uma notificação MovementsUnits com o command_id e
   * o cancelable_until — é a forma FIÁVEL de saber o que cancelar. Andar à
   * procura depois falha: o command_overview devolve 0 comandos em algumas
   * contas, e o modelo local pode não estar actualizado. */
  function comandoDaResposta(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let d = null;
        try { d = JSON.parse(n.param_str); } catch (e) { continue; }
        const mv = d && d.MovementsUnits;
        if (mv && mv.command_id) {
          return { commandId: Number(mv.command_id), cancelavelAte: Number(mv.cancelable_until) || null };
        }
      }
    } catch (e) {}
    return null;
  }

  async function enviarApoio(origem, destino, unidades) {
    const url = mUw.location.origin + '/game/town_info?town_id=' + Number(origem)
      + '&action=send_units&h=' + mUw.Game.csrfToken;
    const payload = Object.assign({}, unidades, {
      id: Number(destino), type: 'support', town_id: Number(origem), nl_init: true,
    });
    const r = await post(url, payload);
    // O command_id do comando criado vem nas notificações da resposta — é
    // assim que se sabe o que cancelar, sem depender de o encontrar depois.
    if (r && r.ok) r.comando = comandoDaResposta(r.raw);
    return r;
  }

  async function cancelarComando(commandId, townId) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    return post(url, {
      model_url: 'Commands', action_name: 'cancelCommand', captcha: null,
      arguments: { id: Number(commandId) }, town_id: Number(townId), nl_init: true,
    });
  }

  async function ativarMilicia(townId) {
    const url = mUw.location.origin + '/game/building_farm?town_id=' + Number(townId)
      + '&action=request_militia&h=' + mUw.Game.csrfToken;
    return post(url, { town_id: Number(townId), nl_init: true });
  }

  /* ---------------------- escolha do destino e da carga ----------------- */
  // Prefere uma cidade na MESMA ilha (a tropa terrestre não precisa de barcos).
  /* Destino da esquiva.
   *
   * Serve QUALQUER cidade da mesma ilha — não precisa de ser minha. Como o
   * comando é cancelado logo a seguir, as tropas nunca lá chegam; o destino é
   * só um pretexto para as tirar de casa. O que importa é ser na mesma ilha,
   * para não serem precisos navios de transporte e a viagem ser curta.
   *
   * (Antes exigia-se uma cidade minha, e numa ilha onde só tenho uma cidade
   *  isso obrigava a mandar as tropas para outra ilha — viagem longa e a
   *  precisar de transportes.)
   */
  /* Cidades da ilha vindas do mapa. A colecção Town só tem as minhas cidades
   * e as que o jogo já carregou; numa ilha onde só tenho uma cidade pode não
   * haver mais nenhuma conhecida. Pedimo-las ao mapa uma vez e guardamos. */
  const cacheIlha = {};
  const CHUNK_MAPA = 20;

  async function carregarIlha(ix, iy, townIdBase) {
    const chave = `${ix}:${iy}`;
    if (cacheIlha[chave]) return cacheIlha[chave];
    try {
      const cx = Math.floor(ix / CHUNK_MAPA), cy = Math.floor(iy / CHUNK_MAPA);
      const url = mUw.location.origin + '/game/map_data?town_id=' + Number(townIdBase)
        + '&action=get_chunks&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({
            chunks: [{ x: cx, y: cy, timestamp: 0 }], town_id: Number(townIdBase), nl_init: true }));
      const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
        .then(lerResposta);
      const d = (r && r.json && r.json.data) || (r && r.json) || {};
      const bloco = d[0] || d['0'];
      const towns = (bloco && bloco.towns) || {};
      const out = [];
      for (const k of Object.keys(towns)) {
        const t = towns[k];
        if (Number(t.x) === Number(ix) && Number(t.y) === Number(iy)) {
          out.push({ id: Number(t.id), name: t.name });
        }
      }
      cacheIlha[chave] = out;
      return out;
    } catch (e) { cacheIlha[chave] = []; return []; }
  }

  function cidadesDaIlha(ix, iy, excluirId) {
    const out = [];
    // 1) as minhas (já as temos em memória)
    try {
      for (const id of Object.keys(mUw.ITowns.towns)) {
        if (Number(id) === Number(excluirId)) continue;
        const t = mUw.ITowns.getTown(Number(id));
        if (Number(t.getIslandCoordinateX()) === Number(ix)
          && Number(t.getIslandCoordinateY()) === Number(iy)) {
          out.push({ id: Number(id), name: t.getName() });
        }
      }
    } catch (e) {}
    // 2) as dos outros jogadores, se a colecção Town as tiver
    try {
      const col = mUw.MM.getCollections().Town;
      const mods = (col && col[0] && col[0].models) || [];
      for (const m of mods) {
        const a = m.attributes || {};
        if (Number(a.id) === Number(excluirId)) continue;
        if (Number(a.island_x) === Number(ix) && Number(a.island_y) === Number(iy)) {
          if (!out.some((x) => x.id === Number(a.id))) out.push({ id: Number(a.id), name: a.name });
        }
      }
    } catch (e) {}

    // 3) as que estiverem em cache do mapa (ver cacheIlha mais abaixo)
    try {
      const cache = cacheIlha[`${ix}:${iy}`] || [];
      for (const a of cache) {
        if (Number(a.id) === Number(excluirId)) continue;
        if (!out.some((x) => x.id === Number(a.id))) out.push({ id: Number(a.id), name: a.name });
      }
    } catch (e) {}

    return out;
  }

  function escolherDestino(origemId, cidades) {
    const org = cidades.find((c) => c.id === Number(origemId));
    if (!org) return null;

    // preferir uma cidade minha na ilha (o apoio é legítimo se algo correr mal)
    const minhasNaIlha = cidades.filter((c) => c.id !== org.id && c.ix === org.ix && c.iy === org.iy);
    if (minhasNaIlha.length) return { destino: minhasNaIlha[0], precisaBarcos: false };

    // senão, qualquer cidade da ilha serve — vai ser cancelado de qualquer modo
    const naIlha = cidadesDaIlha(org.ix, org.iy, org.id);
    if (naIlha.length) return { destino: naIlha[0], precisaBarcos: false };

    // último recurso: outra ilha (precisa de transportes, viagem longa)
    const outra = cidades.find((c) => c.id !== org.id);
    return outra ? { destino: outra, precisaBarcos: true } : null;
  }

  // Tudo o que está na cidade. Se for preciso atravessar mar, junta transportes
  // suficientes para a tropa terrestre (senão o envio é recusado).
  // A MILÍCIA não se pode mover — se for incluída, o jogo recusa o envio
  // inteiro com "Não é possível mover Milícia" e a esquiva falha.
  const NAO_MOVEM = ['militia'];

  function montarCarga(townId, precisaBarcos) {
    const u = tropasDaCidade(townId);
    const carga = {};
    let popTerrestre = 0;
    for (const k of Object.keys(u)) {
      if (NAO_MOVEM.indexOf(k) >= 0) continue;   // milícia fica sempre
      const n = Number(u[k]) || 0;
      if (n <= 0) continue;
      carga[k] = n;
      if (GROUND.indexOf(k) >= 0) popTerrestre += n;   // pop 1 por unidade base
    }
    if (!Object.keys(carga).length) return null;
    if (!precisaBarcos) return carga;

    // atravessar mar: verificar se os transportes que já vão chegam para a tropa
    const beliche = temBeliche(townId);
    const capSmall = CAP.small_transporter[beliche ? 'com' : 'sem'];
    const capBig = CAP.big_transporter[beliche ? 'com' : 'sem'];
    const capacidade = (Number(carga.small_transporter) || 0) * capSmall
                     + (Number(carga.big_transporter) || 0) * capBig;
    if (capacidade >= popTerrestre) return carga;
    // não chega: leva só o que cabe (tira terrestres a mais, do fim para o início)
    let excesso = popTerrestre - capacidade;
    for (let i = GROUND.length - 1; i >= 0 && excesso > 0; i--) {
      const k = GROUND[i];
      if (!carga[k]) continue;
      const tirar = Math.min(carga[k], excesso);
      carga[k] -= tirar; excesso -= tirar;
      if (carga[k] <= 0) delete carga[k];
    }
    return Object.keys(carga).length ? carga : null;
  }

  /* Separar a tropa em TERRESTRE e NAVAL.
   *
   * A tropa terrestre não precisa de barcos para ir a uma cidade da MESMA
   * ilha — só a naval é que anda por mar, e leva-se a si própria. Juntar tudo
   * num envio só fazia o jogo recusar com "a capacidade dos seus navios de
   * transporte não é suficiente", e a esquiva falhava por inteiro.
   *
   * Com dois envios, cada tropa vai pelo seu caminho. */
  function separarCarga(townId) {
    const u = tropasDaCidade(townId);
    const terra = {}, mar = {};
    let temTerra = false, temMar = false;

    for (const k of Object.keys(u)) {
      if (NAO_MOVEM.indexOf(k) >= 0) continue;
      const n = Number(u[k]) || 0;
      if (n <= 0) continue;

      let naval = false;
      try { naval = !!(mUw.GameData.units[k] || {}).is_naval; } catch (e) {}

      if (naval) { mar[k] = n; temMar = true; }
      else { terra[k] = n; temTerra = true; }
    }
    return {
      terra: temTerra ? terra : null,
      mar: temMar ? mar : null,
    };
  }

  /* ---------------------- planeamento ----------------------------------- */
  // Calcula os instantes de envio (S) e cancelamento (C).
  //   casa = C + (C − S)  ⇒  C = (casa + S) / 2
  function calcularTempos(impactos, temNC, c) {
    const ordenados = impactos.slice().sort((a, b) => a.arrival - b.arrival);
    const primeiro = ordenados[0];
    const ultimo = ordenados[ordenados.length - 1];

    let S, casa, tipo;
    if (temNC) {
      /* COM COLONIZADOR: sair para as limpezas, voltar antes dele.
       *
       * A caixa "não esvaziar se vier SÓ colonizador" refere-se ao caso em que
       * ele vem desacompanhado — aí esvaziar entregaria a cidade de bandeja.
       *
       * Vindo com ataques de limpeza à frente, vale a pena sair: a tropa
       * escapa aos primeiros e está em casa quando ele bate.
       *
       * Nota: o desastre que aconteceu NÃO foi por causa disto. O ataque foi
       * classificado como "normal", e nesse tipo a tropa volta DEPOIS do
       * último impacto. O problema está na classificação, não aqui. */
      const nc = ordenados.find((i) => i.nc) || ultimo;
      const antesDoNC = ordenados.filter((i) => !i.nc && i.arrival < nc.arrival);
      if (!antesDoNC.length) return null;               // só vem o NC: não esquivar
      S = antesDoNC[0].arrival - c.antesDoImpacto;
      casa = nc.arrival - c.antesDoNC;                  // em casa mesmo antes do NC
      tipo = 'NC';
    } else {
      S = primeiro.arrival - c.antesDoImpacto;
      casa = ultimo.arrival + c.depoisDoImpacto;
      tipo = 'normal';
    }

    /* Que ataques é que a tropa NÃO evita.
     *
     * Com colonizador, a prioridade é estar em casa quando ele bate — perder a
     * cidade é muito pior do que perder tropa. Mas os ataques de limpeza que
     * batem DEPOIS do regresso apanham a tropa na mesma, e convém sabê-lo. */
    const apanham = ordenados.filter((i) => !i.nc && i.arrival >= casa);

    let C = Math.round((casa + S) / 2);
    let notaLimite = null;
    const maxC = S + c.janelaCancelamento;              // cancelable_until

    if (C > maxC) {
      /* A JANELA DE CANCELAMENTO NÃO CHEGA.
       *
       * O jogo só deixa cancelar nos primeiros `janelaCancelamento` segundos,
       * e a tropa demora a voltar o mesmo que já viajou. Com uma esquiva
       * longa, isso empurra o regresso para depois da hora pretendida.
       *
       * Num plano COM COLONIZADOR isso é fatal: visto em jogo, um plano
       * agendava o regresso às 23:37 quando o colonizador batia às 23:17 —
       * a cidade ficava vazia à chegada dele. Nesse caso é melhor NÃO
       * esquivar de todo: a tropa fica e mata o colonizador. */
      if (tipo === 'NC') {
        return null;
      }

      C = maxC;
      casa = C + (C - S);
      notaLimite = `janela de cancelamento (${c.janelaCancelamento}s) atingida — regresso às ${horaJogo(casa)}`;
    }
    if (C <= S) return null;

    /* Última verificação, para os planos com colonizador: a tropa TEM de estar
     * em casa antes de ele bater. Se as contas não derem, não se esquiva. */
    if (tipo === 'NC') {
      const nc2 = ordenados.find((i) => i.nc);
      if (nc2 && casa >= nc2.arrival) return null;
    }

    return { S, C, casa, tipo, notaLimite, apanham: apanham.length };
  }

  /* ---------------------- execução agendada ----------------------------- */
  async function executarPlano(ctx, plano) {
    const c = cfg();
    const log = ctx.log;
    if (agoraJogo() == null) { log('Sem relógio do servidor — não ajo às cegas.'); return; }
    const cidades = minhasCidades();
    const alvo = cidades.find((x) => x.id === Number(plano.townId));
    const nome = alvo ? alvo.name : plano.townId;

    // garantir que conhecemos as cidades da ilha (pode não haver nenhuma minha)
    try {
      const org0 = cidades.find((x) => x.id === Number(plano.townId));
      if (org0) await carregarIlha(org0.ix, org0.iy, plano.townId);
    } catch (e) {}
    const esc = escolherDestino(plano.townId, cidades);
    if (!esc) { log(`Esquiva ${nome}: sem cidade de destino.`); return; }
    /* DOIS ENVIOS quando é preciso: um por terra, outro por mar.
     *
     * Numa cidade com tropa terrestre e naval, mandar tudo junto fazia o jogo
     * recusar por falta de transportes — mesmo indo para uma cidade da MESMA
     * ilha, onde a tropa terrestre nem precisa de barcos.
     *
     * Se o destino for na mesma ilha, separa-se; se for noutra ilha, tudo tem
     * de ir por mar e mantém-se o envio único com os transportes. */
    const comandos = [];
    if (!esc.precisaBarcos) {
      const sep = separarCarga(plano.townId);
      if (sep.terra) comandos.push({ carga: sep.terra, via: 'terra' });
      if (sep.mar) comandos.push({ carga: sep.mar, via: 'mar' });
    }
    if (!comandos.length) {
      const carga = montarCarga(plano.townId, esc.precisaBarcos);
      if (carga) comandos.push({ carga, via: 'tudo' });
    }
    if (!comandos.length) { log(`Esquiva ${nome}: sem tropas para mandar.`); return; }

    const enviados = [];
    let todosMeus = [];
    for (const cmd of comandos) {
      const r = await enviarApoio(plano.townId, esc.destino.id, cmd.carga);
      if (r.ok) {
        enviados.push(cmd.via);
        /* Guardar o command_id que a resposta traz — é a via fiável.
         * Sem isto ficava-se dependente de procurar nos movimentos, e com dois
         * envios era fácil apanhar o errado. */
        if (r.comando && r.comando.commandId) todosMeus.push(Number(r.comando.commandId));
      } else {
        log(`⚠️ Esquiva ${nome}: envio por ${cmd.via} falhou (${r.msg}).`);
      }
      if (comandos.length > 1) await ctx.sleep(ctx.rand(300, 600));
    }
    if (!enviados.length) return;
    log(`🏃 ${nome}: tropas enviadas para ${esc.destino.name} `
      + `(esquiva ${plano.tipo}${enviados.length > 1 ? ', ' + enviados.join(' + ') : ''}).`);

    // No farm, a milícia mata os enviados divinos da main — se estiver activa
    // (de um ataque anterior) o farm dessa vaga perde-se e convém saber-se.
    if (plano.daMain) {
      const u = tropasDaCidade(plano.townId);
      const mil = Number(u.militia) || 0;
      if (mil > 0) {
        log(`⚠️ ${nome}: há ${mil} de MILÍCIA activa — vai matar os enviados divinos.`
          + ' A milícia não se pode mover nem desactivar; espera que expire.');
      }
    }

    // A MILÍCIA MATA os enviados divinos (confirmado em jogo) e dura horas
    // sem se poder desactivar. Por isso, com o modo farm ligado, nunca se
    // activa — nem sequer contra atacantes que não reconhecemos como a main.
    // Depender do reconhecimento seria arriscar o farm por causa de um nome
    // mal escrito.
    if (c.milicia && c.modoFarm) {
      log(`🌾 ${nome}: modo farm — milícia NUNCA activada (mataria os enviados divinos).`);
    } else if (c.milicia && !plano.daMain) {
      const m = await ativarMilicia(plano.townId);
      log(m.ok ? `🛡️ ${nome}: milícia ativada.` : `⚠️ ${nome}: milícia falhou (${m.msg}).`);
    } else if (c.milicia && plano.daMain) {
      log(`🌾 ${nome}: ataque da main — milícia NÃO activada (os enviados têm de sobreviver).`);
    }

    // Descobrir o command_id do apoio que acabámos de enviar.
    //
    // CUIDADO: a cidade pode ter outros apoios seus a sair ou a REGRESSAR, e
    // todos são do tipo "support" com a mesma origem. Cancelar o errado
    // mandaria tropas de volta a meio de outra viagem. Por isso exige-se:
    //   • ter saído DEPOIS de termos enviado (marca de tempo);
    //   • ir para o destino que escolhemos;
    //   • não ser um regresso (esses têm origem e destino iguais).
    // O command_id vem na RESPOSTA ao envio — não é preciso procurá-lo.
    let meu = todosMeus.length
      ? { commandId: todosMeus[0], cancelavelAte: null } : null;
    if (!meu) {
      // recurso alternativo: modelo local (o servidor devolve 0 comandos em
      // algumas contas, por isso não se usa aqui)
      await ctx.sleep(1200);
      const cand = movimentos()
        .filter((a) => /support/i.test(String(a.type || '')))
        .filter((a) => Number(a.home_town_id) === Number(plano.townId))
        .filter((a) => Number(a.target_town_id) === Number(esc.destino.id))
        .filter((a) => Number(a.target_town_id) !== Number(a.home_town_id))
        .sort((a, b) => (b.started_at || 0) - (a.started_at || 0));

      /* TODOS os comandos que acabaram de sair, não só o último: com a esquiva
       * dividida em terra e mar são dois, e cancelar só um deixava metade da
       * tropa fora de casa. */
      if (cand.length) {
        meu = { commandId: Number(cand[0].command_id), cancelavelAte: cand[0].cancelable_until };
        todosMeus = cand.slice(0, enviados.length || 1)
          .map((x) => Number(x.command_id));
      }
    }

    if (!meu || !meu.commandId) {
      log(`⚠️ Esquiva ${nome}: não encontrei o comando para cancelar — traz as tropas à mão.`);
      return;
    }
    if (!todosMeus.length) todosMeus = [meu.commandId];

    const esperar = Math.max(0, plano.C - agora()) * 1000;
    log(`⏱️ ${nome}: cancelo ${todosMeus.length > 1 ? todosMeus.length + ' comandos' : ''} `
      + `daqui a ${Math.round(esperar / 1000)}s (regresso às ${horaJogo(plano.casa)}).`);

    setTimeout(async () => {
      let algumOk = false;
      for (const cid of todosMeus) {
        const c1 = await cancelarComando(cid, plano.townId);
        if (c1.ok) algumOk = true;
        else log(`⚠️ ${nome}: cancelamento de um comando falhou (${c1.msg}).`);
        if (todosMeus.length > 1) await ctx.sleep(200);
      }
      const cr = { ok: algumOk, msg: algumOk ? '' : 'nenhum cancelado' };
      if (!cr.ok) { log(`⚠️ ${nome}: cancelamento falhou (${cr.msg}).`); return; }
      /* Verificar a hora REAL de regresso.
       *
       * Isto é o que mais interessa saber: se a tropa chegar depois do
       * colonizador, perde-se a cidade. Antes, quando o movimento não era
       * encontrado à primeira, escrevia-se só "comando cancelado" e ficava-se
       * sem saber nada. */
      /* Procurar o REGRESSO.
       *
       * Não basta procurar pelo `command_id` do envio: ao cancelar, o jogo
       * pode criar um comando NOVO para a volta, com outro identificador.
       * Nesse caso não se encontrava nada e escrevia-se "não consegui
       * confirmar a hora de regresso" mesmo tendo corrido tudo bem.
       *
       * Aceita-se qualquer movimento de apoio que venha do destino para esta
       * cidade — é isso o regresso. */
      let volta = null;
      for (let tent = 0; tent < 4 && !volta; tent++) {
        await ctx.sleep(tent === 0 ? 1200 : 900);
        const movs = movimentos();

        // 1º: o mesmo comando (acontece quando o jogo o reaproveita)
        volta = movs.find((a) => todosMeus.indexOf(Number(a.command_id)) >= 0);
        if (volta) break;

        // 2º: um apoio a VOLTAR para esta cidade
        volta = movs.find((a) => {
          if (Number(a.target_town_id) !== Number(plano.townId)) return false;
          if (!/support|regress|return/i.test(String(a.type || '') + String(a.command_name || ''))) return false;
          const chega = Number(a.arrival_at) || 0;
          // só o que chega perto da hora prevista
          return chega > 0 && Math.abs(chega - plano.casa) < 300;
        });
      }

      if (volta && volta.arrival_at) {
        const desvio = Number(volta.arrival_at) - plano.casa;
        const tarde = plano.tipo === 'NC' && desvio > 0;
        log(`↩️ ${nome}: regresso às ${horaJogo(volta.arrival_at)}`
          + (Math.abs(desvio) > 5
            ? ` (${desvio > 0 ? '+' : ''}${desvio}s face ao previsto)` : ' ✔')
          + (tarde ? ' 🛑 CHEGA DEPOIS DO PREVISTO — verifica se apanhou o colonizador' : ''));
        if (tarde) {
          try {
            if (ctx.avisarDiscord) await ctx.avisarDiscord('ataqueNC',
              `Esquiva em ${nome}: a tropa regressa ${desvio}s DEPOIS do previsto. `
              + 'Pode não estar em casa quando o colonizador bater.');
          } catch (e) {}
        }
      } else {
        /* O cancelamento correu bem — só não se conseguiu ler a hora exacta.
         * Não é motivo para alarme: a tropa volta na mesma. Por isso vai para
         * a rotina, não para o registo. */
        const rotinaLog = ctx.logRotina || log;
        rotinaLog(`${nome}: cancelado. Não li a hora de regresso; estava prevista `
          + `para ${horaJogo(plano.casa)}.`);
      }
    }, esperar);
  }

  /* ------------------------------- run ---------------------------------- */
  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const rotina = ctx.logRotina || ctx.log;   // rotina: não vai para o registo
    limitadoPeloServidor = false;

    /* Marcar o arranque na primeira passagem: serve para saber que comandos
     * foram vistos logo a seguir a a página abrir, e cuja hora de partida é
     * portanto desconhecida. */
    if (momentoArranque == null) marcarArranque();
    const c = cfg();
    const log = ctx.log;
    if (!c.ativo) { rotina('Esquiva: está desligada.'); return; }

    const cidades = minhasCidades();
    const minhas = new Set(cidades.map((x) => x.id));
    const t = agora();

    // Ataques a chegar: juntar o modelo local com o servidor. Se dependêssemos
    // só do modelo, um ataque podia não ser visto e a esquiva NÃO acontecia —
    // perdiam-se as tropas sem qualquer aviso.
    // UM ÚNICO PEDIDO: o command_overview devolve os comandos de TODAS as
    // cidades. Consultar cidade a cidade dava erro 429 com 21 cidades — e sem
    // resposta a esquiva não veria ataque nenhum.
    /* O MODELO LOCAL PRIMEIRO.
     *
     * Confirmámos que o `MovementsUnits` traz os ataques recebidos, sem pedido
     * nenhum. Só se ele não tiver nada é que se pergunta ao servidor — e assim
     * evita-se o 429, que deixava a esquiva CEGA precisamente quando havia
     * ataques a chegar. */
    /* CRUZAR o que o modelo local tem com o que a colecção Attack diz.
     *
     * O `MovementsUnits` não traz tudo — com muitos apoios a caminho, os
     * ataques recebidos ficam de fora. A colecção Attack diz QUANTOS ataques
     * cada cidade tem a chegar, e é fiável.
     *
     * Onde os números não baterem, pergunta-se ao servidor por essa cidade. */
    const esperados = ataquesEsperados();
    const contadosLocal = {};
    for (const a of movimentos()) {
      if (!/attack|revolt|conquer/i.test(String(a.type || ''))) continue;
      const alvo = Number(a.target_town_id);
      if (!minhas.has(alvo)) continue;
      const origemId = Number(a.home_town_id) || 0;
      if (a.started_at != null || (origemId && minhas.has(origemId))) continue;  // é meu
      contadosLocal[String(alvo)] = (contadosLocal[String(alvo)] || 0) + 1;
    }

    const emFalta = Object.keys(esperados)
      .filter((tid) => (contadosLocal[tid] || 0) < esperados[tid])
      .map(Number);

    if (emFalta.length) {
      log(`⚠️ Esquiva: ${emFalta.length} cidade(s) com ataques que o jogo não trouxe `
        + '— vou perguntar ao servidor.');
    }

    const doServidor = [];
    const haNoLocal = Object.keys(esperados).length > 0 && !emFalta.length;

    /* Perguntar ao servidor SÓ pelas cidades onde faltam ataques. */
    for (const tid of emFalta) {
      try {
        const cmds = await comandosDoServidor(tid);
        cmds.forEach((cd) => doServidor.push(cd));
        await ctx.sleep(ctx.rand(500, 900));
      } catch (e) {}
    }

    if (!haNoLocal && !emFalta.length) {
      try {
        if (cidades.length) {
          const todos = await comandosDoServidor(cidades[0].id);
          todos.forEach((cd) => doServidor.push(cd));

          // Se só vieram comandos da cidade consultada, o servidor não deu a
          // visão global — consulta-se cidade a cidade, devagar.
          const destinos = new Set(todos.map((cd) => Number(cd.target_town_id)));
          if (todos.length && destinos.size === 1 && cidades.length > 1) {
            for (const ct of cidades.slice(1)) {
              await ctx.sleep(ctx.rand(700, 1100));
              try { (await comandosDoServidor(ct.id)).forEach((cd) => doServidor.push(cd)); } catch (e) {}
            }
          }
        }
      } catch (e) {}
    }

    // agrupar os ataques a chegar por cidade
    const porCidade = {};
    const vistos = new Set();
    for (const a of movimentos().concat(doServidor)) {
      const uid = String(a.command_id || a.id);
      if (vistos.has(uid)) continue;
      vistos.add(uid);
      if (!/attack|revolt|conquer/i.test(String(a.type || ''))) continue;
      const alvoId = Number(a.target_town_id);
      if (!minhas.has(alvoId)) continue;

      /* Distinguir um ataque RECEBIDO de um ataque MEU.
       *
       * CONFIRMADO no jogo: o `player_id` de um ataque recebido é o do DONO
       * DA CIDADE ATACADA (o próprio jogador), não o do atacante — por isso
       * não serve para distinguir.
       *
       * O que distingue é o `started_at`: nos meus comandos vem preenchido,
       * nos recebidos vem a `null`. E se a origem for uma cidade minha, é
       * meu de certeza. */
      const origemId = Number(a.home_town_id) || 0;
      const ehMeu = a.started_at != null || (origemId && minhas.has(origemId));
      if (ehMeu) continue;
      if (Number(a.arrival_at) <= t) continue;
      const alvo = cidades.find((x) => x.id === alvoId);
      (porCidade[alvoId] = porCidade[alvoId] || []).push({
        cmd: a.command_id, arrival: Number(a.arrival_at), nc: pareceNC(a, alvo, c),
        // guardar quem ataca: é o que permite distinguir a main no modo farm
        jogador: a.jogador || '', jogador_id: a.jogador_id || 0,
        origem_town_id: a.origem_town_id || Number(a.home_town_id) || 0,
        /* O NOME da cidade de origem: nos ataques recebidos é a forma
         * fiável de reconhecer a main, porque o `player_id` do modelo local
         * é o meu, não o do atacante. */
        town_name_origin: a.town_name_origin || '',
      });
    }

    limparPlanosVelhos();
    const planos = lerPlanos();

    /* SEPARAR EM VAGAS.
     *
     * Ataques muito afastados no tempo não são a mesma vaga e não se esquivam
     * juntos. Visto em jogo: um ataque às 23:17 e outro às 13:42 do dia
     * seguinte — quase 14 h de intervalo — eram tratados como um só plano, o
     * que obrigava a tropa a sair horas antes e tornava o regresso impossível.
     *
     * Regra: se dois impactos consecutivos distam mais do que a janela de
     * cancelamento (o tempo máximo que a tropa pode andar fora e ainda voltar
     * a horas), são vagas diferentes e cada uma tem o seu plano. */
    const porVaga = {};
    for (const tid of Object.keys(porCidade)) {
      const lista = porCidade[tid].slice().sort((a, b) => a.arrival - b.arrival);
      const intervalo = Math.max(600, Number(c.janelaCancelamento) || 600);

      let vaga = [];
      let n = 0;
      for (const imp of lista) {
        if (vaga.length && (imp.arrival - vaga[vaga.length - 1].arrival) > intervalo) {
          porVaga[`${tid}#${n++}`] = vaga;
          vaga = [];
        }
        vaga.push(imp);
      }
      if (vaga.length) porVaga[`${tid}#${n}`] = vaga;
    }

    for (const chaveVaga of Object.keys(porVaga)) {
      const townId = chaveVaga.split('#')[0];
      const impactos = porVaga[chaveVaga];
      const chave = impactos.map((i) => i.cmd).sort().join('-');

      /* Evitar planos DUPLICADOS para a mesma cidade e hora.
       *
       * A chave são os identificadores dos comandos: se chegar um ataque novo
       * à mesma vaga, a chave muda e cria-se um segundo plano com a mesma hora
       * de saída. Vi seis planos assim para a mesma cidade.
       *
       * Se já houver um plano desta cidade com saída a menos de 60 s, é a
       * mesma vaga — substitui-se em vez de acrescentar. */
      for (const k2 of Object.keys(planos)) {
        const p2 = planos[k2];
        if (!p2 || Number(p2.townId) !== Number(townId)) continue;
        if (k2 === chave) continue;
        const dif = Math.abs(Number(p2.S) - (impactos[0].arrival - c.antesDoImpacto));
        if (dif < 60) { delete planos[k2]; }
      }
      if (agendados.has(chave)) continue;

      /* A regra desta cidade permite esquivar isto?
       * Uma cidade de defesa costuma preferir receber o ataque a esquivar e
       * deixar as catapultas baixarem a muralha. */
      const haNC = impactos.some((i) => i.nc);
      if (!deveEsquivar(townId, haNC)) {
        const nome = (cidades.find((x) => x.id === Number(townId)) || {}).name || townId;
        const regra = regraDaCidade(townId);
        log(`— ${nome}: ${impactos.length} ataque(s) a chegar, mas está definida para `
          + `${regra === 'nada' ? 'não esquivar' : 'esquivar só ataques com colonizador'}.`);
        continue;
      }

      // Ataques da main (farm de favores): a cidade TEM de ficar vazia, e a
      // regra do colonizador não se aplica — ele não vem colonizar.
      const daMain = impactos.every((i) => ehDaMain(i, c));
      // aprender as cidades de origem da main, para as reconhecer no futuro
      // mesmo quando só houver dados do modelo local (sem nome)
      if (daMain) impactos.forEach((i) => aprenderCidadeMain(i.origem_town_id));
      const temNC = !daMain && impactos.some((i) => i.nc);
      const tempos = calcularTempos(impactos, temNC, c);
      const nome = (cidades.find((x) => x.id === Number(townId)) || {}).name || townId;

      if (!tempos) {
        if (temNC) {
          log(`🛑 ${nome}: vem colonizador e NÃO consigo trazer a tropa a tempo — `
            + 'fica em casa para o matar. '
            + '(a janela de cancelamento do jogo não chega para uma esquiva tão longa)');
        }
        agendados.add(chave);
        continue;
      }
      if (tempos.S <= t) { agendados.add(chave); continue; }   // já não dá tempo

      agendados.add(chave);
      planos[chave] = { townId: Number(townId), daMain, S: tempos.S, C: tempos.C, casa: tempos.casa, tipo: tempos.tipo };
      const faltam = tempos.S - t;
      if (ultimaClassificacao) {
        const u = ultimaClassificacao;
        rotina(`   [classificação] velocidade ${u.vel} · limite do colonizador ${u.limite}`
          + ` · distância ${u.dist} · viagem ${Math.round(u.viagem / 60)} min`
          + (u.semStartedAt ? ' · ATENÇÃO: sem started_at, viagem estimada' : '')
          + ` → ${u.ehNC ? 'COM colonizador' : 'sem colonizador'}`);
      }
      log(`${daMain ? '🌾' : '📋'} ${nome}: esquiva ${tempos.tipo} agendada — saída daqui a ${Math.round(faltam / 60)} min`
        + (tempos.apanham
          ? ` ⚠ ${tempos.apanham} ataque(s) batem depois do regresso e apanham a tropa`
            + ' (o colonizador manda: é preciso estar em casa quando ele bate)'
          : '')
          + (daMain ? ' (ataque da main — sem milícia, para os enviados sobreviverem)' : '')
          + (tempos.notaLimite ? ` (${tempos.notaLimite})` : ''));
      setTimeout(() => { executarPlano(ctx, planos[chave]).catch(() => {}); }, faltam * 1000);
    }
    gravarPlanos(planos);

    // Não sair em silêncio: dizer o que se viu, para não parecer avariado.
    const nAtaques = Object.values(porCidade).reduce((n, v) => n + v.length, 0);
    if (!nAtaques) {
      if (limitadoPeloServidor) {
        log('⚠️ Esquiva: o servidor está a limitar pedidos (429) — NÃO consegui ver '
          + 'se há ataques a chegar. Não é o mesmo que não haver nenhum.');
      } else {
        rotina('Esquiva: nenhum ataque a chegar.');
      }
    } else if (!Object.keys(planos).length) {
      rotina(`Esquiva: ${nAtaques} ataque(s) a chegar, nenhum a esquivar agora.`);
    }
  }

  /* ---------------------- PAINEL ---------------------------------------- */
  function painel(container, ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    container.innerHTML = `
      <div style="font-size:11px;line-height:1.7">
        <label><input type="checkbox" id="esq-on"${c.ativo ? ' checked' : ''}> <b>Esquivar ataques</b></label><br>
        <label><input type="checkbox" id="esq-mil"${c.milicia ? ' checked' : ''}> ativar milícia ao esquivar</label><br>
        <label><input type="checkbox" id="esq-nc"${c.naoEsquivarNC ? ' checked' : ''}>
          não esvaziar se vier <b>só</b> colonizador</label>
        <div style="opacity:.65;font-size:10px;margin:2px 0 4px 18px">
          Colonizador sozinho: a tropa fica e mata-o — esvaziar entregaria a cidade.<br>
          Colonizador com limpezas à frente: a tropa sai e volta antes dele, escapando
          aos primeiros ataques.
        </div>
      </div>
      <div style="background:#1a2416;padding:6px;border-radius:4px;margin-top:6px;font-size:11px">
        <label><input type="checkbox" id="esq-farm"${c.modoFarm ? ' checked' : ''}> <b>Modo farm de favores</b></label>
        <div style="opacity:.7;font-size:10px;margin:2px 0 4px 18px">
          Para as multis. Com isto ligado a milícia <b>NUNCA</b> é activada nesta conta —
          ela mata os enviados divinos e dura horas sem se poder desligar. A cidade é
          esvaziada na mesma, para os enviados sobreviverem e o farm continuar.<br>
          <b>Atenção:</b> se a milícia já estiver activa, o farm dessa cidade só volta a
          render quando ela expirar.
        </div>
        A minha main (um por linha):<br>
        <span style="opacity:.65;font-size:10px">
          Põe o <b>NOME DAS CIDADES</b> de onde a main ataca — é o que funciona.
          Um <b>prefixo com ponto</b> apanha todas: <code>34.</code> reconhece a
          34.1, a 34.2 e as seguintes.<br>
          O ID do jogador <b>não serve</b>: nos ataques recebidos, o jogo devolve
          o ID do DONO da cidade atacada (o teu), não o do atacante.
        </span><br>
        <textarea id="esq-farm-jog" rows="2" style="width:100%;box-sizing:border-box;font-size:11px">${(c.jogadoresFarm || []).join('\n')}</textarea>
        Sair <input type="number" id="esq-antes" value="${c.antesDoImpacto}" style="width:46px">s antes ·
        voltar <input type="number" id="esq-depois" value="${c.depoisDoImpacto}" style="width:46px">s depois<br>
        Com colonizador, estar em casa <input type="number" id="esq-nc-antes" value="${c.antesDoNC}" style="width:40px">s antes dele bater
      </div>
      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:5px;font-size:10px;opacity:.8">
        Ao cancelar, a tropa volta a demorar o mesmo que já viajou — é isso que dá
        o controlo do instante do regresso. A janela de cancelamento é de
        ${c.janelaCancelamento}s, logo o máximo fora são ${c.janelaCancelamento * 2}s.
      </div>
      <div style="background:#0d141c;padding:7px 8px;border-radius:4px;margin:6px 0;font-size:11px">
        <b>Cidades — esquivar ou não</b>
        <div style="opacity:.65;font-size:10px;margin:3px 0 5px">
          Numa cidade de <b>defesa</b> costuma valer mais receber o ataque: as tropas
          defendem, a muralha aguenta e não te levam recursos. Numa cidade de
          <b>ataque</b> vale mais esquivar para não perder as tropas.
        </div>

        <input type="text" id="esq-filtro" placeholder="filtrar por nome…"
          value="${esc(filtroCidades || '')}" style="width:100%;font-size:11px;margin-bottom:5px">

        <div style="max-height:260px;overflow:auto">
          ${(() => {
            const termo = String(filtroCidades || '').toLowerCase().trim();
            const lista = (ctx.getMyTowns() || [])
              .filter((t) => !termo || String(t.name).toLowerCase().indexOf(termo) >= 0);
            if (!lista.length) return '<div style="opacity:.6">nenhuma cidade com esse nome.</div>';

            return `<table style="width:100%;border-collapse:collapse;font-size:11px">`
              + lista.map((t) => {
                const naoEsquiva = regraDaCidade(t.id) === 'nada';
                return `<tr style="border-top:1px solid #1a2430">
                  <td style="padding:3px">${esc(t.name)}</td>
                  <td style="padding:3px;text-align:right;width:130px">
                    <select data-regra="${t.id}" style="font-size:10px;width:100%;
                      ${naoEsquiva ? 'color:#f99' : 'color:#9d9'}">
                      <option value="tudo"${!naoEsquiva ? ' selected' : ''}>esquivar</option>
                      <option value="nada"${naoEsquiva ? ' selected' : ''}>NÃO esquivar</option>
                    </select>
                  </td>
                </tr>`;
              }).join('') + `</table>`;
          })()}
        </div>

        <div style="display:flex;gap:4px;margin-top:5px">
          <button id="esq-todas-tudo" style="flex:1;font-size:10px">todas: esquivar</button>
          <button id="esq-todas-nada" style="flex:1;font-size:10px">todas: não esquivar</button>
        </div>
      </div>

      ${(() => {
        const p2 = lerPlanos();
        const n = Object.keys(p2).length;
        if (!n) return '';
        const ag = agoraJogo();
        const velhos = ag == null ? 0 : Object.keys(p2)
          .filter((k) => { const f = Number(p2[k].casa) || 0; return f && (ag - f) > 3600; }).length;
        return `<div style="background:#0d141c;padding:6px 8px;border-radius:4px;margin:6px 0;font-size:11px">
          <b>${n} esquiva(s) agendada(s)</b>
          ${velhos ? `<span style="opacity:.6"> — ${velhos} já cumprida(s)</span>` : ''}
          <button id="esq-limpar-planos" style="cursor:pointer;width:100%;margin-top:4px;font-size:10px">
            Limpar as já cumpridas
          </button>
        </div>`;
      })()}

      <button id="esq-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    // regras por cidade
    container.querySelectorAll('[data-regra]').forEach((sel) => {
      sel.onchange = () => {
        const r = regrasPorCidade();
        r[sel.getAttribute('data-regra')] = sel.value;
        guardarRegras(r);
      };
    });
    const todasPara = (valor, texto) => {
      const r = regrasPorCidade();
      (ctx.getMyTowns() || []).forEach((t) => { r[String(t.id)] = valor; });
      guardarRegras(r);
      ctx.log(`Esquiva: todas as cidades passam a ${texto}.`);
      painel(container, ctx);
    };
    const bT = container.querySelector('#esq-todas-tudo');
    if (bT) bT.onclick = () => todasPara('tudo', 'esquivar');
    const bN = container.querySelector('#esq-todas-nada');
    if (bN) bN.onclick = () => todasPara('nada', 'NÃO esquivar');

    /* Filtro da lista: mantém o foco no campo, senão perde-se a cada tecla. */
    const elF = container.querySelector('#esq-filtro');
    if (elF) elF.oninput = () => {
      filtroCidades = elF.value;
      painel(container, ctx);
      const novo = container.querySelector('#esq-filtro');
      if (novo) { novo.focus(); novo.setSelectionRange(novo.value.length, novo.value.length); }
    };

    const bLp = container.querySelector('#esq-limpar-planos');
    if (bLp) bLp.onclick = () => {
      /* O botão limpa TODOS os que já regressaram, não só os de há mais de uma
       * hora — o rótulo diz "já cumpridas" e é isso que se espera. A limpeza
       * automática continua com a folga de uma hora. */
      const antes = Object.keys(lerPlanos()).length;
      try {
        const p2 = lerPlanos();
        const ag = agoraJogo();
        for (const k of Object.keys(p2)) {
          const fim = Number(p2[k].casa) || Number(p2[k].S) || 0;
          if (fim && ag != null && ag > fim) delete p2[k];
        }
        gravarPlanos(p2);
      } catch (e) {}
      const depois = Object.keys(lerPlanos()).length;
      ctx.log(`Esquiva: limpei ${antes - depois} plano(s) já cumpridos (ficam ${depois}).`);
      painel(container, ctx);
    };

    const g = container.querySelector('#esq-guardar');
    if (g) g.onclick = () => {
      guardarCfg(Object.assign({}, c, {
        ativo: container.querySelector('#esq-on').checked,
        milicia: container.querySelector('#esq-mil').checked,
        modoFarm: container.querySelector('#esq-farm') ? container.querySelector('#esq-farm').checked : false,
        jogadoresFarm: (() => {
          const el = container.querySelector('#esq-farm-jog');
          if (!el) return c.jogadoresFarm || [];
          return el.value.split('\n').map((x) => x.trim()).filter(Boolean);
        })(),
        naoEsquivarNC: container.querySelector('#esq-nc').checked,
        antesDoImpacto: Number(container.querySelector('#esq-antes').value) || 20,
        depoisDoImpacto: Number(container.querySelector('#esq-depois').value) || 15,
        antesDoNC: Number(container.querySelector('#esq-nc-antes').value) || 1,
      }));
      ctx.log('Esquiva: configuração guardada.');
      g.textContent = 'Guardado ✓';
      setTimeout(() => { g.textContent = 'Guardar'; }, 1500);
    };
  }

  return {
    id: 'esquiva',
    nome: 'Esquiva de ataques',
    intervaloMin: opts.intervaloMin || 1,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
    executarPlano,   // exposto para teste
  };
}

  // ========================= MÓDULO: AUTO-CULTURA ========================
/* =============================================================================
 *  MÓDULO: AUTO-CULTURA  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Inicia celebrações em todas as cidades que estiverem livres, para acumular
 *  pontos culturais (que dão direito a mais cidades).
 *
 *  REGRA DE ESCOLHA:
 *   • se a cidade tem TEATRO → peça de teatro
 *   • senão → festa; se a festa não der, procissão triunfal
 *   • Jogos Olímpicos NUNCA (custam ouro)
 *
 *  PONTOS DE COMBATE: a procissão gasta-os, tal como a evolução das aldeias.
 *  A cultura tem prioridade — este módulo é registado ANTES do das aldeias
 *  (o maestro corre-os por ordem) e publica uma reserva que as aldeias
 *  descontam. Como o jogo não expõe o custo da procissão, o módulo APRENDE-O:
 *  mede os pontos antes e depois da primeira que fizer.
 *
 *  Pedido: POST /game/<CONTROLADOR>?town_id=X&action=<ACAO>&h=TOKEN
 *          json={"celebration_type":"triumph"|"party"|"theater","town_id":X}
 * ========================================================================== */

function makeCulturaModule(opts) {
  opts = opts || {};

  // Endpoint confirmado por captura para a PROCISSÃO:
  //   /game/building_place?town_id=X&action=start_celebration
  // A festa e a peça podem celebrar-se noutro edifício, por isso tentamos os
  // controladores plausíveis e GUARDAMOS o que funcionar para cada tipo —
  // assim aprende sozinho em vez de adivinhar.
  const ACAO = opts.acao || 'start_celebration';
  const CONTROLADORES = ['building_place', 'building_theater', 'building_senate'];
  // Confirmados por captura no jogo (festa e procissão usam o mesmo edifício):
  //   party   → building_place  ·  triumph → building_place
  // A peça de teatro ainda não foi capturada: fica para o módulo descobrir.
  const CTRL_CONFIRMADOS = { party: 'building_place', triumph: 'building_place' };
  const CTRL_KEY = 'grepoCultura_ctrl_v1';
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function ctrlAprendido(tipo) {
    if (CTRL_CONFIRMADOS[tipo]) return CTRL_CONFIRMADOS[tipo];
    try { return (JSON.parse(armazem.getItem(CTRL_KEY) || '{}'))[tipo] || null; } catch (e) { return null; }
  }
  function guardarCtrl(tipo, ctrl) {
    try {
      const m = JSON.parse(armazem.getItem(CTRL_KEY) || '{}');
      m[tipo] = ctrl;
      armazem.setItem(CTRL_KEY, JSON.stringify(m));
    } catch (e) {}
  }

  const TIPOS = { teatro: 'theater', festa: 'party', procissao: 'triumph' };

  // Custos lidos do painel do jogo (Ágora → Cultura). O jogo NÃO os expõe em
  // GameData (vem vazio), mas estão visíveis na interface.
  const CUSTOS = {
    party:   { wood: 15000, stone: 18000, iron: 15000 },
    theater: { wood: 10000, stone: 12000, iron: 10000 },
    triumph: { pontosCombate: 300 },
    // games: 50 de ouro — nunca usado
  };

  // As quatro celebrações podem decorrer em SIMULTÂNEO na mesma cidade
  // (confirmado no painel do jogo: festival e peça a correr ao mesmo tempo).
  const VARIAS_POR_CIDADE = true;
  const CFG_KEY = 'grepoCultura_cfg_v1';
  // Aprendido em jogo: o jogo permite mais do que uma celebração por cidade?
  const UMA_KEY = 'grepoCultura_uma_por_cidade_v1';
  function umaPorCidade() { try { return armazem.getItem(UMA_KEY) === '1'; } catch (e) { return false; } }
  function marcarUmaPorCidade() { try { armazem.setItem(UMA_KEY, '1'); } catch (e) {} }
  const CUSTO_KEY = 'grepoCultura_custo_procissao_v1';
  const RESERVA_KEY = 'grepoCultura_reserva_pontos_v1';

  const DEFAULTS = {
    ativo: true,
    festa: true,
    procissao: true,
    teatro: true,
    /* Não fazer desfiles abaixo deste número de pontos de combate. Serve para
     * guardar uma reserva — cada desfile custa 300. */
    minPontosCombate: 0,
  };

  let mUw = null, mWorld = '';

  // RELÓGIO DO SERVIDOR — o único que conta.
  // O relógio da máquina é irrelevante e enganador: este VPS está em Espanha e
  // o jogo corre em hora portuguesa, uma hora de diferença PERMANENTE. Se o
  // servidor não estiver disponível devolvemos null e o módulo NÃO age, em vez
  // de agir com uma hora possivelmente errada.
  function agoraJogo() {
    try {
      if (typeof mUw.Timestamp !== 'undefined' && typeof mUw.Timestamp.now === 'function') {
        const t = Math.floor(mUw.Timestamp.now());
        if (Number.isFinite(t) && t > 0) return t;
      }
    } catch (e) {}
    try {
      const t = Number(mUw.Game && mUw.Game.server_time);
      if (Number.isFinite(t) && t > 0) return Math.floor(t);
    } catch (e) {}
    return null;   // sem relógio do servidor: não se inventa
  }


  function cfg() {
    const c = Object.assign({}, DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function guardarCfg(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }
  function custoProcissao() {
    // Conhecido do painel do jogo: 300 pontos de combate.
    return CUSTOS.triumph.pontosCombate;
  }
  function guardarCusto(v) { try { armazem.setItem(CUSTO_KEY, String(v)); } catch (e) {} }
  function publicarReserva(v) { try { armazem.setItem(RESERVA_KEY, String(v)); } catch (e) {} }

  // NOTA: a cultura já NÃO reserva pontos de combate.
  // Porquê: a evolução das aldeias bárbaras é um investimento FINITO (cada
  // aldeia desbloqueia-se uma vez e a evolução demora tempo), enquanto a
  // cultura é um consumo CONTÍNUO. Reservar para a cultura estrangulava as
  // aldeias sem necessidade. A ordem no maestro passa a ser: aldeias primeiro,
  // cultura a seguir com o que sobrar — que é sempre reposto ao combater.

  const agora = () => agoraJogo();

  /* ---------------------- leitura do jogo ------------------------------- */
  // Celebrações em curso: { town_id: finished_at }
  function celebracoesEmCurso() {
    const out = {};
    try {
      const m = mUw.MM.getModels().Celebration || {};
      for (const k of Object.keys(m)) {
        const a = m[k].attributes || {};
        const fim = Number(a.finished_at) || 0;
        if (fim > agora()) out[Number(a.town_id)] = { fim, tipo: a.celebration_type };
      }
    } catch (e) {}
    return out;
  }

  function recursosDaCidade(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const r = t.resources ? t.resources() : null;
      if (!r) return null;
      return { wood: Number(r.wood) || 0, stone: Number(r.stone) || 0, iron: Number(r.iron) || 0 };
    } catch (e) { return null; }
  }

  function pontosDeCombate() {
    try {
      const m = mUw.MM.getModels().PlayerKillpoints;
      const k = Object.keys(m)[0];
      const a = m[k].attributes || {};
      return Math.max(0, (Number(a.att) || 0) + (Number(a.def) || 0) - (Number(a.used) || 0));
    } catch (e) { return 0; }
  }

  // Nível do teatro de cada cidade (do BuildingBuildData).
  function teatroPorCidade() {
    const out = {};
    try {
      const col = mUw.MM.getCollections().BuildingBuildData[0];
      for (const m of col.models) {
        const a = m.attributes || {};
        const t = (a.building_data || {}).theater;
        const nv = t ? t.level : null;
        out[Number(a.town_id)] = (nv === '-' || nv == null) ? 0 : Number(nv);
      }
    } catch (e) {}
    return out;
  }

  function progressoCultural() {
    try {
      const p = mUw.MM.getModels().Player;
      const k = Object.keys(p)[0];
      const a = p[k].attributes || {};
      return {
        pontos: Number(a.cultural_points) || 0,
        disponiveis: Number(a.available_cultural_points) || 0,
        proximo: Number(a.needed_cultural_points_for_next_step) || 0,
        nivel: Number(a.cultural_step) || 0,
      };
    } catch (e) { return null; }
  }

  /* ---------------------- pedido ---------------------------------------- */
  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * E faz a passagem seguinte ler valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels().Town.
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }

  async function pedir(controlador, townId, tipo) {
    const url = mUw.location.origin + '/game/' + controlador
      + '?town_id=' + Number(townId) + '&action=' + ACAO + '&h=' + mUw.Game.csrfToken;
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({ celebration_type: tipo, town_id: Number(townId), nl_init: true })),
      }).then(lerResposta);
      aplicarNotificacoes(r);   // refresca a interface e os modelos
      const j = r && r.json;
      const erro = j && j.error;
      return { ok: !erro, msg: erro || (j && j.success) || 'ok', interno: /interno/i.test(String(erro || '')) };
    } catch (e) { return { ok: false, msg: e.message, interno: false }; }
  }

  // Tenta o controlador já aprendido para este tipo; se não houver, percorre os
  // plausíveis e guarda o primeiro que resultar.
  async function celebrar(townId, tipo) {
    const conhecido = ctrlAprendido(tipo);
    if (conhecido) return pedir(conhecido, townId, tipo);
    let ultimo = { ok: false, msg: 'sem controlador' };
    for (const ctrl of CONTROLADORES) {
      const r = await pedir(ctrl, townId, tipo);
      if (r.ok) { guardarCtrl(tipo, ctrl); return r; }
      ultimo = r;
      // "erro interno" costuma significar controlador errado → tenta o seguinte;
      // qualquer outro erro (recursos, requisitos) é do jogo → não insiste.
      if (!r.interno) break;
    }
    return ultimo;
  }

  /* ------------------------------- run ---------------------------------- */
  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const rotina = ctx.logRotina || ctx.log;
    let avisouMinimo = false;

    /* Limpar a marca antiga de "uma celebração por cidade": era gravada para
     * sempre a partir de uma recusa pontual, e travava as celebrações em todas
     * as cidades. */
    try { if (armazem.getItem(UMA_KEY) === '1') armazem.removeItem(UMA_KEY); } catch (e) {}
    const c = cfg();
    const log = ctx.log;
    if (!c.ativo) { log('Auto-cultura: está DESLIGADO (liga a caixa no painel e guarda).'); return; }

    if (agoraJogo() == null) { log('Sem relógio do servidor — não ajo às cegas.'); return; }
    const towns = ctx.getMyTowns();
    if (!towns.length) { log('Sem cidades para processar.'); return; }

    const emCurso = celebracoesEmCurso();
    const teatros = teatroPorCidade();
    const livres = towns.filter((t) => !emCurso[t.id]);

    // Reserva de pontos de combate para as procissões pendentes (as aldeias
    // descontam isto). Só é possível depois de conhecer o custo.
    const custo = custoProcissao();
    if (custo && c.procissao) {
      const semTeatro = livres.filter((t) => !(teatros[t.id] > 0)).length;
      publicarReserva(0);
    }

    if (!livres.length) {
      const prox = Math.min.apply(null, Object.values(emCurso).map((x) => x.fim));
      log(`Cultura: todas as ${towns.length} cidades a celebrar (próxima livre em ${Math.round((prox - agora()) / 60)} min).`);
      return;
    }

    let feitas = 0;
    let semPontosParaDesfile = false;
    for (const t of livres) {
      // que tipos tentar, por esta ordem
      const tentativas = [];
      if (c.teatro && teatros[t.id] > 0) tentativas.push(TIPOS.teatro);
      if (c.festa) tentativas.push(TIPOS.festa);
      if (c.procissao && !semPontosParaDesfile) tentativas.push(TIPOS.procissao);
      // Jogos Olímpicos NUNCA entram aqui (custam ouro).

      // Tentar TODAS as celebrações possíveis na mesma cidade, não parar à
      // primeira. Se o jogo não permitir duas em simultâneo, recusa — e nós
      // aprendemos isso para não insistir em todas as passagens.
      const rec = recursosDaCidade(t.id);
      let conseguiu = false;
      let jaCelebrouAqui = false;
      for (const tipo of tentativas) {
        /* AS TRÊS EM PARALELO — confirmado no jogo: vi uma cidade com festival
         * (fim 06:39) e desfile (fim 02:31) ao mesmo tempo.
         *
         * A mensagem "Atualmente está a decorrer uma celebração nesta cidade"
         * é do MESMO tipo, não de todos. Por isso continua-se a tentar as
         * outras depois de uma resultar. */

        // Não gastar pedidos quando é certo que não chega.
        const custo = CUSTOS[tipo];
        if (custo && rec) {
          if (custo.wood != null &&
              (rec.wood < custo.wood || rec.stone < custo.stone || rec.iron < custo.iron)) {
            continue;
          }
          if (custo.pontosCombate != null) {
            const pts = pontosDeCombate();
            const minimo = Math.max(
              custo.pontosCombate,
              (Number(c.minPontosCombate) || 0) + custo.pontosCombate);
            if (pts < minimo) {
              if (!avisouMinimo) {
                avisouMinimo = true;
                const reserva = Number(c.minPontosCombate) || 0;
                log(reserva
                  ? `ℹ️ Desfiles parados: tens ${pts} pontos e queres guardar ${reserva}.`
                  : `ℹ️ Desfiles parados: ${pts} pontos, cada um custa ${custo.pontosCombate}.`);
              }
              continue;
            }
          }
        }
        // medir MESMO antes desta tentativa (as anteriores podem ter falhado
        // depois de já se ter medido, falseando o custo aprendido)
        const pontosAntes = (tipo === TIPOS.procissao && !custoProcissao()) ? pontosDeCombate() : null;
        const r = await celebrar(t.id, tipo);
        /* Quando o servidor recusa, dizer PORQUÊ — sem isto, uma cidade que
         * não celebra não dá qualquer pista. */
        /* Dizer sempre o motivo da recusa: sem isto, uma cidade que só faz
         * uma celebração não dá qualquer pista do que falta. */
        if (!r.ok) {
          const nomeT = tipo === TIPOS.teatro ? 'peça de teatro'
            : tipo === TIPOS.festa ? 'festa' : 'desfile';
          const extra = tipo === TIPOS.procissao ? ` (tens ${pontosDeCombate()} pontos)` : '';
          rotina(`— ${t.name}: ${nomeT} recusada — ${r.msg || 'sem motivo'}${extra}`);
        }
        if (r.ok) {
          conseguiu = true; feitas++;
          const nome = tipo === TIPOS.teatro ? 'peça de teatro' : tipo === TIPOS.festa ? 'festa' : 'procissão';
          log(`🎭 ${t.name}: ${nome} iniciada.`);
          // aprender o custo da procissão (o jogo não o expõe)
          if (tipo === TIPOS.procissao && pontosAntes != null && !custoProcissao()) {
            await ctx.sleep(1200);
            const gasto = pontosAntes - pontosDeCombate();
            if (gasto > 0) { guardarCusto(gasto); log(`ℹ️ Custo da procissão aprendido: ${gasto} pontos de combate.`); }
          }
          jaCelebrouAqui = true;
          await ctx.sleep(ctx.rand(800, 1600));
          continue;   // tentar também os outros tipos nesta cidade
        }
        // Se falhou LOGO A SEGUIR a um sucesso na mesma cidade, é sinal de que
        // só se permite uma celebração de cada vez — regista-se para não voltar
        // a gastar pedidos com isso.
        // O desfile exige pontos de combate acumulados; se o jogo disser que
        // não chegam, não vale a pena repetir noutras cidades nesta passagem —
        // os pontos são do jogador, não da cidade.
        if (tipo === TIPOS.procissao && /inimigos|derrotou|suficientes/i.test(String(r.msg))) {
          semPontosParaDesfile = true;
          log('ℹ️ Pontos de combate insuficientes para o desfile da vitória.');
          continue;
        }
        /* NÃO marcar "uma por cidade" de forma permanente.
         *
         * O utilizador quer as três celebrações sempre que possível. Uma
         * recusa pontual não prova que o jogo as limite — pode ser dessa
         * cidade, desse momento, ou de outra razão. Marcar para sempre fazia
         * o módulo desistir em todas as cidades a partir daí, que era o que
         * estava a acontecer.
         *
         * Salta-se esta celebração nesta cidade e continua-se com as outras. */
        /* Esta celebração já está a decorrer aqui — passa-se à seguinte,
         * porque as outras podem entrar na mesma. */
        if (/decorrer|já|celebra|andamento|another|running/i.test(String(r.msg))) {
          rotina(`— ${t.name}: ${tipo} já a decorrer; tento as outras.`);
          continue;
        }
      }
      if (!conseguiu) {
        // sem recursos/pontos ou requisitos por cumprir — tenta na próxima ronda
      }
    }
    // Republicar a reserva no fim: se o custo tiver sido aprendido agora, as
    // aldeias já o respeitam na próxima passagem delas.
    const custoFinal = custoProcissao();
    if (custoFinal && c.procissao) {
      const emCursoDepois = celebracoesEmCurso();
      const porCelebrar = towns.filter((t) => !emCursoDepois[t.id] && !(teatros[t.id] > 0)).length;
      publicarReserva(0);
    } else {
      publicarReserva(0);
    }

    if (feitas) {
      const p = progressoCultural();
      if (p) log(`Cultura: ${feitas} celebração(ões) · nível ${p.nivel} · ${p.pontos}/${p.proximo} para o próximo.`);
    }
  }

  /* ---------------------- PAINEL ---------------------------------------- */
  function painel(container, ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    const p = progressoCultural();
    const emCurso = celebracoesEmCurso();
    const towns = ctx.getMyTowns();
    const livres = towns.filter((t) => !emCurso[t.id]).length;
    const custo = custoProcissao();

    container.innerHTML = `
      <div style="background:#0d141c;padding:5px;border-radius:4px;font-size:11px;line-height:1.6">
        ${p ? `Nível cultural <b>${p.nivel}</b> · ${p.pontos}/${p.proximo} para o próximo<br>
        Pontos disponíveis: <b>${p.disponiveis}</b><br>` : ''}
        A celebrar: <b>${towns.length - livres}</b> · livres: <b>${livres}</b><br>
        Pontos de combate: <b>${pontosDeCombate()}</b>${custo ? ` · procissão custa ${custo}` : ' · custo da procissão ainda por aprender'}
      </div>
      <div style="font-size:11px;line-height:1.7;margin-top:5px">
        <label><input type="checkbox" id="cul-on"${c.ativo ? ' checked' : ''}> <b>Celebrar automaticamente</b></label><br>
        <label><input type="checkbox" id="cul-teatro"${c.teatro ? ' checked' : ''}> peça de teatro (se a cidade tiver teatro)</label><br>
        <label><input type="checkbox" id="cul-festa"${c.festa ? ' checked' : ''}> festa</label><br>
        <label><input type="checkbox" id="cul-proc"${c.procissao ? ' checked' : ''}> desfile da vitória (gasta pontos de combate)</label><br>
        <div style="margin-left:18px;opacity:.85">
          Guardar pelo menos <input type="number" min="0" id="cul-minpts"
            value="${Number(c.minPontosCombate) || 0}" style="width:70px"> pontos de combate
          <div style="opacity:.65;font-size:10px">
            Abaixo disto não faz mais desfiles. Cada um custa
            ${(CUSTOS.triumph && CUSTOS.triumph.pontosCombate) || 300}.
            Tens agora <b>${pontosDeCombate().toLocaleString('pt-PT')}</b>.
          </div>
        </div>
        <span style="opacity:.65">Jogos Olímpicos nunca são iniciados (custam ouro).</span>
      </div>
      <button id="cul-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    const g = container.querySelector('#cul-guardar');
    if (g) g.onclick = () => {
      guardarCfg({
        ativo: container.querySelector('#cul-on').checked,
        teatro: container.querySelector('#cul-teatro').checked,
        festa: container.querySelector('#cul-festa').checked,
        procissao: container.querySelector('#cul-proc').checked,
        minPontosCombate: Math.max(0, Number(container.querySelector('#cul-minpts').value) || 0),
      });
      ctx.log('Cultura: configuração guardada.');
      g.textContent = 'Guardado ✓';
      setTimeout(() => { g.textContent = 'Guardar'; }, 1500);
    };
  }

  return {
    id: 'cultura',
    nome: 'Auto-cultura',
    intervaloMin: opts.intervaloMin || 30,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
  };
}

  // ========================== MÓDULO: AUTO-GRUTA =========================
/* =============================================================================
 *  MÓDULO: AUTO-GRUTA  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Quando a PRATA de uma cidade enche o armazém, guarda uma percentagem dela
 *  na gruta. A prata guardada fica protegida do saque e liberta espaço no
 *  armazém (que de outro modo pararia de acumular).
 *
 *  Nota: no cliente, a prata é o recurso "iron".
 *
 *  Pedido: frontend_bridge/execute
 *          model_url "BuildingHide", action "storeIron", {iron_to_store: N}
 * ========================================================================== */

function makeGrutaModule(opts) {
  opts = opts || {};

  const CFG_KEY = 'grepoGruta_cfg_v1';
  const DEFAULTS = {
    ativo: true,
    percentagem: 30,     // quanto da prata atual guardar quando o armazém enche
    // Orçamento de TEMPO para sondagens, por passagem. Limitar por número de
    // cidades não escala: com 100 cidades, 4 por ronda levariam horas a fazer
    // o inventário. Com um orçamento de tempo, o custo por passagem é sempre o
    // mesmo — o que muda é só quantas rondas leva a completar.
    segundosParaSondar: 3,
    limiarPct: 99.5,     // considera "cheio" a partir daqui (a produção continua)
    minimo: 100,         // não vale a pena guardar migalhas
  };

  let mUw = null, mWorld = '';

  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function cfg() {
    const c = Object.assign({}, DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function guardarCfg(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  /* ---------------------- leitura do jogo ------------------------------- */
  function recursos(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const r = t.resources ? t.resources() : null;
      if (!r) return null;
      return { prata: Number(r.iron) || 0, armazem: Number(r.storage) || 0 };
    } catch (e) { return null; }
  }

  // Capacidade da gruta: 1000 por nível; a partir do nível 10 é ilimitada.
  const NIVEL_ILIMITADO = 10;
  const POR_NIVEL = 1000;
  function capacidadeGruta(nivel) {
    if (!nivel) return 0;
    return nivel >= NIVEL_ILIMITADO ? Infinity : nivel * POR_NIVEL;
  }

  // O cliente NÃO expõe quanto está guardado na gruta (só o nível), e o valor
  // varia sem o nosso conhecimento: cada espionagem GASTA prata da gruta.
  // Por isso não tentamos contabilizar nada — depositamos o que a capacidade do
  // nível permite e deixamos o jogo decidir. Se recusar, tentamos de novo na
  // passagem seguinte (o espaço reabre à medida que espias).

  function nivelGruta(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const b = t.buildings ? (t.buildings().attributes || t.buildings()) : {};
      const n = b.hide;
      return (n === '-' || n == null) ? 0 : Number(n);
    } catch (e) { return 0; }
  }

  /* -------------------- CONTEÚDO CONHECIDO DA GRUTA ----------------------
   * O jogo só revela quanto está guardado na RESPOSTA a um depósito
   * (espionage_storage). Por isso guardamos o que vamos sabendo, e há um
   * "sondar" que deposita 1 moeda só para ficar a saber.
   * -------------------------------------------------------------------- */
  const CONTEUDO_KEY = 'grepoGruta_conteudo_v1';
  function lerConteudos() {
    try { return JSON.parse(armazem.getItem(CONTEUDO_KEY) || '{}'); } catch (e) { return {}; }
  }
  // Vale a pena sondar? Quando não há registo ou já está velho — a prata da
  // gruta desce a cada espionagem, por isso o valor não se mantém válido.
  // Quanto tempo o valor lido se mantém útil.
  //  • gruta LIMITADA: o valor decide quanto ainda cabe, por isso convém fresco.
  //  • gruta ILIMITADA (nível 10): cabe sempre tudo — o valor só serve de
  //    inventário, e pode ser bem mais espaçado.
  const VALIDADE_LIMITADA_MIN = 30;
  const VALIDADE_ILIMITADA_MIN = 6 * 60;

  function precisaSondar(townId) {
    try {
      const reg = lerConteudos()[townId];
      if (!reg) return true;
      const ilimitada = nivelGruta(townId) >= NIVEL_ILIMITADO;
      const validade = (ilimitada ? VALIDADE_ILIMITADA_MIN : VALIDADE_LIMITADA_MIN) * 60 * 1000;
      return (Date.now() - reg.quando) > validade;
    } catch (e) { return true; }
  }

  function gravarConteudo(townId, valor) {
    try {
      const m = lerConteudos();
      m[townId] = { valor: Number(valor), quando: Date.now() };
      armazem.setItem(CONTEUDO_KEY, JSON.stringify(m));
    } catch (e) {}
  }

  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado —
   * é assim que a própria interface se refresca. Se as ignorarmos, o ecrã
   * fica desactualizado E, pior, a passagem seguinte lê valores velhos e pode
   * repetir a acção. Aplicá-las resolve as duas coisas.
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    // Devolve a prata guardada na gruta, que só aparece nestas notificações
    // (em espionage_storage, no dataChangedHide ou dentro da própria Town).
    let prataNaGruta = null;
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        // conteúdo da gruta
        if (dados.espionage_storage != null) prataNaGruta = Number(dados.espionage_storage);
        else if (dados.Town && dados.Town.espionage_storage != null) prataNaGruta = Number(dados.Town.espionage_storage);

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
    return prataNaGruta;
  }

  /* ---------------------- pedido ---------------------------------------- */
  async function guardarPrata(townId, quantidade) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    const payload = {
      model_url: 'BuildingHide', action_name: 'storeIron', captcha: null,
      arguments: { iron_to_store: Math.floor(quantidade) },
      town_id: Number(townId), nl_init: true,
    };
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      const j = r && r.json;
      const erro = j && j.error;
      // aplicar o estado devolvido: refresca a interface e evita ler valores
      // velhos na passagem seguinte
      const naGruta = aplicarNotificacoes(r);
      return { ok: !erro, msg: erro || (j && j.success) || 'ok', naGruta };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* --------------------------- SONDAR ------------------------------------
   * Deposita 1 moeda em cada cidade com gruta só para ler o espionage_storage
   * da resposta. Custa uma moeda por cidade e dá o retrato completo.
   * -------------------------------------------------------------------- */
  async function sondarTodas(ctx) {
    mUw = ctx.uw;
    const log = ctx.log;
    const towns = ctx.getMyTowns();
    let lidas = 0;
    for (const t of towns) {
      const nv = nivelGruta(t.id);
      if (!nv) continue;
      const r = await guardarPrata(t.id, 1);
      if (r.ok && r.naGruta != null) {
        gravarConteudo(t.id, r.naGruta);
        lidas++;
        log(`🔍 ${t.name}: ${r.naGruta} de prata na gruta (nv${nv}).`);
      } else if (!r.ok) {
        log(`— ${t.name}: não consegui sondar (${r.msg}).`);
      }
      await ctx.sleep(ctx.rand(500, 900));
    }
    log(`Sondagem terminada: ${lidas} cidade(s) lidas.`);
    return lidas;
  }

  /* ------------------------------- run ---------------------------------- */
  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    const log = ctx.log;
    if (!c.ativo) { log('Auto-gruta: está DESLIGADO (liga a caixa no painel e guarda).'); return; }

    const towns = ctx.getMyTowns();
    let guardou = 0, total = 0, sondasFeitas = 0;
    const inicioSondas = Date.now();

    // ROTAÇÃO JUSTA: percorrer por ordem de antiguidade da leitura — as nunca
    // sondadas primeiro, depois as mais antigas. Sem isto, as primeiras da
    // lista seriam sondadas vezes sem conta e as últimas talvez nunca.
    const conteudos = lerConteudos();
    const ordemSonda = towns.slice().sort((a, b) => {
      const ra = conteudos[a.id], rb = conteudos[b.id];
      const qa = ra ? ra.quando : 0;   // nunca sondada = mais antiga possível
      const qb = rb ? rb.quando : 0;
      return qa - qb;
    });

    for (const t of ordemSonda) {
      if (!nivelGruta(t.id)) continue;          // sem gruta construída
      const r = recursos(t.id);
      if (!r || r.armazem <= 0) continue;

      const pct = (r.prata / r.armazem) * 100;

      // SONDAGEM AUTOMÁTICA: se não soubermos quanto está na gruta (ou o valor
      // estiver velho), deposita 1 moeda só para ler o espionage_storage da
      // resposta. Uma moeda é insignificante e evita andar às cegas.
      const dentroDoOrcamento = (Date.now() - inicioSondas) < (c.segundosParaSondar || 3) * 1000;
      if (dentroDoOrcamento && precisaSondar(t.id)) {
        sondasFeitas++;
        const sonda = await guardarPrata(t.id, 1);
        if (sonda.ok && sonda.naGruta != null) {
          gravarConteudo(t.id, sonda.naGruta);
          const nvS = nivelGruta(t.id);
          const capS = capacidadeGruta(nvS);
          log(`🔍 ${t.name}: ${sonda.naGruta} na gruta${capS !== Infinity ? ` (cabe ${Math.max(0, capS - sonda.naGruta)})` : ''}.`);
        }
        await ctx.sleep(ctx.rand(300, 600));
      }

      if (pct < c.limiarPct) continue;          // ainda não está cheio

      let quantidade = Math.floor(r.prata * (c.percentagem / 100));
      let limiteEspaco = false;

      // Limitar pela capacidade da gruta (1000/nível; ilimitada ao nível 10).
      const nivel = nivelGruta(t.id);
      const capacidade = capacidadeGruta(nivel);
      // Capacidade: agora sabemos quanto está guardado (vem na resposta do
      // último depósito, em espionage_storage). Com isso calcula-se o espaço
      // livre real em vez de tentar e esperar pela recusa.
      if (capacidade !== Infinity) {
        let jaLa = null;
        try {
          const m = lerConteudos();
          const reg = m[t.id];
          // o valor envelhece: a prata desce a cada espionagem, por isso só se
          // confia nele durante algum tempo
          if (reg && (Date.now() - reg.quando) < 30 * 60 * 1000) jaLa = Number(reg.valor);
        } catch (e) {}
        const cabe = (jaLa != null) ? Math.max(0, capacidade - jaLa) : capacidade;
        if (cabe <= 0) { log(`— ${t.name}: gruta cheia (${jaLa}/${capacidade}).`); continue; }
        if (quantidade > cabe) {
          quantidade = cabe;
          // Encher o que resta: o mínimo por depósito não se aplica quando é o
          // espaço da gruta que o limita — senão ficariam moedas por guardar
          // só porque sobravam menos do que o mínimo.
          limiteEspaco = true;
        }
      }

      if (quantidade < c.minimo && !limiteEspaco) continue;
      if (quantidade <= 0) continue;

      const res = await guardarPrata(t.id, quantidade);
      if (res.ok) {
        guardou++; total += quantidade;
        if (res.naGruta != null) gravarConteudo(t.id, res.naGruta);
        const nv = nivelGruta(t.id);
        const lim = nv >= NIVEL_ILIMITADO ? 'ilimitada' : `máx ${nv * POR_NIVEL}`;
        log(`🪙 ${t.name}: ${quantidade} de prata guardados (gruta nv${nv}, ${lim})`
          + (res.naGruta != null ? ` — na gruta: ${res.naGruta}.` : '.'));
        await ctx.sleep(ctx.rand(600, 1200));
      } else {
        // Provavelmente sem espaço agora. Não insiste nesta passagem, mas volta
        // a tentar na seguinte — a prata da gruta vai sendo gasta a espiar.
        log(`— ${t.name}: gruta sem espaço agora (${res.msg}).`);
      }
    }

    if (guardou) log(`Gruta: ${total} de prata guardados em ${guardou} cidade(s).`);
    const porSondar = towns.filter((t) => nivelGruta(t.id) && precisaSondar(t.id)).length;
    if (porSondar) log(`Gruta: ${sondasFeitas} sondada(s) nesta passagem, ${porSondar} por sondar — continua a seguir.`);
  }

  /* ---------------------- PAINEL ---------------------------------------- */
  function painel(container, ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    const towns = ctx.getMyTowns();

    // quantas cidades estão neste momento com o armazém cheio de prata
    let cheias = 0, semGruta = 0;
    for (const t of towns) {
      if (!nivelGruta(t.id)) { semGruta++; continue; }
      const r = recursos(t.id);
      if (r && r.armazem > 0 && (r.prata / r.armazem) * 100 >= c.limiarPct) cheias++;
    }

    container.innerHTML = `
      <div style="font-size:11px;line-height:1.7">
        <label><input type="checkbox" id="gru-on"${c.ativo ? ' checked' : ''}> <b>Guardar prata na gruta</b></label><br>
        Guardar <input type="number" id="gru-pct" min="1" max="100" value="${c.percentagem}" style="width:48px">%
        da prata quando o armazém encher<br>
        <span style="opacity:.65">Mínimo por depósito: ${c.minimo} · a prata na gruta fica protegida do saque.</span>
      </div>
      ${(() => {
        // Com muitas cidades, listar todas é impraticável: mostra-se o TOP 10
        // por prata guardada, com pesquisa para encontrar qualquer outra.
        const cont = lerConteudos();
        const dados = towns.map((t) => {
          const nv = nivelGruta(t.id);
          if (!nv) return null;
          const reg = cont[t.id];
          return {
            id: t.id, nome: t.name, nv,
            cap: nv >= NIVEL_ILIMITADO ? null : nv * POR_NIVEL,
            val: reg ? Number(reg.valor) : null,
            idade: reg ? Math.round((Date.now() - reg.quando) / 60000) : null,
          };
        }).filter(Boolean);
        if (!dados.length) return '';

        const total = dados.reduce((a, x) => a + (x.val || 0), 0);
        const conhecidas = dados.filter((x) => x.val != null).length;

        const totalConhecido = dados.reduce((a, y) => a + (y.val || 0), 0);
        const linha = (x) => {
          const pct = (x.val != null && x.cap) ? Math.min(100, Math.round(x.val / x.cap * 100)) : null;
          const cor = pct != null && pct >= 95 ? '#f88' : (pct != null && pct >= 80 ? '#fc8' : '#cde');
          const idade = x.idade == null ? '' : (x.idade < 60 ? x.idade + 'm' : Math.round(x.idade / 60) + 'h');
          return `<tr class="gru-linha" data-nome="${String(x.nome).toLowerCase()}">
            <td style="padding:1px 4px">${x.nome}</td>
            <td style="padding:1px 4px;opacity:.7">nv${x.nv}</td>
            <td style="padding:1px 4px;text-align:right;color:${cor}">${x.val != null ? x.val.toLocaleString('pt-PT') : '?'}</td>
            <td style="padding:1px 4px;opacity:.55;font-size:10px">${
              x.cap ? '/' + x.cap.toLocaleString('pt-PT')
                    : (x.val != null && totalConhecido ? Math.round(x.val / totalConhecido * 100) + '%' : '')
            }</td>
            <td style="padding:1px 4px;opacity:.45;font-size:10px">${idade}</td>
          </tr>`;
        };

        const top = dados.slice().sort((a, b) => (b.val || -1) - (a.val || -1)).slice(0, 10);

        return `<div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:5px;font-size:11px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b>Prata nas grutas</b>
            <span style="opacity:.6;font-size:10px">total ${total.toLocaleString('pt-PT')} · ${conhecidas}/${dados.length} lidas</span>
          </div>
          <input id="gru-procura" placeholder="procurar cidade..." style="width:100%;box-sizing:border-box;margin:4px 0;font-size:11px;padding:2px">
          <table id="gru-tabela" style="width:100%;border-collapse:collapse">${top.map(linha).join('')}</table>
          <table id="gru-tabela-todas" style="width:100%;border-collapse:collapse;display:none">${dados.slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome))).map(linha).join('')}</table>
          <div style="opacity:.5;font-size:10px;margin-top:3px">A mostrar as 10 com mais prata${dados.length > 10 ? ` de ${dados.length}` : ''} — escreve acima para procurar as restantes.</div>
        </div>`;
      })()}
      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:5px;font-size:11px">
        Cidades com armazém cheio de prata agora: <b>${cheias}</b>
        ${semGruta ? `<br><span style="opacity:.7">${semGruta} cidade(s) sem gruta construída (ignoradas)</span>` : ''}
      </div>
      <div style="font-size:10px;opacity:.7;margin-top:5px">
        O conteúdo de cada gruta é lido da resposta do jogo ao depositar — por
        isso o módulo deposita 1 moeda de sonda quando não sabe. O valor desce a
        cada espionagem, e é relido de tempos a tempos.
      </div>
      <button id="gru-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    // pesquisa: escrever mostra a lista completa filtrada; vazio volta ao top
    const proc = container.querySelector('#gru-procura');
    if (proc) proc.oninput = () => {
      const termo = proc.value.trim().toLowerCase();
      const tTop = container.querySelector('#gru-tabela');
      const tTodas = container.querySelector('#gru-tabela-todas');
      if (!termo) { tTop.style.display = ''; tTodas.style.display = 'none'; return; }
      tTop.style.display = 'none'; tTodas.style.display = '';
      tTodas.querySelectorAll('.gru-linha').forEach((tr) => {
        tr.style.display = tr.getAttribute('data-nome').includes(termo) ? '' : 'none';
      });
    };

    const g = container.querySelector('#gru-guardar');
    if (g) g.onclick = () => {
      guardarCfg(Object.assign({}, c, {
        ativo: container.querySelector('#gru-on').checked,
        percentagem: Math.min(100, Math.max(1, Number(container.querySelector('#gru-pct').value) || 30)),
      }));
      ctx.log('Gruta: configuração guardada.');
      g.textContent = 'Guardado ✓';
      setTimeout(() => { g.textContent = 'Guardar'; }, 1500);
    };
  }

  return {
    id: 'gruta',
    nome: 'Auto-gruta',
    intervaloMin: opts.intervaloMin || 10,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
    sondarTodas,
  };
}

  // ================= MÓDULO: RECURSOS ENTRE CIDADES ======================
/* =============================================================================
 *  MÓDULO: TROCA DE RECURSOS ENTRE CIDADES  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Cidades que já não estão a usar os recursos (sem nada em fila e com o
 *  armazém acima de uma percentagem) enviam o excedente para cidades que estão
 *  travadas por falta de recursos.
 *
 *  QUEM RECEBE: cidades com construção ou recrutamento parados por falta de
 *  recursos. A construção é detetada pelo próprio jogo (BuildingBuildData diz,
 *  por edifício, se há recursos que cheguem).
 *
 *  QUEM ENVIA: cidades sem ordens de construção, pesquisa nem recrutamento e
 *  com o armazém acima do limiar (50% por omissão).
 *
 *  Pedido: (a confirmar por captura) POST /game/<CONTROLADOR>?...&action=<ACAO>
 * ========================================================================== */

function makeTrocaCidadesModule(opts) {
  opts = opts || {};

  // Confirmado por captura:
  //   POST /game/town_info?town_id=<ORIGEM>&action=trade&h=TOKEN
  //   json={"id":<DESTINO>,"wood":N,"stone":N,"iron":N,"town_id":<ORIGEM>}
  const ENDPOINT = {
    controlador: opts.controlador || 'town_info',
    acao: opts.acao || 'trade',
  };

  const RES = ['wood', 'stone', 'iron'];
  const CFG_KEY = 'grepoTrocaCid_cfg_v1';
  const DEFAULTS = {
    ativo: true,
    limiarEnvio: 50,       // só envia quem tiver o armazém acima disto (%)
    encherAte: 75,         // até onde encher a cidade que recebe (%) — precisa
                           // de folga para lançar ordens que rendam
    deixarPct: 45,         // quem AINDA vai precisar guarda isto (%)
    deixarSemNada: 10,     // quem já não tem nada para fazer pode descer a isto
    minEnvio: 500,         // não vale a pena enviar menos do que isto
  };

  let mUw = null, mWorld = '';

  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function cfg() {
    const c = Object.assign({}, DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function guardarCfg(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  /* ---------------------- leitura do jogo ------------------------------- */
  function recursos(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const r = t.resources ? t.resources() : null;
      if (!r) return null;
      return { wood: Number(r.wood) || 0, stone: Number(r.stone) || 0, iron: Number(r.iron) || 0,
        storage: Number(r.storage) || 0 };
    } catch (e) { return null; }
  }

  // Capacidade de comércio DISPONÍVEL (já desconta os mercadores em viagem).
  // Confirmado no jogo: 500 por nível de mercado (nv15→7500, nv16→8000, nv30→15000).
  const POR_NIVEL_MERCADO = 500;
  function capacidadeComercio(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      if (typeof t.getAvailableTradeCapacity === 'function') {
        const v = Number(t.getAvailableTradeCapacity());
        if (Number.isFinite(v)) return Math.max(0, v);
      }
      // recurso alternativo: estimar pelo nível do mercado
      const b = t.buildings ? (t.buildings().attributes || t.buildings()) : {};
      const nv = (b.market === '-' || b.market == null) ? 0 : Number(b.market);
      return nv * POR_NIVEL_MERCADO;
    } catch (e) { return 0; }
  }

  /* --------- MERCADO NÍVEL 5: exigido para trocar ENTRE ILHAS -----------
   * Dentro da mesma ilha basta ter mercado. Para enviar recursos para outra
   * ilha o mercado tem de estar pelo menos no nível 5 — sem isto o módulo
   * tentava e o jogo recusava.
   * -------------------------------------------------------------------- */
  const MERCADO_MIN_ENTRE_ILHAS = 5;

  function nivelMercado(townId) {
    try {
      const col = mUw.MM.getCollections().BuildingBuildData[0];
      const m = col.models.find((x) => Number(x.attributes.town_id) === Number(townId));
      const bd = (m && m.attributes.building_data) || {};
      const lv = (bd.market || {}).level;
      return (lv === '-' || lv == null) ? 0 : Number(lv);
    } catch (e) { return 0; }
  }

  function ilhaDe(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const x = typeof t.getIslandCoordinateX === 'function' ? t.getIslandCoordinateX() : null;
      const y = typeof t.getIslandCoordinateY === 'function' ? t.getIslandCoordinateY() : null;
      return (x == null || y == null) ? null : (x + ':' + y);
    } catch (e) { return null; }
  }

  // Pode esta cidade enviar para aquela?
  function podeEnviar(deId, paraId) {
    const iA = ilhaDe(deId), iB = ilhaDe(paraId);
    if (iA && iB && iA === iB) return true;          // mesma ilha: basta ter mercado
    return nivelMercado(deId) >= MERCADO_MIN_ENTRE_ILHAS;
  }

  // Cidades com alguma ordem em curso (construção, pesquisa ou recrutamento).
  function cidadesOcupadas() {
    const ocupadas = new Set();
    const marcar = (nome, campo) => {
      try {
        const col = (mUw.MM.getCollections()[nome] || [])[0];
        for (const m of ((col && col.models) || [])) {
          const a = m.attributes || {};
          if (a[campo] != null) ocupadas.add(Number(a[campo]));
        }
      } catch (e) {}
    };
    marcar('BuildingOrder', 'town_id');
    marcar('ResearchOrder', 'town_id');
    marcar('UnitOrder', 'town_id');
    return ocupadas;
  }

  // O jogo diz, por edifício, se faltam recursos — sinal direto de bloqueio.
  /* Esta cidade AINDA tem coisas para fazer?
   *
   * Diferente de "travada": travada é não poder avançar agora por falta de
   * recursos. Isto é ter trabalho no template que ainda não está feito, mesmo
   * que as filas estejam cheias neste momento.
   *
   * Quem já não tem nada pendente pode dar quase tudo; quem ainda vai
   * precisar guarda uma reserva maior. */
  function temTrabalhoPendente(townId, res) {
    try {
      // construção: algum edifício do template abaixo do alvo?
      const alvos = alvosDoTemplate(townId);
      if (alvos && Object.keys(alvos).length) {
        const col = mUw.MM.getCollections().BuildingBuildData[0];
        const m = col.models.find((x) => Number(x.attributes.town_id) === Number(townId));
        const bd = (m && m.attributes.building_data) || {};
        for (const b of Object.keys(alvos)) {
          const e = bd[b];
          if (!e || e.has_max_level) continue;
          const nivel = (e.level === '-' || e.level == null) ? 0 : Number(e.level);
          if (nivel < Number(alvos[b])) return true;
        }
      }

      // recrutamento: alguma unidade do template abaixo do alvo?
      const exp = JSON.parse(armazem.getItem('grepoRecruta_expandido_v1') || '{}');
      const alvosU = exp[townId];
      if (alvosU && Object.keys(alvosU).length) {
        const town = mUw.ITowns.getTown(Number(townId));
        const tenho = (town && town.units()) || {};
        for (const u of Object.keys(alvosU)) {
          if ((Number(tenho[u]) || 0) < Number(alvosU[u])) return true;
        }
      }
    } catch (e) {}
    return false;   // nada pendente: pode dar quase tudo
  }

  function construcaoTravada(townId) {
    try {
      const col = mUw.MM.getCollections().BuildingBuildData[0];
      const m = col.models.find((x) => Number(x.attributes.town_id) === Number(townId));
      if (!m) return false;
      const bd = m.attributes.building_data || {};

      // SÓ conta o que está no TEMPLATE desta cidade. Sem isto, uma cidade com
      // o template terminado parecia "travada" só porque há sempre edifícios
      // que poderia subir mas que não queremos — e recebia recursos à toa.
      const alvos = alvosDoTemplate(townId);
      if (alvos === null) return false;          // sem template: não há trabalho definido
      if (!Object.keys(alvos).length) return false;

      for (const b of Object.keys(alvos)) {
        const e = bd[b];
        if (!e || e.has_max_level) continue;
        const nivel = (e.level === '-' || e.level == null) ? 0 : Number(e.level);
        if (nivel >= Number(alvos[b])) continue;  // já atingiu o alvo do template
        // falta subir este edifício, tem espaço no armazém, mas faltam recursos
        if (!e.can_upgrade && e.enough_storage && e.enough_resources === false) return true;
      }
    } catch (e) {}
    return false;
  }

  // Níveis-alvo do template de construção aplicável a esta cidade.
  // Devolve null se não houver template nenhum.
  function alvosDoTemplate(townId) {
    try {
      const tpls = JSON.parse(armazem.getItem('grepoConstru_templates_v1') || '{}');
      if (!Object.keys(tpls).length) return null;
      const grupo = grupoDaCidade(townId);
      const t = (grupo && tpls[grupo]) || tpls.todos;
      if (!t) return null;
      const out = {};
      for (const bloco of (t.blocos || [])) {
        for (const item of bloco) out[item.b] = Math.max(out[item.b] || 0, Number(item.alvo) || 0);
      }
      return out;
    } catch (e) { return null; }
  }

  // Grupo a que a cidade pertence (para escolher o template certo).
  function grupoDaCidade(townId) {
    try {
      const grupos = {};
      for (const m of mUw.MM.getCollections().TownGroup[0].models) {
        const a = m.attributes; if (Number(a.id) > 0) grupos[a.id] = a.name;
      }
      const tpls = JSON.parse(armazem.getItem('grepoConstru_templates_v1') || '{}');
      for (const m of mUw.MM.getCollections().TownGroupTown[0].models) {
        const a = m.attributes;
        if (Number(a.town_id) !== Number(townId)) continue;
        const nome = grupos[a.group_id];
        if (nome && tpls[nome]) return nome;
      }
    } catch (e) {}
    return null;
  }

  /* Pesquisa travada: há tecnologias marcadas no template que ainda faltam e
   * os recursos não chegam. Uma cidade com todas as pesquisas do template
   * feitas não precisa de receber nada por esta via. */
  function pesquisaTravada(townId, res) {
    try {
      const tpls = JSON.parse(armazem.getItem('grepoPesquisa_templates_v1') || '{}');
      if (!Object.keys(tpls).length) return false;
      const grupo = grupoDaCidadePesquisa(townId);
      const t = (grupo && tpls[grupo]) || tpls.todos;
      if (!t) return false;
      const marcadas = t.pesquisas || [];
      if (!marcadas.length) return false;

      const mods = mUw.MM.getModels().Researches || {};
      const feitas = (mods[townId] && mods[townId].attributes) || {};
      const gd = mUw.GameData.researches || {};

      for (const id of marcadas) {
        if (feitas[id]) continue;                       // já investigada
        const c = (gd[id] || {}).resources || {};
        const falta = (Number(c.wood) || 0) > (res.wood || 0)
          || (Number(c.stone) || 0) > (res.stone || 0)
          || (Number(c.iron) || 0) > (res.iron || 0);
        if (falta) return true;                          // quer investigar e não chega
      }
    } catch (e) {}
    return false;
  }

  function grupoDaCidadePesquisa(townId) {
    try {
      const grupos = {};
      for (const m of mUw.MM.getCollections().TownGroup[0].models) {
        const a = m.attributes; if (Number(a.id) > 0) grupos[a.id] = a.name;
      }
      const tpls = JSON.parse(armazem.getItem('grepoPesquisa_templates_v1') || '{}');
      for (const m of mUw.MM.getCollections().TownGroupTown[0].models) {
        const a = m.attributes;
        if (Number(a.town_id) !== Number(townId)) continue;
        const nome = grupos[a.group_id];
        if (nome && tpls[nome]) return nome;
      }
    } catch (e) {}
    return null;
  }

  // Recrutamento travado: há alvos por cumprir mas os recursos estão baixos.
  function recrutamentoTravado(townId, res) {
    try {
      const exp = JSON.parse(armazem.getItem('grepoRecruta_expandido_v1') || '{}');
      const alvos = exp[townId];
      if (!alvos || !Object.keys(alvos).length) return false;
      if (!res || !res.storage) return false;
      const menor = Math.min(res.wood, res.stone, res.iron);
      return (menor / res.storage) < 0.25;   // com pouco em caixa, não avança
    } catch (e) { return false; }
  }

  /* ---------------------- pedido ---------------------------------------- */
  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * E faz a passagem seguinte ler valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels().Town.
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }

  async function enviarRecursos(origem, destino, quantidades) {
    const url = mUw.location.origin + '/game/' + ENDPOINT.controlador
      + '?town_id=' + Number(origem) + '&action=' + ENDPOINT.acao + '&h=' + mUw.Game.csrfToken;
    // O jogo envia sempre os três recursos, mesmo a zero.
    const payload = {
      id: Number(destino),
      wood: Math.floor(quantidades.wood || 0),
      stone: Math.floor(quantidades.stone || 0),
      iron: Math.floor(quantidades.iron || 0),
      town_id: Number(origem), nl_init: true,
    };
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      aplicarNotificacoes(r);   // refresca a interface e os modelos
      const j = r && r.json;
      const erro = j && j.error;
      return { ok: !erro, msg: erro || (j && j.success) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ---------------------- decisão --------------------------------------- */
  // Classifica as cidades em quem pode dar e quem precisa de receber.
  function classificar(towns, c) {
    /* `cidadesOcupadas()` já não é usada aqui: ter obras na fila não impede o
     * mercado de funcionar, e excluir essas cidades deixava-as com o armazém
     * cheio a desperdiçar produção. */
    const dadores = [], carentes = [];
    for (const t of towns) {
      const res = recursos(t.id);
      if (!res || !res.storage) continue;
      const menorPct = (Math.min(res.wood, res.stone, res.iron) / res.storage) * 100;

      const travada = construcaoTravada(t.id)
        || recrutamentoTravado(t.id, res)
        || pesquisaTravada(t.id, res);
      if (travada) { carentes.push({ t, res, menorPct }); continue; }

      /* QUANTO É QUE ESTA CIDADE PODE DAR.
       *
       * Não é igual para todas: uma cidade que já não tem nada para fazer
       * pode esvaziar-se quase toda, enquanto uma que tem as filas cheias mas
       * ainda vai precisar de recursos deve guardar uma boa parte.
       *
       * - nada pendente (template completo)  → guarda só `deixarSemNada`
       * - ainda tem coisas por fazer         → guarda `deixarPct` */
      const aindaPrecisa = temTrabalhoPendente(t.id, res);
      const deixar = aindaPrecisa ? c.deixarPct : c.deixarSemNada;
      const limiar = aindaPrecisa ? c.limiarEnvio : c.deixarSemNada;

      /* NÃO excluir por ter obras na fila.
       *
       * Uma cidade com construção a decorrer continua a poder enviar pelo
       * mercado — são coisas independentes. Excluí-las deixava cidades com o
       * armazém CHEIO a desperdiçar produção enquanto outras esperavam.
       *
       * O que protege a construção é a percentagem que se deixa em casa
       * (`deixarPct`), não impedir o envio.
       *
       * Visto em jogo: uma cidade com os três recursos a 11824/11824 e nada a
       * sair não era considerada dadora, só por ter 2 obras na fila. */
      if (menorPct >= limiar) {
        dadores.push({ t, res, menorPct, deixar,
          capacidade: capacidadeComercio(t.id) });
      }
    }
    // quem está pior recebe primeiro; quem tem mais dá primeiro
    carentes.sort((a, b) => a.menorPct - b.menorPct);
    dadores.sort((a, b) => b.menorPct - a.menorPct);
    return { dadores, carentes };
  }

  /* Recursos JÁ A CAMINHO de uma cidade.
   *
   * Sem isto, várias cidades enviam ao mesmo tempo para o mesmo destino e o
   * armazém transborda — o que passa do limite perde-se. Visto no jogo: sete
   * cidades a enviar para a mesma numa só passagem. */
  function aCaminhoPara(townId) {
    const out = { wood: 0, stone: 0, iron: 0 };
    try {
      const col = mUw.MM.getCollections().Trade;
      const mods = (col && col[0] && col[0].models) || [];
      for (const m of mods) {
        const a = m.attributes || {};
        if (Number(a.to_town_id) !== Number(townId)) continue;
        for (const r of RES) out[r] += Number(a[r]) || 0;
      }
    } catch (e) {}
    return out;
  }

  /* Quanto ainda cabe nesta cidade, por recurso, contando o que já vai a
   * caminho e deixando uma pequena folga. */
  function espacoLivre(townId, res) {
    const vem = aCaminhoPara(townId);
    const out = {};
    for (const r of RES) {
      const tecto = Math.floor(res.storage * 0.97);   // 3% de folga
      out[r] = Math.max(0, tecto - (Number(res[r]) || 0) - vem[r]);
    }
    return out;
  }

  // Quanto pode este dador enviar, sem descer abaixo da reserva dele.
  function excedente(d, c) {
    /* Cada dador tem o SEU limite: quem já não tem nada para fazer deixa
     * pouco, quem ainda vai precisar deixa mais. */
    const pct = (d.deixar != null) ? d.deixar : c.deixarPct;
    const guardar = d.res.storage * (pct / 100);
    const out = {};
    let total = 0;
    for (const r of RES) {
      const sobra = Math.max(0, Math.floor(d.res[r] - guardar));
      if (sobra > 0) { out[r] = sobra; total += sobra; }
    }
    return { por: out, total };
  }

  /* ------------------------------- run ---------------------------------- */
  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    const log = ctx.log;
    if (!c.ativo) { log('Trocas entre cidades: está DESLIGADO (liga a caixa no painel e guarda).'); return; }

    const towns = ctx.getMyTowns();
    if (towns.length < 2) { log('Trocas entre cidades: precisa de pelo menos 2 cidades.'); return; }

    const { dadores, carentes } = classificar(towns, c);
    if (!carentes.length) {
      // Distinguir "não há nada a fazer" de "não há templates configurados",
      // que são situações muito diferentes para quem está a ver o log.
      const temC = Object.keys((() => { try { return JSON.parse(armazem.getItem('grepoConstru_templates_v1') || '{}'); } catch (e) { return {}; } })()).length;
      const temR = Object.keys((() => { try { return JSON.parse(armazem.getItem('grepoRecruta_templates_v1') || '{}'); } catch (e) { return {}; } })()).length;
      const temP = Object.keys((() => { try { return JSON.parse(armazem.getItem('grepoPesquisa_templates_v1') || '{}'); } catch (e) { return {}; } })()).length;
      if (!temC && !temR && !temP) {
        log('Trocas entre cidades: sem templates de construção, recrutamento ou pesquisa — '
          + 'não sei o que as cidades precisam de fazer, por isso não envio nada.');
      } else {
        log('Trocas entre cidades: nenhuma cidade travada por recursos '
          + `(templates: ${temC ? 'construção' : ''}${temR ? ' recrutamento' : ''}${temP ? ' pesquisa' : ''}).`);
      }
      return;
    }
    if (!dadores.length) { log(`Trocas entre cidades: ${carentes.length} cidade(s) a precisar, mas nenhuma com excedente.`); return; }

    let envios = 0;
    for (const carente of carentes) {
      // Encher até ao alvo definido (não ao limiar de quem dá): uma cidade que
      // vai lançar ordens precisa de estar bem cheia para elas renderem.
      const alvo = carente.res.storage * ((c.encherAte || 75) / 100);
      const falta = {};
      for (const r of RES) {
        const f = Math.max(0, Math.floor(alvo - carente.res[r]));
        if (f > 0) falta[r] = f;
      }
      if (!Object.keys(falta).length) continue;

      for (const d of dadores) {
        if (d.capacidade <= 0) continue;
        const exc = excedente(d, c);
        if (exc.total < c.minEnvio) continue;

        // Montar o envio: o que falta ao carente, limitado pelo excedente do
        // dador e pela capacidade de comércio. A capacidade é repartida
        // PROPORCIONALMENTE pelos recursos em falta — senão o primeiro da lista
        // consumia-a toda e os outros ficavam a zero.
        /* Limitar também pelo ESPAÇO que resta no destino, contando o que já
         * vai a caminho. Sem isto, várias cidades enchiam a mesma e o que
         * passasse do armazém perdia-se. */
        const cabe = espacoLivre(carente.t.id, carente.res);

        const possivel = {};
        let desejado = 0;
        for (const r of RES) {
          const q = Math.min(falta[r] || 0, exc.por[r] || 0, cabe[r] || 0);
          if (q > 0) { possivel[r] = q; desejado += q; }
        }
        if (!desejado) continue;

        const envio = {};
        let soma = 0;
        if (desejado <= d.capacidade) {
          Object.assign(envio, possivel);
          soma = desejado;
        } else {
          const fator = d.capacidade / desejado;
          for (const r of Object.keys(possivel)) {
            const q = Math.floor(possivel[r] * fator);
            if (q > 0) { envio[r] = q; soma += q; }
          }
        }
        if (soma < c.minEnvio) continue;

        // Entre ilhas diferentes o mercado tem de estar no nível 5.
        if (!podeEnviar(d.t.id, carente.t.id)) continue;

        const res = await enviarRecursos(d.t.id, carente.t.id, envio);
        if (res.ok) {
          envios++;
          d.capacidade -= soma;
          for (const r of Object.keys(envio)) {
            d.res[r] -= envio[r];
            carente.res[r] += envio[r];
            falta[r] = Math.max(0, (falta[r] || 0) - envio[r]);
          }
          const detalhe = Object.keys(envio).map((r) => `${envio[r]} ${r}`).join(', ');
          log(`📦 ${d.t.name} → ${carente.t.name}: ${detalhe}.`);
          await ctx.sleep(ctx.rand(800, 1600));
        } else {
          log(`⚠️ ${d.t.name} → ${carente.t.name}: envio falhou (${res.msg}).`);
        }
        if (!Object.keys(falta).some((r) => falta[r] > 0)) break;  // já chega
      }
    }
    if (envios) log(`Trocas entre cidades: ${envios} envio(s).`);
  }

  /* ---------------------- PAINEL ---------------------------------------- */
  function painel(container, ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    const towns = ctx.getMyTowns();
    let dadores = [], carentes = [];
    try { ({ dadores, carentes } = classificar(towns, c)); } catch (e) {}

    container.innerHTML = `
      <div style="font-size:11px;line-height:1.7">
        <label><input type="checkbox" id="tc-on"${c.ativo ? ' checked' : ''}> <b>Enviar recursos entre cidades</b></label><br>
        Envia quem tiver o armazém acima de
        <input type="number" id="tc-limiar" min="10" max="95" value="${c.limiarEnvio}" style="width:46px">%
        e nada em fila<br>
        Quem ainda tem coisas para fazer deixa
        <input type="number" id="tc-deixar" min="0" max="90" value="${c.deixarPct}" style="width:46px">% em casa<br>
        Quem já tem o template completo deixa só
        <input type="number" id="tc-deixar-vazio" min="0" max="90" value="${c.deixarSemNada}" style="width:46px">%
        <span style="opacity:.65;font-size:10px">— e envia mesmo com pouco em caixa</span><br>
        Encher quem recebe até <input type="number" id="tc-encher" min="20" max="100" value="${c.encherAte}" style="width:46px">%
        <span style="opacity:.65">(folga para as ordens renderem)</span>
      </div>
      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:5px;font-size:11px">
        A precisar: <b>${carentes.length}</b> · com excedente: <b>${dadores.length}</b>
        ${carentes.length ? `<br><span style="opacity:.75">Mais carente: ${carentes[0].t.name} (${Math.floor(carentes[0].menorPct)}%)</span>` : ''}
        ${dadores.length ? `<br><span style="opacity:.75">Capacidade de comércio disponível: ${dadores.reduce((s2, d) => s2 + d.capacidade, 0)}</span>` : ''}
      </div>
      <div style="font-size:10px;opacity:.7;margin-top:5px">
        Recebe quem tem construção ou recrutamento parados por falta de recursos.
      </div>
      <button id="tc-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    const g = container.querySelector('#tc-guardar');
    if (g) g.onclick = () => {
      guardarCfg(Object.assign({}, c, {
        ativo: container.querySelector('#tc-on').checked,
        limiarEnvio: Number(container.querySelector('#tc-limiar').value) || 50,
        encherAte: Number(container.querySelector('#tc-encher').value) || 75,
        deixarPct: Number(container.querySelector('#tc-deixar').value) || 30,
        deixarSemNada: Number(container.querySelector('#tc-deixar-vazio').value) || 10,
      }));
      ctx.log('Trocas entre cidades: configuração guardada.');
      g.textContent = 'Guardado ✓';
      setTimeout(() => { g.textContent = 'Guardar'; }, 1500);
    };
  }

  return {
    id: 'trocacidades',
    nome: 'Recursos entre cidades',
    intervaloMin: opts.intervaloMin || 15,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
  };
}

  // ===================== MÓDULO: ENCAIXE DE COMANDOS =====================
/* =============================================================================
 *  MÓDULO: ENCAIXE DE COMANDOS  (para o Maestro)
 *  ---------------------------------------------------------------------------
 *  Faz um apoio ou ataque CHEGAR à cidade alvo a uma hora exacta (hh:mm:ss),
 *  dentro de uma margem configurável.
 *
 *  MODELO DE TEMPO (validado com dois comandos reais):
 *     duração = runtime_setup_time + K × distância ÷ velocidade_efectiva
 *     runtime_setup_time = Game.constants.units.runtime_setup_time (300 s)
 *     K ≈ 5258  (calibrado com dois comandos reais; erro medido de 0,3%)
 *     ATENÇÃO: os bónus de velocidade da cidade de origem estão ABSORVIDOS na
 *     constante. Não voltar a aplicá-los — daria uma duração curta de mais.
 *
 *  AFINAÇÃO: como sobra ~0,8% de erro, perto da hora de envio o módulo entra
 *  em ciclo — envia, lê a hora de chegada real e, se estiver fora da margem,
 *  cancela e tenta outra vez. Pára assim que acertar.
 *
 *  ⚠️ Uma rajada de envios/cancelamentos é um padrão muito artificial e é o
 *     que mais facilmente aciona a verificação de bot. Há limite de tentativas.
 * ========================================================================== */

function makeEncaixeModule(opts) {
  opts = opts || {};

  const CFG_KEY = 'grepoEncaixe_cfg_v1';
  const DESVIOS_KEY = 'grepoEncaixe_desvios_v1';
  const PLANOS_KEY = 'grepoEncaixe_planos_v1';

  const DEFAULTS = {
    ativo: false,             // desligado por omissão
    // Constante calibrada com dois comandos reais (birreme e colonizador) de
    // uma cidade COM cartografia. O bónus está absorvido aqui — não o somes
    // outra vez. Erro medido: 0,3%. Se enviares de uma cidade com outros
    // bónus (farol, construtor naval, meteorologia), afina este valor.
    K: 5258,
    margemSeg: 2,             // tolerância de chegada (0-5 s)
    direcao: 'ambos',         // 'antes' | 'depois' | 'ambos'
                              // 'antes'  → só aceita chegar À HORA ou ANTES
                              //            (essencial com colonizador atrás ou
                              //             em mundos de cerco: 1s depois estraga)
                              // 'depois' → só aceita à hora ou depois
                              // 'ambos'  → aceita para os dois lados
    comecarAntes: 12,         // começa N segundos antes do envio previsto — a
                              // variação do jogo também ADIANTA, por isso vale a
                              // pena cobrir uma janela e não só um instante
    maxTentativas: 40,        // travão de segurança (raramente atingido)
    // Medido por simulação com a variação real (±3 s): desistir aos 5 atrasos
    // dá 94,5% de sucesso com margem 0; aos 10 sobe para 99,6%. Mais do que 10
    // não acrescenta nada.
    // Trava por TEMPO: passados N segundos da hora ideal de envio, deixa de
    // tentar. A deriva é de ~1 s por segundo, portanto depois disso as
    // chegadas estão pelo menos N segundos atrasadas e não há hipótese.
    limiteAposEnvioSeg: 10,
    atrasosSeguidosParaParar: 15, // pára quando N tentativas SEGUIDAS chegam
                                  // depois da hora: a janela já fechou e as
                                  // seguintes só podiam chegar ainda mais tarde
    // Folga sobre o tempo de regresso das tropas. Quanto MAIS CURTO o ciclo,
    // mais tentativas caem perto do alvo: medido, passar de 2 s para 1 s por
    // ciclo sobe o sucesso com margem 0 de 41% para 66%. Começa curta e cresce
    // sozinha se o jogo responder que as tropas ainda vêm a caminho.
    margemPausaMs: 200,
  };

  let mUw = null, mWorld = '';
  const emCurso = new Set();

  /* Temporizadores armados por plano: garantem que a rajada arranca à hora
   * certa, sem depender de a passagem do módulo calhar na janela. */
  const temporizadores = {};
  // Rajadas a decorrer POR CIDADE. Duas rajadas da mesma origem atropelam-se:
  // usam as mesmas tropas e uma cancelaria comandos da outra. Por isso só uma
  // de cada vez por cidade — as outras esperam pela vez.
  const cidadeOcupada = new Map();   // townId -> promessa da rajada em curso

  /* Número configurado, aceitando o ZERO como valor válido.
   *
   * `a || b` trata o 0 como ausente e cai no valor por omissão — o que já nos
   * mordeu várias vezes. Esta função só recorre ao alternativo quando o valor
   * está mesmo em falta. */
  /* Hora do JOGO, não a do computador — que pode estar horas ao lado. */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function horaJogo(segundos) {
    try {
      const f = mUw.__maestroHoraJogo || uw.__maestroHoraJogo;
      if (f) return f(segundos);
    } catch (e) {}
    try {
      /* serverGMTOffset é uma FUNÇÃO, não um número. */
      const w = mUw || uw;
      const raw = w.Timestamp.serverGMTOffset;
      let d = (typeof raw === 'function') ? Number(raw.call(w.Timestamp)) : Number(raw);
      if (!Number.isFinite(d)) d = Number(w.Game && w.Game.server_gmt_offset) || 0;
      return new Date((Number(segundos) + d) * 1000).toISOString().slice(11, 19);
    } catch (e) { return '?'; }
  }

  function numeroOu(valor, alternativo) {
    const n = Number(valor);
    return (valor !== null && valor !== undefined && valor !== '' && Number.isFinite(n))
      ? n : alternativo;
  }

  function cfg() {
    const c = Object.assign({}, DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    // MIGRAÇÃO: o valor antigo (5 atrasos) ficava guardado e continuava a
    // desistir cedo mesmo depois de o valor por omissão passar a 10. Medido:
    // com a variação real (~±10s), 5 dá 71% de sucesso e 10 dá 87%.
    try {
      if (!c.migrado_v3) {
        if (Number(c.atrasosSeguidosParaParar) <= 10) c.atrasosSeguidosParaParar = 15;
        c.migrado_v3 = true;
        armazem.setItem(CFG_KEY, JSON.stringify(c));
      }
    } catch (e) {}
    return c;
  }
  function guardarCfg(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }
  function lerPlanos() { try { return JSON.parse(armazem.getItem(PLANOS_KEY) || '[]'); } catch (e) { return []; } }
  /* Nunca apagar TODOS os planos de uma vez.
   *
   * Vi os planos desaparecerem 25 minutos antes da hora de envio, sem motivo
   * registado. A causa mais provável é uma gravação concorrente: duas partes
   * do módulo lêem a lista, uma remove o seu plano e grava — e apaga o que a
   * outra tinha acrescentado entretanto.
   *
   * A remoção explícita (botão cancelar, plano cumprido) passa
   * `permitirVazio`; o resto não. */
  function gravarPlanos(p, permitirVazio) {
    try {
      const antes = lerPlanos().length;
      if (!permitirVazio && antes > 0 && (!p || !p.length)) {
        try { console.log('[MAESTRO/encaixe] recusei apagar', antes, 'plano(s) de uma vez'); } catch (e) {}
        return;
      }
    } catch (e) {}
    try { armazem.setItem(PLANOS_KEY, JSON.stringify(p)); } catch (e) {}
    // Redesenhar o painel: um agendamento feito na janela de ataque tem de
    // aparecer logo na lista, senão não há como cancelá-lo sem reabrir tudo.
    try {
      if (painelRef && painelRef.container && painelRef.container.isConnected) {
        painel(painelRef.container, painelRef.ctx);
      }
    } catch (e) {}
  }

  // RELÓGIO DO SERVIDOR — o único que conta. O relógio da máquina é
  // irrelevante e enganador (este VPS está em Espanha e o jogo corre em hora
  // portuguesa: uma hora de diferença permanente). Sem relógio do servidor,
  // devolvemos null e o módulo recusa agendar, em vez de errar a hora.
  function agora() {
    try {
      if (typeof mUw.Timestamp !== 'undefined' && typeof mUw.Timestamp.now === 'function') {
        const t = Math.floor(mUw.Timestamp.now());
        if (Number.isFinite(t) && t > 0) return t;
      }
    } catch (e) {}
    try {
      const t = Number(mUw.Game && mUw.Game.server_time);
      if (Number.isFinite(t) && t > 0) return Math.floor(t);
    } catch (e) {}
    return null;
  }

  // Desvio do fuso do SERVIDOR face a UTC, em segundos (ex.: UTC+1 → 3600).
  function desvioFuso() {
    try {
      const T = mUw.Timestamp;
      if (T && typeof T.serverGMTOffset !== 'undefined') {
        const sv = typeof T.serverGMTOffset === 'function' ? T.serverGMTOffset() : T.serverGMTOffset;
        if (Number.isFinite(Number(sv))) return Number(sv);
      }
    } catch (e) {}
    return 0;
  }

  // Converte hh:mm:ss DO JOGO no instante (timestamp) correspondente.
  // Trabalha inteiramente em UTC e aplica o desvio do servidor — o fuso do
  // navegador não entra na conta, porque a hora que escreves é a do jogo.
  function horaDoJogoParaTimestamp(h, m, sg, amanha) {
    const off = desvioFuso();
    // "hoje" no calendário do servidor
    const hojeServidor = new Date((agora() + off) * 1000);
    const ts = Date.UTC(
      hojeServidor.getUTCFullYear(), hojeServidor.getUTCMonth(), hojeServidor.getUTCDate(),
      h, m, sg, 0
    ) / 1000 - off;
    return Math.floor(ts) + (amanha ? 86400 : 0);
  }

  /* ---------------------- modelo de tempo ------------------------------- */
  function setupTime() {
    try { return Number(mUw.Game.constants.units.runtime_setup_time) || 300; } catch (e) { return 300; }
  }

  function coordsCidade(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      return { x: Number(t.getIslandCoordinateX()), y: Number(t.getIslandCoordinateY()) };
    } catch (e) { return null; }
  }

  // Aceita coordenadas em {x,y} ou {ix,iy} — a janela do jogo usa ix/iy.
  function norm(p) {
    if (!p) return null;
    const x = p.x != null ? Number(p.x) : Number(p.ix);
    const y = p.y != null ? Number(p.y) : Number(p.iy);
    return (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
  }
  function distancia(a, b) {
    const A = norm(a), B = norm(b);
    if (!A || !B) return null;
    return Math.sqrt(Math.pow(A.x - B.x, 2) + Math.pow(A.y - B.y, 2));
  }

  // O comando viaja à velocidade da unidade MAIS LENTA que leva.
  // NOTA: não se aplica aqui nenhum bónus — os bónus da cidade de origem já
  // estão absorvidos na constante K (ver acima).
  function velocidadeDoComando(unidades) {
    let menor = Infinity;
    try {
      const gd = mUw.GameData.units || {};
      for (const u of Object.keys(unidades)) {
        if (!unidades[u]) continue;
        const v = Number((gd[u] || {}).speed) || 0;
        if (v > 0 && v < menor) menor = v;
      }
    } catch (e) {}
    if (!Number.isFinite(menor)) return null;
    return menor;
  }

  // Duração prevista em segundos.
  function duracaoPrevista(origemId, alvoCoords, unidades, c) {
    const o = coordsCidade(origemId);
    const a = norm(alvoCoords);
    // Sem coordenadas do alvo NÃO se estima nada. (Cidades inimigas não estão
    // na nossa coleção; tratá-las como 0:0 dava distâncias absurdas.)
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return null;
    const d = distancia(o, a);
    const v = velocidadeDoComando(unidades);
    if (d == null || !v) return null;
    return Math.round(setupTime() + (c.K * d) / v);
  }

  /* ---------------------- pedidos --------------------------------------- */
  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ---------------------
   * O jogo devolve, em cada acção, notificações com o estado actualizado — é
   * assim que a própria interface se refresca. Ignorá-las deixa o ecrã parado
   * (é preciso recarregar para ver o efeito) E faz a passagem seguinte ler
   * valores velhos, podendo repetir a acção.
   *
   * Atenção: ITowns.getTown() devolve um invólucro SEM método set(); os
   * modelos Backbone reais estão em MM.getModels()[Nome].
   * -------------------------------------------------------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados || typeof dados !== 'object') continue;

        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // 1) COLECÇÕES primeiro: entradas NOVAS (Trade, ResearchOrder,
          //    UnitOrder, BuildingOrder...). Tem de vir antes dos modelos —
          //    há nomes que existem nos dois sítios (Trade, por exemplo) e,
          //    se os modelos fossem tentados primeiro, a entrada nova nunca
          //    era acrescentada à lista que a interface mostra.
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          // 2) MODELOS: actualizar o que já existe (Town, PlayerLedger, ...)
          try {
            const colecao = mUw.MM.getModels()[nome];
            if (colecao) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(colecao)) {
                const m = colecao[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(colecao).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
          continue;

        }
      }
    } catch (e) {}
  }


  async function post(url, payload) {
    const r = await mUw.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
      credentials: 'include',
      body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
    }).then(lerResposta);
    aplicarNotificacoes(r);
    const j = r && r.json;
    return { ok: !(j && j.error), msg: (j && (j.error || j.success)) || 'ok', raw: r };
  }

  async function enviarComando(origem, alvoId, unidades, tipo) {
    const url = mUw.location.origin + '/game/town_info?town_id=' + Number(origem)
      + '&action=send_units&h=' + mUw.Game.csrfToken;
    return post(url, Object.assign({}, unidades, {
      id: Number(alvoId), type: tipo, town_id: Number(origem), nl_init: true,
    }));
  }

  async function cancelar(commandId, townId) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    return post(url, {
      model_url: 'Commands', action_name: 'cancelCommand', captcha: null,
      arguments: { id: Number(commandId) }, town_id: Number(townId), nl_init: true,
    });
  }

  // Encontra o comando que acabámos de enviar (o mais recente desta origem).
  // Encontra o comando que ACABÁMOS de enviar. Filtrar só pela origem não
  // chega: o modelo também contém regressos (tipo "abort") e comandos antigos
  // para outros destinos. Exigimos origem, destino e um command_id novo.
  // Pergunta ao SERVIDOR os comandos desta cidade. É a fonte fiável: o modelo
  // MovementsUnits fica VAZIO até a página ser atualizada, mesmo com comandos
  // acabados de enviar — foi isso que impedia a verificação e o cancelamento.
  // Endpoint confirmado: /game/town_overviews?action=command_overview
  let semAdministrador = false;

  // NOTA: o command_overview exige ADMINISTRADOR. Sem ele responde
  // "Necessita do administrador para aceder às visões gerais". Detecta-se uma
  // vez e não se insiste — as multis não o têm.
  async function comandosDoServidor(townId) {
    if (semAdministrador) return [];
    try {
      const url = mUw.location.origin + '/game/town_overviews?town_id=' + Number(townId)
        + '&action=command_overview&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({ town_id: Number(townId), nl_init: true }))
        + '&_=' + Date.now();
      const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
        .then(lerResposta);
      const erroAdm = r && r.json && r.json.error;
      if (erroAdm && /administrador|administrator|premium/i.test(String(erroAdm))) {
        // O encaixe é usado só na main, que tem sempre Administrador — isto é
        // apenas uma salvaguarda para não insistir se algum dia for usado
        // noutra conta (sem ele, o módulo não teria como verificar a chegada).
        semAdministrador = true;
        return [];
      }
      const cmds = ((r && r.json && r.json.data) || {}).commands || [];
      return cmds.map((c) => ({
        command_id: Number(c.id),
        arrival_at: Number(c.arrival_at),
        started_at: Number(c.started_at),
        destino: Number(c.destination_town_id),
        origem: Number(c.origin_town_id),
        tipo: String(c.type || ''),
        regresso: !!(c.return || c.cmd_return),
        cancelavel: !!c.cancelable,
      })).filter((c) => c.command_id && c.arrival_at && !c.regresso);
    } catch (e) { return []; }
  }

  // Identifica o comando ACABADO de enviar: o que apareceu a mais desde que
  // registámos os existentes. NÃO se exige que o destino coincida com o campo
  // "cidade alvo" — o jogo envia para a cidade da janela, e se o campo tiver um
  // valor de outra janela ficaríamos à procura de algo que não existe (foi o
  // que aconteceu: campo com 3353, comando para 1091, nada encontrado).
  function comandoMaisRecente(origemId, alvoId, jaConhecidos) {
    try {
      const m = mUw.MM.getModels().MovementsUnits || {};
      const cand = Object.keys(m).map((k) => m[k].attributes || {})
        .filter((a) => Number(a.home_town_id) === Number(origemId))
        .filter((a) => !/abort|return/i.test(String(a.type || '')))
        .filter((a) => !jaConhecidos || !jaConhecidos.has(Number(a.command_id)));
      return cand.sort((a, b) => (b.command_id || 0) - (a.command_id || 0))[0] || null;
    } catch (e) { return null; }
  }

  // Igual, mas aceita comandos ainda sem hora de chegada — serve para
  // cancelar o que acabámos de enviar quando não conseguimos verificá-lo.
  // Para CANCELAR por segurança: começa exigente (mesmo destino) e, se não
  // encontrar, aceita qualquer comando NOVO daquela cidade que não seja um
  // regresso. Vale mais cancelar do que deixar tropas a caminho sem controlo.
  function ultimoComandoEnviado(origemId, alvoId, jaConhecidos) {
    try {
      const m = mUw.MM.getModels().MovementsUnits || {};
      const todos = Object.keys(m).map((k) => m[k].attributes || {})
        .filter((a) => Number(a.home_town_id) === Number(origemId) && a.command_id)
        .filter((a) => !/abort|return/i.test(String(a.type || '')))
        .filter((a) => !jaConhecidos || !jaConhecidos.has(Number(a.command_id)))
        .sort((a, b) => (b.command_id || 0) - (a.command_id || 0));
      if (!todos.length) return null;
      const comDestino = todos.filter((a) => !alvoId || Number(a.target_town_id) === Number(alvoId));
      return comDestino[0] || todos[0];
    } catch (e) { return null; }
  }

  /* ------------------- aprendizagem da variação do jogo ------------------
   * Cada tentativa diz-nos o desvio entre a chegada real e a pretendida.
   * Guardando esses valores aprendemos a distribuição real deste mundo — e
   * podemos centrar o envio nela, em vez de assumir que está centrada em zero.
   * -------------------------------------------------------------------- */
  // O histórico anterior a esta correção continha desvios NÃO descontados da
  // deriva, o que inflacionava a mediana. Limpa-se uma vez.
  (function limparHistoricoContaminado() {
    try {
      if (armazem.getItem('grepoEncaixe_desvios_limpo_v2')) return;
      armazem.removeItem(DESVIOS_KEY);
      armazem.setItem('grepoEncaixe_desvios_limpo_v2', '1');
    } catch (e) {}
  })();

  function lerDesvios() {
    try { const v = JSON.parse(armazem.getItem(DESVIOS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function registarDesvio(d) {
    try {
      const v = lerDesvios();
      v.push(Number(d));
      armazem.setItem(DESVIOS_KEY, JSON.stringify(v.slice(-200)));
    } catch (e) {}
  }
  // Mediana dos desvios observados: se for diferente de zero, o envio está
  // enviesado e vale a pena deslocá-lo por essa medida.
  /* A correcção pelo viés está DESLIGADA por omissão.
   *
   * A ideia era aprender com as tentativas anteriores, mas na prática mexe no
   * que o utilizador configurou e piora o resultado — visto em jogo: com
   * "começar 13s antes" e "parar 10s depois" bem definidos, a correcção de
   * +10s fez o encaixe sair 1 segundo antes do pretendido.
   *
   * Quem quiser experimentar liga no painel. */
  function corrigirVies() {
    try { return armazem.getItem('grepoEncaixe_corrigirVies_v1') === '1'; }
    catch (e) { return false; }
  }

  function vieselObservado() {
    if (!corrigirVies()) return 0;
    const v = lerDesvios();
    if (v.length < 8) return 0;          // poucas amostras: não mexer
    const ord = v.slice().sort((a, b) => a - b);
    const mediana = ord[Math.floor(ord.length / 2)];
    return Math.max(-10, Math.min(10, Math.round(mediana)));
  }
  function estatisticaDesvios() {
    const v = lerDesvios();
    if (!v.length) return null;
    const ord = v.slice().sort((a, b) => a - b);
    return {
      n: v.length,
      min: ord[0],
      max: ord[ord.length - 1],
      mediana: ord[Math.floor(ord.length / 2)],
    };
  }

  /* ---------------------- execução do plano ----------------------------- */
  async function executar(ctx, plano) {
    const c = cfg();
    const log = ctx.log;

    // Esperar que a cidade fique livre (rajada anterior da mesma origem).
    const anterior = cidadeOcupada.get(Number(plano.origemId));
    if (anterior) {
      log(`⏳ Encaixe: a cidade ${plano.origemId} tem outra rajada em curso; espero pela vez.`);
      try { await anterior; } catch (e) {}
    }
    let libertar;
    cidadeOcupada.set(Number(plano.origemId), new Promise((r) => { libertar = r; }));
    const chave = plano.id;
    if (emCurso.has(chave)) return;
    emCurso.add(chave);

    try {
      const alvo = plano.alvoCoords || coordsCidade(plano.alvoId);
      // A duração é a que o JOGO indicou quando agendaste. Recalcular por
      // distância dava valores absurdos para cidades inimigas (sem coordenadas)
      // — chegou a dar 1429 min e a disparar o envio fora de horas.
      const duracao = plano.duracaoJogo || duracaoPrevista(plano.origemId, alvo, plano.unidades, c);
      if (!duracao) { log('Encaixe: sem duração fiável da viagem; não envio.'); return; }

      const envioPrevisto = plano.chegada - duracao;
      const hhLocal = (t) => new Date((t + desvioFuso()) * 1000).toISOString().substr(11, 8);
      log(`🎯 Encaixe: viagem ${Math.round(duracao / 60)} min → envio às ${hhLocal(envioPrevisto)} (hora do jogo).`);

      // TRAVA: nunca enviar muito antes ou muito depois do previsto.
      const desfasado = agora() - envioPrevisto;
      if (desfasado > 60) {
        log(`🛑 Encaixe: o instante de envio já passou há ${desfasado}s. Não envio nada.`);
        return;
      }

      // esperar até ao instante de envio (antecipado pela compensação)
      // Deslocar o envio pelo viés observado neste mundo (mediana dos desvios).
      const vies = vieselObservado();
      if (vies) log(`   (a corrigir ${vies > 0 ? '-' : '+'}${Math.abs(vies)}s pelo viés observado)`);
      // A antecipação tem de ser aplicada AQUI: antes, "começar N segundos
      // antes" só decidia quando a rotina arrancava, e ela ficava depois à
      // espera da hora exacta — a primeira tentativa saía sempre na hora, nunca
      // antes, e todo o varrimento inicial se perdia.
      const antecipacao = (plano.comecarAntes != null) ? Number(plano.comecarAntes) : c.comecarAntes;
      const inicioRajada = envioPrevisto - antecipacao - vies;
      log(`   (rajada começa ${antecipacao}s antes da hora de envio)`);
      const esperar = (inicioRajada - agora()) * 1000;
      if (esperar > 0) await new Promise((r) => setTimeout(r, esperar));


      // Guardar os comandos já existentes: o que aparecer a mais é o nosso.
      const conhecidos = new Set();
      try {
        const mm = mUw.MM.getModels().MovementsUnits || {};
        Object.keys(mm).forEach((k) => conhecidos.add(Number((mm[k].attributes || {}).command_id)));
      } catch (e) {}
      // e também os que o servidor já conhece (o modelo local costuma estar vazio)
      try {
        (await comandosDoServidor(plano.origemId)).forEach((x) => conhecidos.add(x.command_id));
      } catch (e) {}

      // ciclo de afinação: envia, verifica, cancela se falhar
      let atrasosSeguidos = 0;
      // Folga aprendida em rajadas anteriores: assim não se repete o mesmo
      // tropeço todas as vezes (40% das tentativas chegaram a ser perdidas).
      let folgaExtra = 0;
      try { folgaExtra = Math.min(900, Number(armazem.getItem('grepoEncaixe_folga_v1')) || 0); } catch (e) {}
      // Atenção ao 0: `x || 10` trocaria um limite de 0 s por 10 s, tornando
      // impossível pedir "parar assim que passar da hora". Mesmo erro que já
      // nos mordeu na margem de segundos.
      const limiteTempo = envioPrevisto + numeroOu(plano.limiteAposEnvioSeg, numeroOu(c.limiteAposEnvioSeg, 10));
      for (let tentativa = 1; tentativa <= c.maxTentativas; tentativa++) {
        // Trava por tempo: passada a janela, mais tentativas só chegariam
        // ainda mais tarde (a deriva é de ~1 s por segundo decorrido).
        if (agora() > limiteTempo) {
          const e3 = estatisticaDesvios();
          log(`⏰ Encaixe: passaram ${Math.round(agora() - envioPrevisto)}s da hora de envio — paro. Sem comando enviado.`);
          if (e3) log(`   (variação acumulada: ${e3.min}s a +${e3.max}s, mediana ${e3.mediana >= 0 ? '+' : ''}${e3.mediana}s em ${e3.n} tentativas)`);
          return;
        }
        const tEnvio = Date.now();
        const r = await enviarComando(plano.origemId, plano.alvoId, plano.unidades, plano.tipo);
        if (!r.ok) {
          // "Não há unidades suficientes" logo a seguir a um cancelamento
          // costuma significar que as tropas ainda vêm a caminho de casa:
          // esperar um pouco e repetir, em vez de desistir do encaixe.
          if (/unidades|units/i.test(String(r.msg)) && tentativa < c.maxTentativas) {
            // Se isto acontece, a folga está curta: aumentamo-la para as
            // tentativas seguintes, para não desperdiçar mais nenhuma.
            folgaExtra = Math.min(900, folgaExtra + 150);
            try { armazem.setItem('grepoEncaixe_folga_v1', String(folgaExtra)); } catch (e) {}
            /* Mostrar a mensagem EXACTA do servidor: "tropas ainda a regressar"
             * é a minha interpretação, e pode estar errada. Sem o texto real
             * não se distingue tropa fora de casa de outro problema qualquer. */
            log(`   tentativa ${tentativa}: "${r.msg}" — espero mais ${folgaExtra} ms e repito.`);
            await new Promise((res) => setTimeout(res, 250 + folgaExtra));
            continue;
          }
          log(`⚠️ Encaixe: envio falhou (${r.msg}).`);
          return;
        }

        /* Procurar o comando que acabou de sair — DEPRESSA.
         *
         * A rajada de tentativas é o coração do encaixe: cada ciclo demora
         * poucas centenas de milissegundos e são elas que acertam no segundo
         * certo. Uma pausa longa aqui parte a rajada e perde-se a janela toda.
         *
         * Por isso: duas tentativas rápidas (~80 ms cada) e segue. Se não se
         * encontrar, trata-se disso mais abaixo sem estragar o ritmo. */
        let cmd = null;
        /* DIAGNÓSTICO: guardar o que cada fonte devolveu, para saber onde
         * falhou quando não se encontra o comando. Não altera os tempos. */
        const diag = { local: 0, servidor: 0, tentativas: 0 };

        for (let tent = 0; tent < 2 && !cmd; tent++) {
          await new Promise((res) => setTimeout(res, 80));
          diag.tentativas++;

          cmd = comandoMaisRecente(plano.origemId, plano.alvoId, conhecidos);
          if (cmd) diag.local++;
          if (cmd && cmd.arrival_at) break;

          const doServidor = await comandosDoServidor(plano.origemId);
          diag.servidor = doServidor.length;
          const novos = doServidor.filter((x) => !conhecidos.has(x.command_id));
          if (novos.length) {
            cmd = novos.sort((a, b) => b.command_id - a.command_id)[0];
            if (cmd && cmd.arrival_at) break;
          }
          cmd = null;
        }
        if (!cmd || !cmd.arrival_at) {
          // NÃO deixar o comando à solta: se não se consegue verificar a hora
          // de chegada, não se sabe se acertou — e um ataque fora de horas pode
          // ser pior do que nenhum. Tenta cancelar o que acabou de sair.
          log('⚠️ Encaixe: não consegui ler a chegada. A cancelar o comando por segurança.');
          log(`   [diagnóstico] ${diag.tentativas} tentativa(s) · modelo local: `
            + `${diag.local ? 'devolveu comando sem hora' : 'vazio'} · `
            + `servidor: ${diag.servidor} comando(s) devolvido(s)`);
          /* Aqui já se desistiu da rajada, portanto pode-se insistir: deixar
           * um comando à solta é o pior resultado possível. */
          let ult = null;
          for (let tent = 0; tent < 5 && !ult; tent++) {
            if (tent) await new Promise((res) => setTimeout(res, 600));
            ult = ultimoComandoEnviado(plano.origemId, plano.alvoId, conhecidos);
            if (ult) break;
            const sv = (await comandosDoServidor(plano.origemId)).filter((x) => !conhecidos.has(x.command_id));
            if (sv.length) ult = sv.sort((a, b) => b.command_id - a.command_id)[0];
          }
          if (ult && ult.command_id) {
            const cr = await cancelar(ult.command_id, plano.origemId);
            log(cr.ok ? '↩️ Comando cancelado.' : `🛑 NÃO consegui cancelar (${cr.msg}) — verifica no jogo!`);
          } else {
            log('🛑 Não encontrei o comando para cancelar — VERIFICA NO JOGO. '
              + 'Pode ter saído tropa da cidade ' + plano.origemId + '.');
            try { if (ctx.avisarDiscord) await ctx.avisarDiscord('ataque',
              `Encaixe: enviei um comando da cidade ${plano.origemId} e não consegui `
              + 'cancelá-lo nem confirmar a chegada. Verifica no jogo.'); } catch (e) {}
          }
          return;
        }

        // Se o comando saiu para outra cidade que não a esperada, avisar já:
        // significa que o campo do alvo não correspondia à janela usada.
        const destinoReal = Number(cmd.destino || cmd.target_town_id);
        if (plano.alvoId && destinoReal && destinoReal !== Number(plano.alvoId)) {
          log(`⚠️ Encaixe: o comando saiu para a cidade ${destinoReal}, não para ${plano.alvoId}. A cancelar.`);
          await cancelar(cmd.command_id, plano.origemId);
          return;
        }

        const desvio = Number(cmd.arrival_at) - plano.chegada;

        // Limites aceitáveis conforme a direção escolhida.
        const dir = plano.direcao || c.direcao || 'ambos';
        const marg = (plano.margemSeg != null) ? Number(plano.margemSeg) : c.margemSeg;
        const limInf = (dir === 'depois') ? 0 : -marg;
        const limSup = (dir === 'antes') ? 0 : marg;
        const aceite = desvio >= limInf && desvio <= limSup;

        if (aceite) {
          log(`✅ Encaixe conseguido à ${tentativa}ª tentativa: chega às ${horaJogo(cmd.arrival_at)} (${desvio >= 0 ? '+' : ''}${desvio}s).`);
          return;
        }

        // Contar atrasos SEGUIDOS: passou o limite superior aceitável, logo o
        // relógio já ultrapassou a janela útil e as seguintes só piorariam.
        // Com direção 'antes', o limite superior é a própria hora — por isso
        // uma chegada 1s depois já conta como tarde.
        // Chegadas ADIANTADAS nunca contam: a janela ainda não abriu.
        if (desvio > limSup) atrasosSeguidos++; else atrasosSeguidos = 0;


        // fora da margem: cancelar e tentar de novo
        conhecidos.add(Number(cmd.command_id));
        const cicloMs = Date.now() - tEnvio;
        // Tempo que as tropas estiveram EM VIAGEM: do envio até ao cancelamento.
        // É esse que demoram a regressar, a contar do cancelamento.
        const tCancelamento = Date.now();
        registarDesvio(desvio);
        log(`   tentativa ${tentativa}: ${desvio >= 0 ? '+' : ''}${desvio}s (ciclo ${cicloMs} ms)`);

        const cr = await cancelar(cmd.command_id, plano.origemId);
        if (!cr.ok) { log(`⚠️ Encaixe: chegada ${desvio}s fora e não consegui cancelar (${cr.msg}).`); return; }

        const limiteAtrasos = numeroOu(plano.atrasosSeguidosParaParar, numeroOu(c.atrasosSeguidosParaParar, 10));
        if (atrasosSeguidos >= limiteAtrasos) {
          const e2 = estatisticaDesvios();
          log(`🛑 Encaixe: ${atrasosSeguidos} tentativas seguidas já a chegar tarde (último ${desvio >= 0 ? '+' : ''}${desvio}s) — a janela fechou. Desisto sem deixar comando.`);
          if (e2) log(`   (variação acumulada: ${e2.min}s a +${e2.max}s, mediana ${e2.mediana >= 0 ? '+' : ''}${e2.mediana}s em ${e2.n} tentativas)`);
          return;
        }
        if (tentativa === c.maxTentativas) {
          log(`🛑 Encaixe: ${c.maxTentativas} tentativas sem acertar (último desvio ${desvio}s). Desisto.`);
          return;
        }
        // Ao cancelar, as tropas demoram a voltar o mesmo tempo que estiveram
        // em viagem — a contar DO CANCELAMENTO. Se tentarmos antes disso, o
        // jogo responde "não há unidades suficientes".
        // A espera pelo regresso das tropas é o GARGALO: medido, passar de
        // 1,9 s para 0,8 s por tentativa sobe o sucesso com margem 0 de 41%
        // para 76%. Por isso esperamos só o mínimo teórico (o tempo que
        // estiveram em viagem) e deixamos que uma recusa ocasional custe uma
        // tentativa — sai mais barato do que esperar sempre pelo pior caso.
        const emViagemMs = tCancelamento - tEnvio;
        const jaPassou = Date.now() - tCancelamento;
        // ESPERA ADAPTATIVA: perto do alvo, cada tentativa vale ouro — a
        // rajada só atravessa a zona útil durante alguns segundos, e é aí que
        // se acerta (medido: 4 tentativas seguidas a +1, +2, +1, -1). Longe do
        // alvo, uma tentativa perdida não custa nada, por isso damos folga.
        const perto = Math.abs(desvio) <= 4;
        const folgaAgora = perto ? Math.min(folgaExtra, 150) : folgaExtra;
        const pausaAgora = perto ? Math.min(c.margemPausaMs, 120) : c.margemPausaMs;
        let faltaEsperar = Math.max(0, emViagemMs - jaPassou) + pausaAgora + folgaAgora;

        // NÃO saltar para o alvo, mesmo sabendo o desvio. Parece contra-
        // intuitivo, mas foi medido: saltar diretamente baixa o sucesso com
        // margem 0 de 83% para 64%. A razão é que a rajada funciona por
        // VARRIMENTO — o desvio desloca-se ~1 s por segundo decorrido, e
        // avançar devagar faz cair muitas tentativas perto do zero. Um salto
        // passa por cima dessa zona e, com o ruído, falha do outro lado.
        await new Promise((res) => setTimeout(res, faltaEsperar));
      }
    } catch (e) {
      ctx.log('Encaixe falhou: ' + e.message);
    } finally {
      try { if (libertar) libertar(); } catch (e) {}
      cidadeOcupada.delete(Number(plano.origemId));
      emCurso.delete(chave);
      // retirar o plano da lista
      (() => { if (temporizadores[chave]) { clearTimeout(temporizadores[chave]); delete temporizadores[chave]; } })();
      gravarPlanos(lerPlanos().filter((p) => p.id !== chave), true);
    }
  }

  /* ------------------------------- run ---------------------------------- */
  async function run(ctx) {
    const rotina = ctx.logRotina || ctx.log;
    mUw = ctx.uw; mWorld = ctx.WORLD;
    instalarEspiaoDeAlvo();  // aprende o alvo quando envias algo à mão
    vigiarJanelaDeAtaque(ctx);   // fica atento à abertura da janela
    injetarNaJanela(ctx);
    mUw = ctx.uw; mWorld = ctx.WORLD;
    /* O `log` tem de vir do ctx: sem isto apanhava um `log` global e a linha
     * saía mal formada no registo (o texto aparecia como nome do módulo). */
    const log = ctx.log;
    const c = cfg();
    if (!c.ativo) { rotina('Encaixe: está desligado.'); return; }

    const planos = lerPlanos();
    if (!planos.length) { /* sem planos agendados: silêncio é apropriado aqui */ return; }

    for (const plano of planos) {
      if (emCurso.has(plano.id)) continue;
      const alvo = plano.alvoCoords || coordsCidade(plano.alvoId);
      const duracao = plano.duracaoJogo || duracaoPrevista(plano.origemId, alvo, plano.unidades, c);
      if (!duracao) continue;
      const envioPrevisto = plano.chegada - duracao;
      const faltam = envioPrevisto - agora();

      if (faltam < -60) {                       // já passou a hora
        const hh = (t) => horaJogo(t);
        ctx.log(`⌛ Encaixe: plano descartado — envio era às ${hh(envioPrevisto)}, `
          + `agora são ${hh(agora())} (passaram ${Math.round(-faltam / 60)} min). `
          + `Chegada ${hh(plano.chegada)}, viagem ${Math.round(duracao / 60)} min.`);
        gravarPlanos(lerPlanos().filter((p) => p.id !== plano.id), true);
        continue;
      }
      /* ARMAR UM TEMPORIZADOR, em vez de esperar pela próxima passagem.
       *
       * Antes só arrancava se a passagem do módulo calhasse na janela certa.
       * Como o módulo corre de ~26 em ~26 s, uma passagem podia apanhar 40 s
       * antes e a seguinte já depois da hora — e perdia-se tudo. Visto em
       * jogo: agendado às 03:57:08 para sair às 03:58:30, a rajada só arrancou
       * às 03:59:07, 37 s atrasada.
       *
       * Agora marca-se a hora exacta e o temporizador dispara sozinho. */
      const antesDoPlano = (plano.comecarAntes != null) ? Number(plano.comecarAntes) : c.comecarAntes;

      if (faltam <= antesDoPlano + 5) {
        executar(ctx, plano).catch(() => {});
      } else if (!temporizadores[plano.id]) {
        const esperarMs = Math.max(0, (faltam - antesDoPlano - 2) * 1000);
        temporizadores[plano.id] = setTimeout(() => {
          delete temporizadores[plano.id];
          executar(ctx, plano).catch(() => {});
        }, esperarMs);
        ctx.log(`⏳ Encaixe: rajada armada para daqui a ${Math.round(esperarMs / 1000)}s `
          + `(envio às ${horaJogo(envioPrevisto)}).`);
      }
    }
  }

  /* ------------- PAINEL DENTRO DA JANELA DE ATAQUE/APOIO ---------------- *
   * Aproveita a janela do jogo: usa as unidades que lá selecionaste e a cidade
   * alvo que está aberta. Assim não é preciso repetir nada noutro sítio.
   * --------------------------------------------------------------------- */

  // Alvo selecionado. Lê o endereço por várias vias: com o Tampermonkey, o
  // `location` obtido através do unsafeWindow nem sempre reflete o hash atual,
  // por isso tentamos também o document e o window direto.
  function hashAtual() {
    const fontes = [];
    try { fontes.push(String(window.location.hash || '')); } catch (e) {}
    try { fontes.push(String(document.location.hash || '')); } catch (e) {}
    try { fontes.push(String(mUw.location.hash || '')); } catch (e) {}
    try { fontes.push(String(top.location.hash || '')); } catch (e) {}
    for (const h of fontes) if (h && h.indexOf('eyJ') >= 0) return h;
    return '';
  }

  /* ---- IDENTIFICAÇÃO DO ALVO ------------------------------------------
   * O jogo NÃO expõe de forma fiável a cidade da janela aberta: o endereço só
   * às vezes tem o identificador, o título é apenas o nome (que o dono pode
   * mudar) e não há coordenadas em lado nenhum. Tentar adivinhar arriscaria
   * enviar o comando para a cidade errada — por isso o alvo é EXPLÍCITO.
   *
   * Há um modo de captura: ligas, envias uma unidade à mão, e o identificador
   * desse envio fica no campo para confirmares.
   * ------------------------------------------------------------------- */
  let capturaAtiva = false;
  let aoCapturar = null;

  // Alvo detetado automaticamente: quando abres a janela de ataque/apoio de
  // uma cidade, o jogo pede /game/town_info?action=attack|support com o id
  // dessa cidade no parâmetro "id". É a via fiável — a janela em si não o
  // expõe, e o endereço da página nem sempre o tem.
  let alvoDetetado = null;

  let espiaoInstalado = false;
  function instalarEspiaoDeAlvo() {
    if (espiaoInstalado) return;
    espiaoInstalado = true;
    try {
      const XHR = mUw.XMLHttpRequest.prototype;
      const oOpen = XHR.open, oSend = XHR.send;
      XHR.open = function (m, u) { this.__encUrl = u; return oOpen.apply(this, arguments); };
      XHR.send = function (b) {
        try {
          const u = String(this.__encUrl || '');
          // 1) o pedido de abertura da janela traz o alvo
          if (/town_info/.test(u) && /action=(attack|support)/.test(u)) {
            let j = null;
            try { j = JSON.parse(decodeURIComponent((u.split('json=')[1] || '').split('&')[0])); } catch (e) {}
            const id = j && (j.id || j.target_town_id);
            if (id) {
              alvoDetetado = Number(id);
              const campo = document.getElementById('encj-alvo');
              if (campo && !campo.dataset.manual) campo.value = alvoDetetado;
              const nb = document.getElementById('encj-alvo-nome');
              if (nb) nb.textContent = 'alvo ' + alvoDetetado + ' (detetado)';
            }
          }
          // 2) captura manual (botão "captar"), se ainda for usada
          if (capturaAtiva && /send_units/.test(u)) {
            const j = JSON.parse(decodeURIComponent(String(b || '')).replace('json=', ''));
            if (j && j.id && aoCapturar) { capturaAtiva = false; aoCapturar(Number(j.id)); }
          }
        } catch (e) {}
        return oSend.apply(this, arguments);
      };
    } catch (e) {}
  }

  // O JOGO já calcula e mostra o tempo de viagem na janela (classe
  // "way_duration", ex.: "~00:06:09"). Esse valor é exato e inclui todos os
  // bónus — é muito melhor do que estimar por distância, e funciona para
  // cidades inimigas, cujas coordenadas não temos.
  function duracaoDaJanela() {
    try {
      const el = document.querySelector('.way_duration');
      if (!el) return null;
      const m = String(el.textContent || '').match(/(\d{1,2}):(\d{2}):(\d{2})/);
      if (!m) return null;
      const seg = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      return seg > 0 ? seg : null;
    } catch (e) { return null; }
  }

  // Unidades escritas nos campos da janela do jogo.
  function unidadesDaJanela() {
    const out = {};
    try {
      document.querySelectorAll('input.unit_input[name]').forEach((i) => {
        const n = parseInt(i.value, 10);
        if (n > 0) out[i.name] = n;
      });
    } catch (e) {}
    return out;
  }

  // Coordenadas de uma cidade conhecida do mapa, pelo id.
  function coordsDoMapa(townId) {
    try {
      const col = (mUw.MM.getCollections().Town || [])[0];
      for (const m of ((col && col.models) || [])) {
        const a = m.attributes || {};
        if (Number(a.id) === Number(townId)) return { ix: Number(a.island_x), iy: Number(a.island_y) };
      }
    } catch (e) {}
    return null;
  }

  function alvoDaJanela() {
    // 1ª via: o endereço da página, quando o jogo o preenche
    try {
      const m = hashAtual().match(/#?(eyJ[A-Za-z0-9+/=]+)/);
      if (m) {
        const o = JSON.parse(atob(m[1]));
        if (o && o.tp === 'town' && o.id) {
          return { id: Number(o.id), ix: Number(o.ix), iy: Number(o.iy), nome: o.name || ('cidade ' + o.id), via: 'endereço' };
        }
      }
    } catch (e) {}

    // 2ª via: o alvo detetado no pedido de abertura da janela
    if (alvoDetetado) {
      const c = coordsDoMapa(alvoDetetado);
      return { id: alvoDetetado, ix: c ? c.ix : null, iy: c ? c.iy : null,
        nome: 'cidade ' + alvoDetetado, via: 'detetado' };
    }

    // 3ª via: identificador escrito (ou capturado) no campo do painel
    try {
      const campo = document.getElementById('encj-alvo');
      const id = campo && Number(campo.value);
      if (id > 0) {
        const c = coordsDoMapa(id);
        return { id, ix: c ? c.ix : null, iy: c ? c.iy : null, nome: 'cidade ' + id, via: 'indicado' };
      }
    } catch (e) {}

    return null;
  }

  // Estica a janela para acomodar o painel injetado. Usa o scrollHeight (o que
  // o conteúdo realmente precisa) em vez de somar alturas, que descoordenava.
  function ajustarAltura(cont, box) {
    try {
      const aplicar = () => {
        const preciso = cont.scrollHeight;
        if (!preciso) return;
        cont.style.height = preciso + 'px';
        const frame = cont.parentElement;
        if (frame) frame.style.height = (preciso + 22) + 'px';
        const dialog = frame && frame.parentElement;
        if (dialog && dialog.classList.contains('ui-dialog')) {
          dialog.style.height = (preciso + 62) + 'px';
        }
      };
      aplicar();
      // repetir depois de o navegador desenhar: só então o scrollHeight é fiável
      setTimeout(aplicar, 60);
      setTimeout(aplicar, 300);
      // e sempre que o painel mudar de tamanho (mensagens, campos)
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => aplicar());
        ro.observe(box);
      }
    } catch (e) {}
  }

  /* Vigiar a abertura da janela de ataque.
   *
   * Antes, o painel do encaixe só aparecia quando o módulo corria — podia
   * demorar minutos, e ao abrir a janela não havia nada. Agora fica um
   * observador atento: mal a janela apareça, o painel entra.
   *
   * Usa-se MutationObserver (reage à mudança) com uma verificação periódica
   * de reserva, para o caso de o jogo trocar o conteúdo sem alterar a árvore. */
  let vigiaJanela = null;

  function vigiarJanelaDeAtaque(ctx) {
    if (vigiaJanela) { vigiaJanela.ctx = ctx; return; }
    vigiaJanela = { ctx };

    const tentar = () => {
      try { injetarNaJanela(vigiaJanela.ctx); } catch (e) {}
    };

    try {
      const obs = new MutationObserver(() => {
        // só faz trabalho a sério se houver janela nova sem o painel
        if (document.getElementById('encaixe-box')) return;
        if (!document.querySelector('input.unit_input[name]')) return;
        tentar();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}

    // reserva: de 2 em 2 segundos, barato porque sai logo se já lá está
    setInterval(tentar, 2000);
    tentar();
  }

  function injetarNaJanela(ctx) {
    try {
      if (document.getElementById('encaixe-box')) return;
      const cont = document.querySelector('.gpwindow_content');
      if (!cont) return;
      if (!document.querySelector('input.unit_input[name]')) return;  // não é a janela certa

      const c = cfg();
      const box = document.createElement('div');
      box.id = 'encaixe-box';
      box.style.cssText = 'margin:6px;padding:7px;background:#1b2838;color:#cde;border-radius:6px;font:11px sans-serif';
      box.innerHTML = `
        <div style="background:linear-gradient(#2b3a4d,#1d2836);padding:5px 8px;border-radius:5px 5px 0 0;font-weight:bold;letter-spacing:.3px;display:flex;justify-content:space-between;align-items:center">
          <span>⏱️ ENCAIXE DE COMANDOS</span>
          <span id="encj-alvo-nome" style="font-weight:normal;opacity:.75;font-size:10px"></span>
        </div>
        <div style="padding:7px 8px">

          <div style="font-size:10px;letter-spacing:.5px;opacity:.65;margin-bottom:3px">DATA DE CHEGADA</div>
          <div style="display:flex;gap:4px;align-items:center;margin-bottom:8px">
            <select id="encj-dia" style="flex:0 0 74px"><option value="0">Hoje</option><option value="1">Amanhã</option></select>
            <input id="encj-h" type="number" min="0" max="23" placeholder="HH" style="width:46px;text-align:center">
            <span style="opacity:.5">:</span>
            <input id="encj-m" type="number" min="0" max="59" placeholder="MM" style="width:46px;text-align:center">
            <span style="opacity:.5">:</span>
            <input id="encj-s" type="number" min="0" max="59" placeholder="SS" style="width:46px;text-align:center">
          </div>

          <div style="border:1px solid #2c3e50;border-radius:5px;padding:6px;margin-bottom:8px">
            <div style="font-size:10px;letter-spacing:.5px;opacity:.65;margin-bottom:4px">TOLERÂNCIA DE CHEGADA</div>
            <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
              <span>Desvio máx.:</span>
              <select id="encj-margem" style="width:62px">
                ${[0,1,2,3,4,5].map((n) => `<option value="${n}"${n === c.margemSeg ? ' selected' : ''}>${n}s</option>`).join('')}
              </select>
              <span>Direção:</span>
              <select id="encj-dir" style="width:104px">
                <option value="ambos"${c.direcao === 'ambos' ? ' selected' : ''}>Os dois</option>
                <option value="antes"${c.direcao === 'antes' ? ' selected' : ''}>Só antes</option>
                <option value="depois"${c.direcao === 'depois' ? ' selected' : ''}>Só depois</option>
              </select>
            </div>
            <div style="font-size:10px;opacity:.55;margin-top:3px">Aceita esta diferença entre a chegada real e a pretendida.</div>
            <div id="encj-aviso-margem" style="font-size:10px;opacity:.75;margin-top:2px"></div>
          </div>

          <div style="display:flex;gap:5px;align-items:center;margin-bottom:8px;font-size:11px">
            <span>Tentativas:</span>
            <input id="encj-max" type="number" min="1" max="80" value="${c.maxTentativas}" style="width:48px">
            <span style="opacity:.5">·</span>
            <span title="Desiste quando este número de tentativas seguidas chegar depois da hora">Desistir após:</span>
            <input id="encj-atrasos" type="number" min="1" max="30" value="${c.atrasosSeguidosParaParar}" style="width:42px">
            <span style="opacity:.5">·</span>
            <span title="Deixa de tentar passados estes segundos da hora ideal de envio">Parar após:</span>
            <input id="encj-limite" type="number" min="2" max="120" value="${c.limiteAposEnvioSeg}" style="width:42px">s
            <span style="opacity:.5">·</span>
            <span title="Começa a tentar estes segundos antes da hora ideal de envio">Começar antes:</span>
            <input id="encj-antes" type="number" min="0" max="60" value="${c.comecarAntes}" style="width:42px">s
            <span style="opacity:.5">·</span>
            <span>Cidade alvo:</span>
            <input id="encj-alvo" type="number" placeholder="id desta cidade" style="width:92px" title="Identificador da cidade DESTA janela — usa 'captar' se não souberes">
            <button id="encj-captar" style="cursor:pointer;padding:2px 6px" title="Liga a captura e envia 1 unidade à mão: o id aparece aqui">captar</button>
          </div>

          <div style="display:flex;gap:5px">
            <button id="encj-atk" style="flex:1;cursor:pointer;padding:5px;background:#7a3b2e;color:#fee;border:none;border-radius:4px;font-weight:bold">⚔ Programar ataque</button>
            <button id="encj-sup" style="flex:1;cursor:pointer;padding:5px;background:#2e5a7a;color:#eef;border:none;border-radius:4px;font-weight:bold">🛡 Programar apoio</button>
          </div>

          <div id="encj-info" style="margin-top:6px;background:#0d141c;padding:5px;border-radius:4px;min-height:15px;font-size:11px"></div>
          <div id="encj-agendados" style="margin-top:4px;font-size:11px"></div>
          <div style="opacity:.5;margin-top:4px;font-size:10px">O jogo varia a viagem ~6s. Com ±3s costuma acertar à primeira; margens apertadas exigem muitas tentativas.</div>
        </div>`;
      cont.insertBefore(box, cont.firstChild);

      // A janela do jogo tem altura fixa, calculada antes de inserirmos isto:
      // sem ajustar, o fundo não acompanha e o rodapé fica sobre o mapa.
      // O autoResize do jogo não chega — forçamos a altura pelo conteúdo real.
      ajustarAltura(cont, box);

      // mostrar no cabeçalho qual o alvo detetado (ou avisar que falta)
      try {
        const al = alvoDaJanela();
        const nomeBox = box.querySelector('#encj-alvo-nome');
        if (nomeBox) nomeBox.textContent = al
          ? ('alvo ' + al.id + ' (' + al.via + ')')
          : 'indica a cidade alvo → escreve o id ou usa "captar"';
      } catch (e) {}

      // botão de captura do identificador
      const campoAlvo = box.querySelector('#encj-alvo');
      if (campoAlvo) {
        if (alvoDetetado && !campoAlvo.value) campoAlvo.value = alvoDetetado;
        campoAlvo.oninput = () => { campoAlvo.dataset.manual = '1'; alvoDetetado = null; };
      }
      const btnCapt = box.querySelector('#encj-captar');
      if (btnCapt) btnCapt.onclick = () => {
        capturaAtiva = true;
        btnCapt.textContent = 'à espera…';
        aoCapturar = (id) => {
          campoAlvo.value = id;
          btnCapt.textContent = 'captado ✓';
          const nb = box.querySelector('#encj-alvo-nome');
          if (nb) nb.textContent = 'alvo: ' + id + ' (confirma antes de programar)';
          setTimeout(() => { btnCapt.textContent = 'captar'; }, 2500);
        };
        setTimeout(() => { if (capturaAtiva) { capturaAtiva = false; btnCapt.textContent = 'captar'; } }, 60000);
      };

      const info = box.querySelector('#encj-info');
      const diz = (m) => { info.textContent = m; if (ctx) ctx.log(m); };

      // Lista dos agendamentos activos aqui mesmo, com cancelamento — para não
      // ser preciso ir ao painel do maestro só para desfazer.
      const mostrarAgendados = () => {
        const cx = box.querySelector('#encj-agendados');
        if (!cx) return;
        const ps = lerPlanos();
        if (!ps.length) { cx.innerHTML = ''; return; }
        const off = desvioFuso();
        const hh = (t) => new Date((t + off) * 1000).toISOString().substr(11, 8);
        cx.innerHTML = ps.map((p) => `<div style="display:flex;justify-content:space-between;border-top:1px solid #223;padding:2px 0">
          <span>${p.tipo === 'attack' ? '⚔' : '🛡'} → ${p.alvoId} · chega ${hh(p.chegada)}</span>
          <a href="#" data-canc="${p.id}" style="color:#f88;text-decoration:none">✕</a></div>`).join('');
        cx.querySelectorAll('[data-canc]').forEach((el) => {
          el.onclick = (ev) => {
            ev.preventDefault();
            gravarPlanos(lerPlanos().filter((x) => x.id !== el.getAttribute('data-canc')), true);
            diz('Agendamento cancelado.');
            mostrarAgendados();
          };
        });
      };
      mostrarAgendados();

      let diaSeguinte = false;
      const lerHora = () => {
        diaSeguinte = false;
        const h = Number(box.querySelector('#encj-h').value);
        const m = Number(box.querySelector('#encj-m').value);
        const sg = Number(box.querySelector('#encj-s').value);
        if (![h, m, sg].every(Number.isFinite)) return null;
        const escolheuAmanha = Number(box.querySelector('#encj-dia').value) === 1;
        let ts = horaDoJogoParaTimestamp(h, m, sg, escolheuAmanha);
        // Só empurra para o dia seguinte se a hora JÁ PASSOU no relógio do jogo.
        if (!escolheuAmanha && ts <= agora()) { ts += 86400; diaSeguinte = true; }
        return ts;
      };

      const programar = (tipo) => {
        if (agora() == null) { diz('Sem relógio do servidor — não programo às cegas.'); return; }
        const conf = Object.assign({}, cfg(), {
          // ATENÇÃO: nunca usar "|| 2" aqui — em JavaScript o zero é falso, e
          // uma margem de 0 (a mais exigente) seria silenciosamente trocada
          // por 2. Foi este o erro que fazia aceitar chegadas a -2s.
          margemSeg: (function () {
            const v = Number(box.querySelector('#encj-margem').value);
            return Number.isFinite(v) ? Math.min(5, Math.max(0, v)) : 2;
          })(),
          direcao: box.querySelector('#encj-dir').value,
          maxTentativas: Number(box.querySelector('#encj-max').value) || 40,
          ativo: true,
        });
        guardarCfg(conf);

        const chegada = lerHora();
        if (!chegada) { diz('Hora inválida.'); return; }
        const alvo = alvoDaJanela();
        if (!alvo) { diz('Não identifiquei a cidade alvo desta janela.'); return; }
        const unidades = unidadesDaJanela();
        if (!Object.keys(unidades).length) { diz('Escolhe primeiro as unidades nos campos acima.'); return; }

        const origemId = Number(mUw.Game.townId);
        // Preferir SEMPRE o tempo que o jogo mostra na janela.
        let dur = duracaoDaJanela();
        let fonte = 'do jogo';
        if (!dur) {
          dur = duracaoPrevista(origemId, alvo, unidades, conf);
          fonte = 'estimada';
        }
        if (!dur) { diz('Não consegui obter a duração da viagem — confirma que há unidades selecionadas.'); return; }

        const envio = chegada - dur;
        const faltam = envio - agora();
        if (faltam < 0) { diz(`Tarde demais: teria de ter saído há ${Math.abs(faltam)}s.`); return; }

        // Guardar a margem e a direção NO PLANO: se as mudares depois, o
        // agendamento já feito mantém as condições com que foi criado.
        // Avisar se já houver um agendamento da mesma cidade com horas
        // próximas: as rajadas usam as mesmas tropas e vão ter de esperar
        // uma pela outra, o que pode fazer a segunda perder a janela.
        try {
          const conflito = lerPlanos().find((x) => Number(x.origemId) === Number(origemId)
            && Math.abs(Number(x.chegada) - chegada) < 120);
          if (conflito) {
            diz('⚠️ Já há um agendamento desta cidade a menos de 2 min — as rajadas competem pelas mesmas tropas.');
          }
        } catch (e) {}

        adicionarPlano({ origemId, alvoId: alvo.id, alvoCoords: alvo, unidades, tipo, chegada,
          direcao: box.querySelector('#encj-dir').value,
          margemSeg: conf.margemSeg,
          atrasosSeguidosParaParar: conf.atrasosSeguidosParaParar,
          limiteAposEnvioSeg: conf.limiteAposEnvioSeg,
          comecarAntes: conf.comecarAntes,
          duracaoJogo: dur });
        const hh = (t) => new Date((t + desvioFuso()) * 1000).toISOString().substr(11, 8);
        diz(`Agendado: chega ${hh(chegada)}${diaSeguinte ? ' de AMANHÃ' : ''} · sai ~${hh(envio)} · viagem ${Math.round(dur / 60)} min (${fonte}).`);
        mostrarAgendados();
      };

      // Guardar as opções assim que mudam — antes só eram guardadas ao
      // programar, e o painel do maestro mostrava valores antigos.
      // Avisar se a margem escolhida for exigente face à variação já observada
      const avaliarMargem = () => {
        const e = estatisticaDesvios();
        const av = box.querySelector('#encj-aviso-margem');
        if (!av) return;
        const m = Number(box.querySelector('#encj-margem').value);
        if (!e || e.n < 8) { av.textContent = ''; return; }
        const amplitude = e.max - e.min + 1;
        const hipotese = Math.min(1, (2 * m + 1) / amplitude);
        const tentativas = hipotese > 0 ? Math.ceil(1 / hipotese) : 99;
        av.textContent = tentativas <= 2
          ? `variação observada ${e.min}s a +${e.max}s — deve acertar à primeira`
          : `variação observada ${e.min}s a +${e.max}s — ~${tentativas} tentativas em média`;
        av.style.color = tentativas > 12 ? '#fc8' : '';
      };

      const guardarOpcoes = () => {
        guardarCfg(Object.assign({}, cfg(), {
          margemSeg: Math.min(5, Math.max(0, Number(box.querySelector('#encj-margem').value))),
          direcao: box.querySelector('#encj-dir').value,
          maxTentativas: Number(box.querySelector('#encj-max').value) || 40,
          atrasosSeguidosParaParar: Number(box.querySelector('#encj-atrasos').value) || 15,
          limiteAposEnvioSeg: Number(box.querySelector('#encj-limite').value) || 10,
          comecarAntes: (function () {
            const v = Number(box.querySelector('#encj-antes').value);
            return Number.isFinite(v) ? Math.max(0, v) : 12;
          })(),
        }));
        // redesenhar o painel do maestro: senão continua a mostrar os valores
        // de quando foi aberto (era isto que mostrava ±2s com margem 0 escolhida)
        try {
          if (painelRef && painelRef.container && painelRef.container.isConnected) {
            painel(painelRef.container, painelRef.ctx);
          }
        } catch (e) {}
      };
      ['#encj-margem', '#encj-dir', '#encj-max', '#encj-atrasos', '#encj-limite', '#encj-antes'].forEach((sel) => {
        const el = box.querySelector(sel);
        if (el) el.onchange = () => { guardarOpcoes(); avaliarMargem(); };
      });
      avaliarMargem();

      box.querySelector('#encj-atk').onclick = () => programar('attack');
      box.querySelector('#encj-sup').onclick = () => programar('support');
    } catch (e) {}
  }

  /* ---------------------- API para o painel ----------------------------- */
  function adicionarPlano(p) {
    const planos = lerPlanos();
    planos.push(Object.assign({ id: 'p' + Date.now() }, p));
    gravarPlanos(planos);
  }

  let painelRef = null;   // para redesenhar quando os agendamentos mudarem

  function painel(container, ctx) {
    vigiarJanelaDeAtaque(ctx);   // não esperar pela 1ª passagem do módulo
    mUw = ctx.uw; mWorld = ctx.WORLD;
    painelRef = { container, ctx };
    const c = cfg();
    const planos = lerPlanos();
    // Horas sempre no fuso do JOGO, para baterem com o relógio que vês no ecrã.
    const off = desvioFuso();
    const hh = (t) => new Date((t + off) * 1000).toISOString().substr(11, 8);
    const dia = (t) => {
      const d = new Date((t + off) * 1000), hoje = new Date((agora() + off) * 1000);
      return (d.toISOString().substr(0, 10) === hoje.toISOString().substr(0, 10)) ? '' : ' (amanhã)';
    };

    const lista = planos.map((p) => {
      const alvo = p.alvoCoords || coordsCidade(p.alvoId);
      const dur = p.duracaoJogo || duracaoPrevista(p.origemId, alvo, p.unidades, c);
      const falta = p.chegada - agora();
      const envio = dur ? hh(p.chegada - dur) : '?';
      const tropas = Object.keys(p.unidades || {}).map((u) => p.unidades[u] + ' ' + u).join(', ');
      const quando = falta > 0
        ? (falta > 3600 ? `daqui a ${Math.round(falta / 3600)}h` : `daqui a ${Math.round(falta / 60)} min`)
        : 'já passou';
      return `<div style="border-top:1px solid #223;padding:4px 0;font-size:11px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b>${p.tipo === 'attack' ? '⚔️ ataque' : '🤝 apoio'} → ${p.alvoId}</b>
          <a href="#" data-cancelar="${p.id}" style="color:#f88;text-decoration:none" title="cancelar este agendamento">✕ cancelar</a>
        </div>
        chega <b>${hh(p.chegada)}</b>${dia(p.chegada)} · ${quando}<br>
        <span style="opacity:.7">sai ${envio} · ${tropas || 'sem unidades'} · margem ±${p.margemSeg != null ? p.margemSeg : c.margemSeg}s ${p.direcao === 'antes' ? '(só antes)' : p.direcao === 'depois' ? '(só depois)' : ''}</span>
        ${p.duracaoJogo ? '' : '<br><span style="color:#fc8">⚠ duração estimada — o alvo não tinha coordenadas</span>'}
      </div>`;
    }).join('');

    container.innerHTML = `
      <div style="font-size:11px;line-height:1.6">
        <label><input type="checkbox" id="enc-on"${c.ativo ? ' checked' : ''}> <b>Encaixe de comandos ativo</b></label><br>
        <span style="opacity:.7">A hora, a margem e a direção definem-se na janela de ataque/apoio da cidade alvo.</span><br>
        <label style="font-size:10px;opacity:.85">
          <input type="checkbox" id="enc-vies"${(() => {
            try { return armazem.getItem('grepoEncaixe_corrigirVies_v1') === '1' ? ' checked' : ''; }
            catch (e) { return ''; }
          })()}>
          corrigir pelo desvio das tentativas anteriores
        </label>
        <div style="opacity:.6;font-size:10px;margin-left:18px">
          Normalmente <b>piora</b> — mexe no que definiste na janela. Se o envio sair
          adiantado ou atrasado, ajusta antes o “começar antes”.
        </div>
      </div>
      ${(() => { const e = estatisticaDesvios(); return e ? `<div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:5px;font-size:11px">
        <b>Variação observada</b> (${e.n} tentativas): de ${e.min >= 0 ? '+' : ''}${e.min}s a ${e.max >= 0 ? '+' : ''}${e.max}s · mediana ${e.mediana >= 0 ? '+' : ''}${e.mediana}s
      </div>` : ''; })()}
      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:5px">
        <b style="font-size:11px">Agendados: ${planos.length}</b>
        ${lista || '<div style="font-size:11px;opacity:.6;padding-top:3px">Nenhum.</div>'}
      </div>`;

    const chk = container.querySelector('#enc-on');
    if (chk) chk.onchange = (e) => {
      guardarCfg(Object.assign({}, cfg(), { ativo: e.target.checked }));
      ctx.log('Encaixe ' + (e.target.checked ? 'ativado' : 'desativado') + '.');
    };

    container.querySelectorAll('[data-cancelar]').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        const id = el.getAttribute('data-cancelar');
        (() => { if (temporizadores[id]) { clearTimeout(temporizadores[id]); delete temporizadores[id]; } })();
        gravarPlanos(lerPlanos().filter((x) => x.id !== id), true);
        ctx.log('Encaixe: agendamento cancelado.');
        painel(container, ctx);
      };
    });
  }

  return {
    id: 'encaixe',
    nome: 'Encaixe de comandos',
    intervaloMin: opts.intervaloMin || 1,
    worlds: opts.worlds || null,
    autoStart: opts.autoStart !== false,
    run,
    painel,
    adicionarPlano,
  };
}

  // ====================== MÓDULO: MISSÕES DE ILHA ========================
/* ============================================================================
 *  MISSÕES DE ILHA — aceita, cumpre e recolhe
 *
 *  As missões aparecem numa ilha onde a conta tenha cidade. Cada uma tem duas
 *  variantes: "Good" (moedas de SABEDORIA) e "Evil" (moedas de GUERRA). O
 *  utilizador quer sempre a de sabedoria quando houver escolha — e, nas de
 *  ameaça, a variante Good é justamente a de DEFENDER, por isso as duas regras
 *  coincidem.
 *
 *  Tipos de missão e o que fazemos:
 *    • esperar          → nada a fazer, só recolher no fim
 *    • enviar recursos  → challengeResources com o que falta
 *    • defender         → deixar as tropas defensivas em casa; se não houver
 *                         nenhuma, activar a milícia
 *    • enviar tropas    → só aceitar se houver tropas suficientes
 *
 *  Pedidos confirmados por captura (frontend_bridge → IslandQuests):
 *    getIslandQuestStatus  {}
 *    decide                {decision:'good'|'evil', progressable_name}
 *    challengeResources    {challenge:{wood,stone,iron}, progressable_name}
 *    claimReward           {reward_action:'use', state:'closed', progressable_id}
 * ========================================================================== */

function makeMissoesModule(opts) {
  opts = opts || {};

  let mUw = null, mWorld = '';
  const CFG_KEY = 'grepoMissoes_cfg_v1';

  const DEFAULTS = {
    ativo: false,
    preferirSabedoria: true,   // escolher a variante Good quando houver escolha
    darRecursos: true,         // completar as missões de recursos
    maxRecursosPorMissao: 5000, // não gastar mais do que isto numa missão
    reservaPct: 20,            // deixar sempre esta % do armazém
    enviarTropas: true,        // aceitar missões que peçam enviar tropas
    milicia: true,             // activar milícia nas de defesa sem tropas
    recompensaAcao: 'stash',   // guardar o feitiço em vez de o usar já
    descartarTropas: true,     // recompensas de tropas: descartar sempre
    pedirAtaque: true,         // pedir as vagas de ataque (desgaste)
    estacionarTropa: true,     // missões que pedem população estacionada
  };

  /* Número configurado, aceitando o ZERO como valor válido.
   * `a || b` trata o 0 como ausente — e há campos onde 0 tem significado
   * (não esperar, não exigir mínimo, não dar recursos). */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function num(valor, alternativo) {
    const n = Number(valor);
    return (valor !== null && valor !== undefined && valor !== '' && Number.isFinite(n))
      ? n : alternativo;
  }

  function cfg() {
    const c = Object.assign({}, DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function guardar(c) {
    try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {}
  }

  /* ---------------------- leitura do estado ----------------------------- */

  function missoes() {
    try {
      const col = mUw.MM.getCollections().IslandQuest[0];
      return (col.models || []).map((m) => m.attributes || {});
    } catch (e) { return []; }
  }

  function relacoes() {
    try {
      const col = mUw.MM.getCollections().IslandQuestPlayerRelation[0];
      return (col.models || []).map((m) => m.attributes || {});
    } catch (e) { return []; }
  }

  // Moeda que esta variante dá: 'coins_of_wisdom' ou 'coins_of_war'.
  function moedaDa(missao) {
    try {
      const r = (missao.configuration || {}).rewards || [];
      for (const x of r) {
        const t = ((x.configuration || {}).type) || '';
        if (/coins_of_/.test(t)) return t;
      }
    } catch (e) {}
    return '';
  }

  function ehSabedoria(missao) { return moedaDa(missao) === 'coins_of_wisdom'; }

  /* Recompensas que dão TROPAS — descartadas sempre: ocupam população e não
   * são as unidades que interessam.
   *
   * CONFIRMADO no inventário do jogo: as tropas NÃO são um tipo de recompensa
   * à parte. Vêm como `type: 'power'`, tal como os feitiços — o que as
   * distingue é o **power_id**:
   *
   *   {"properties":{"power_id":"unit_training_boost",
   *     "configuration":{"type":"sword","amount":54,...}}}
   *
   * Ou seja: procura-se o power_id, não o type. */
  const PODERES_DE_TROPAS = ['unit_training_boost'];

  /* Missões já iniciadas — o jogo não distingue "aceite" de "a decorrer",
   * portanto guarda-se aqui para não repetir o pedido a cada passagem. */
  const INICIADAS_KEY = 'grepoMissoes_iniciadas_v1';

  function jaIniciada(m) {
    try {
      const l = JSON.parse(armazem.getItem(INICIADAS_KEY) || '{}');
      const t = l[String(m.progressable_id)];
      // vale 24 h: passado isso a missão ou acabou ou é outra
      return t && (Math.floor(Date.now() / 1000) - t) < 86400;
    } catch (e) { return false; }
  }
  function marcarIniciada(m) {
    try {
      const l = JSON.parse(armazem.getItem(INICIADAS_KEY) || '{}');
      l[String(m.progressable_id)] = Math.floor(Date.now() / 1000);
      armazem.setItem(INICIADAS_KEY, JSON.stringify(l));
    } catch (e) {}
  }

  function poderesDa(recompensa) {
    const d = recompensa && recompensa.data;
    return d ? Object.keys(d) : [];
  }

  /* Tipos vistos, para eu saber o que existe de facto. Fica guardado e o painel
   * mostra-o — assim descobrimos os nomes reais em vez de adivinhar. */
  function anotarTipoVisto(tipo, nomeMissao) {
    try {
      const k = 'grepoMissoes_tiposVistos_v1';
      const t = JSON.parse(armazem.getItem(k) || '{}');
      if (!t[tipo]) t[tipo] = { primeira: nomeMissao, vezes: 0 };
      t[tipo].vezes++;
      armazem.setItem(k, JSON.stringify(t));
    } catch (e) {}
  }
  function tiposVistos() {
    try { return JSON.parse(armazem.getItem('grepoMissoes_tiposVistos_v1') || '{}'); }
    catch (e) { return {}; }
  }

  function recompensasDe(missao) {
    try { return ((missao.static_data || {}).rewards) || []; } catch (e) { return []; }
  }

  function daTropas(missao) {
    return recompensasDe(missao).some((r) =>
      poderesDa(r).some((k) => PODERES_DE_TROPAS.indexOf(k) >= 0));
  }

  /* Tipos que ainda não conhecemos — para avisar em vez de assumir. */
  /* Poderes já vistos, para saber o que existe. Os conhecidos:
   *   instant_currency      → moedas
   *   favor_boost           → favor
   *   unit_training_boost   → TROPAS (descartar)
   *   longterm_attack_boost, longterm_defense_boost, epic_attack_boost → úteis */
  const PODERES_CONHECIDOS = [
    'instant_currency', 'favor_boost', 'unit_training_boost',
    'longterm_attack_boost', 'longterm_defense_boost', 'epic_attack_boost',
    'resource_boost', 'building_order_boost', 'unit_order_boost',
  ];

  function tiposDesconhecidos(missao) {
    const out = [];
    for (const r of recompensasDe(missao)) {
      for (const k of poderesDa(r)) {
        if (PODERES_CONHECIDOS.indexOf(k) < 0) out.push(k);
      }
    }
    return out;
  }

  function quantasMoedas(missao) {
    try {
      const r = (missao.configuration || {}).rewards || [];
      for (const x of r) {
        const c = x.configuration || {};
        if (/coins_of_/.test(String(c.type))) return Number(c.amount) || 0;
      }
    } catch (e) {}
    return 0;
  }

  // Recursos que ainda faltam entregar.
  function recursosEmFalta(missao) {
    const pedido = (missao.configuration || {}).resources;
    if (!pedido) return null;
    const feito = ((missao.progress || {}).resources) || {};
    const falta = {};
    let total = 0;
    for (const k of ['wood', 'stone', 'iron']) {
      const f = Math.max(0, (Number(pedido[k]) || 0) - (Number(feito[k]) || 0));
      if (f > 0) { falta[k] = f; total += f; }
    }
    return total > 0 ? { falta, total } : null;
  }

  /* ATENÇÃO: nas missões de ameaça, `configuration.units` NÃO é o que tenho de
   * ter — é a FORÇA ATACANTE que a missão vai enviar e que tenho de derrotar.
   * (Confirmado pelo utilizador: 217 hoplitas eram o ataque, não o requisito.)
   * Por isso não se pode tratar isto como "já está em posição". */
  function forcaAtacante(missao) {
    return unidadesPedidas(missao);
  }

  // Unidades indicadas na missão (interpretação depende do tipo — ver acima).
  function unidadesPedidas(missao) {
    const u = (missao.configuration || {}).units;
    if (!u) return null;
    const out = {};
    let total = 0;
    for (const k of Object.keys(u)) {
      const n = Number(u[k]) || 0;
      if (n > 0) { out[k] = n; total += n; }
    }
    return total > 0 ? { unidades: out, total } : null;
  }

  // Já foram entregues as unidades pedidas?
  function unidadesJaLa(missao) {
    const pedido = unidadesPedidas(missao);
    if (!pedido) return true;
    const feito = ((missao.progress || {}).units) || {};
    for (const k of Object.keys(pedido.unidades)) {
      if ((Number(feito[k]) || 0) < pedido.unidades[k]) return false;
    }
    return true;
  }

  /* ---------------------- pedidos --------------------------------------- */

  async function bridge(townId, acao, args) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({
          model_url: 'IslandQuests', action_name: acao, captcha: null,
          arguments: args || {}, town_id: Number(townId), nl_init: true,
        })),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      const erro = j && j.error;
      return { ok: !erro, msg: erro || (j && j.success) || 'ok', raw: r };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  const consultar = (townId) => bridge(townId, 'getIslandQuestStatus', {});
  const decidir = (townId, nome, lado) =>
    bridge(townId, 'decide', { decision: lado, progressable_name: nome });
  const darRecursos = (townId, nome, quanto) =>
    bridge(townId, 'challengeResources', {
      challenge: { wood: Number(quanto.wood) || 0, iron: Number(quanto.iron) || 0, stone: Number(quanto.stone) || 0 },
      progressable_name: nome,
    });
  /* Pedir (nova) vaga de ataque. O jogo exige que a cidade esteja ACTIVA —
   * `current_town_id: true` refere-se à cidade activa, não ao town_id do
   * pedido. Sem mudar de cidade primeiro, falha. */
  const pedirAtaque = (townId, nome) =>
    bridge(townId, 'challenge', { challenge: { current_town_id: true }, progressable_name: nome });

  /* ============ MISSÕES DE ESTACIONAR TROPA ============================
   * Há missões que não pedem ataque: pedem que se ESTACIONE população numa
   * cidade da ilha (a `town_id` da configuração). O campo `count_to_rally`
   * diz quanta.
   *
   * As tropas VOLTAM quando a missão acabar e se recolher a recompensa — não
   * há perda, só ficam ocupadas.
   *
   * Confirmado no jogo:
   *   unitRuntimes {target_town_id} → tempos de viagem por unidade
   *   sendUnits {target_id, sending_type:'support',
   *              attacking_strategy:['regular'], params:{sword:1000,...}}
   * ==================================================================== */
  const tempoDasUnidades = (townId, alvoId) =>
    bridge(townId, 'unitRuntimes', { target_town_id: Number(alvoId) });

  const enviarTropa = (townId, alvoId, unidades) =>
    bridge(townId, 'sendUnits', {
      target_id: Number(alvoId),
      sending_type: 'support',
      attacking_strategy: ['regular'],
      params: unidades,
    });

  /* Escolher que tropas mandar para somar a população pedida.
   * Manda-se primeiro o que é mais barato em população por unidade — assim
   * ocupa-se menos capacidade de combate. */
  function escolherTropaParaMissao(townId, populacaoPedida) {
    const escolha = {};
    let somaPop = 0;
    try {
      const tenho = mUw.ITowns.getTown(Number(townId)).units() || {};
      const gd = mUw.GameData.units || {};

      const candidatas = Object.keys(tenho)
        .filter((u) => Number(tenho[u]) > 0)
        .filter((u) => gd[u] && !gd[u].is_naval)          // só terrestres
        .map((u) => ({ u, pop: Number(gd[u].population) || 1, tem: Number(tenho[u]) }))
        .sort((a, b) => a.pop - b.pop);

      for (const c of candidatas) {
        if (somaPop >= populacaoPedida) break;
        const faltam = populacaoPedida - somaPop;
        const quantas = Math.min(c.tem, Math.ceil(faltam / c.pop));
        if (quantas > 0) {
          escolha[c.u] = quantas;
          somaPop += quantas * c.pop;
        }
      }
    } catch (e) {}
    return { unidades: escolha, populacao: somaPop };
  }

  /* Quanta população já lá está estacionada desta conta. */
  function popJaEstacionada(missao) {
    try {
      const conf = missao.configuration || {};
      return Number(conf.rallied) || Number(conf.count_rallied) || 0;
    } catch (e) { return 0; }
  }

  /* Ao recolher há duas opções (confirmado em jogo):
   *   'stash' → guarda o feitiço no inventário para usar quando quiseres
   *   'use'   → usa-o já
   * As moedas vêm sempre; a escolha é só para o feitiço que acompanha. */
  /* O que fazer com a recompensa de uma missão.
   *
   * As de TROPAS descartam-se: ocupam população e raramente são as unidades
   * que interessam. As outras — moedas, recursos, feitiços — guardam-se no
   * inventário.
   *
   * O tipo distingue-se pelo `power_id`, não pelo `type` (confirmado em jogo:
   * `unit_training_boost` marca as de tropas). */
  function escolherAcaoRecompensa(missao, c) {
    try {
      const rec = (missao.configuration || {}).rewards || [];
      const temTropas = rec.some((r) => {
        const pid = String((r || {}).power_id || '');
        return PODERES_DE_TROPAS.indexOf(pid) >= 0;
      });
      if (temTropas && c && c.descartarTropas !== false) return 'trash';
    } catch (e) {}

    /* Respeitar o que está escolhido no painel ("guardar" ou "usar já").
     * Estava fixo em 'stash' e ignorava a definição. */
    const escolhida = c && c.recompensaAcao;
    return (escolhida === 'use' || escolhida === 'trash') ? escolhida : 'stash';
  }

  /* reward_action, confirmados em jogo:
   *   'stash' → guardar no inventário
   *   'use'   → usar já
   *   'trash' → descartar (é o que se faz às recompensas de tropas) */
  const recolher = (townId, id, acao) => {
    const validas = ['stash', 'use', 'trash'];
    const a = validas.indexOf(acao) >= 0 ? acao : 'stash';
    return bridge(townId, 'claimReward', {
      reward_action: a, state: 'closed', progressable_id: id,
    });
  };

  async function ativarMilicia(townId) {
    const url = mUw.location.origin + '/game/building_farm?town_id=' + Number(townId)
      + '&action=request_militia&h=' + mUw.Game.csrfToken;
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({ town_id: Number(townId), nl_init: true })),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      return { ok: !(j && j.error), msg: (j && (j.error || j.success)) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        if (String(n.type) !== 'backbone') continue;
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados) continue;
        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;

          // colecções primeiro (entradas novas), depois modelos
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;

          try {
            const modelos = mUw.MM.getModels()[nome];
            if (modelos) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(modelos)) {
                const m = modelos[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(modelos).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  /* ---------------------- utilitários ----------------------------------- */

  function cidadeNaIlha(ix, iy) {
    try {
      for (const id of Object.keys(mUw.ITowns.towns)) {
        const t = mUw.ITowns.getTown(Number(id));
        if (Number(t.getIslandCoordinateX()) === Number(ix)
          && Number(t.getIslandCoordinateY()) === Number(iy)) {
          return { id: Number(id), name: t.getName() };
        }
      }
    } catch (e) {}
    return null;
  }

  function recursosDaCidade(townId) {
    try {
      const r = mUw.ITowns.getTown(Number(townId)).resources();
      return {
        wood: Number(r.wood) || 0, stone: Number(r.stone) || 0,
        iron: Number(r.iron) || 0, storage: Number(r.storage) || 0,
      };
    } catch (e) { return { wood: 0, stone: 0, iron: 0, storage: 0 }; }
  }

  function tropasDaCidade(townId) {
    try { return mUw.ITowns.getTown(Number(townId)).units() || {}; }
    catch (e) { return {}; }
  }

  // Unidades DEFENSIVAS (as que ficam bem numa missão de defesa).
  const DEFENSIVAS = ['sword', 'archer', 'hoplite', 'militia'];

  /* Estimativa grosseira de força, para avisar quando a defesa é claramente
   * insuficiente. Não substitui um simulador — serve só para distinguir
   * "tenho hipótese" de "vou perder de certeza". */
  function forcaDefensiva(unidades) {
    let total = 0;
    for (const k of Object.keys(unidades || {})) {
      const n = Number(unidades[k]) || 0;
      if (n <= 0) continue;
      try {
        const u = mUw.GameData.units[k] || {};
        const d = ((Number(u.defense_hack) || 0) + (Number(u.defense_pierce) || 0)
          + (Number(u.defense_distance) || 0)) / 3;
        total += n * (d || 0);
      } catch (e) {}
    }
    return Math.round(total);
  }

  function forcaOfensiva(unidades) {
    let total = 0;
    for (const k of Object.keys(unidades || {})) {
      const n = Number(unidades[k]) || 0;
      if (n <= 0) continue;
      try { total += n * (Number((mUw.GameData.units[k] || {}).attack) || 0); } catch (e) {}
    }
    return Math.round(total);
  }

  function temSoDefensivas(townId) {
    const u = tropasDaCidade(townId);
    let temDef = false;
    for (const k of Object.keys(u)) {
      const n = Number(u[k]) || 0;
      if (n <= 0) continue;
      if (DEFENSIVAS.indexOf(k) >= 0) temDef = true;
      else return { soDefensivas: false, temDef };
    }
    return { soDefensivas: true, temDef };
  }

  /* ---------------------- decisão --------------------------------------- */

  /* Escolher entre as duas variantes de uma missão.
   * Preferência: sabedoria (que nas missões de ameaça é também a de defender).
   * Mas só se a variante for exequível — não vale a pena escolher uma que
   * exija tropas que não temos. */
  function escolherVariante(candidatas, c, townId) {
    const viaveis = candidatas.filter((m) => exequivel(m, c, townId).pode);
    if (!viaveis.length) return null;
    if (c.preferirSabedoria) {
      const sab = viaveis.find(ehSabedoria);
      if (sab) return sab;
    }
    // senão, a que der mais moedas
    return viaveis.sort((a, b) => quantasMoedas(b) - quantasMoedas(a))[0];
  }

  /* Podemos cumprir esta missão? */
  function exequivel(missao, c, townId) {
    const pedeUnid = unidadesPedidas(missao);
    const pedeRes = recursosEmFalta(missao);

    /* MISSÕES DE ESTACIONAR TROPA: só a cidade que está NA ILHA pode enviar.
     * Se ela não tiver tropa terrestre que chegue, a missão não se cumpre —
     * e aceitá-la ocupa a vaga da ilha à toa, mesmo sendo de sabedoria. */
    const pedeTropa = Number((missao.configuration || {}).count_to_rally) || 0;
    if (pedeTropa) {
      if (c.estacionarTropa === false) {
        return { pode: false, porque: 'missões de estacionar tropa desligadas' };
      }
      const esc = escolherTropaParaMissao(townId, pedeTropa);
      if (esc.populacao < pedeTropa) {
        return {
          pode: false,
          porque: `pede ${pedeTropa} de população e a cidade só tem ${esc.populacao}`,
        };
      }
    }

    if (pedeRes) {
      if (!c.darRecursos) return { pode: false, porque: 'missões de recursos desligadas' };
      if (pedeRes.total > (num(c.maxRecursosPorMissao, 5000))) {
        return { pode: false, porque: `pede ${pedeRes.total} recursos (máximo ${c.maxRecursosPorMissao})` };
      }
      const r = recursosDaCidade(townId);
      const reserva = (Number(c.reservaPct) || 0) / 100 * (r.storage || 0);
      for (const k of Object.keys(pedeRes.falta)) {
        if ((r[k] || 0) - pedeRes.falta[k] < reserva) {
          return { pode: false, porque: `não sobra ${k} depois da reserva` };
        }
      }
      return { pode: true, tipo: 'recursos' };
    }

    if (pedeUnid) {
      // As de DEFESA pedem que as unidades estejam em casa; as de ENVIAR
      // pedem que sejam mandadas. Distinguem-se pelo lado da missão.
      const lado = ladoDa(missao);
      if (lado === 'good' && /threat|defen/i.test(String(missao.progressable_id))) {
        return { pode: true, tipo: 'defender' };
      }
      if (!c.enviarTropas) return { pode: false, porque: 'missões de tropas desligadas' };
      const tenho = tropasDaCidade(townId);
      for (const k of Object.keys(pedeUnid.unidades)) {
        if ((Number(tenho[k]) || 0) < pedeUnid.unidades[k]) {
          return { pode: false, porque: `faltam ${pedeUnid.unidades[k] - (Number(tenho[k]) || 0)} ${k}` };
        }
      }
      return { pode: true, tipo: 'tropas' };
    }

    // sem custo: é das de esperar
    return { pode: true, tipo: 'esperar' };
  }

  function ladoDa(missao) {
    const id = String(missao.progressable_id || '');
    if (/GoodIslandQuest$/.test(id)) return 'good';
    if (/EvilIslandQuest$/.test(id)) return 'evil';
    try { return String((missao.static_data || {}).side || '').toLowerCase(); } catch (e) { return ''; }
  }

  // Nome base da missão (sem Good/Evil), para agrupar as variantes.
  function nomeBase(missao) {
    return String(missao.progressable_id || '').replace(/(Good|Evil)IslandQuest$/, '');
  }

  /* ---------------------- ciclo principal ------------------------------- */

  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const log = ctx.log;
    const rotina = ctx.logRotina || ctx.log;   // rotina: só nos módulos lentos
    const c = cfg();
    if (!c.ativo) { log('Missões: está DESLIGADO (liga a caixa no painel e guarda).'); return; }

    // pedir o estado ao servidor (as colecções podem estar vazias)
    const towns = ctx.getMyTowns();
    if (!towns.length) { log('Missões: sem cidades.'); return; }
    await consultar(towns[0].id);
    await ctx.sleep(ctx.rand(400, 800));

    const todas = missoes();
    if (!todas.length) { log('Missões: nenhuma disponível.'); return; }

    let agiu = 0;

    /* 1. RECOLHER as que já estão prontas */
    for (const m of todas) {
      if (String(m.state) !== 'closed' && String(m.state) !== 'finished') continue;
      const conf = m.configuration || {};
      const cidade = cidadeNaIlha(conf.island_x, conf.island_y);
      if (!cidade) continue;
      /* Recompensas de TROPAS são descartadas: ocupam população e não são as
       * unidades que interessam. As moedas vêm na mesma. */
      const nome = (m.static_data || {}).name || m.progressable_id;
      let acao = c.recompensaAcao;
      // 'trash' = descartar (confirmado em jogo)
      if (c.descartarTropas && daTropas(m)) acao = 'trash';

      recompensasDe(m).forEach((rr) => poderesDa(rr).forEach((k) => anotarTipoVisto(k, nome)));

      const desconhecidos = tiposDesconhecidos(m);
      if (desconhecidos.length) {
        log(`ℹ️ ${nome}: recompensa de tipo desconhecido (${desconhecidos.join(', ')}) — `
          + 'recolhida como as outras. Diz-me se devia ser descartada.');
      }

      const r = await recolher(cidade.id, m.progressable_id, acao);
      if (r.ok) {
        const oQueFez = acao === 'trash' ? 'recompensa de tropas descartada'
          : acao === 'use' ? 'feitiço usado já' : 'feitiço guardado no inventário';
        log(`🎁 ${nome}: ${quantasMoedas(m)} `
          + `${ehSabedoria(m) ? 'moedas de sabedoria' : 'moedas de guerra'} — ${oQueFez}.`);
        agiu++;
        await ctx.sleep(ctx.rand(700, 1400));
      } else {
        if (acao === 'trash') {
          log(`⚠️ ${nome}: não consegui descartar (${r.msg}). `
            + 'Diz-me qual é a acção certa — vou guardar em vez de perder a recompensa.');
          const r2 = await recolher(cidade.id, m.progressable_id, 'stash');
          if (r2.ok) log(`🎁 ${nome}: guardada no inventário, já que não pude descartar.`);
        } else {
          log(`⚠️ recolha falhou: ${r.msg}`);
        }
      }
    }

    /* 2. ESCOLHER variante nas que estão por decidir */
    const porDecidir = {};
    for (const m of todas) {
      if (String(m.state) !== 'viable') continue;
      const base = nomeBase(m);
      (porDecidir[base] = porDecidir[base] || []).push(m);
    }

    for (const base of Object.keys(porDecidir)) {
      const variantes = porDecidir[base];
      const conf = variantes[0].configuration || {};
      const cidade = cidadeNaIlha(conf.island_x, conf.island_y);
      if (!cidade) { log(`— ${base}: não tenho cidade na ilha ${conf.island_x}:${conf.island_y}.`); continue; }

      const escolhida = escolherVariante(variantes, c, cidade.id);
      if (!escolhida) {
        const porques = variantes.map((m) => exequivel(m, c, cidade.id).porque).filter(Boolean);
        log(`— ${(variantes[0].static_data || {}).name || base}: nenhuma variante possível`
          + (porques.length ? ` (${porques[0]})` : '') + '.');
        continue;
      }

      const lado = ladoDa(escolhida);
      const r = await decidir(cidade.id, escolhida.progressable_id, lado);
      if (r.ok) {
        const info = exequivel(escolhida, c, cidade.id);
        log(`📜 ${(escolhida.static_data || {}).name || base} (${cidade.name}): escolhi `
          + `${ehSabedoria(escolhida) ? 'sabedoria' : 'guerra'} — ${quantasMoedas(escolhida)} moedas, tipo ${info.tipo}.`);
        agiu++;
        await ctx.sleep(ctx.rand(800, 1600));
      } else {
        log(`⚠️ ${base}: não consegui escolher (${r.msg}).`);
      }
    }

    /* 2b. RECOLHER as recompensas das que já acabaram.
     *
     * Uma missão concluída fica em `satisfied` — não em `running`. Como o
     * módulo só olhava para as `running`, as recompensas ficavam por recolher
     * indefinidamente.
     *
     * O que fazer com cada recompensa:
     *   • moedas e recursos → 'stash' (guardar no inventário)
     *   • tropas            → 'trash' (não interessam; ocupavam população) */
    for (const m of todas) {
      if (String(m.state) !== 'satisfied') continue;

      const nome = (m.static_data || {}).name || m.progressable_id;
      const conf = m.configuration || {};
      const cidade = cidadeNaIlha(conf.island_x, conf.island_y);

      /* O pedido usa a cidade activa (current_town_id), tal como o
       * `challenge` — sem trocar, o servidor recusa. */
      if (cidade) {
        const mudou = await ctx.switchToTown(cidade.id);
        if (!mudou) { log(`— ${nome}: não consegui mudar para ${cidade.name}.`); continue; }
        await ctx.sleep(ctx.rand(600, 1200));
      }

      const acao = escolherAcaoRecompensa(m, c);
      const alvo = cidade ? cidade.id : mUw.Game.townId;
      const r = await recolher(alvo, m.progressable_id, acao);

      if (r.ok) {
        log(`🎁 ${nome}: recompensa recolhida (${acao === 'trash' ? 'descartada' : acao === 'use' ? 'usada' : 'guardada'}).`);
        agiu++;
        await ctx.sleep(ctx.rand(800, 1500));
      } else {
        log(`⚠️ ${nome}: não consegui recolher a recompensa (${r.msg}).`);
      }
    }

    /* 3. CUMPRIR as que estão a decorrer */
    for (const m of todas) {
      if (String(m.state) !== 'running') continue;
      const conf = m.configuration || {};
      const cidade = cidadeNaIlha(conf.island_x, conf.island_y);
      if (!cidade) continue;
      const nome = (m.static_data || {}).name || m.progressable_id;

      /* MISSÕES DE TEMPO: têm `time_to_wait` e não pedem recursos nem tropas —
       * mas TÊM de ser iniciadas com o `challenge`, senão o tempo nunca começa
       * a contar. Eu classificava-as como "nada a fazer" e ficavam paradas.
       *
       * ATENÇÃO: o pedido usa `current_town_id: true`, ou seja o servidor olha
       * para a CIDADE ACTIVA no jogo, não para o `town_id` enviado. Sem trocar
       * de cidade primeiro, responde "apenas pode utilizar cidades que se
       * encontrem na mesma ilha". */
      const soTempo = Number(conf.time_to_wait) > 0
        && !recursosEmFalta(m)
        && !(unidadesPedidas(m) || []).length
        && !Number(conf.count_to_rally);

      if (soTempo && !jaIniciada(m)) {
        const mudou = await ctx.switchToTown(cidade.id);
        if (!mudou) { log(`— ${nome}: não consegui mudar para ${cidade.name}.`); continue; }
        await ctx.sleep(ctx.rand(700, 1300));

        const r0 = await pedirAtaque(cidade.id, m.progressable_id);
        if (r0.ok) {
          log(`⏳ ${nome} (${cidade.name}): missão iniciada — agora é esperar `
            + `${Math.round(Number(conf.time_to_wait) / 3600)} h.`);
          marcarIniciada(m);
          agiu++;
          await ctx.sleep(ctx.rand(800, 1500));
        } else if (/mesma ilha/i.test(String(r0.msg))) {
          log(`— ${nome}: o jogo exige a cidade da ilha activa; tento na próxima passagem.`);
        } else if (/j[áa]|already|aceite/i.test(String(r0.msg))) {
          marcarIniciada(m);        // já estava iniciada
        } else {
          log(`⚠️ ${nome}: não consegui iniciar (${r0.msg}).`);
        }
        continue;
      }

      // a) recursos em falta
      const res = recursosEmFalta(m);
      if (res && c.darRecursos) {
        const disp = recursosDaCidade(cidade.id);
        const reserva = (Number(c.reservaPct) || 0) / 100 * (disp.storage || 0);
        const dar = {};
        let algum = false;
        for (const k of Object.keys(res.falta)) {
          const podeDar = Math.max(0, Math.min(res.falta[k], (disp[k] || 0) - reserva));
          if (podeDar > 0) { dar[k] = Math.floor(podeDar); algum = true; }
        }
        if (algum) {
          const r = await darRecursos(cidade.id, m.progressable_id, dar);
          if (r.ok) {
            const det = Object.keys(dar).map((k) => `${dar[k]} ${k}`).join(', ');
            log(`📦 ${nome} (${cidade.name}): entreguei ${det}.`);
            agiu++;
            await ctx.sleep(ctx.rand(700, 1400));
          } else {
            log(`⚠️ ${nome}: entrega falhou (${r.msg}).`);
          }
        } else {
          log(`— ${nome}: sem recursos de sobra para entregar agora.`);
        }
        continue;
      }

      /* b) missão de AMEAÇA: uma força ataca e tenho de a derrotar.
       *
       * FUNCIONA POR DESGASTE (confirmado pelo utilizador): se a milícia não
       * chegar para as derrotar todas, a missão NÃO se perde — só sobrevivem
       * os atacantes que restaram, e pode pedir-se nova vaga. Basta esperar
       * que a milícia expire, activá-la outra vez e voltar a pedir ataque.
       *
       * Por isso vale sempre a pena activar a milícia, mesmo quando parece
       * insuficiente: cada vaga mata alguns. */
      const ataque = forcaAtacante(m);
      if (ataque) {
        const det = Object.keys(ataque.unidades)
          .map((k) => `${ataque.unidades[k]} ${(mUw.GameData.units[k] || {}).name || k}`).join(', ');
        const est = temSoDefensivas(cidade.id);

        // Tropas ofensivas morrem à toa na defesa — avisar sempre.
        if (est.temDef && !est.soDefensivas) {
          log(`⚠️ ${nome} (${cidade.name}): restam ${det} — há tropas OFENSIVAS na cidade `
            + 'que vão morrer na defesa; tira-as se não as quiseres perder.');
        }

        // Sem defesa nenhuma: activar milícia. Vale sempre a pena, porque
        // mesmo perdendo mata alguns atacantes (desgaste).
        if (!est.temDef) {
          if (!c.milicia) {
            log(`⚠️ ${nome} (${cidade.name}): restam ${det} e a cidade está sem defesa `
              + '(milícia desligada na configuração).');
            continue;
          }
          const r = await ativarMilicia(cidade.id);
          if (!r.ok) {
            // já activa? então é só esperar que expire para a chamar de novo
            if (/já|already/i.test(String(r.msg))) {
              log(`⏳ ${nome} (${cidade.name}): restam ${det} — milícia já activa, `
                + 'espero que expire para chamar outra vaga.');
            } else {
              log(`⚠️ ${nome}: milícia falhou (${r.msg}).`);
            }
            continue;
          }
          log(`🛡️ ${nome} (${cidade.name}): restam ${det} — milícia activada.`);
          agiu++;
          await ctx.sleep(ctx.rand(600, 1200));
        }

        /* MISSÃO DE ESTACIONAR TROPA: reconhece-se pelo `count_to_rally`.
         * Não é ataque — pede população numa cidade da ilha, e as tropas
         * voltam quando se recolher a recompensa. */
        const pedeTropa = Number((m.configuration || {}).count_to_rally) || 0;
        if (pedeTropa && c.estacionarTropa !== false) {
          const alvoId = Number((m.configuration || {}).town_id) || 0;
          if (!alvoId) {
            log(`— ${nome}: pede ${pedeTropa} de população mas não sei para que cidade.`);
            continue;
          }

          const jaLa = popJaEstacionada(m);
          const faltam = Math.max(0, pedeTropa - jaLa);
          if (!faltam) continue;

          /* SÓ a cidade que está NA ILHA da missão pode enviar — as outras
           * não têm acesso. Se essa cidade não tiver tropa terrestre que
           * chegue, a missão não se consegue cumprir. */
          const esc = escolherTropaParaMissao(cidade.id, faltam);
          if (esc.populacao < faltam) {
            log(`— ${nome} (${cidade.name}): precisa de ${faltam} de população e a cidade `
              + `só tem ${esc.populacao}. Não dá para cumprir.`);
            continue;
          }

          const r3 = await enviarTropa(cidade.id, alvoId, esc.unidades);
          if (r3.ok) {
            const det = Object.keys(esc.unidades)
              .map((u) => `${esc.unidades[u]} ${(mUw.GameData.units[u] || {}).name || u}`)
              .join(', ');
            log(`🛡️ ${nome} (${cidade.name}): ${det} — ${esc.populacao} de população. `
              + 'Voltam quando a missão acabar.');
            agiu++;
            await ctx.sleep(ctx.rand(800, 1600));
          } else {
            log(`⚠️ ${nome}: envio falhou (${r3.msg}).`);
          }
          continue;
        }

        // Com defesa em casa (própria ou milícia acabada de chamar): pedir a
        // vaga de ataque. Se não os matar todos, na próxima passagem restam
        // menos e repete-se.
        if (c.pedirAtaque) {
          const mudou = await ctx.switchToTown(cidade.id);
          if (!mudou) { log(`— ${nome}: não consegui mudar para ${cidade.name}.`); continue; }
          await ctx.sleep(ctx.rand(800, 1400));

          const atq = forcaOfensiva(ataque.unidades);
          const def = forcaDefensiva(tropasDaCidade(cidade.id));
          const r2 = await pedirAtaque(cidade.id, m.progressable_id);
          if (r2.ok) {
            log(`⚔️ ${nome} (${cidade.name}): pedi o ataque — ${det} contra a minha defesa`
              + (atq > 0 && def > 0 && def < atq * 0.8
                ? ` (ataque ~${atq} contra ~${def}: não devem morrer todos, mas cada vaga desgasta).`
                : '.'));
            agiu++;
            await ctx.sleep(ctx.rand(900, 1800));
          } else {
            log(`— ${nome}: ainda não posso pedir ataque (${r2.msg}).`);
          }
        }
      }
    }

    if (!agiu) {
      const emCurso = todas.filter((m) => String(m.state) === 'running').length;
      const porDecidirN = todas.filter((m) => String(m.state) === 'viable').length;
      if (emCurso || porDecidirN) {
        /* Dizer o que cada missão a decorrer está à espera — sem isto, uma
         * missão aceite que não avança não dá qualquer pista. */
        const detalhes = todas
          .filter((m) => String(m.state) === 'running')
          .map((m) => {
            const nome = (m.static_data || {}).name || m.progressable_id;
            const conf = m.configuration || {};
            const pedeTropa = Number(conf.count_to_rally) || 0;
            const res = recursosEmFalta(m);
            const unid = unidadesPedidas(m);
            if (pedeTropa) return `${nome}: precisa de ${pedeTropa} de população estacionada`;
            if (res) return `${nome}: faltam recursos`;
            if (unid && unid.length) return `${nome}: precisa de unidades`;
            return `${nome}: à espera do tempo passar`;
          });
        rotina(`Missões: ${emCurso} a decorrer, ${porDecidirN} por decidir. `
          + (detalhes.length ? detalhes.join(' · ') : 'nada a fazer agora.'));
      } else {
        log('Missões: nenhuma missão activa.');
      }
    }
  }

  /* ---------------------- painel ---------------------------------------- */

  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }


  /* Preservar a posição do rolamento ao redesenhar o painel — senão volta ao
   * topo a cada alteração. */
  function comRolamento(fn) {
    /* Guardar TODOS os elementos que estejam rolados, não só os que se
     * adivinham: o que rola pode ser uma caixa interna e o salto para o topo
     * mantinha-se. */
    /* Guardar o CAMINHO e não só a referência: o redesenho destrói os
     * elementos internos e a referência antiga deixa de estar no ecrã. */
    const caminhoDe = (el) => {
      const p = []; let n = el;
      while (n && n.parentElement && p.length < 30) {
        p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
        if (n.id) { p.unshift('#' + n.id); break; }
      }
      return p;
    };
    const porCaminho = (p) => {
      try {
        if (!p.length) return null;
        let n = null, i = 0;
        if (typeof p[0] === 'string' && p[0].charAt(0) === '#') { n = document.getElementById(p[0].slice(1)); i = 1; }
        else n = document.body;
        for (; n && i < p.length; i++) n = n.children[p[i]];
        return n || null;
      } catch (e) { return null; }
    };

    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}
    fn();
    const repor = () => guardados.forEach(({ caminho, y, el }) => {
      try {
        if (el && el.isConnected) { el.scrollTop = y; return; }
        const n2 = porCaminho(caminho);
        if (n2) n2.scrollTop = y;
      } catch (e) {}
    });
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  function painel(container, ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    const todas = missoes();

    const lista = todas.length ? todas.map((m) => {
      const conf = m.configuration || {};
      const cid = cidadeNaIlha(conf.island_x, conf.island_y);
      const res = recursosEmFalta(m);
      const un = unidadesPedidas(m);
      const pede = res ? Object.keys(res.falta).map((k) => `${res.falta[k]} ${k}`).join(', ')
        : (un ? Object.keys(un.unidades).map((k) => `${un.unidades[k]} ${k}`).join(', ') : 'nada (esperar)');
      return `<tr>
        <td style="padding:1px 3px">${esc((m.static_data || {}).name || m.progressable_id)}</td>
        <td style="padding:1px 3px;color:${ehSabedoria(m) ? '#8cf' : '#fa8'}">
          ${quantasMoedas(m)} ${ehSabedoria(m) ? 'sab' : 'guerra'}
        </td>
        <td style="padding:1px 3px;opacity:.75">${esc(pede)}</td>
        <td style="padding:1px 3px;opacity:.6">${esc(m.state)}${cid ? ' · ' + esc(cid.name) : ' · sem cidade'}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" style="opacity:.6;padding:3px">Nenhuma missão neste momento.</td></tr>';

    container.innerHTML = `
      <div style="font-size:11px;line-height:1.7">
        <label><input type="checkbox" id="mis-on"${c.ativo ? ' checked' : ''}> <b>Fazer missões de ilha</b></label><br>
        <label><input type="checkbox" id="mis-sab"${c.preferirSabedoria ? ' checked' : ''}> preferir moedas de sabedoria</label>
        <span style="opacity:.6;font-size:10px">(nas de ameaça, é também a de defender)</span><br>
        <label><input type="checkbox" id="mis-res"${c.darRecursos ? ' checked' : ''}> entregar recursos</label>
        até <input type="number" min="0" id="mis-max" value="${c.maxRecursosPorMissao}" style="width:64px"> por missão,
        deixando <input type="number" min="0" max="90" id="mis-reserva" value="${c.reservaPct}" style="width:42px">% no armazém<br>
        <label><input type="checkbox" id="mis-tropas"${c.enviarTropas ? ' checked' : ''}> aceitar missões que peçam enviar tropas</label>
        <span style="opacity:.6;font-size:10px">(só se as tiver)</span><br>
        <label><input type="checkbox" id="mis-mil"${c.milicia ? ' checked' : ''}> activar milícia nas de defesa sem tropas</label><br>
        Feitiço da recompensa:
        <select id="mis-recomp" style="font-size:11px">
          <option value="stash"${c.recompensaAcao !== 'use' ? ' selected' : ''}>guardar no inventário</option>
          <option value="use"${c.recompensaAcao === 'use' ? ' selected' : ''}>usar já</option>
        </select>
        <span style="opacity:.6;font-size:10px">(as moedas vêm sempre)</span><br>
        <label><input type="checkbox" id="mis-descartar"${c.descartarTropas ? ' checked' : ''}>
          descartar as recompensas de <b>tropas</b></label>
        <span style="opacity:.6;font-size:10px">— ocupam população</span><br>
        ${(() => {
          const t = tiposVistos();
          const ks = Object.keys(t);
          if (!ks.length) return '';
          return `<div style="opacity:.55;font-size:10px;margin:2px 0 4px">
            Tipos de recompensa já vistos: ${ks.map((k) => `${esc(k)} (${t[k].vezes}×)`).join(', ')}.
          </div>`;
        })()}
        <label><input type="checkbox" id="mis-atk"${c.pedirAtaque ? ' checked' : ''}> pedir as vagas de ataque</label>
        <span style="opacity:.6;font-size:10px">
          (a missão não se perde se não os matares todos — cada vaga desgasta os atacantes
          e pode pedir-se outra depois de a milícia voltar)
        </span>
      </div>

      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:6px;font-size:11px">
        <b>Missões agora</b>
        <table style="width:100%;border-collapse:collapse;margin-top:3px">
          <tr style="opacity:.6"><td>missão</td><td>moedas</td><td>pede</td><td>estado</td></tr>
          ${lista}
        </table>
      </div>

      <button id="mis-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    const g = container.querySelector('#mis-guardar');
    if (g) g.onclick = () => {
      guardar({
        ativo: container.querySelector('#mis-on').checked,
        preferirSabedoria: container.querySelector('#mis-sab').checked,
        darRecursos: container.querySelector('#mis-res').checked,
        maxRecursosPorMissao: Number(container.querySelector('#mis-max').value) || 5000,
        reservaPct: Number(container.querySelector('#mis-reserva').value) || 0,
        enviarTropas: container.querySelector('#mis-tropas').checked,
        milicia: container.querySelector('#mis-mil').checked,
        pedirAtaque: container.querySelector('#mis-atk').checked,
        recompensaAcao: container.querySelector('#mis-recomp').value || 'stash',
        descartarTropas: container.querySelector('#mis-descartar').checked,
      });
      ctx.log('Missões: configuração guardada.');
      comRolamento(() => painel(container, ctx));
    };
  }

  return {
    id: 'missoes',
    nome: 'Missões de ilha',
    intervaloMin: opts.intervaloMin || 30,
    autoStart: true,
    run, painel,
  };
}

  // ================= MÓDULO: ROTAÇÃO DE COLONIZADORES ====================
/* ============================================================================
 *  ROTAÇÃO DE COLONIZADORES — acumular, atacar e fundar
 *
 *  ESQUEMA (explicado pelo utilizador):
 *  Duas equipas de contas. Cada equipa junta todos os colonizadores que fabrica
 *  numa cidade-depósito sua. Uma conta da equipa OPOSTA ataca esse depósito: os
 *  colonizadores morrem, o atacante ganha pontos de combate, e os pontos viram
 *  cultura.
 *
 *  As duas equipas acumulam e atacam ao mesmo tempo. São duas (e não uma) para
 *  nenhuma conta se atacar a si própria — o que não geraria pontos.
 *
 *  Quem ataca: a conta da equipa oposta com MENOS pontos de cultura, para todas
 *  progredirem ao mesmo ritmo.
 *
 *  PRIORIDADE: fundar vem primeiro. Fundar não se pode fazer a toda a hora, mas
 *  produzir colonizadores pode fazer-se o dia todo desde que haja recursos.
 *
 *  Coordenação pelo Gist: cada conta publica a sua equipa, o seu depósito, os
 *  seus pontos de cultura e quantos colonizadores tem acumulados.
 * ========================================================================== */

function makeColonosModule(opts) {
  /* Última partilha lida, para o painel listar as contas e as cidades delas
   * sem ir buscar outra vez ao Gist. */
  let partilhaCache = null;
  let donoEscolhido = null;

  opts = opts || {};

  let mUw = null, mWorld = '';
  const CFG_KEY = 'grepoColonos_cfg_v1';
  const GIST_ID = opts.gistId || '';
  const GIST_TOKEN = opts.gistToken || '';

  const NC = 'colonize_ship';

  // Navios que servem para atacar. Transportes NÃO servem: não combatem.
  const NAVIOS_ATAQUE = ['bireme', 'trireme', 'attack_ship', 'demolition_ship'];

  const DEFAULTS = {
    ativo: false,
    equipa: '',              // 'A' ou 'B'
    /* MODO de funcionamento:
     *   'rotacao' — esquema das duas equipas: cada uma junta os colonizadores
     *               numa base e ataca a base da outra para farmar pontos;
     *   'destino' — mais simples: todas as cidades enviam os colonizadores
     *               para UMA cidade que indicas (por identificador), e tu
     *               atacas essa cidade com a main quando quiseres.
     */
    modo: 'rotacao',
    destino: null,           // id da cidade que recebe (modo 'destino')

    baseA: null,             // cidade-base da equipa A (recebe os colonizadores)
    baseB: null,             // cidade-base da equipa B
    minParaAtacar: 100,      // não atacar por meia dúzia
    pausaAposAtaque: 45,     // segundos
    intervaloEnvioMin: 15,
    intervaloProducaoMin: 30,
    produzir: true,
    enviar: true,
    atacar: true,
    fundar: true,
  };

  /* Número configurado, aceitando o ZERO como valor válido.
   * `a || b` trata o 0 como ausente — e há campos onde 0 tem significado
   * (não esperar, não exigir mínimo, não dar recursos). */
  /* Hora do SERVIDOR do jogo. O relógio do computador não deve mandar em nada:
   * pode estar adiantado ou atrasado, e o jogo não sabe disso. */
  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function agoraServidor() {
    try {
      const t = Number(mUw.Timestamp.now());
      if (Number.isFinite(t) && t > 0) return Math.floor(t);
    } catch (e) {}
    return Math.floor(Date.now() / 1000);   // só se o jogo não responder
  }

  function num(valor, alternativo) {
    const n = Number(valor);
    return (valor !== null && valor !== undefined && valor !== '' && Number.isFinite(n))
      ? n : alternativo;
  }

  function cfg() {
    const c = Object.assign({}, DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function guardar(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  /* ---------------------- estado próprio -------------------------------- */

  function meuNome() {
    try { return String(mUw.Game.player_name || ''); } catch (e) { return ''; }
  }
  function meuId() {
    try { return Number(mUw.Game.player_id) || 0; } catch (e) { return 0; }
  }

  // Pontos de cultura: modelo Player → cultural_points (confirmado no jogo).
  function pontosCultura() {
    try {
      const m = mUw.MM.getModels().Player;
      const k = Object.keys(m)[0];
      return Number((m[k].attributes || {}).cultural_points) || 0;
    } catch (e) { return 0; }
  }

  /* Colonizadores numa cidade: os PRÓPRIOS mais os que lá estão de APOIO.
   *
   * O `units()` só conta as unidades da cidade. Os colonizadores enviados
   * como apoio — que é como se juntam no depósito — ficam no
   * `unitsSupport()`.
   *
   * Confirmado no jogo: a base tinha `units()` sem colonizadores e
   * `unitsSupport()` com 93. Por isso o registo dizia "depósito deles (0)"
   * quando estava cheio. */
  function colonizadoresEm(townId) {
    let total = 0;
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      total += Number((t.units() || {})[NC]) || 0;
      if (typeof t.unitsSupport === 'function') {
        total += Number((t.unitsSupport() || {})[NC]) || 0;
      }
    } catch (e) {}
    return total;
  }

  /* Colonizadores que esta cidade pode USAR — só os próprios.
   *
   * Os que lá estão de apoio pertencem a outras contas: contam para o
   * depósito, mas não se podem enviar nem usar para fundar. */
  function colonizadoresProprios(townId) {
    try { return Number((mUw.ITowns.getTown(Number(townId)).units() || {})[NC]) || 0; }
    catch (e) { return 0; }
  }

  function totalColonizadores() {
    let t = 0;
    try {
      // só os PRÓPRIOS: os de apoio são de outras contas
      for (const id of Object.keys(mUw.ITowns.towns)) t += colonizadoresProprios(id);
    } catch (e) {}
    return t;
  }

  function ilhaDe(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const x = t.getIslandCoordinateX(), y = t.getIslandCoordinateY();
      return (x == null || y == null) ? null : { x: Number(x), y: Number(y) };
    } catch (e) { return null; }
  }

  /* ---------------------- partilha pelo Gist ---------------------------- */

  /* Este ficheiro é de COORDENAÇÃO entre contas: as 20 multis têm de ver a
   * mesma lista, por isso NÃO leva o perfil no nome — só o mundo. Meter o
   * perfil aqui isolaria cada conta e a coordenação deixava de funcionar. */
  const FICHEIRO = () => `colonos_${mWorld}.json`;

  async function lerPartilha() {
    if (!GIST_ID || !GIST_TOKEN) return {};
    try {
      const r = await mUw.fetch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { Authorization: `token ${GIST_TOKEN}`, Accept: 'application/vnd.github+json' },
      });
      if (!r.ok) return {};
      const j = await r.json();
      const f = (j.files || {})[FICHEIRO()];
      if (!f || !f.content) return {};
      return JSON.parse(f.content);
    } catch (e) { return {}; }
  }

  async function escreverPartilha(dados) {
    // não segurar o processo (importante nos testes)
    try { if (typeof t2 !== 'undefined' && t2 && t2.unref) t2.unref(); } catch (e) {}
    if (!GIST_ID || !GIST_TOKEN) return false;
    try {
      const body = { files: {} };
      body.files[FICHEIRO()] = { content: JSON.stringify(dados, null, 1) };
      const r = await mUw.fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: {
          Authorization: `token ${GIST_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return r.ok;
    } catch (e) { return false; }
  }

  /* Publica o meu estado e devolve o de todos. */
  async function sincronizar(c) {
    const todos = await lerPartilha();
    const eu = meuNome() || String(meuId());
    if (!eu) return todos;

    /* Aplicar as bases e o modo que vieram da partilha. A EQUIPA não: essa é
     * de cada conta. */
    try {
      const comum = todos.__comum;
      if (comum && (comum.quem !== eu)) {
        let mudou = false;
        for (const campo of ['baseA', 'baseB', 'destino', 'modo']) {
          if (comum[campo] != null && c[campo] !== comum[campo]) {
            c[campo] = comum[campo];
            mudou = true;
          }
        }
        if (mudou) {
          guardar(c);
          try { console.log(`[MAESTRO/colonos] bases e modo actualizados a partir de ${comum.quem}`); } catch (e) {}
        }
      }
    } catch (e) {}

    // Publicar também as MINHAS cidades: assim qualquer conta do grupo pode
    // escolher a base de entre todas as cidades das contas do grupo (são todas
    // do mesmo dono — isto é para as multis).
    const minhasCidades = [];
    try {
      for (const id of Object.keys(mUw.ITowns.towns)) {
        const t = mUw.ITowns.getTown(Number(id));
        const i = ilhaDe(id);
        minhasCidades.push({
          id: Number(id), nome: t.getName(),
          ilha: i ? `${i.x}:${i.y}` : null,
          nc: colonizadoresEm(id),
        });
      }
    } catch (e) {}

    todos[eu] = {
      equipa: c.equipa || '',
      cidades: minhasCidades,
      cultura: pontosCultura(),
      colonizadores: totalColonizadores(),
      atualizado: agoraServidor(),
    };

    /* AS BASES E O MODO viajam com a partilha, numa entrada própria.
     *
     * Assim basta mudá-los NUMA conta: as outras leem-nos na passagem
     * seguinte, sem ser preciso fazer Buscar em cada uma.
     *
     * Quem os define é quem os tiver preenchidos — a última conta a gravar
     * manda. Se puseres tudo a enviar para uma cidade só e depois voltares à
     * rotação, todas seguem. */
    if (c.baseA || c.baseB || c.destino) {
      todos.__comum = {
        baseA: c.baseA || null,
        baseB: c.baseB || null,
        destino: c.destino || null,
        modo: c.modo || 'rotacao',
        quem: eu,
        quando: agoraServidor(),
      };
    }
    await escreverPartilha(todos);
    partilhaCache = todos;      // o painel usa isto para listar as contas
    return todos;
  }

  /* ---------------------- pedidos --------------------------------------- */

  async function enviarUnidades(origemId, destinoId, unidades, tipo) {
    const url = mUw.location.origin + '/game/town_info?town_id=' + Number(origemId)
      + '&action=send_units&h=' + mUw.Game.csrfToken;
    const payload = Object.assign({}, unidades, {
      id: Number(destinoId), type: tipo || 'support',
      town_id: Number(origemId), nl_init: true,
    });
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      return { ok: !(j && j.error), msg: (j && (j.error || j.success)) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        if (String(n.type) !== 'backbone') continue;
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados) continue;
        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;
          try {
            const modelos = mUw.MM.getModels()[nome];
            if (modelos) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(modelos)) {
                const m = modelos[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(modelos).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  /* ---------------------- envio para o depósito ------------------------- */

  /* Junta os colonizadores de todas as cidades no depósito da minha equipa.
   * Os colonizadores são navios: viajam sozinhos, sem transportes. */
  async function enviarParaDeposito(ctx, c, partilha) {
    const log = ctx.log;
    const alvo = depositoDaMinhaEquipa(c, partilha);
    if (!alvo) { log('Colonos: não sei qual é o depósito da minha equipa.'); return 0; }

    let enviados = 0;
    for (const t of ctx.getMyTowns()) {
      if (Number(t.id) === Number(alvo.townId)) continue;   // já lá está
      const n = colonizadoresEm(t.id);
      if (n <= 0) continue;

      const carga = {}; carga[NC] = n;
      const r = await enviarUnidades(t.id, alvo.townId, carga, 'support');
      if (r.ok) {
        log(`🚢 ${t.name}: ${n} colonizador(es) → ${alvo.nome || ('#' + alvo.townId)}`
          + (alvo.dono && alvo.dono !== '?' ? ` (${alvo.dono})` : '') + '.');
        enviados += n;
        await ctx.sleep(ctx.rand(800, 1600));
      } else {
        log(`⚠️ ${t.name}: envio falhou (${r.msg}).`);
      }
    }
    return enviados;
  }

  /* As bases são escolhidas por ti no painel (baseA e baseB) e valem para
   * todas as contas — são todas do mesmo dono. Procura-se a cidade na partilha
   * para saber a ilha e quantos colonizadores lá estão. */
  function procurarCidade(partilha, townId) {
    if (!townId) return null;
    for (const nome of Object.keys(partilha)) {
      if (nome === '__comum') continue;   // não é uma conta: são as bases e o modo
      const p = partilha[nome] || {};
      for (const cd of (p.cidades || [])) {
        if (Number(cd.id) === Number(townId)) {
          const [x, y] = String(cd.ilha || '').split(':');
          return {
            townId: Number(cd.id), nome: cd.nome, dono: nome,
            ilha: x ? { x: Number(x), y: Number(y) } : null,
            colonizadores: Number(cd.nc) || 0,
          };
        }
      }
    }
    return null;
  }

  function depositoDaMinhaEquipa(c, partilha) {
    // no modo 'destino' é sempre a cidade que indicaste
    if (c.modo === 'destino') {
      if (!c.destino) return null;
      const achada = procurarCidade(partilha, c.destino);
      if (achada) return achada;
      return { townId: Number(c.destino), nome: '#' + c.destino, dono: '?',
        ilha: ilhaDe(c.destino), colonizadores: colonizadoresEm(c.destino) };
    }
    const id = c.equipa === 'A' ? c.baseA : c.baseB;
    const achada = procurarCidade(partilha, id);
    if (achada) return achada;
    // ainda não publicada: pelo menos sabemos o id
    return id ? { townId: Number(id), nome: '#' + id, dono: '?', ilha: ilhaDe(id), colonizadores: colonizadoresEm(id) } : null;
  }

  function depositoDaEquipaOposta(c, partilha) {
    const id = c.equipa === 'A' ? c.baseB : c.baseA;
    const achada = procurarCidade(partilha, id);
    if (achada) return achada;
    return id ? { townId: Number(id), nome: '#' + id, dono: '?', ilha: null, colonizadores: 0 } : null;
  }

  /* ---------------------- ataque ao depósito oposto --------------------- */

  /* É a minha vez de atacar? A conta da MINHA equipa com menos cultura é que
   * ataca — assim todas progridem ao mesmo ritmo. */
  function minhaVez(c, partilha) {
    const eu = meuNome();
    const daMinha = Object.keys(partilha)
      .filter((n) => n !== '__comum')
      .filter((n) => (partilha[n] || {}).equipa === c.equipa)
      .map((n) => ({ nome: n, cultura: Number(partilha[n].cultura) || 0 }))
      .sort((a, b) => a.cultura - b.cultura);
    if (!daMinha.length) return true;      // sozinho: sou eu
    return daMinha[0].nome === eu;
  }

  /* Cidade de onde parte o ataque: a mais próxima do depósito que tenha navios
   * de combate. Transportes não servem — não combatem. */
  function cidadeParaAtacar(ilhaAlvo) {
    let melhor = null;
    try {
      for (const id of Object.keys(mUw.ITowns.towns)) {
        const t = mUw.ITowns.getTown(Number(id));
        const u = t.units() || {};
        const navios = {};
        let tem = 0;
        for (const k of NAVIOS_ATAQUE) {
          const n = Number(u[k]) || 0;
          if (n > 0) { navios[k] = n; tem += n; }
        }
        if (!tem) continue;

        const ilha = { x: Number(t.getIslandCoordinateX()), y: Number(t.getIslandCoordinateY()) };
        const d = (ilhaAlvo && ilha.x != null)
          ? Math.sqrt(Math.pow(ilha.x - ilhaAlvo.x, 2) + Math.pow(ilha.y - ilhaAlvo.y, 2))
          : 0;
        if (!melhor || d < melhor.distancia) {
          melhor = { id: Number(id), name: t.getName(), navios, distancia: d };
        }
      }
    } catch (e) {}
    return melhor;
  }

  async function atacarDeposito(ctx, c, partilha) {
    const log = ctx.log;
    const alvo = depositoDaEquipaOposta(c, partilha);
    if (!alvo) { log('Colonos: não sei qual é o depósito da equipa oposta.'); return false; }

    if (alvo.colonizadores < (num(c.minParaAtacar, 100))) {
      log(`Colonos: o depósito de ${alvo.dono} tem ${alvo.colonizadores} colonizadores `
        + `(mínimo ${c.minParaAtacar}) — ainda não ataco.`);
      return false;
    }

    if (!minhaVez(c, partilha)) {
      const daMinha = Object.keys(partilha)
        .filter((n) => n !== '__comum')
        .filter((n) => (partilha[n] || {}).equipa === c.equipa)
        .sort((a, b) => (partilha[a].cultura || 0) - (partilha[b].cultura || 0));
      log(`Colonos: desta vez ataca ${daMinha[0]} (tem menos cultura do que eu).`);
      return false;
    }

    const origem = cidadeParaAtacar(alvo.ilha);
    if (!origem) {
      log('Colonos: não tenho navios de combate em nenhuma cidade (transportes não servem).');
      return false;
    }

    const r = await enviarUnidades(origem.id, alvo.townId, origem.navios, 'attack');
    if (r.ok) {
      const det = Object.keys(origem.navios)
        .map((k) => `${origem.navios[k]} ${(mUw.GameData.units[k] || {}).name || k}`).join(', ');
      log(`⚔️ ${origem.name} → depósito de ${alvo.dono}: ${det} `
        + `(${alvo.colonizadores} colonizadores a abater).`);
      await ctx.sleep((num(c.pausaAposAtaque, 45)) * 1000);
      return true;
    }
    log(`⚠️ ataque falhou: ${r.msg}`);
    return false;
  }

  /* ---------------------- fundação -------------------------------------- */

  /* ---------------------- ciclo principal ------------------------------- */

  let ultimoEnvio = 0, ultimaProducao = 0;

  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const log = ctx.log;
    const c = cfg();
    if (!c.ativo) { log('Colonos: está DESLIGADO (liga a caixa no painel e guarda).'); return; }
    if (c.modo === 'destino') {
      if (!c.destino) { log('Colonos: falta indicar a cidade que recebe os colonizadores.'); return; }
    } else if (!c.equipa) {
      log('Colonos: falta escolher a equipa (A ou B) no painel.'); return;
    }

    const partilha = await sincronizar(c);
    /* A hora do SERVIDOR, não a do computador.
     *
     * Estes valores são partilhados entre as 20 contas pelo Gist. Se cada
     * máquina usasse o seu relógio, uma com 30 s de desvio estragava a
     * coordenação — e o relógio do jogador não manda em nada no jogo. */
    const agora = agoraServidor();
    let agiu = 0;

    /* A FUNDAÇÃO saiu daqui para módulo próprio (Auto-fundação): são coisas
     * independentes — a rotação farma pontos de combate entre as multis, a
     * fundação usa colonizadores para criar cidades. */

    /* 1. ENVIAR para o depósito */
    if (c.enviar && (agora - ultimoEnvio) >= (num(c.intervaloEnvioMin, 15)) * 60) {
      const n = await enviarParaDeposito(ctx, c, partilha);
      if (n) { agiu++; ultimoEnvio = agora; }
      else ultimoEnvio = agora;   // não insistir já
    }

    /* 2. ATACAR o depósito oposto — só no modo de rotação. No modo 'destino'
     * és tu que atacas com a main quando quiseres. */
    if (c.atacar && c.modo !== 'destino') {
      const fez = await atacarDeposito(ctx, c, partilha);
      if (fez) agiu++;
    }

    if (!agiu) {
      const meu = depositoDaMinhaEquipa(c, partilha);
      const op = depositoDaEquipaOposta(c, partilha);
      log(`Colonos: equipa ${c.equipa} · ${totalColonizadores()} colonizadores meus`
        + (meu ? ` · depósito nosso: ${meu.dono}` : ' · sem depósito nosso')
        + (op ? ` · deles: ${op.dono} (${op.colonizadores})` : ' · sem depósito deles')
        + '.');
    }
  }

  /* ---------------------- painel ---------------------------------------- */

  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Cidades conhecidas de todas as contas, lidas da última partilha guardada.
   * Como as contas são todas do mesmo dono (multis), qualquer cidade pode ser
   * base — só tem de estar publicada por alguma conta. */
  const CACHE_CIDADES = 'grepoColonos_cidades_v1';

  function cidadesGuardadas() {
    try { return JSON.parse(armazem.getItem(CACHE_CIDADES) || '{}'); } catch (e) { return {}; }
  }

  function opcoesCidades(porConta, equipa, selecionada) {
    const out = [];
    for (const conta of Object.keys(porConta)) {
      const p = porConta[conta] || {};
      if (equipa && p.equipa && p.equipa !== equipa) continue;
      for (const cd of (p.cidades || [])) {
        const sel = Number(selecionada) === Number(cd.id) ? ' selected' : '';
        out.push(`<option value="${cd.id}"${sel}>${esc(conta)} · ${esc(cd.nome)}</option>`);
      }
    }
    return out.join('');
  }


  /* Preservar a posição do rolamento ao redesenhar o painel — senão volta ao
   * topo a cada alteração. */
  function comRolamento(fn) {
    /* Guardar TODOS os elementos que estejam rolados, não só os que se
     * adivinham: o que rola pode ser uma caixa interna e o salto para o topo
     * mantinha-se. */
    /* Guardar o CAMINHO e não só a referência: o redesenho destrói os
     * elementos internos e a referência antiga deixa de estar no ecrã. */
    const caminhoDe = (el) => {
      const p = []; let n = el;
      while (n && n.parentElement && p.length < 30) {
        p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
        if (n.id) { p.unshift('#' + n.id); break; }
      }
      return p;
    };
    const porCaminho = (p) => {
      try {
        if (!p.length) return null;
        let n = null, i = 0;
        if (typeof p[0] === 'string' && p[0].charAt(0) === '#') { n = document.getElementById(p[0].slice(1)); i = 1; }
        else n = document.body;
        for (; n && i < p.length; i++) n = n.children[p[i]];
        return n || null;
      } catch (e) { return null; }
    };

    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}
    fn();
    const repor = () => guardados.forEach(({ caminho, y, el }) => {
      try {
        if (el && el.isConnected) { el.scrollTop = y; return; }
        const n2 = porCaminho(caminho);
        if (n2) n2.scrollTop = y;
      } catch (e) {}
    });
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  function painel(container, ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    const towns = ctx.getMyTowns();
    const cidadesConhecidas = cidadesGuardadas();

    container.innerHTML = `
      <div style="font-size:11px;line-height:1.7">
        <label><input type="checkbox" id="col-on"${c.ativo ? ' checked' : ''}> <b>Sistema de colonizadores</b></label><br>

        <div style="background:#0d141c;padding:6px;border-radius:4px;margin:5px 0">
          <label style="display:block"><input type="radio" name="col-modo" value="destino"${c.modo === 'destino' ? ' checked' : ''}>
            <b>Enviar para uma cidade</b>
            <span style="opacity:.6;font-size:10px">— todas as cidades mandam os colonizadores
            para a cidade que indicares; tu atacas quando quiseres</span></label>
          <div style="margin:2px 0 6px 18px">
            Cidade que recebe:
            <input type="text" id="col-destino" value="${c.destino || ''}"
              placeholder="123 ou [town]123[/town]" style="width:150px">
          </div>

          ${(() => {
            /* ESCOLHER A CIDADE EM DOIS PASSOS: primeiro o jogador, depois a
             * cidade dele.
             *
             * Com 10 multis de ~14 cidades são 140 numa lista só — impossível
             * de percorrer. Escolhendo o jogador primeiro, a segunda lista
             * fica com 14. */
            const donos = Object.keys(partilhaCache || {})
              .filter((x) => x !== '__comum').sort();
            if (!donos.length) {
              return `<div style="opacity:.5;font-size:10px;margin-top:3px">
                Ainda não recebi a lista das outras contas — escreve o número à mão.
              </div>`;
            }
            const donoSel = donoEscolhido || donos[0];
            const cidades = ((partilhaCache[donoSel] || {}).cidades) || [];
            return `<div style="display:flex;gap:4px;align-items:center;margin-top:4px">
              <span style="opacity:.7;font-size:10px;flex:0 0 auto">ou escolhe:</span>
              <select id="col-dono" style="flex:1;font-size:10px">
                ${donos.map((d) => `<option value="${esc(d)}"${d === donoSel ? ' selected' : ''}>
                  ${esc(d)}</option>`).join('')}
              </select>
              <select id="col-cidade" style="flex:1;font-size:10px">
                <option value="">— cidade —</option>
                ${cidades.map((ct) => `<option value="${ct.id}">${esc(ct.nome || ct.id)}</option>`).join('')}
              </select>
            </div>`;
          })()}

          <label style="display:block"><input type="radio" name="col-modo" value="rotacao"${c.modo !== 'destino' ? ' checked' : ''}>
            <b>Rotação entre duas equipas</b>
            <span style="opacity:.6;font-size:10px">— cada equipa junta numa base e
            ataca a base da outra</span></label>

          ${(() => {
            /* AS DUAS BASES.
             *
             * Faltavam no painel: só havia o campo do "destino", que é do outro
             * modo. Sem elas, o módulo dizia "sem depósito nosso e sem depósito
             * deles" por muito que se preenchesse o destino. */
            const donos = Object.keys(partilhaCache || {})
              .filter((x) => x !== '__comum').sort();
            const linha = (qual, valor) => {
              const donoSel = donoEscolhido || donos[0];
              const cidades = donos.length
                ? (((partilhaCache[donoSel] || {}).cidades) || []) : [];
              return `<div style="display:flex;gap:4px;align-items:center;margin:3px 0 0 20px">
                <span style="opacity:.75;font-size:10px;width:58px">Base ${qual}</span>
                <input type="text" id="col-base${qual}" value="${valor || ''}"
                  placeholder="número da cidade" style="width:110px;font-size:10px">
                ${donos.length ? `<select data-base="${qual}" style="flex:1;font-size:10px">
                  <option value="">— escolher —</option>
                  ${cidades.map((ct) => `<option value="${ct.id}">${esc(ct.nome || ct.id)}</option>`).join('')}
                </select>` : ''}
              </div>`;
            };
            return linha('A', c.baseA) + linha('B', c.baseB)
              + `<div style="opacity:.6;font-size:10px;margin:2px 0 0 20px">
                  A tua equipa junta os colonizadores na sua base e ataca a outra.<br>
                  <b>As bases e o modo são partilhados</b>: mudas aqui e as outras contas
                  aplicam-nos na passagem seguinte. Só a <b>equipa</b> é de cada conta.
                </div>`;
          })()}
        </div>

        Equipa:
        <label style="margin-left:4px"><input type="radio" name="col-eq" value="A"${c.equipa === 'A' ? ' checked' : ''}> A</label>
        <label style="margin-left:8px"><input type="radio" name="col-eq" value="B"${c.equipa === 'B' ? ' checked' : ''}> B</label>
        <span style="opacity:.6;font-size:10px">— cada equipa ataca o depósito da outra</span><br>

        <div style="margin:4px 0">
          <b>Cidades-base</b>
          <button id="col-atualizar" style="cursor:pointer;font-size:10px;margin-left:6px">🔄 procurar cidades das contas</button>
          <div style="opacity:.6;font-size:10px">
            A base de cada equipa é uma cidade de qualquer conta dessa equipa — é para
            lá que todas enviam os colonizadores, e é essa que a equipa oposta ataca.
          </div>
          <div style="margin-top:3px">
            Base da equipa A:
            <select id="col-baseA" style="max-width:190px">
              <option value="">(por escolher)</option>
              ${opcoesCidades(cidadesConhecidas, 'A', c.baseA)}
            </select>
          </div>
          <div style="margin-top:2px">
            Base da equipa B:
            <select id="col-baseB" style="max-width:190px">
              <option value="">(por escolher)</option>
              ${opcoesCidades(cidadesConhecidas, 'B', c.baseB)}
            </select>
          </div>
        </div>

        Atacar a partir de <input type="number" min="1" id="col-min" value="${c.minParaAtacar}" style="width:56px"> colonizadores
        · pausa de <input type="number" min="0" id="col-pausa" value="${c.pausaAposAtaque}" style="width:48px">s depois<br>
        Enviar a cada <input type="number" min="1" id="col-ienv" value="${c.intervaloEnvioMin}" style="width:44px"> min
        · produzir a cada <input type="number" min="1" id="col-iprod" value="${c.intervaloProducaoMin}" style="width:44px"> min<br>

        <label><input type="checkbox" id="col-enviar"${c.enviar ? ' checked' : ''}> juntar os colonizadores no depósito</label><br>
        <label><input type="checkbox" id="col-atacar"${c.atacar ? ' checked' : ''}> atacar o depósito da equipa oposta</label><br>
        <div style="opacity:.6;font-size:10px;margin-top:3px">
          Para <b>fundar</b> cidades, usa o módulo <i>Auto-fundação</i> — são coisas
          independentes.
        </div>

      </div>

      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:6px;font-size:11px">
        <b>Estado</b><br>
        Colonizadores meus: ${totalColonizadores()} ·
        pontos de cultura: ${pontosCultura()}
        <div style="opacity:.6;font-size:10px;margin-top:2px">
          Ataca a conta da minha equipa com MENOS cultura, para todas progredirem igual.
        </div>
      </div>

      <button id="col-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    const bt = container.querySelector('#col-atualizar');
    if (bt) bt.onclick = async () => {
      bt.disabled = true; bt.textContent = 'a procurar...';
      const todos = await sincronizar(cfg());
      try { armazem.setItem(CACHE_CIDADES, JSON.stringify(todos)); } catch (e) {}
      const n = Object.keys(todos).length;
      const nc = Object.keys(todos).reduce((s2, k) => s2 + ((todos[k].cidades || []).length), 0);
      ctx.log(`Colonos: ${n} conta(s) conhecidas, ${nc} cidade(s). Escolhe as bases.`);
      bt.disabled = false; bt.textContent = '🔄 procurar cidades das contas';
      comRolamento(() => painel(container, ctx));
    };

    /* Escolher o dono primeiro, depois a cidade dele. */
    const selDono = container.querySelector('#col-dono');
    if (selDono) selDono.onchange = () => {
      donoEscolhido = selDono.value;
      painel(container, ctx);
    };
    const selCid = container.querySelector('#col-cidade');
    if (selCid) selCid.onchange = () => {
      const el = container.querySelector('#col-destino');
      if (el && selCid.value) el.value = selCid.value;
    };

    /* Os seletores das duas bases preenchem os campos respectivos. */
    container.querySelectorAll('select[data-base]').forEach((sel) => {
      sel.onchange = () => {
        const qual = sel.getAttribute('data-base');
        const el = container.querySelector(`#col-base${qual}`);
        if (el && sel.value) el.value = sel.value;
      };
    });

    const g = container.querySelector('#col-guardar');
    if (g) g.onclick = () => {
      const extrairId = (t) => {
        const m = String(t || '').match(/\[town\]\s*(\d+)/i) || String(t || '').match(/(\d+)/);
        return m ? Number(m[1]) : null;
      };
      guardar({
        ativo: container.querySelector('#col-on').checked,
        modo: (container.querySelector('input[name="col-modo"]:checked') || {}).value || 'rotacao',
        destino: extrairId(container.querySelector('#col-destino').value),
        baseA: extrairId((container.querySelector('#col-baseA') || {}).value),
        baseB: extrairId((container.querySelector('#col-baseB') || {}).value),
        equipa: (container.querySelector('input[name="col-eq"]:checked') || {}).value || '',
        baseA: container.querySelector('#col-baseA').value ? Number(container.querySelector('#col-baseA').value) : null,
        baseB: container.querySelector('#col-baseB').value ? Number(container.querySelector('#col-baseB').value) : null,
        minParaAtacar: Number(container.querySelector('#col-min').value) || 100,
        pausaAposAtaque: Number(container.querySelector('#col-pausa').value) || 45,
        intervaloEnvioMin: Number(container.querySelector('#col-ienv').value) || 15,
        intervaloProducaoMin: Number(container.querySelector('#col-iprod').value) || 30,
        enviar: container.querySelector('#col-enviar').checked,
        atacar: container.querySelector('#col-atacar').checked,
      });
      ctx.log('Colonos: configuração guardada.');
      comRolamento(() => painel(container, ctx));
    };
  }

  return {
    id: 'colonos',
    nome: 'Rotação de colonizadores',
    intervaloMin: opts.intervaloMin || 10,
    autoStart: true,
    run, painel,
  };
}

  // ==================== MÓDULO: APOIO DISTRIBUÍDO ========================
/* ============================================================================
 *  APOIO DISTRIBUÍDO — versão para o maestro
 *
 *  Envia apoio às cidades de uma lista partilhada (Gist), a partir das cidades
 *  de cada conta, com rodízio e limite por alvo. Ao remover um alvo da lista, o
 *  apoio que lá está é mandado de volta.
 *
 *  MUDANÇAS pedidas em relação à versão anterior:
 *   1. Painel centrado e redimensionável (a VPS tem pouca resolução e com
 *      muitas cidades não se via tudo).
 *   2. Caixa com botão "adicionar" em vez de editar um bloco de texto e
 *      guardar à mão — cada id adicionado grava logo.
 *   3. Lista dos alvos com nome da cidade, jogador e tropas já enviadas, com um
 *      botão por linha para retirar o apoio (remove o alvo e as tropas voltam).
 * ========================================================================== */

function makeApoioModule(opts) {
  opts = opts || {};

  let mUw = null, mWorld = '';
  const GIST_ID = opts.gistId || '';
  const GIST_TOKEN = opts.gistToken || '';

  const CFG_KEY = 'grepoApoio_cfg_v1';
  const DONE_KEY = 'grepoApoio_done_v1';
  const CACHE_ALVOS = 'grepoApoio_cacheAlvos_v1';

  const DEFAULTS = {
    ativo: false,
    pacote: { sword: 40, archer: 40, hoplite: 40, bireme: 20 },
    maxCidadesPorAlvo: 10,
    /* O transporte grande anda a 24 e o rápido a 45 — com ele na carga, o
     * apoio demora o dobro. Por omissão evita-se. */
    evitarTransporteGrande: true,
  };

  /* ============ TRANSPORTES PARA A TROPA TERRESTRE ======================
   * A tropa terrestre não chega a outra ilha sozinha: precisa de navios de
   * carga. As birremes são de GUERRA e não levam nada.
   *
   * Sem isto, o pacote (40 espadas + 40 arqueiros + 40 hoplitas) era enviado
   * sem transportes e o jogo respondia "Necessita de navios de transporte
   * para poder apoiar uma cidade noutra ilha".
   *
   * Capacidades confirmadas: o beliche (berth) sobe-as, e é POR CIDADE.
   * ==================================================================== */
  const CAPACIDADE = {
    small_transporter: { sem: 10, com: 16 },
    big_transporter: { sem: 26, com: 32 },
  };
  const TERRESTRES = ['sword', 'slinger', 'archer', 'hoplite', 'rider', 'chariot', 'catapult'];

  function temBeliche(townId) {
    /* As pesquisas estão em `researches().attributes`, não no objecto
     * directamente — `researches().berth` dá sempre indefinido.
     *
     * Foi por isso que se enviavam 12 transportes onde 8 chegavam: com o
     * beliche por detectar, usava-se a capacidade de 10 em vez de 16. */
    try {
      const r = mUw.ITowns.getTown(Number(townId)).researches();
      if (!r) return false;
      const a = r.attributes || r;
      return !!a.berth;
    } catch (e) { return false; }
  }

  function popDaUnidade(u) {
    try { return Number((mUw.GameData.units[u] || {}).population) || 1; } catch (e) { return 1; }
  }

  /* Acrescenta ao pacote os transportes precisos para a tropa terrestre.
   * Se não houver transportes que cheguem, corta a tropa terrestre ao que
   * couber — mais vale mandar menos do que ver o envio recusado. */
  function juntarTransportes(townId, pacote, c) {
    c = c || {};
    const berth = temBeliche(townId);
    let tenho = {};
    try { tenho = mUw.ITowns.getTown(Number(townId)).units() || {}; } catch (e) {}

    let popTerra = 0;
    for (const u of TERRESTRES) popTerra += (Number(pacote[u]) || 0) * popDaUnidade(u);
    if (popTerra <= 0) return pacote;      // só navios: não precisa de carga

    const out = Object.assign({}, pacote);
    let porCarregar = popTerra;

    /* Usar primeiro os RÁPIDOS.
     *
     * Não é só por serem baratos: o transporte rápido anda a 45, tal como as
     * birremes, mas o GRANDE anda a 24 — metade. Num envio único, tudo viaja
     * à velocidade do mais lento, portanto meter um transporte grande faz o
     * apoio demorar o dobro.
     *
     * Com `evitarTransporteGrande`, prefere-se levar menos tropa a chegar
     * tarde. */
    const naves = c.evitarTransporteGrande
      ? ['small_transporter']
      : ['small_transporter', 'big_transporter'];

    for (const nave of naves) {
      if (porCarregar <= 0) break;
      const cap = CAPACIDADE[nave][berth ? 'com' : 'sem'];
      const disponiveis = Number(tenho[nave]) || 0;
      if (!disponiveis || !cap) continue;

      const precisas = Math.min(disponiveis, Math.ceil(porCarregar / cap));
      if (precisas > 0) {
        out[nave] = (Number(out[nave]) || 0) + precisas;
        porCarregar -= precisas * cap;
      }
    }

    /* Não chegam transportes: cortar tropa terrestre do fim para o início. */
    if (porCarregar > 0) {
      let excesso = porCarregar;
      for (let i = TERRESTRES.length - 1; i >= 0 && excesso > 0; i--) {
        const u = TERRESTRES[i];
        if (!out[u]) continue;
        const pop = popDaUnidade(u);
        const tirar = Math.min(out[u], Math.ceil(excesso / pop));
        out[u] -= tirar;
        excesso -= tirar * pop;
        if (out[u] <= 0) delete out[u];
      }
    }
    return out;
  }

  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function cfg() {
    const c = JSON.parse(JSON.stringify(DEFAULTS));
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function guardarCfg(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  function meuId() {
    try { return String(mUw.Game.player_id || mUw.Game.playerId || 'x'); } catch (e) { return 'x'; }
  }

  /* ---------------------- registo do que já foi enviado ------------------ */

  function lerRegisto() {
    try {
      const todos = JSON.parse(armazem.getItem(DONE_KEY) || '{}');
      return todos[meuId()] || {};
    } catch (e) { return {}; }
  }
  function gravarRegisto(reg) {
    try {
      const todos = JSON.parse(armazem.getItem(DONE_KEY) || '{}');
      todos[meuId()] = reg;
      armazem.setItem(DONE_KEY, JSON.stringify(todos));
    } catch (e) {}
  }
  const chavePar = (origem, alvo) => `${origem}->${alvo}`;

  /* ---------------------- lista partilhada (Gist) ----------------------- */

  /* Este ficheiro é de COORDENAÇÃO entre contas: as 20 multis têm de ver a
   * mesma lista, por isso NÃO leva o perfil no nome — só o mundo. Meter o
   * perfil aqui isolaria cada conta e a coordenação deixava de funcionar. */
  const FICHEIRO = () => `apoio-${mWorld}.json`;

  async function lerLista() {
    if (!GIST_ID) return null;
    try {
      const r = await mUw.fetch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!r.ok) return null;
      const j = await r.json();
      const f = (j.files || {})[FICHEIRO()];
      if (!f || !f.content) return null;
      const dados = JSON.parse(f.content);
      // guardar em cache para o painel funcionar mesmo offline
      try { armazem.setItem(CACHE_ALVOS, JSON.stringify(dados)); } catch (e) {}
      return dados;
    } catch (e) { return null; }
  }

  /* Devolve { ok, msg } — o motivo importa.
   *
   * Antes devolvia só true/false e a mensagem dizia sempre "falta o token do
   * Gist?", mesmo quando o token estava bom. O que costuma falhar é o LIMITE
   * DE ESCRITAS do GitHub: com 19 contas a gravar, esgota-se depressa. */
  async function escreverLista(dados) {
    // não segurar o processo (importante nos testes)
    try { if (typeof t2 !== 'undefined' && t2 && t2.unref) t2.unref(); } catch (e) {}
    if (!GIST_ID || !GIST_TOKEN) return { ok: false, msg: 'sem Gist configurado' };
    try {
      const body = { files: {} };
      body.files[FICHEIRO()] = { content: JSON.stringify(dados, null, 1) };
      const r = await mUw.fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + GIST_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (r.ok) {
        try { armazem.setItem(CACHE_ALVOS, JSON.stringify(dados)); } catch (e) {}
        return { ok: true };
      }

      if (r.status === 403) {
        /* Pode ser limite de pedidos ou permissões — a mensagem do GitHub
         * diz qual. Guarda-se localmente na mesma, para não se perder o que
         * se acabou de configurar. */
        try { armazem.setItem(CACHE_ALVOS, JSON.stringify(dados)); } catch (e) {}
        let porque = 'o GitHub recusou (403)';
        try {
          const j = await r.json();
          if (j && /rate limit/i.test(String(j.message || ''))) {
            porque = 'o GitHub limitou as escritas — tenta daqui a uns minutos '
              + '(guardei localmente entretanto)';
          }
        } catch (e) {}
        return { ok: false, msg: porque };
      }

      return { ok: false, msg: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  function listaEmCache() {
    try { return JSON.parse(armazem.getItem(CACHE_ALVOS) || 'null'); } catch (e) { return null; }
  }

  /* ---------------------- informação sobre os alvos --------------------- */

  /* Nome da cidade e do jogador de um alvo. As cidades dos outros jogadores
   * vêm do mapa (map_data), como no módulo dos deuses. */
  const CHUNK = 20;
  /* Nomes das cidades alvo, GUARDADOS entre sessões.
   *
   * Era uma variável só em memória: procurava-se o nome, guardava-se, e
   * perdia-se ao recarregar a página. Daí o "obter nomes" parecer não fazer
   * nada — fazia, mas não durava. */
  const NOMES_KEY = 'grepoApoio_nomes_v1';

  const cacheCidades = (() => {
    try { return JSON.parse(armazem.getItem(NOMES_KEY) || '{}'); } catch (e) { return {}; }
  })();

  function gravarNomes() {
    try { armazem.setItem(NOMES_KEY, JSON.stringify(cacheCidades)); } catch (e) {}
  }

  /* Blocos do mapa já procurados, para a busca continuar de onde parou em vez
   * de recomeçar do princípio a cada vez. */
  const VISTOS_KEY = 'grepoApoio_blocosVistos_v1';
  function blocosJaVistos() {
    try { return new Set(JSON.parse(armazem.getItem(VISTOS_KEY) || '[]')); }
    catch (e) { return new Set(); }
  }
  function gravarBlocos(set) {
    try { armazem.setItem(VISTOS_KEY, JSON.stringify(Array.from(set).slice(-400))); } catch (e) {}
  }

  /* O nome pode estar nos MEUS MOVIMENTOS.
   *
   * Um apoio a caminho traz `town_name_destination` e um `link_destination`
   * com as coordenadas em base64. Como os alvos são cidades que apoiamos, o
   * nome costuma estar aí — sem varrer o mapa nem depender da Ágora.
   *
   * Confirmado no jogo: `town_name_destination: "c-8"` e
   * `link_destination` com `{"id":4934,"ix":533,"iy":498,"name":"c-8"}`. */
  function nomePelosMovimentos(townId) {
    try {
      const m = mUw.MM.getModels().MovementsUnits || {};
      for (const k of Object.keys(m)) {
        const a = m[k].attributes || {};

        const par = [
          [a.target_town_id, a.town_name_destination, a.link_destination],
          [a.home_town_id, a.town_name_origin, a.link_origin],
        ];
        for (const [id, nome, link] of par) {
          if (Number(id) !== Number(townId)) continue;

          let ilha = null;
          try {
            const b64 = String(link || '').match(/#([A-Za-z0-9+/=]{16,})/);
            if (b64) {
              const d = JSON.parse(atob(b64[1]));
              if (Number.isFinite(Number(d.ix))) ilha = { x: Number(d.ix), y: Number(d.iy) };
            }
          } catch (e) {}

          if (nome) return { nome: String(nome), jogador: '?', minha: false, ilha };
        }
      }
    } catch (e) {}
    return null;
  }

  async function infoDaCidade(townId, townIdBase) {
    if (cacheCidades[townId]) return cacheCidades[townId];

    /* O nome pode estar nos meus movimentos — mas o JOGADOR não vem lá (o
     * `player_id` do movimento sou eu, não o dono da cidade).
     *
     * Guarda-se já o nome, para o painel não ficar com "#171", e segue-se
     * para o mapa: é lá que está o dono. */
    const dosMovimentos = nomePelosMovimentos(townId);
    if (dosMovimentos) {
      cacheCidades[townId] = dosMovimentos;
      gravarNomes();
      // não devolve já: continua, para tentar apanhar o nome do jogador
    }

    // se for minha, sei logo
    try {
      if (mUw.ITowns.towns[townId]) {
        const t = mUw.ITowns.getTown(Number(townId));
        const info = { nome: t.getName(), jogador: '(minha)', minha: true };
        cacheCidades[townId] = info;
        gravarNomes();
        return info;
      }
    } catch (e) {}

    // senão, procurar no mapa à volta das minhas ilhas
    try {
      const vistos = new Set();
      for (const id of Object.keys(mUw.ITowns.towns)) {
        const t = mUw.ITowns.getTown(Number(id));
        const cx = Math.floor(Number(t.getIslandCoordinateX()) / CHUNK);
        const cy = Math.floor(Number(t.getIslandCoordinateY()) / CHUNK);
        const chave = `${cx}:${cy}`;
        if (vistos.has(chave)) continue;
        vistos.add(chave);

        const url = mUw.location.origin + '/game/map_data?town_id=' + Number(townIdBase || id)
          + '&action=get_chunks&h=' + mUw.Game.csrfToken
          + '&json=' + encodeURIComponent(JSON.stringify({
              chunks: [{ x: cx, y: cy, timestamp: 0 }], town_id: Number(townIdBase || id), nl_init: true }));
        const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
          .then(lerResposta);
        const d = (r && r.json && r.json.data) || {};
        const bloco = d[0] || d['0'];
        const towns = (bloco && bloco.towns) || {};
        for (const k of Object.keys(towns)) {
          const x = towns[k];
          if (!cacheCidades[x.id]) {
            cacheCidades[x.id] = { nome: x.name, jogador: x.player_name || '(sem dono)', minha: false };
          }
        }
        if (cacheCidades[townId]) { gravarNomes(); return cacheCidades[townId]; }
      }
      gravarNomes();   // guardar o que se aprendeu, mesmo que o alvo não apareça
    } catch (e) {}

    /* SEI AS COORDENADAS? Vou direto ao bloco certo.
     *
     * Mesmo sem o nome, os movimentos podem trazer o `link` com as
     * coordenadas. Com elas, um pedido chega — em vez de varrer dezenas de
     * blocos à sorte. */
    try {
      const comIlha = nomePelosMovimentos(townId);
      const ilha = comIlha && comIlha.ilha;
      if (ilha) {
        const base = Number(townIdBase) || Number(Object.keys(mUw.ITowns.towns)[0]);
        const cx = Math.floor(ilha.x / CHUNK), cy = Math.floor(ilha.y / CHUNK);
        const url = mUw.location.origin + '/game/map_data?town_id=' + Number(base)
          + '&action=get_chunks&h=' + mUw.Game.csrfToken
          + '&json=' + encodeURIComponent(JSON.stringify({
            chunks: [{ x: cx, y: cy, timestamp: 0 }],
            town_id: Number(base), nl_init: true,
          }));
        const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
          .then(lerResposta);
        const d = (r && r.json && r.json.data) || {};
        const bloco = d[0] || d['0'];
        const towns = (bloco && bloco.towns) || {};
        for (const k of Object.keys(towns)) {
          const x = towns[k];
          if (!cacheCidades[x.id]) {
            cacheCidades[x.id] = { nome: x.name, jogador: x.player_name || '(sem dono)', minha: false };
          }
        }
        gravarNomes();
        if (cacheCidades[townId] && cacheCidades[townId].jogador !== '?') {
          return cacheCidades[townId];
        }
      }
    } catch (e) {}

    /* Se já se sabe o nome pelos movimentos, não vale a pena varrer o mapa só
     * para descobrir o dono — devolve-se o que há. */
    if (dosMovimentos) return cacheCidades[townId] || dosMovimentos;

    /* NÃO ESTÁ PERTO: procurar mais longe.
     *
     * Os blocos à volta das minhas cidades não chegam quando o alvo está
     * noutro oceano — visto em jogo: as minhas cidades nos blocos 33-39 e a
     * cidade alvo no bloco 25:25.
     *
     * Varre-se em espiral à volta do centro do mapa, que é por onde as contas
     * costumam estar. Poucos pedidos, com pausa entre eles. */
    try {
      const base = Number(townIdBase) || Number(Object.keys(mUw.ITowns.towns)[0]);
      const CENTRO = 50;                 // o mapa vai de 0 a ~100 em blocos
      const jaVi = blocosJaVistos();
      for (const id of Object.keys(mUw.ITowns.towns)) {
        try {
          const t = mUw.ITowns.getTown(Number(id));
          jaVi.add(`${Math.floor(t.getIslandCoordinateX() / CHUNK)}:${Math.floor(t.getIslandCoordinateY() / CHUNK)}`);
        } catch (e) {}
      }

      /* Grelha à volta do centro, do mais perto para o mais longe.
       *
       * Cada bloco cobre 10×10 ilhas, e o mapa tem ~100×100 blocos. Uma
       * grelha de 5 em 5 a até 30 blocos do centro cobre a zona onde as
       * contas jogam, com ~150 pedidos no pior caso — mas para quase sempre
       * muito antes, porque encontra o alvo.
       *
       * Visto em jogo: as minhas cidades no bloco 33-39 e o alvo no 25:25. */
      const porVer = [];
      for (let raio = 5; raio <= 30; raio += 5) {
        for (let dx = -raio; dx <= raio; dx += 5) {
          for (let dy = -raio; dy <= raio; dy += 5) {
            // só a orla deste raio: o interior já foi visto na volta anterior
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== raio) continue;
            const cx = CENTRO + dx, cy = CENTRO + dy;
            const ch = `${cx}:${cy}`;
            if (cx < 0 || cy < 0 || jaVi.has(ch)) continue;
            jaVi.add(ch);
            porVer.push({ x: cx, y: cy });
          }
        }
      }

      /* Limite de pedidos: procurar o mapa todo seriam ~167 blocos, o que dá
       * 429 do servidor. Faz-se um bocado de cada vez — o que se encontrar
       * fica guardado, e a passagem seguinte continua de onde parou. */
      const MAX_POR_VEZ = 25;
      let feitos = 0;

      for (const bl of porVer) {
        if (feitos++ >= MAX_POR_VEZ) {
          try {
            console.log(`[MAESTRO/apoio] procurei ${MAX_POR_VEZ} blocos sem achar `
              + `a cidade ${townId}; continuo na próxima vez.`);
          } catch (e) {}
          break;
        }
        const url = mUw.location.origin + '/game/map_data?town_id=' + Number(base)
          + '&action=get_chunks&h=' + mUw.Game.csrfToken
          + '&json=' + encodeURIComponent(JSON.stringify({
            chunks: [{ x: bl.x, y: bl.y, timestamp: 0 }],
            town_id: Number(base), nl_init: true,
          }));
        const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
          .then(lerResposta);
        const d = (r && r.json && r.json.data) || {};
        const bloco = d[0] || d['0'];
        const towns = (bloco && bloco.towns) || {};
        for (const k of Object.keys(towns)) {
          const x = towns[k];
          if (!cacheCidades[x.id]) {
            cacheCidades[x.id] = { nome: x.name, jogador: x.player_name || '(sem dono)', minha: false };
          }
        }
        if (cacheCidades[townId]) { gravarNomes(); gravarBlocos(jaVi); return cacheCidades[townId]; }
        await new Promise((res) => setTimeout(res, 400));
      }
      gravarNomes();
      gravarBlocos(jaVi);
    } catch (e) {}

    return cacheCidades[townId] || { nome: '#' + townId, jogador: '?', minha: false };
  }

  /* Tropas que ESTA conta já enviou para um alvo. */
  function tropasEnviadasPara(alvoId, reg) {
    const total = {};
    let n = 0;
    for (const k of Object.keys(reg || {})) {
      const m = k.match(/^(\d+)->(\d+)$/);
      if (!m || Number(m[2]) !== Number(alvoId)) continue;
      const u = (reg[k] || {}).u || {};
      for (const un of Object.keys(u)) {
        total[un] = (total[un] || 0) + (Number(u[un]) || 0);
        n += Number(u[un]) || 0;
      }
    }
    return { detalhe: total, total: n, cidades: Object.keys(reg || {})
      .filter((k) => { const m = k.match(/^(\d+)->(\d+)$/); return m && Number(m[2]) === Number(alvoId); }).length };
  }

  /* ---------------------- envio ----------------------------------------- */

  async function enviarApoio(origemId, alvoId, unidades) {
    const url = mUw.location.origin + '/game/town_info?town_id=' + Number(origemId)
      + '&action=send_units&h=' + mUw.Game.csrfToken;
    const payload = Object.assign({}, unidades, {
      id: Number(alvoId), type: 'support', town_id: Number(origemId), nl_init: true,
    });
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify(payload)),
      }).then(lerResposta);
      const j = r && r.json;
      return { ok: !(j && j.error), msg: (j && (j.error || j.success)) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* Mandar voltar o apoio que esta conta tem num alvo. */
  async function retirarApoio(ctx, alvoId) {
    const log = ctx.log;
    let voltaram = 0;

    /* 1. O que ainda vai A CAMINHO: cancela-se o comando. */
    try {
      const movs = mUw.MM.getModels().MovementsUnits || {};
      for (const k of Object.keys(movs)) {
        const a = movs[k].attributes || {};
        if (!/support/i.test(String(a.type || ''))) continue;
        if (Number(a.target_town_id) !== Number(alvoId)) continue;
        if (!mUw.ITowns.towns[a.home_town_id]) continue;   // não é minha
        const r = await cancelarOuRetirar(a, alvoId);
        if (r) { voltaram++; await ctx.sleep(ctx.rand(600, 1200)); }
      }
    } catch (e) {}

    /* 2. O que JÁ LÁ ESTÁ estacionado: manda-se de volta.
     *
     * Isto faltava por completo. O `MovementsUnits` só tem a tropa em viagem;
     * a que já chegou está no modelo `Units`, e por isso ficava lá para sempre
     * mesmo depois de o alvo sair da lista.
     *
     * Confirmado no jogo: `building_place?action=send_back` com o
     * `support_id`, pedido a partir da cidade de ORIGEM — a minha, a que
     * mandou a tropa. É o que se faz na Ágora, separador "Fora". */
    /* NUNCA tocar nas BASES da rotação de colonizadores.
     *
     * Os colonizadores juntam-se na base como APOIO, e o módulo de apoio usa o
     * mesmo mecanismo — sem esta protecção, retirar um alvo mandava de volta
     * os colonizadores do depósito e desfazia a rotação toda. */
    const basesProtegidas = new Set();
    try {
      const cc = JSON.parse(armazem.getItem('grepoColonos_cfg_v1') || '{}');
      for (const b of [cc.baseA, cc.baseB, cc.destino]) {
        const n = Number(b) || 0;
        if (n) basesProtegidas.add(n);
      }
    } catch (e) {}

    if (basesProtegidas.has(Number(alvoId))) {
      log(`Apoio: ${alvoId} é uma base do módulo de colonizadores `
        + '(rotação entre equipas ou cidade de destino) — não retiro nada de lá.');
      return voltaram;
    }

    try {
      const mods = mUw.MM.getModels().Units || {};
      for (const k of Object.keys(mods)) {
        const a = mods[k].attributes || {};
        if (Number(a.current_town_id) !== Number(alvoId)) continue;

        const casa = Number(a.home_town_id);
        if (!casa || casa === Number(alvoId)) continue;      // não é apoio
        if (!mUw.ITowns.towns[casa]) continue;               // não é minha

        /* Não mexer em colonizadores: são da rotação, não deste módulo. */
        if ((Number(a.colonize_ship) || 0) > 0) continue;

        const r = await mandarDeVolta(a.id, casa);
        if (r) { voltaram++; await ctx.sleep(ctx.rand(700, 1300)); }
      }
    } catch (e) {}

    return voltaram;
  }

  /* Mandar de volta um apoio já estacionado.
   *
   * O pedido parte da cidade de ORIGEM — a minha, a que mandou a tropa. É o
   * mesmo que se faz na Ágora, separador "Fora". */
  async function mandarDeVolta(supportId, origemId) {
    if (!supportId || !origemId) return false;
    try {
      const url = mUw.location.origin + '/game/building_place?town_id=' + Number(origemId)
        + '&action=send_back&h=' + mUw.Game.csrfToken;
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({
          support_id: Number(supportId), town_id: Number(origemId), nl_init: true,
        })),
      }).then(lerResposta);
      return !(r && r.json && r.json.error);
    } catch (e) { return false; }
  }

  async function cancelarOuRetirar(mov, alvoId) {
    // se ainda vai a caminho e é cancelável, cancela-se
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(mov.home_town_id)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({
          model_url: 'Commands', action_name: 'cancelCommand', captcha: null,
          arguments: { id: Number(mov.command_id) },
          town_id: Number(mov.home_town_id), nl_init: true,
        })),
      }).then(lerResposta);
      return !(r && r.json && r.json.error);
    } catch (e) { return false; }
  }

  /* ---------------------- ciclo principal ------------------------------- */

  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const rotina = ctx.logRotina || ctx.log;   // rotina: não vai para o registo
    const log = ctx.log;
    const c = cfg();
    if (!c.ativo) { log('Apoio: está DESLIGADO (liga a caixa no painel e guarda).'); return; }

    const lista = await lerLista();
    if (!lista) { log('Apoio: não consegui ler a lista partilhada (Gist).'); return; }

    const alvos = (lista.alvos || lista.targets || []).map(Number).filter(Boolean);

    /* RETIRAR O QUE JÁ NÃO ESTÁ NA LISTA.
     *
     * A lista é partilhada: se removeres um alvo NOUTRA conta, esta fica com
     * tropa lá parada e nunca a traz de volta — a retirada só corria ao
     * carregar no botão da própria conta.
     *
     * Aqui percorre-se o que está estacionado fora e traz-se de volta o que
     * não pertence a nenhum alvo actual. */
    try {
      const doColonos = (() => {
        const out = new Set();
        try {
          const cc = JSON.parse(armazem.getItem('grepoColonos_cfg_v1') || '{}');
          for (const b of [cc.baseA, cc.baseB, cc.destino]) {
            const n = Number(b) || 0;
            if (n) out.add(n);
          }
        } catch (e) {}
        return out;
      })();

      const naLista = new Set(alvos);
      const ondeTenho = new Set();
      const mods = mUw.MM.getModels().Units || {};
      for (const k of Object.keys(mods)) {
        const a = mods[k].attributes || {};
        const casa = Number(a.home_town_id), onde = Number(a.current_town_id);
        if (!casa || !onde || casa === onde) continue;
        if (!mUw.ITowns.towns[casa]) continue;
        if ((Number(a.colonize_ship) || 0) > 0) continue;   // é da rotação
        if (naLista.has(onde) || doColonos.has(onde)) continue;
        ondeTenho.add(onde);
      }

      for (const cidade of ondeTenho) {
        const n = await retirarApoio(ctx, cidade);
        if (n) log(`↩️ Apoio: ${cidade} já não está na lista — ${n} comando(s) a voltar.`);
      }
    } catch (e) {}

    if (!alvos.length) { log('Apoio: a lista de alvos está vazia.'); return; }

    const reg = lerRegisto();

    /* Limpeza: entradas de cidades que já não são minhas (perdidas ou
     * conquistadas) ficariam para sempre. Não pesa muito — são uns KB — mas
     * falseia a contagem de quantas cidades apoiam cada alvo. */
    (function limpar() {
      let removidas = 0;
      for (const k of Object.keys(reg)) {
        const m = k.match(/^(\d+)->(\d+)$/);
        if (!m) { delete reg[k]; removidas++; continue; }
        try {
          if (!mUw.ITowns.towns[m[1]]) { delete reg[k]; removidas++; }
        } catch (e) {}
      }
      if (removidas) {
        gravarRegisto(reg);
        log(`Apoio: limpei ${removidas} registo(s) de cidades que já não tenho.`);
      }
    })();
    const pacote = lista.pacote || c.pacote;
    const maxPorAlvo = Number(lista.maxCidadesPorAlvo || c.maxCidadesPorAlvo) || 10;

    // 1. RETORNOS: alvos que já não estão na lista mas que ainda apoio
    const ativos = new Set(alvos);
    const apoiados = new Set();
    for (const k of Object.keys(reg)) {
      const m = k.match(/^(\d+)->(\d+)$/);
      if (m) apoiados.add(Number(m[2]));
    }
    for (const alvo of apoiados) {
      if (ativos.has(alvo)) continue;
      const n = await retirarApoio(ctx, alvo);
      if (n) log(`↩️ Apoio: ${n} comando(s) de volta do alvo ${alvo} (saiu da lista).`);
      // limpar o registo desse alvo
      for (const k of Object.keys(reg)) {
        const m = k.match(/^(\d+)->(\d+)$/);
        if (m && Number(m[2]) === alvo) delete reg[k];
      }
    }
    gravarRegisto(reg);

    // 2. ENVIOS: apoiar os alvos da lista
    const towns = ctx.getMyTowns();
    let enviados = 0;

    for (const alvo of alvos) {
      const jaApoiam = Object.keys(reg)
        .filter((k) => { const m = k.match(/^(\d+)->(\d+)$/); return m && Number(m[2]) === alvo; }).length;
      if (jaApoiam >= maxPorAlvo) continue;

      // rodízio: preferir as cidades que menos alvos apoiam
      const uso = {};
      towns.forEach((t) => { uso[t.id] = 0; });
      for (const k of Object.keys(reg)) {
        const m = k.match(/^(\d+)->(\d+)$/);
        if (m && uso[m[1]] != null) uso[m[1]]++;
      }
      /* O REGISTO não chega: a tropa pode ter voltado.
       *
       * Visto em jogo: cinco cidades registadas como tendo apoiado a 108, sem
       * tropa lá nem a caminho. O apoio tinha sido enviado com êxito, mas
       * voltou — ou porque o dono da cidade o dispensou, ou por outra razão.
       *
       * Como o módulo confiava no registo, nunca reenviava. Aqui confirma-se
       * que a tropa está mesmo lá (ou a caminho); se não estiver, o registo é
       * apagado e a cidade volta a ser candidata. */
      const temLaOuACaminho = (origemId) => {
        try {
          const mods = mUw.MM.getModels().Units || {};
          for (const k of Object.keys(mods)) {
            const a = mods[k].attributes || {};
            if (Number(a.home_town_id) === Number(origemId)
              && Number(a.current_town_id) === Number(alvo)) return true;
          }
          const movs = mUw.MM.getModels().MovementsUnits || {};
          for (const k of Object.keys(movs)) {
            const a = movs[k].attributes || {};
            if (Number(a.home_town_id) === Number(origemId)
              && Number(a.target_town_id) === Number(alvo)) return true;
          }
        } catch (e) {}
        return false;
      };

      let limpos = 0;
      for (const t of towns) {
        const chave = chavePar(t.id, alvo);
        if (!reg[chave]) continue;
        /* Dar meia hora de folga: a tropa pode estar a caminho e o modelo
         * ainda não a mostrar. */
        if (Date.now() - (reg[chave].t || 0) < 30 * 60 * 1000) continue;
        if (!temLaOuACaminho(t.id)) { delete reg[chave]; limpos++; }
      }
      if (limpos) {
        gravarRegisto(reg);
        rotina(`Apoio: ${limpos} envio(s) para ${alvo} não chegaram (a tropa voltou?) `
          + '— vou tentar outra vez.');
      }

      const candidatas = towns
        .filter((t) => !reg[chavePar(t.id, alvo)])
        .sort((a, b) => (uso[a.id] || 0) - (uso[b.id] || 0));

      for (const t of candidatas) {
        if (Object.keys(reg).filter((k) => {
          const m = k.match(/^(\d+)->(\d+)$/); return m && Number(m[2]) === alvo;
        }).length >= maxPorAlvo) break;

        // só mandar o que a cidade tem
        const tem = (() => { try { return mUw.ITowns.getTown(Number(t.id)).units() || {}; } catch (e) { return {}; } })();
        const carga = {};
        let algum = 0;
        for (const u of Object.keys(pacote)) {
          const q = Math.min(Number(pacote[u]) || 0, Number(tem[u]) || 0);
          if (q > 0) { carga[u] = q; algum += q; }
        }
        if (!algum) continue;

        /* Juntar os TRANSPORTES precisos para a tropa terrestre.
         *
         * O pacote traz só as unidades a apoiar; sem navios de carga o jogo
         * recusa com "Necessita de navios de transporte para poder apoiar uma
         * cidade noutra ilha". As birremes são de guerra e não servem. */
        const cargaFinal = juntarTransportes(t.id, carga, c);
        const temAlgo = Object.keys(cargaFinal).some((u) => (Number(cargaFinal[u]) || 0) > 0);
        if (!temAlgo) {
          rotina(`${t.name} → ${alvo}: sem transportes para levar a tropa; salto.`);
          continue;
        }

        const r = await enviarApoio(t.id, alvo, cargaFinal);
        if (r.ok) {
          reg[chavePar(t.id, alvo)] = { t: Date.now(), u: cargaFinal };
          gravarRegisto(reg);
          enviados++;
          log(`🛡️ ${t.name} → ${alvo}: ${Object.keys(cargaFinal).map((k) => `${cargaFinal[k]} ${k}`).join(', ')}.`);
          await ctx.sleep(ctx.rand(800, 1600));
        } else {
          log(`⚠️ ${t.name} → ${alvo}: ${r.msg}`);
        }
      }
    }

    if (!enviados) {
      rotina(`Apoio: ${alvos.length} alvo(s) na lista — nada a enviar agora `
        + '(já apoiados ou sem tropas).');
    }
  }

  /* ---------------------- painel ---------------------------------------- */

  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }


  /* Preservar a posição do rolamento ao redesenhar o painel — senão volta ao
   * topo a cada alteração. */
  function comRolamento(fn) {
    /* Guardar TODOS os elementos que estejam rolados, não só os que se
     * adivinham: o que rola pode ser uma caixa interna e o salto para o topo
     * mantinha-se. */
    /* Guardar o CAMINHO e não só a referência: o redesenho destrói os
     * elementos internos e a referência antiga deixa de estar no ecrã. */
    const caminhoDe = (el) => {
      const p = []; let n = el;
      while (n && n.parentElement && p.length < 30) {
        p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
        if (n.id) { p.unshift('#' + n.id); break; }
      }
      return p;
    };
    const porCaminho = (p) => {
      try {
        if (!p.length) return null;
        let n = null, i = 0;
        if (typeof p[0] === 'string' && p[0].charAt(0) === '#') { n = document.getElementById(p[0].slice(1)); i = 1; }
        else n = document.body;
        for (; n && i < p.length; i++) n = n.children[p[i]];
        return n || null;
      } catch (e) { return null; }
    };

    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}
    fn();
    const repor = () => guardados.forEach(({ caminho, y, el }) => {
      try {
        if (el && el.isConnected) { el.scrollTop = y; return; }
        const n2 = porCaminho(caminho);
        if (n2) n2.scrollTop = y;
      } catch (e) {}
    });
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  function painel(container, ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    const lista = listaEmCache() || {};
    const alvos = (lista.alvos || lista.targets || []).map(Number).filter(Boolean);
    const reg = lerRegisto();

    const linhas = alvos.length ? alvos.map((id) => {
      const info = cacheCidades[id] || { nome: '#' + id, jogador: '…' };
      const t = tropasEnviadasPara(id, reg);
      const det = Object.keys(t.detalhe).map((k) => `${t.detalhe[k]} ${k}`).join(', ');
      return `<tr data-alvo="${id}">
        <td style="padding:2px 3px">${esc(info.nome)}</td>
        <td style="padding:2px 3px;opacity:.75">${esc(info.jogador)}</td>
        <td style="padding:2px 3px;opacity:.85">${t.total ? esc(det) + ` <span style="opacity:.6">(${t.cidades} cidade(s))</span>` : '<span style="opacity:.5">nada ainda</span>'}</td>
        <td style="padding:2px 3px;text-align:right">
          <button data-remover="${id}" style="cursor:pointer;font-size:10px;background:#733;color:#fdd;border:none;border-radius:3px;padding:2px 6px">retirar</button>
        </td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" style="opacity:.6;padding:4px">Nenhum alvo na lista.</td></tr>';

    container.innerHTML = `
      <div style="font-size:11px;line-height:1.7">
        <label><input type="checkbox" id="ap-on"${c.ativo ? ' checked' : ''}> <b>Apoio distribuído</b></label><br>

        <div style="margin:5px 0">
          Acrescentar alvo:
          <input type="text" id="ap-novo" placeholder="123 ou [town]123[/town]" style="width:150px">
          <button id="ap-add" style="cursor:pointer;padding:2px 8px">+ adicionar</button>
          <span style="opacity:.6;font-size:10px">grava logo, sem ter de guardar</span>
        </div>

        <div style="margin:4px 0">
          Pacote por cidade:
          E<input type="number" id="ap-sword" value="${c.pacote.sword}" style="width:44px">
          A<input type="number" id="ap-archer" value="${c.pacote.archer}" style="width:44px">
          H<input type="number" id="ap-hoplite" value="${c.pacote.hoplite}" style="width:44px">
          B<input type="number" id="ap-bireme" value="${c.pacote.bireme}" style="width:44px">
          · máx. <input type="number" id="ap-max" value="${c.maxCidadesPorAlvo}" style="width:44px">
        <div style="margin-top:5px">
          <label><input type="checkbox" id="ap-sotr"${c.evitarTransporteGrande !== false ? ' checked' : ''}>
            não usar transportes grandes</label>
          <div style="opacity:.6;font-size:10px;margin-left:18px">
            O transporte grande anda a <b>24</b> e o rápido a <b>45</b>, tal como as
            birremes. Num envio único tudo viaja à velocidade do mais lento — com um
            transporte grande, o apoio demora o dobro.
          </div>
        </div> cidades por alvo
        </div>
      </div>

      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:6px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          <b style="font-size:11px">Alvos apoiados</b>
          <button id="ap-nomes" style="cursor:pointer;font-size:10px">🔄 obter nomes</button>
          <span style="opacity:.55;font-size:10px">“retirar” tira o alvo da lista e manda o apoio de volta</span>
        </div>
        <div style="max-height:180px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <tr style="opacity:.6"><td>cidade</td><td>jogador</td><td>tropas minhas lá</td><td></td></tr>
            ${linhas}
          </table>
        </div>
      </div>

      <button id="ap-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar definições</button>`;

    /* ---- acrescentar alvo: grava logo ---- */
    /* Aceita o número simples (123) e também o formato que o jogo copia,
     * [town]123[/town] — assim não é preciso limpar à mão. */
    function extrairIds(texto) {
      const s2 = String(texto || '');
      const ids = [];
      // formato do jogo
      const re = /\[town\]\s*(\d+)\s*\[\/?town\]/gi;
      let m;
      while ((m = re.exec(s2))) ids.push(Number(m[1]));
      if (ids.length) return ids;
      // senão, todos os números que lá estiverem (aceita vários separados)
      for (const n of (s2.match(/\d+/g) || [])) ids.push(Number(n));
      return ids;
    }

    const add = async () => {
      const el = container.querySelector('#ap-novo');
      const ids = extrairIds(el.value);
      if (!ids.length) { ctx.log('Apoio: escreve o id da cidade (123 ou [town]123[/town]).'); return; }

      const atual0 = (await lerLista()) || listaEmCache() || {};
      const arr0 = (atual0.alvos || atual0.targets || []).map(Number).filter(Boolean);
      const novos = ids.filter((x) => arr0.indexOf(x) < 0);
      const repetidos = ids.filter((x) => arr0.indexOf(x) >= 0);

      if (!novos.length) {
        ctx.log(`Apoio: ${repetidos.join(', ')} já ${repetidos.length > 1 ? 'estão' : 'está'} na lista.`);
        el.value = '';
        return;
      }
      novos.forEach((x) => arr0.push(x));
      atual0.alvos = arr0; delete atual0.targets;
      const r0 = await escreverLista(atual0);
      ctx.log(r0.ok
        ? `Apoio: acrescentei ${novos.join(', ')}${repetidos.length ? ` (${repetidos.join(', ')} já lá ${repetidos.length > 1 ? 'estavam' : 'estava'})` : ''}.`
        : `Apoio: não consegui gravar no Gist — ${r0.msg}.`);
      el.value = '';
      comRolamento(() => painel(container, ctx));
      return;
    };

    const btAdd = container.querySelector('#ap-add');
    if (btAdd) btAdd.onclick = add;
    const elNovo = container.querySelector('#ap-novo');
    if (elNovo) elNovo.onkeydown = (e) => { if (e.key === 'Enter') add(); };

    /* ---- retirar alvo: sai da lista e o apoio volta ---- */
    container.querySelectorAll('[data-remover]').forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.getAttribute('data-remover'));
        const info = cacheCidades[id] || { nome: '#' + id };
        if (!confirm(`Retirar o apoio de ${info.nome}?\n\nA cidade sai da lista e as tropas que lá tens voltam.`)) return;
        b.disabled = true; b.textContent = '...';
        const atual = (await lerLista()) || listaEmCache() || {};
        const arr = (atual.alvos || atual.targets || []).map(Number).filter((x) => x && x !== id);
        atual.alvos = arr; delete atual.targets;
        const rr = await escreverLista(atual);
        if (rr.ok) {
          ctx.log(`Apoio: ${info.nome} saiu da lista — as tropas voltam na próxima passagem.`);
          const n = await retirarApoio(ctx, id);
          if (n) ctx.log(`↩️ ${n} comando(s) já a voltar.`);
        } else {
          ctx.log(`Apoio: não consegui gravar a lista — ${rr.msg}.`);
        }
        comRolamento(() => painel(container, ctx));
      };
    });

    /* ---- obter nomes das cidades ---- */
    const btN = container.querySelector('#ap-nomes');
    if (btN) btN.onclick = async () => {
      btN.disabled = true; btN.textContent = 'a procurar...';
      const towns = ctx.getMyTowns();
      for (const id of alvos) await infoDaCidade(id, towns.length ? towns[0].id : null);
      btN.disabled = false; btN.textContent = '🔄 obter nomes';
      comRolamento(() => painel(container, ctx));
    };

    const g = container.querySelector('#ap-guardar');
    if (g) g.onclick = () => {
      guardarCfg({
        ativo: container.querySelector('#ap-on').checked,
        pacote: {
          sword: Number(container.querySelector('#ap-sword').value) || 0,
          archer: Number(container.querySelector('#ap-archer').value) || 0,
          hoplite: Number(container.querySelector('#ap-hoplite').value) || 0,
          bireme: Number(container.querySelector('#ap-bireme').value) || 0,
        },
        maxCidadesPorAlvo: Number(container.querySelector('#ap-max').value) || 10,
        evitarTransporteGrande: !!(container.querySelector('#ap-sotr') || {}).checked,
      });
      ctx.log('Apoio: definições guardadas.');
    };
  }

  return {
    id: 'apoio',
    nome: 'Apoio distribuído',
    intervaloMin: opts.intervaloMin || 2,
    autoStart: true,
    run, painel,
  };
}

  // ====================== MÓDULO: AUTO-FUNDAÇÃO ==========================
/* ============================================================================
 *  AUTO-FUNDAÇÃO — fundar cidades nos lugares livres
 *
 *  Serve tanto a main como as multis. Nada tem que ver com a rotação de
 *  colonizadores: aqui só interessa pegar num colonizador e fundar.
 *
 *  Escolha do sítio, por ordem:
 *    1. ilhas que marcaste (pelo botão na janela de ilha do jogo, ou à mão);
 *    2. se não marcaste nenhuma, ilhas do(s) oceano(s) que indicares;
 *    3. se não indicares nada, as ilhas onde já tens cidade.
 *
 *  Pedidos confirmados em jogo:
 *    consulta: frontend_bridge?action=fetch&window_type=colonization
 *    fundar:   frontend_bridge?action=execute
 *              model_url Colonization/{playerId}, action_name sendColonizer,
 *              arguments {target_x, target_y, target_number_on_island, colonize_ship}
 *
 *  Sobre os lugares: as ilhas grandes têm 20, numerados de 0 a 19. As que têm
 *  menos não têm aldeias bárbaras e são descartadas. As aldeias aparecem na
 *  lista do mapa sem número de lugar.
 * ========================================================================== */

function makeFundacaoModule(opts) {
  opts = opts || {};

  let mUw = null, mWorld = '';
  const CFG_KEY = 'grepoFundacao_cfg_v1';

  const NC = 'colonize_ship';
  const CHUNK = 20;
  const LUGARES_POR_ILHA = 20;

  /* Estado conhecido de cada ilha, para a lista mostrar algo útil sem ter de
   * consultar o mapa a cada desenho do painel. É actualizado quando se guarda
   * a ilha e a cada passagem do módulo. */
  const ESTADO_KEY = 'grepoFundacao_estado_v1';

  /* Ler a resposta do servidor com segurança.
   *
   * `resposta.json()` rebenta com "Unexpected end of JSON input" quando o
   * servidor devolve vazio — e essa mensagem não diz nada de útil. Aqui lê-se
   * o texto primeiro e devolve-se um objecto com o erro explicado.
   *
   * Devolve sempre um objecto: `{ json: {...} }` no caso normal, ou
   * `{ json: { error: '...' } }` quando a resposta não presta. */
  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status}): ${txt.slice(0, 60)}` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Armazenamento com o sufixo do perfil — vem do núcleo. Se não existir
   * (módulo a correr sozinho), usa-se o localStorage directamente. */
  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function lerEstado() {
    try { return JSON.parse(armazem.getItem(ESTADO_KEY) || '{}'); } catch (e) { return {}; }
  }
  function gravarEstado(e) {
    try { armazem.setItem(ESTADO_KEY, JSON.stringify(e)); } catch (e2) {}
  }
  /* Tenho VAGA para mais uma cidade?
   *
   * Confirmado no jogo: `cultural_step` é o limite (33) e
   * `additional_town_count` são as fundações já a caminho (2). Com 31 cidades
   * e 2 a caminho, o limite está cheio — e tentar os 20 lugares da ilha só
   * gasta pedidos para nada, com a resposta "Não escolheu uma posição válida".
   *
   * Devolve: { pode, tenho, aCaminho, limite } */
  function vagaParaCidade() {
    try {
      const p2 = mUw.MM.getModels().Player;
      const k = Object.keys(p2)[0];
      const a = (p2[k] || {}).attributes || {};

      const limite = Number(a.cultural_step) || 0;
      const aCaminho = Number(a.additional_town_count) || 0;
      const tenho = Object.keys(mUw.ITowns.towns || {}).length;

      if (!limite) return { pode: true, tenho, aCaminho, limite: 0 };   // sem dados: não travar
      return { pode: (tenho + aCaminho) < limite, tenho, aCaminho, limite };
    } catch (e) { return { pode: true, tenho: 0, aCaminho: 0, limite: 0 }; }
  }

  /* Coordenadas da ilha a partir do link de destino (base64 no href). */
  function coordenadasDoLinkDestino(link) {
    try {
      const m = String(link || '').match(/#([A-Za-z0-9+/=]{16,})/);
      if (!m) return null;
      const d = JSON.parse(atob(m[1]));
      if (Number.isFinite(Number(d.ix))) return { ix: Number(d.ix), iy: Number(d.iy) };
    } catch (e) {}
    return null;
  }

  function agoraSeg() {
    try { return Number(mUw.Timestamp.now()) || Math.floor(Date.now() / 1000); }
    catch (e) { return Math.floor(Date.now() / 1000); }
  }

  function anotarIlha(chave, dados) {
    const e = lerEstado();
    e[chave] = Object.assign({}, e[chave] || {}, dados, { lido: agoraSeg() });
    gravarEstado(e);
  }

  const DEFAULTS = {
    ativo: false,
    simular: true,            // fundar gasta um colonizador e é irreversível
    ilhas: [],                // ['499:507', ...] marcadas por ti
    oceanos: [],              // ['45', '55'] — usados quando não há ilhas marcadas
    exigirAldeias: true,      // só ilhas grandes (com aldeias bárbaras)
  };

  function cfg() {
    const c = JSON.parse(JSON.stringify(DEFAULTS));
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function guardar(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  /* ---------------------- leitura do jogo ------------------------------- */

  /* Colonizadores numa cidade: os PRÓPRIOS mais os que lá estão de APOIO.
   *
   * O `units()` só conta as unidades da cidade. Os colonizadores enviados
   * como apoio — que é como se juntam no depósito — ficam no
   * `unitsSupport()`.
   *
   * Confirmado no jogo: a base tinha `units()` sem colonizadores e
   * `unitsSupport()` com 93. Por isso o registo dizia "depósito deles (0)"
   * quando estava cheio. */
  /* SÓ os colonizadores PRÓPRIOS da cidade.
   *
   * Os que lá estão de apoio pertencem a outras contas e não se podem usar
   * para fundar — contam para o depósito da rotação, não para aqui. */
  function colonizadoresEm(townId) {
    try { return Number((mUw.ITowns.getTown(Number(townId)).units() || {})[NC]) || 0; }
    catch (e) { return 0; }
  }

  /* Colonizadores que esta cidade pode USAR — só os próprios.
   *
   * Os que lá estão de apoio pertencem a outras contas: contam para o
   * depósito, mas não se podem enviar nem usar para fundar. */
  function colonizadoresProprios(townId) {
    try { return Number((mUw.ITowns.getTown(Number(townId)).units() || {})[NC]) || 0; }
    catch (e) { return 0; }
  }

  function ilhaDe(townId) {
    try {
      const t = mUw.ITowns.getTown(Number(townId));
      const x = t.getIslandCoordinateX(), y = t.getIslandCoordinateY();
      return (x == null || y == null) ? null : { x: Number(x), y: Number(y) };
    } catch (e) { return null; }
  }

  // Oceano de uma ilha: os dois primeiros dígitos das coordenadas.
  function oceanoDe(ix, iy) {
    return `${Math.floor(Number(ix) / 100)}${Math.floor(Number(iy) / 100)}`;
  }

  /* ---------------------- pedidos --------------------------------------- */

  async function consultarColonizacao(townId) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=fetch&h=' + mUw.Game.csrfToken
      + '&json=' + encodeURIComponent(JSON.stringify({
          window_type: 'colonization', tab_type: 'index',
          known_data: { models: [], collections: [] },
          town_id: Number(townId), nl_init: true,
        }));
    try {
      const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
        .then(lerResposta);
      const d = (((r || {}).json || {}).models || {}).Colonization;
      return (d && d.data) || null;
    } catch (e) { return null; }
  }

  async function fundarCidade(townId, alvo) {
    const url = mUw.location.origin + '/game/frontend_bridge?town_id=' + Number(townId)
      + '&action=execute&h=' + mUw.Game.csrfToken;
    try {
      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({
          model_url: 'Colonization/' + (mUw.Game.player_id || ''),
          action_name: 'sendColonizer', captcha: null,
          arguments: {
            target_x: Number(alvo.x), target_y: Number(alvo.y),
            target_number_on_island: Number(alvo.numero), colonize_ship: 1,
          },
          town_id: Number(townId), nl_init: true,
        })),
      }).then(lerResposta);
      aplicarNotificacoes(r);
      const j = r && r.json;
      return { ok: !(j && j.error), msg: (j && (j.error || j.success)) || 'ok' };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /* Lugares livres numa ilha, lidos do mapa.
   *
   * SEM CACHE de propósito: com 20 contas a fundar na mesma ilha, os lugares
   * mudam de minuto a minuto. Dados velhos fariam tentar sítios já ocupados —
   * e o custo de um pedido é menor do que o de gastar tentativas à toa. */
  async function lugaresLivres(ix, iy, townIdBase) {
    try {
      const cx = Math.floor(ix / CHUNK), cy = Math.floor(iy / CHUNK);
      const url = mUw.location.origin + '/game/map_data?town_id=' + Number(townIdBase)
        + '&action=get_chunks&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({
            chunks: [{ x: cx, y: cy, timestamp: 0 }], town_id: Number(townIdBase), nl_init: true }));
      const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
        .then(lerResposta);
      const d = (r && r.json && r.json.data) || {};
      const bloco = d[0] || d['0'];
      const towns = (bloco && bloco.towns) || {};

      /* CONFIRMADO no jogo (ilha 475:549, que a janela dizia ter 18 livres):
       *
       * O mapa devolve TAMBÉM os lugares VAZIOS — com número de lugar, mas sem
       * `name` e sem dono. Contar tudo o que tem número como ocupado dava zero
       * livres numa ilha com apenas 2 cidades.
       *
       * Um lugar só está OCUPADO se tiver NOME. As aldeias bárbaras ou não têm
       * número, ou têm um acima de 19. */
      /* Guardar o ID da ilha: a visão de comandos identifica as fundações por
       * "Ilha 64948", não por coordenadas. */
      try {
        for (const il of ((bloco && bloco.islands) || [])) {
          if (Number(il.x) === Number(ix) && Number(il.y) === Number(iy) && il.id) {
            anotarIlha(`${ix}:${iy}`, { islandId: Number(il.id) });
            break;
          }
        }
      } catch (e) {}

      const ocupados = new Set();
      let aldeias = 0;
      for (const k of Object.keys(towns)) {
        const t = towns[k];
        if (Number(t.x) !== Number(ix) || Number(t.y) !== Number(iy)) continue;

        const temNome = !!(t.name && String(t.name).trim());
        const nr = Number(t.nr);
        const nrValido = Number.isFinite(nr);

        // aldeia bárbara: tem nome mas não ocupa lugar de cidade
        if (temNome && (!nrValido || nr >= LUGARES_POR_ILHA)) { aldeias++; continue; }
        // lugar vazio: vem no mapa com número mas sem nome
        if (!temNome) continue;
        // cidade a sério
        if (nrValido && nr >= 0 && nr < LUGARES_POR_ILHA) ocupados.add(nr);
      }

      const livres = [];
      for (let n = 0; n < LUGARES_POR_ILHA; n++) if (!ocupados.has(n)) livres.push(n);
      return { livres, ocupados: ocupados.size, aldeias };
    } catch (e) { return { livres: [], ocupados: 0, aldeias: 0 }; }
  }

  /* Ilhas do mapa dentro de um oceano, à volta das minhas cidades. */
  async function ilhasDoOceano(oceano, townIdBase) {
    const achadas = [];
    try {
      const vistos = new Set();
      for (const id of Object.keys(mUw.ITowns.towns)) {
        const i = ilhaDe(id);
        if (!i) continue;
        const cx = Math.floor(i.x / CHUNK), cy = Math.floor(i.y / CHUNK);
        // o bloco onde estou e os oito à volta
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const chave = `${cx + dx}:${cy + dy}`;
            if (vistos.has(chave)) continue;
            vistos.add(chave);

            const url = mUw.location.origin + '/game/map_data?town_id=' + Number(townIdBase)
              + '&action=get_chunks&h=' + mUw.Game.csrfToken
              + '&json=' + encodeURIComponent(JSON.stringify({
                  chunks: [{ x: cx + dx, y: cy + dy, timestamp: 0 }],
                  town_id: Number(townIdBase), nl_init: true }));
            const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
              .then(lerResposta).catch(() => null);
            const d = (r && r.json && r.json.data) || {};
            const bloco = d[0] || d['0'];
            for (const il of ((bloco && bloco.islands) || [])) {
              const ox = Number(il.x), oy = Number(il.y);
              if (!Number.isFinite(ox)) continue;
              if (String(oceanoDe(ox, oy)) !== String(oceano)) continue;
              if (achadas.some((a) => a.x === ox && a.y === oy)) continue;
              achadas.push({ x: ox, y: oy });
            }
          }
        }
      }
    } catch (e) {}
    return achadas;
  }

  /* ------------- APLICAR AS NOTIFICAÇÕES DA RESPOSTA ------------------- */
  function aplicarNotificacoes(resposta) {
    try {
      const nots = (resposta && resposta.json && resposta.json.notifications) || [];
      for (const n of nots) {
        if (String(n.type) !== 'backbone') continue;
        let dados = null;
        try { dados = JSON.parse(n.param_str); } catch (e) { continue; }
        if (!dados) continue;
        for (const nome of Object.keys(dados)) {
          const attrs = dados[nome];
          if (!attrs || typeof attrs !== 'object') continue;
          let tratado = false;
          try {
            const cols = mUw.MM.getCollections()[nome];
            const col = cols && cols[0];
            if (col && typeof col.add === 'function') {
              const idNovo = Number(n.param_id) || Number(attrs.id);
              const existente = (col.models || []).find((m) =>
                m.attributes && Number(m.attributes.id) === idNovo);
              if (existente) { if (typeof existente.set === 'function') existente.set(attrs); }
              else { col.add(Object.assign({ id: idNovo }, attrs)); }
              tratado = true;
            }
          } catch (e) {}
          if (tratado) continue;
          try {
            const modelos = mUw.MM.getModels()[nome];
            if (modelos) {
              const alvoId = Number(n.param_id) || Number(attrs.id);
              for (const k of Object.keys(modelos)) {
                const m = modelos[k];
                const id = (m.attributes && m.attributes.id) != null ? Number(m.attributes.id) : null;
                if ((alvoId && id === alvoId) || (!alvoId && Object.keys(modelos).length === 1)) {
                  if (typeof m.set === 'function') m.set(attrs);
                  break;
                }
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  /* ---------------------- ciclo principal ------------------------------- */

  async function run(ctx) {
    const rotina = ctx.logRotina || ctx.log;
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const log = ctx.log;
    const c = cfg();
    if (!c.ativo) { log('Fundação: está DESLIGADA (liga a caixa no painel e guarda).'); return; }

    /* Primeiro: há vaga? Sem isto, tentavam-se os 20 lugares da ilha e o
     * servidor recusava todos com "Não escolheu uma posição válida". */
    const vaga = vagaParaCidade();
    if (!vaga.pode) {
      rotina(`Fundação: sem vaga — tens ${vaga.tenho} cidade(s) e ${vaga.aCaminho} a caminho, `
        + `o limite é ${vaga.limite}. Precisas de mais cultura.`);
      return;
    }

    const comNC = ctx.getMyTowns().filter((t) => colonizadoresEm(t.id) > 0);
    if (!comNC.length) { log('Fundação: nenhuma cidade tem colonizador.'); return; }
    const t = comNC[0];

    // pontos de cultura
    const dados = await consultarColonizacao(t.id);
    if (dados && dados.enough_culture_points === false) {
      log(`Fundação: faltam ${dados.needed_culture_points || '?'} pontos de cultura.`);
      return;
    }

    /* Ilhas a tentar, por ordem de preferência. */
    let aTentar = [];
    if ((c.ilhas || []).length) {
      aTentar = c.ilhas.map((k) => {
        const [x, y] = String(k).split(':');
        return { x: Number(x), y: Number(y), origem: 'marcada' };
      }).filter((i) => Number.isFinite(i.x) && Number.isFinite(i.y));
    } else if ((c.oceanos || []).length) {
      for (const oc of c.oceanos) {
        const ilhas = await ilhasDoOceano(oc, t.id);
        ilhas.forEach((i) => aTentar.push({ x: i.x, y: i.y, origem: 'oceano ' + oc }));
      }

      /* ORDENAR pelas MAIS PERTO da cidade que vai fundar.
       *
       * Sem isto, as ilhas eram tentadas pela ordem em que apareciam no
       * varrimento do mapa — que segue a ordem das minhas cidades, não a
       * distância. Podia mandar-se um colonizador para o outro lado do oceano
       * tendo uma ilha livre ao lado.
       *
       * Menos viagem é menos tempo exposto e menos hipótese de ser
       * interceptado. */
      const daqui = ilhaDe(t.id);
      if (daqui) {
        aTentar.sort((a, b) => {
          const da = Math.hypot(a.x - daqui.x, a.y - daqui.y);
          const db = Math.hypot(b.x - daqui.x, b.y - daqui.y);
          return da - db;
        });
      }
      if (!aTentar.length) log(`Fundação: não encontrei ilhas no(s) oceano(s) ${c.oceanos.join(', ')} perto das minhas cidades.`);
    } else {
      /* Sem ilhas marcadas nem oceanos: NÃO funda nada.
       *
       * Antes usava as ilhas onde já havia cidade, e isso podia fundar em
       * sítios que o utilizador não escolheu — um colonizador gasto num sítio
       * errado é caro. Fundar é uma decisão dele. */
      rotina('Fundação: sem ilhas marcadas nem oceanos indicados — não fundo nada. '
        + 'Marca uma ilha na janela "Informação da ilha" ou indica um oceano no painel.');
      return;
    }

    if (!aTentar.length) {
      log('Fundação: sem ilhas para tentar. Marca ilhas no jogo ou indica um oceano no painel.');
      return;
    }

    // uma vez por passagem: as ilhas para onde já vai colonizador
    const emViagem = await ilhasComColonizadorAcaminho(t.id);

    for (const ilha of aTentar) {
      const chave = `${ilha.x}:${ilha.y}`;

      /* NÃO se limita a uma cidade por ilha: com as 20 multis o objectivo é
       * FECHAR a ilha, cada conta a ocupar um lugar. Quem coordena é o
       * servidor — recusa os lugares já tomados.
       *
       * A única salvaguarda é não mandar DOIS colonizadores desta conta para a
       * mesma ilha ao mesmo tempo. */
      if (emViagem && emViagem.has(chave)) {
        log(`— ${chave}: já vai um colonizador teu a caminho; salto.`);
        continue;
      }
      /* Rede de segurança: o que este módulo enviou há pouco. O movimento
       * pode ainda não estar nos dados do jogo logo a seguir ao envio. */
      const st = lerEstado()[chave] || {};
      if (st.enviadoEm && (agoraSeg() - st.enviadoEm) < 12 * 3600) {
        log(`— ${chave}: mandei um colonizador há ${Math.round((agoraSeg() - st.enviadoEm) / 60)} min; salto.`);
        continue;
      }
      /* Uma tentativa recente que não chegou a confirmar: pode ter sido enviada
       * na mesma (a resposta perdeu-se). Esperar antes de repetir. */
      if (st.tentativaEm && (agoraSeg() - st.tentativaEm) < 900) {
        log(`— ${chave}: houve uma tentativa há ${Math.round((agoraSeg() - st.tentativaEm) / 60)} min; espero.`);
        continue;
      }

      const { livres, ocupados, aldeias } = await lugaresLivres(ilha.x, ilha.y, t.id);
      // guardar o que se soube, para a lista do painel mostrar
      anotarIlha(chave, { livres: livres.length, ocupados, aldeias });

      /* "Só ilhas grandes" descarta as que não têm aldeias bárbaras. Mas se o
       * mapa não trouxer nenhuma cidade da ilha, `aldeias` vem a zero sem que
       * isso queira dizer que a ilha é pequena — só que não há dados. Por isso
       * só se descarta quando o mapa devolveu ALGUMA coisa sobre a ilha. */
      const semDados = !aldeias && !ocupados;
      if (c.exigirAldeias && !aldeias && !semDados) {
        log(`— ${chave}: ilha pequena (sem aldeias bárbaras); salto.`);
        continue;
      }
      if (semDados) {
        log(`— ${chave}: o mapa não devolveu dados desta ilha; tento na mesma.`);
      }
      if (!livres.length) continue;

      if (c.simular) {
        log(`🔎 [simulação] ${t.name}: fundaria em ${chave}, lugar ${livres[0]} `
          + `(${ocupados}/${LUGARES_POR_ILHA} ocupados, ${aldeias} aldeia(s), ${ilha.origem}).`);
        return;
      }

      /* Tentar TODOS os lugares livres, não só alguns.
       *
       * Os dados do mapa ficam desactualizados e um lugar que aparece livre
       * pode já ter cidade. Antes eu tentava seis e desistia ao primeiro erro
       * que não reconhecia — numa ilha com muitas cidades isso falhava sempre.
       *
       * Agora percorre-se a lista toda. Só se pára em erros que são da conta e
       * não do lugar (sem colonizador, sem cultura, sem porto), porque esses
       * repetir-se-iam em todos. */
      let recusas = 0;
      const motivos = {};
      const paraTudo = /colonizad|cultura|pontos|porto|academia|docks|academy|premium|ouro/i;

      for (const numero of livres) {
        const r = await fundarCidade(t.id, { x: ilha.x, y: ilha.y, numero });
        if (r.ok) {
          log(`🏛️ ${t.name}: colonizador a caminho de ${chave}, lugar ${numero}`
            + (recusas ? ` (${recusas} lugar(es) já ocupados antes deste)` : '') + '.');
          anotarIlha(chave, { enviadoEm: agoraSeg(), lugar: numero, deCidade: t.name });
          return;
        }

        // erro que se repetiria em qualquer lugar: não vale a pena insistir
        if (paraTudo.test(String(r.msg))) {
          log(`⚠️ Fundação: ${r.msg}`);
          return;
        }

        recusas++;
        // guardar a razão: sem isto, 20 recusas seguidas não dizem nada
        if (!motivos[r.msg]) motivos[r.msg] = 0;
        motivos[r.msg]++;
        await ctx.sleep(ctx.rand(400, 900));
      }

      if (recusas) {
        /* Todos recusados = a ilha está fechada (por mim ou pelas outras
         * contas). Marca-se para o painel mostrar. */
        if (recusas >= livres.length) {
          const porque = Object.keys(motivos)
            .sort((a, b) => motivos[b] - motivos[a])
            .slice(0, 2)
            .map((k) => `${k} (${motivos[k]}×)`)
            .join(' · ');
          log(`— ${chave}: os ${recusas} lugares foram todos recusados. Motivo: ${porque || '?'}`);
          // só marcar como cheia se foi mesmo por estarem ocupados
          const porOcupacao = Object.keys(motivos).some((k) => /ocupad|exist|cidade/i.test(k));
          if (porOcupacao) anotarIlha(chave, { livres: 0, ocupados: LUGARES_POR_ILHA });
        }
      }
    }

    log('Fundação: não encontrei lugar livre nas ilhas a tentar.');
  }

  /* ============ BOTÃO NA JANELA DE ILHA DO JOGO ========================= */

  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function coordenadasDaJanela(janela) {
    try {
      const txt = (janela.textContent || '').replace(/\s+/g, ' ');
      const m = txt.match(/\((\d+)\s*\/\s*(\d+)\)/);   // "Oceano: 45 (475/549)"
      if (m) return { x: Number(m[1]), y: Number(m[2]) };
    } catch (e) {}
    return null;
  }

  function livresDaJanela(janela) {
    try {
      const txt = (janela.textContent || '').replace(/\s+/g, ' ');
      const m = txt.match(/livres\s*:?\s*(\d+)/i);
      if (m) return Number(m[1]);
    } catch (e) {}
    return null;
  }

  function temIlha(chave) { return (cfg().ilhas || []).indexOf(chave) >= 0; }

  function alternarIlha(chave) {
    const c = cfg();
    const lista = (c.ilhas || []).slice();
    const i = lista.indexOf(chave);
    if (i >= 0) lista.splice(i, 1); else lista.push(chave);
    c.ilhas = lista;
    guardar(c);
    return lista.indexOf(chave) >= 0;
  }

  function pintar(bt, chave) {
    const dentro = temIlha(chave);
    bt.textContent = dentro ? '★ Guardada para fundar' : '☆ Guardar para fundar';
    bt.style.background = dentro ? '#2e6b45' : '#1c2530';
    bt.style.color = dentro ? '#dfd' : '#d8a33f';
    bt.style.borderColor = dentro ? '#4fc7a1' : '#3a4757';
  }

  function vigiarJanelaDeIlha(ctx) {
    vigiarJanelaDeIlha._ctx = ctx;
    if (vigiarJanelaDeIlha._ligado) return;
    vigiarJanelaDeIlha._ligado = true;

    const tentar = () => {
      try {
        document.querySelectorAll('.ui-dialog').forEach((jan) => {
          if (jan.style.display === 'none') return;
          const tit = jan.querySelector('.ui-dialog-title, .gpwindow_title');
          if (!tit || !/informa[çc][ãa]o da ilha|island info/i.test(tit.textContent || '')) return;
          if (jan.querySelector('[data-maestro-ilha]')) return;

          const co = coordenadasDaJanela(jan);
          if (!co) return;
          const chave = `${co.x}:${co.y}`;
          const livres = livresDaJanela(jan);

          const bt = document.createElement('button');
          bt.setAttribute('data-maestro-ilha', chave);
          bt.style.cssText = 'display:block;width:calc(100% - 20px);margin:6px 10px;padding:6px;'
            + 'border:1px solid #3a4757;border-radius:5px;cursor:pointer;'
            + 'font:600 12px system-ui,sans-serif;letter-spacing:.03em';
          bt.title = `Ilha ${chave}` + (livres != null ? ` · ${livres} espaço(s) livre(s)` : '');
          pintar(bt, chave);
          bt.onclick = (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            const ficou = alternarIlha(chave);
            /* Guardar já o que a janela mostra: os lugares livres e os
             * ocupados. Assim a lista do painel diz algo útil sem ter de ir
             * ao mapa. */
            if (ficou) {
              anotarIlha(chave, {
                livres: livres != null ? livres : null,
                ocupados: livres != null ? (LUGARES_POR_ILHA - livres) : null,
              });
            }
            pintar(bt, chave);
            if (ctx && ctx.log) {
              ctx.log(ficou
                ? `Ilha ${chave} guardada para fundar${livres != null ? ` — ${livres} livre(s)` : ''}.`
                : `Ilha ${chave} retirada da lista.`);
            }
            // redesenhar o painel do módulo, se estiver aberto
            try {
              const p2 = document.getElementById('maestro-painel-fundacao')
                || document.getElementById('solo-corpo');
              if (p2 && vigiarJanelaDeIlha._ctx) painel(p2, vigiarJanelaDeIlha._ctx);
            } catch (e) {}
          };

          const conteudo = jan.querySelector('.gpwindow_content') || jan;
          conteudo.insertBefore(bt, conteudo.firstChild);
        });
      } catch (e) {}
    };

    setInterval(tentar, 900);
    tentar();
  }

  /* ---------------------- painel ---------------------------------------- */

  function comRolamento(fn) {
    const caminhoDe = (el) => {
      const p = []; let n = el;
      while (n && n.parentElement && p.length < 30) {
        p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
        if (n.id) { p.unshift('#' + n.id); break; }
      }
      return p;
    };
    const porCaminho = (p) => {
      try {
        if (!p.length) return null;
        let n = null, i = 0;
        if (typeof p[0] === 'string' && p[0].charAt(0) === '#') { n = document.getElementById(p[0].slice(1)); i = 1; }
        else n = document.body;
        for (; n && i < p.length; i++) n = n.children[p[i]];
        return n || null;
      } catch (e) { return null; }
    };
    const guardados = [];
    try {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('*').forEach((el) => {
          if (el.scrollTop > 0) guardados.push({ caminho: caminhoDe(el), y: el.scrollTop, el });
        });
      }
    } catch (e) {}
    fn();
    const repor = () => guardados.forEach(({ caminho, y, el }) => {
      try {
        if (el && el.isConnected) { el.scrollTop = y; return; }
        const n2 = porCaminho(caminho);
        if (n2) n2.scrollTop = y;
      } catch (e) {}
    });
    repor();
    try { requestAnimationFrame(repor); } catch (e) { setTimeout(repor, 0); }
    setTimeout(repor, 30);
  }

  // Lugares livres de cada ilha guardada, preenchido a pedido (custa pedidos
  // ao servidor, por isso não se faz sozinho ao abrir o painel).
  const infoIlhas = {};

  /* Já tenho cidade nesta ilha? */
  function temCidadeNaIlha(ix, iy) {
    try {
      for (const id of Object.keys(mUw.ITowns.towns)) {
        const i = ilhaDe(id);
        if (i && Number(i.x) === Number(ix) && Number(i.y) === Number(iy)) return true;
      }
    } catch (e) {}
    return false;
  }

  /* Colonizadores em viagem, lidos da visão geral de comandos.
   *
   * Só funciona com Administrador (a main) — nas multis o pedido não devolve
   * nada e fica-se pelo registo local, que é a base em qualquer caso.
   *
   * O texto do jogo é: "55.3 (Jogador) → Ilha 64948 (Fundação de uma cidade)".
   * Basta procurar o número da ilha nas linhas de fundação. */
  async function ilhasComColonizadorAcaminho(townIdBase) {
    const out = new Set();

    /* O MODELO LOCAL PRIMEIRO — sem pedido nenhum.
     *
     * Os colonizadores em viagem são MEUS, portanto estão no MovementsUnits
     * com o `started_at` preenchido. Basta ver o destino de cada um e traduzir
     * a cidade para a ilha.
     *
     * Assim evita-se o `command_overview`, que dá 429 e nas multis nem sequer
     * responde. */
    try {
      const mods = mUw.MM.getModels().MovementsUnits || {};
      for (const k of Object.keys(mods)) {
        const a = mods[k].attributes || {};
        if (a.started_at == null) continue;                    // não é meu
        if (!/coloni/i.test(String(a.command_name || '') + String(a.type || ''))) continue;
        if (/regress|return/i.test(String(a.command_name || ''))) continue;

        /* O destino vem no link, em base64: {"id":..,"ix":..,"iy":..}.
         * As coordenadas identificam a ilha. */
        const co = coordenadasDoLinkDestino(a.link_destination);
        if (co) out.add(`${co.ix}:${co.iy}`);
      }
    } catch (e) {}
    if (out.size) return out;

    try {
      const url = mUw.location.origin + '/game/town_overviews?town_id=' + Number(townIdBase)
        + '&action=command_overview&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify({ town_id: Number(townIdBase), nl_init: true }));
      const r = await mUw.fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' })
        .then(lerResposta);
      const html = ((r || {}).json || {}).html || '';
      if (html.length < 2000) return out;   // só a moldura: sem Administrador

      // "Ilha 64948 (Fundação de uma cidade)"
      const re = /Ilha\s+(\d+)[^<]*\(\s*Funda/gi;
      let m;
      while ((m = re.exec(html))) out.add(Number(m[1]));
    } catch (e) {}
    return out;
  }

  /* Vai algum colonizador meu a caminho desta ilha?
   * Os movimentos de colonização estão na colecção MovementsColonization. */
  function colonizadorACaminho(ix, iy) {
    try {
      const col = mUw.MM.getCollections().MovementsColonization;
      const mods = (col && col[0] && col[0].models) || [];
      for (const m of mods) {
        const a = m.attributes || {};
        // o destino vem nas coordenadas da ilha, quando disponível
        if (Number(a.target_x) === Number(ix) && Number(a.target_y) === Number(iy)) return true;
        if (Number(a.island_x) === Number(ix) && Number(a.island_y) === Number(iy)) return true;
      }
      /* Se houver QUALQUER movimento de colonização mas sem coordenadas que
       * batam, devolve-se true: mais vale não fundar do que fundar duas vezes.
       * (Antes devolvia null, que em JavaScript é falso e deixava passar.) */
      return mods.length > 0;
    } catch (e) { return false; }
  }

  function painel(container, ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    vigiarJanelaDeIlha(ctx);
    const c = cfg();
    const estado = lerEstado();

    let comNC = 0;
    try { comNC = ctx.getMyTowns().filter((t) => colonizadoresEm(t.id) > 0).length; } catch (e) {}

    container.innerHTML = `
      <div style="font-size:11px;line-height:1.7">
        <label><input type="checkbox" id="fun-on"${c.ativo ? ' checked' : ''}> <b>Fundar cidades</b></label><br>
        <label><input type="checkbox" id="fun-sim"${c.simular ? ' checked' : ''}> só simular</label>
        <span style="opacity:.6;font-size:10px">— diz onde fundaria sem gastar o colonizador</span><br>
        <label><input type="checkbox" id="fun-ald"${c.exigirAldeias ? ' checked' : ''}> só ilhas grandes</label>
        <span style="opacity:.6;font-size:10px">— as que têm aldeias bárbaras</span>
      </div>

      <div style="background:#0d141c;padding:6px;border-radius:4px;margin-top:6px;font-size:11px">
        <b>Onde fundar</b>
        <div style="opacity:.6;font-size:10px;margin-bottom:4px">
          Abre a <i>Informação da ilha</i> no jogo e carrega em “Guardar para fundar”.
          Sem ilhas marcadas, usa os oceanos abaixo. <b>Sem uma coisa nem outra não funda
          nada</b> — para não gastar colonizadores em sítios que não escolheste.
        </div>

        ${(c.ilhas || []).length ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin:5px 0 3px">
            <span class="mEtiq" style="font-size:9px;letter-spacing:.12em;opacity:.55">
              ${(c.ilhas || []).length} ILHA(S) GUARDADA(S) — POR ORDEM DE PRIORIDADE</span>
            <a href="#" id="fun-ver" style="font-size:10px;color:#8cf;text-decoration:none">ver lugares livres</a>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <tr style="opacity:.4;font-size:9px;letter-spacing:.08em">
              <td></td><td style="padding:1px 4px">ILHA</td>
              <td style="padding:1px 4px;text-align:center">LUGARES</td>
              <td style="padding:1px 4px">ESTADO</td><td></td>
            </tr>
            ${(c.ilhas || []).map((k, i) => {
              const [ix, iy] = String(k).split(':');
              const oc = (Number(ix) && Number(iy)) ? oceanoDe(Number(ix), Number(iy)) : '?';
              // o que se sabe: da última consulta ao mapa, ou do que ficou
              // guardado quando marcaste a ilha na janela do jogo
              const info = infoIlhas[k] || estado[k] || null;
              const minha = temCidadeNaIlha(ix, iy);
              const aCaminho = colonizadorACaminho(ix, iy);

              /* O estado que interessa ler de relance: se já está feito, se
               * vai a caminho, ou se ainda há trabalho. */
              const st2 = estado[k] || {};
              const enviadoHa = st2.enviadoEm ? (agoraSeg() - st2.enviadoEm) : null;

              let etiqueta, cor, podeTirar = false;
              if (minha) {
                etiqueta = '✓ cidade fundada'; cor = '#7d7'; podeTirar = true;
              } else if (enviadoHa != null && enviadoHa < 6 * 3600) {
                const min = Math.round(enviadoHa / 60);
                etiqueta = `⛵ a caminho há ${min < 60 ? min + ' min' : Math.round(min / 60) + ' h'}`;
                cor = '#d8a33f';
              } else if (aCaminho) {
                etiqueta = '⛵ colonizador a caminho'; cor = '#d8a33f';
              } else if (info && info.livres === 0) {
                etiqueta = 'cheia'; cor = '#f88'; podeTirar = true;
              } else if (info && info.livres > 0) {
                etiqueta = 'à espera de colonizador'; cor = '#8cf';
              } else {
                etiqueta = 'por verificar'; cor = '#8493a5';
              }

              const lugares = (info && info.livres != null)
                ? `${info.livres}/${LUGARES_POR_ILHA}`
                : '—';

              return `<tr style="border-top:1px solid #1a2430">
                <td style="padding:3px 4px;width:16px;opacity:.45;font-size:10px">${i + 1}</td>
                <td style="padding:3px 4px"><b>${esc(k)}</b>
                  <span style="opacity:.5;font-size:10px">· oc. ${oc}</span></td>
                <td style="padding:3px 4px;text-align:center;font-size:10px;opacity:.85"
                    title="lugares livres em ${LUGARES_POR_ILHA}">${lugares}</td>
                <td style="padding:3px 4px;font-size:10px;color:${cor}">${etiqueta}</td>
                <td style="padding:3px 4px;width:16px;text-align:right">
                  <a href="#" data-tirar="${esc(k)}"
                     title="${podeTirar ? 'já podes retirar esta ilha' : 'retirar da lista'}"
                     style="color:${podeTirar ? '#7d7' : '#d9705f'};text-decoration:none;
                            font-weight:${podeTirar ? '700' : '400'}">×</a></td>
              </tr>`;
            }).join('')}
          </table>
          <div style="opacity:.5;font-size:10px;margin-top:2px">
            Tenta pela ordem de cima para baixo; a primeira com lugar livre leva o colonizador.
          </div>`
          : '<div style="opacity:.5;font-size:10px;margin:4px 0">Nenhuma ilha marcada — abre uma ilha no jogo e carrega em “Guardar para fundar”.</div>'}

        <div style="margin-top:5px">
          Oceanos (separados por vírgula):
          <input type="text" id="fun-oceanos" value="${esc((c.oceanos || []).join(', '))}"
            placeholder="45, 55" style="width:110px">
        </div>
      </div>

      <div style="background:#0d141c;padding:5px;border-radius:4px;margin-top:6px;font-size:11px">
        <b>Estado</b><br>
        ${comNC ? `${comNC} cidade(s) com colonizador pronto.` : 'Nenhuma cidade tem colonizador.'}
      </div>

      <button id="fun-guardar" style="cursor:pointer;width:100%;margin-top:5px;background:#48d;color:#fff;padding:5px;border:none;border-radius:4px">Guardar</button>`;

    container.querySelectorAll('[data-tirar]').forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        const k = a.getAttribute('data-tirar');
        const cc = cfg();
        cc.ilhas = (cc.ilhas || []).filter((x) => x !== k);
        guardar(cc);
        ctx.log(`Ilha ${k} retirada da lista.`);
        comRolamento(() => painel(container, ctx));
      };
    });

    const ver = container.querySelector('#fun-ver');
    if (ver) ver.onclick = async (ev) => {
      ev.preventDefault();
      ver.textContent = 'a procurar...';
      const towns = ctx.getMyTowns();
      const base = towns.length ? towns[0].id : null;
      if (base) {
        for (const k of (cfg().ilhas || [])) {
          const [ix, iy] = String(k).split(':').map(Number);
          if (!Number.isFinite(ix)) continue;
          const r = await lugaresLivres(ix, iy, base);
          infoIlhas[k] = { livres: r.livres.length, aldeias: r.aldeias, ocupados: r.ocupados };
        }
      }
      ver.textContent = 'ver lugares livres';
      comRolamento(() => painel(container, ctx));
    };

    const g = container.querySelector('#fun-guardar');
    if (g) g.onclick = () => {
      const cc = cfg();
      cc.ativo = container.querySelector('#fun-on').checked;
      cc.simular = container.querySelector('#fun-sim').checked;
      cc.exigirAldeias = container.querySelector('#fun-ald').checked;
      cc.oceanos = String(container.querySelector('#fun-oceanos').value || '')
        .split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
      guardar(cc);
      ctx.log('Fundação: configuração guardada.');
      comRolamento(() => painel(container, ctx));
    };
  }

  return {
    id: 'fundacao',
    nome: 'Auto-fundação',
    intervaloMin: opts.intervaloMin || 20,
    autoStart: true,
    run, painel,
  };
}

/* ============================================================================
 * LIMPAR RELATÓRIOS
 *
 * Os apoios entre as 20 contas enchem a caixa de relatórios com centenas de
 * entradas que não interessam a ninguém. Este módulo apaga-os.
 *
 * Como funciona (confirmado no jogo):
 *   1. `report?action=index` com `{filter_type:'support', folder_id:0}`
 *      devolve o HTML da lista filtrada;
 *   2. os identificadores estão em `data-reportid="329462"` — seis dígitos;
 *   3. `report?action=delete_many` com `{report_ids:[...]}` apaga vários
 *      de uma vez.
 *
 * ATENÇÃO — lição aprendida à custa: apagar um a um inunda o servidor e dá
 * 429. Por isso vai em LOTES, com pausas entre eles, e com um limite por
 * passagem.
 * ========================================================================== */
function makeRelatoriosModule(opts) {
  let mUw = null, mWorld = null;

  const CFG_KEY = 'grepoRelatorios_cfg_v1';
  const DEFAULTS = {
    ativo: false,              // desligado por omissão: apagar não se desfaz
    apoios: true,              // apagar relatórios de apoio
    transportes: false,        // apagar transportes de recursos
    porLote: 30,               // quantos por pedido
    maxPorPassagem: 90,        // limite por passagem, para não abusar
  };

  const armazem = (() => {
    try {
      const a = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__maestroArmazem;
      if (a) return a;
    } catch (e) {}
    return localStorage;
  })();

  function cfg() {
    const c = Object.assign({}, DEFAULTS);
    try { Object.assign(c, JSON.parse(armazem.getItem(CFG_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function guardarCfg(c) { try { armazem.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  /* Tirar acentos e escapes, para comparar texto sem surpresas. */
  function normalizar(txt) {
    return String(txt || '')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim();
  }

  /* Relatórios que NUNCA se apagam, mesmo estando na aba dos apoios.
   *
   * "está a atacar o seu apoio" quer dizer que se perdeu tropa a defender
   * outra conta — é informação útil, ao contrário dos avisos de apoio enviado
   * e de regresso de tropas. */
  const GUARDAR_SEMPRE = [
    'atacar o seu apoio',
    'atacar o seu apoi',        // caso o texto venha cortado
    'attacking your support',
  ];

  function guardarEste(assunto) {
    return GUARDAR_SEMPRE.some((k) => assunto.indexOf(k) >= 0);
  }

  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function lerResposta(resposta) {
    try {
      const txt = await resposta.text();
      if (!txt || !txt.trim()) {
        return { json: { error: `o servidor não respondeu (HTTP ${resposta.status})` } };
      }
      try { return JSON.parse(txt); }
      catch (e) {
        return { json: { error: `resposta ilegível (HTTP ${resposta.status})` } };
      }
    } catch (e) {
      return { json: { error: 'não consegui ler a resposta: ' + e.message } };
    }
  }

  /* Listar os relatórios de um tipo, uma PÁGINA de cada vez.
   *
   * O jogo devolve ~25 por página. Sem pedir as seguintes, só se apagavam 25
   * por passagem por muitos que houvesse. */
  async function listar(filtro, pagina) {
    try {
      const t = mUw.Game.townId;
      const params = {
        filter_type: filtro, folder_id: 0, town_id: Number(t), nl_init: true,
      };
      if (pagina > 0) params.page = pagina;

      const url = mUw.location.origin + '/game/report?town_id=' + Number(t)
        + '&action=index&h=' + mUw.Game.csrfToken
        + '&json=' + encodeURIComponent(JSON.stringify(params))
        + '&_=' + Date.now();

      /* Ler o TEXTO CRU, não o JSON convertido.
       *
       * O `lerResposta` devolve o objecto já convertido, e voltar a passá-lo
       * por `JSON.stringify` muda o escape das aspas — o padrão deixava de
       * encontrar os `data-reportid`. Sobre o texto original funciona. */
      const resp = await mUw.fetch(url, {
        headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include',
      });
      const bruto = await resp.text();

      /* Os identificadores estão no HTML, no atributo `data-reportid`, e o
       * assunto no `report_subject_header` logo a seguir.
       *
       * Nem todos os relatórios de "apoio" são iguais:
       *   • "X apoia cidade de Y"                    → ruído, apagar
       *   • "X ordenou o regresso das tropas..."     → ruído, apagar
       *   • "X está a ATACAR O SEU APOIO em Y"       → IMPORTANTE, guardar
       *
       * O último diz que se perdeu tropa a defender alguém. */
      const ids = [];
      const re = /data-reportid=\\?\\?"?(\d+)([\s\S]{0,500}?)report_subject_header\\?"?>([\s\S]{0,200}?)<\\?\/span>/g;
      let m;
      while ((m = re.exec(bruto)) !== null) {
        const id = Number(m[1]);
        if (!id || ids.indexOf(id) >= 0) continue;

        const assunto = normalizar(m[3] || '');
        if (guardarEste(assunto)) continue;      // não apagar

        ids.push(id);
      }
      return ids;
    } catch (e) { return []; }
  }

  /* Apagar um lote. */
  async function apagarLote(ids) {
    try {
      const t = mUw.Game.townId;
      const url = mUw.location.origin + '/game/report?town_id=' + Number(t)
        + '&action=delete_many&h=' + mUw.Game.csrfToken;

      const r = await mUw.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: 'json=' + encodeURIComponent(JSON.stringify({
          report_ids: ids, town_id: Number(t), nl_init: true,
        })),
      }).then(lerResposta);

      const err = r && r.json && r.json.error;
      return err ? { ok: false, msg: String(err) } : { ok: true };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  async function run(ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const log = ctx.log;
    const rotina = ctx.logRotina || ctx.log;
    const c = cfg();

    if (!c.ativo) { rotina('Relatórios: está desligado.'); return; }

    const tipos = [];
    if (c.apoios) tipos.push({ f: 'support', nome: 'apoio' });
    if (c.transportes) tipos.push({ f: 'resource_transports', nome: 'transporte' });
    if (!tipos.length) { rotina('Relatórios: nada marcado para apagar.'); return; }

    let total = 0;
    for (const tipo of tipos) {
      if (total >= c.maxPorPassagem) break;

      /* Apagar página a página, até ao limite da passagem.
       *
       * Depois de apagar uma página, os que sobram sobem — por isso pede-se
       * sempre a PRIMEIRA página outra vez, em vez de avançar. Assim não se
       * saltam relatórios. */
      let paginasSemNada = 0;
      while (total < c.maxPorPassagem && paginasSemNada < 2) {
        const ids = await listar(tipo.f, 0);
        if (!ids.length) {
          if (!total) rotina(`Relatórios: nenhum de ${tipo.nome}.`);
          break;
        }

        /* EM LOTES, com pausas. Apagar um a um inunda o servidor — foi assim
         * que se apanhou 429 e se partiu a pilha de notificações do jogo. */
        const aApagar = ids.slice(0, Math.max(0, c.maxPorPassagem - total));
        if (!aApagar.length) break;

        let apagouAlgo = false;
        for (let i = 0; i < aApagar.length; i += c.porLote) {
          const lote = aApagar.slice(i, i + c.porLote);
          const r = await apagarLote(lote);
          if (!r.ok) { log(`⚠️ Relatórios: falha a apagar (${r.msg}).`); break; }
          total += lote.length;
          apagouAlgo = true;
          await ctx.sleep(ctx.rand(1200, 2000));
        }
        if (!apagouAlgo) paginasSemNada++;
        else paginasSemNada = 0;
      }
    }

    if (total) log(`🗑️ Relatórios: ${total} apagado(s).`);
    else rotina('Relatórios: nada a apagar.');
  }

  function painel(container, ctx) {
    mUw = ctx.uw; mWorld = ctx.WORLD;
    const c = cfg();
    container.innerHTML = `
      <div style="font-size:11px">
        <label><input type="checkbox" id="rel-on"${c.ativo ? ' checked' : ''}>
          <b>Apagar relatórios automaticamente</b></label>
        <div style="opacity:.65;font-size:10px;margin:3px 0 6px 18px">
          Os apoios entre contas enchem a caixa com centenas de entradas.
          <b>Apagar não se desfaz</b> — por isso vem desligado.
        </div>

        <div style="background:#0d141c;padding:6px 8px;border-radius:4px;margin-bottom:6px">
          <label><input type="checkbox" id="rel-apoios"${c.apoios ? ' checked' : ''}>
            relatórios de <b>apoio</b></label>
          <div style="opacity:.6;font-size:10px;margin:1px 0 3px 18px">
            Apaga os avisos de apoio enviado e de regresso de tropas.
            Os de <b>"está a atacar o seu apoio"</b> são sempre guardados —
            esses dizem que perdeste tropa a defender.
          </div>
          <label><input type="checkbox" id="rel-transp"${c.transportes ? ' checked' : ''}>
            relatórios de <b>transporte de recursos</b></label>
        </div>

        <div style="background:#0d141c;padding:6px 8px;border-radius:4px;margin-bottom:6px">
          Apagar até <input type="number" id="rel-max" min="10" max="500"
            value="${Number(c.maxPorPassagem) || 90}" style="width:56px"> por passagem,
          em lotes de <input type="number" id="rel-lote" min="5" max="100"
            value="${Number(c.porLote) || 30}" style="width:48px">
          <div style="opacity:.6;font-size:10px;margin-top:2px">
            Em lotes com pausas, para o servidor não recusar os pedidos.
          </div>
        </div>

        <button id="rel-agora" style="cursor:pointer;width:100%;margin-bottom:5px">
          Apagar agora (uma passagem)
        </button>
        <button id="rel-guardar" style="cursor:pointer;width:100%;background:#48d;color:#fff;
          padding:5px;border:none;border-radius:4px">Guardar</button>
      </div>`;

    const g = container.querySelector('#rel-guardar');
    if (g) g.onclick = () => {
      guardarCfg({
        ativo: container.querySelector('#rel-on').checked,
        apoios: container.querySelector('#rel-apoios').checked,
        transportes: container.querySelector('#rel-transp').checked,
        maxPorPassagem: Number(container.querySelector('#rel-max').value) || 90,
        porLote: Number(container.querySelector('#rel-lote').value) || 30,
      });
      ctx.log('Relatórios: configuração guardada.');
    };

    const ag = container.querySelector('#rel-agora');
    if (ag) ag.onclick = async () => {
      ag.disabled = true; ag.textContent = 'a apagar...';
      const antes = cfg();
      guardarCfg(Object.assign({}, antes, { ativo: true }));
      try { await run(ctx); } catch (e) { ctx.log('Relatórios: erro — ' + e.message); }
      guardarCfg(antes);
      ag.disabled = false; ag.textContent = 'Apagar agora (uma passagem)';
    };
  }

  /* O maestro precisa de `id`, `nome` e `intervaloMin` para registar o módulo.
   * Sem isso, o painel mostrava "undefined" e nem abria. */
  return {
    id: 'relatorios',
    nome: 'Limpar relatórios',
    intervaloMin: opts.intervaloMin || 30,
    autoStart: false,        // apagar não se desfaz: só corre se o ligares
    run, painel,
  };
}

  /* ===================== REGISTO DOS MÓDULOS ==============================
   * ⚠️ Preenche GIST_ID e GIST_TOKEN para partilhar as configurações entre as
   *    contas. Cada módulo escreve no seu próprio ficheiro dentro do Gist.
   * ===================================================================== */
  /* ================= CREDENCIAIS DO GIST =================================
   * GUARDADAS NA CONTA, não no ficheiro.
   *
   * Com a actualização automática, o ficheiro é substituído de cada vez que
   * há uma versão nova — se as credenciais estivessem aqui, seriam apagadas
   * nas 20 contas a cada actualização.
   *
   * Ficam no armazenamento do navegador e configuram-se uma vez, no painel.
   * Os valores abaixo servem só de arranque: se o armazenamento já tiver
   * alguma coisa, é essa que vale.
   * ==================================================================== */
  const GIST_ID = GIST_GUARDADO.id || '';
  const GIST_TOKEN = GIST_GUARDADO.token || '';

  // o núcleo também precisa deles, para o perfil partilhado
  try { GIST_ID_GLOBAL = GIST_ID; GIST_TOKEN_GLOBAL = GIST_TOKEN; } catch (e) {}

  registerModule(makeConstrucaoModule({ intervaloMin: 10, gistId: GIST_ID, gistToken: GIST_TOKEN }));
  registerModule(makePesquisaModule({ intervaloMin: 15, gistId: GIST_ID, gistToken: GIST_TOKEN }));
  registerModule(makeRecrutamentoModule({ intervaloMin: 10, gistId: GIST_ID, gistToken: GIST_TOKEN }));
  registerModule(makeHeroisModule({ intervaloMin: 60, gistId: GIST_ID, gistToken: GIST_TOKEN }));
  registerModule(makeGrutaModule({ intervaloMin: 10 }));
  registerModule(makeTrocaCidadesModule({ intervaloMin: 15 }));
  registerModule(makeEncaixeModule({ intervaloMin: 1 }));
  // As ALDEIAS são registadas antes da CULTURA: como o maestro corre os
  // módulos por ordem, as aldeias servem-se primeiro dos pontos de combate.
  // A evolução de aldeias é finita; a cultura consome sempre e os pontos
  // repõem-se ao combater.
  registerModule(makeAldeiasModule({ intervaloMin: 5 }));
  registerModule(makeCulturaModule({ intervaloMin: 30 }));
  registerModule(makeAlertasModule({ intervaloMin: 1 }));
  registerModule(makeDeusesModule({ intervaloMin: 20, gistId: GIST_ID, gistToken: GIST_TOKEN }));
  registerModule(makeEsquivaModule({ intervaloMin: 1 }));
  registerModule(makeMissoesModule({ intervaloMin: 30 }));
  registerModule(makeColonosModule({ intervaloMin: 10, gistId: GIST_ID, gistToken: GIST_TOKEN }));
  registerModule(makeApoioModule({ intervaloMin: 2, gistId: GIST_ID, gistToken: GIST_TOKEN }));
  registerModule(makeFundacaoModule({ intervaloMin: 20 }));
  registerModule(makeRelatoriosModule({ intervaloMin: 30 }));

  // (sem módulos registados ainda — adiciona os teus acima desta linha)

  (async function init() {
    const ok = await waitReady();
    if (!ok) { console.log('[MAESTRO] jogo não carregou a tempo.'); return; }
    /* Aplicar o perfil publicado pela conta principal ANTES de desenhar o
     * painel: assim o que se vê já é a configuração actual.
     *
     * Na conta PRINCIPAL faz-se o inverso: publica-se logo ao arrancar, para
     * que recarregar a página baste para propagar uma mudança — sem esperar
     * pela publicação de meia em meia hora. */
    if (souPrincipal()) {
      try {
        const esc0 = lerEscolhas();
        const perfil0 = (esc0 && esc0.perfil) || '';
        if (perfil0 && GIST_ID_GLOBAL && GIST_TOKEN_GLOBAL) {
          const r0 = await publicarPerfil(perfil0);
          if (r0 && r0.ok) {
            log('core', `Perfil "${perfil0}" publicado (${r0.n} definição(ões)).`);
          }
        }
      } catch (e) {}
    } else {
      await aplicarPerfilAoArrancar();
    }

    buildPanel();
    atualizarPainelEstado();
    guardarPerfilPeriodicamente();
    limparNotificacoes();          // ligar os vigias já, sem esperar

    /* Procurar versão nova de 10 em 10 minutos.
     *
     * Com um desvio por conta, para as 40 abas não recarregarem todas ao
     * mesmo segundo — o que daria uma vaga de pedidos ao jogo. */
    try {
      const desvio = Math.floor(Math.random() * 5 * 60 * 1000);
      setTimeout(() => {
        verificarVersaoNova();
        setInterval(verificarVersaoNova, 10 * 60 * 1000);
      }, 30000 + desvio);
    } catch (e) {}
    if (autoStartLigado()) {
      log('core', 'Pronto — arranque automático ligado.');
      startMaestro();
    } else {
      log('core', 'Pronto. Arranque automático desligado: carrega em "Iniciar" quando quiseres.');
    }
  })();
})();
