/* O JOGO SIMULADO, partilhado pelos testes.
 *
 * Os testes não reescrevem o Maestro: tiram do `maestro.user.js` o código REAL
 * (uma função, um módulo inteiro, um troço do núcleo) e correm-no contra um
 * jogo de mentira — os modelos, as colecções e as respostas do servidor que
 * cada cenário precisa. Se o código mudar, o teste corre o código novo.
 *
 * Os formatos das respostas são os que a espia viu em jogo (11/09): a lista
 * da visão geral vem em `json.data.commands`; os comandos de outros vêm com
 * `started_at: 0`; os colonizadores têm `id` em texto ("colonization_…"). */
const fs = require('fs');
const vm = require('vm');

const AGORA_S = 2_000_000;   // hora do jogo, em segundos

function ler(caminho) { return fs.readFileSync(caminho, 'utf8'); }

/* Um troço de texto do ficheiro: de `inicio` até ao primeiro `fim` a seguir. */
function tira(src, inicio, fim, depoisDe) {
  const de = depoisDe ? src.indexOf(depoisDe) : 0;
  const a = src.indexOf(inicio, de < 0 ? 0 : de);
  if (a < 0) throw new Error('não encontrei no ficheiro: ' + inicio.slice(0, 60));
  const b = src.indexOf(fim, a);
  if (b < 0) throw new Error('não encontrei o fim de: ' + inicio.slice(0, 60));
  return src.slice(a, b + fim.length);
}

/* Uma função de indentação 2, até ao `  }` que a fecha. */
const funcao = (src, inicio, depoisDe) => tira(src, inicio, '\n  }\n', depoisDe);

/* Uma fábrica de módulo (coluna 0), até ao `}` que a fecha. */
const fabrica = (src, nome) => tira(src, `function ${nome}(opts) {`, '\n}\n');

/* O leitor comum das respostas e o leitor da visão geral, do núcleo. */
function blocoNucleo(src) {
  const a = src.indexOf('  async function lerRespostaComum(resposta) {');
  const b = src.indexOf('  /* ============ AVISO DE VERIFICAÇÃO DE BOT', a);
  if (a < 0 || b < 0) throw new Error('não encontrei o leitor da visão geral no núcleo');
  return src.slice(a, b);   // sem o comentário seguinte, que ficaria por fechar
}

/* O jogo. `op`:
 *   respostas  fila de respostas à visão geral ({ corpo, status }); a última repete
 *   movimentos modelos MovementsUnits · attack colecção Attack · units modelos Units
 *   semAdm     sem Administrador no modelo das assinaturas */
function jogo(op) {
  op = op || {};
  const pedidos = [];
  const fila = (op.respostas || []).slice();
  const win = {
    location: { origin: 'https://pt125.grepolis.com' },
    Game: { csrfToken: 'TOK', townId: 111, player_id: 1, player_name: 'Shad0wRA', world_id: 'pt125',
      constants: { units: { runtime_setup_time: 300 } } },
    Timestamp: { now: () => AGORA_S, serverTime: () => AGORA_S },
    ITowns: {
      towns: { 111: {}, 222: {} },
      getTown: (id) => ({
        id: Number(id), getName: () => 'Cidade ' + id, name: 'Cidade ' + id,
        units: () => ({ sword: 10 }), unitsOuter: () => ({}), unitsSupport: () => ({}),
        getIslandCoordinateX: () => 100, getIslandCoordinateY: () => (Number(id) === 111 ? 100 : 110),
        getBuildings: () => ({ getBuildingLevel: () => 0 }), researches: () => ({ attributes: {} }),
        god: () => null, getGod: () => null,
      }),
      getCurrentTown: () => ({ id: 111 }),
    },
    GameData: { units: { sword: { speed: 8, is_naval: false, population: 1 }, archer: {}, hoplite: {}, bireme: {} } },
    MM: {
      getModels: () => ({
        PremiumFeatures: op.semAdm ? { k: { attributes: {} } } : { k: { attributes: { curator: 9e12 } } },
        MovementsUnits: op.movimentos || {},
        Units: op.units || {},
      }),
      getCollections: () => ({
        Attack: [{ models: (op.attack || []).map((a) => ({ attributes: a })) }],
        TownGroup: [{ models: [] }], TownGroupTown: [{ models: [] }],
      }),
    },
    gpAjax: { ajaxGet: (a, b, c, d, cb) => { if (cb) cb(); } },
    console: { log: () => {} },
    fetch: async (url) => {
      pedidos.push(String(url));
      let r;
      if (/command_overview/.test(url)) {
        r = fila.length > 1 ? fila.shift() : (fila[0] || { corpo: { json: { data: { commands: [] } } } });
      } else if (/send_back/.test(url)) {
        r = { corpo: { json: { success: 'A tropa vai a caminho.', all_units: {} } } };
      } else {
        r = { corpo: { json: {} } };
      }
      const texto = typeof r.corpo === 'string' ? r.corpo : JSON.stringify(r.corpo);
      return { status: r.status || 200, text: async () => texto, json: async () => JSON.parse(texto) };
    },
    __maestroTravar: () => {},
  };
  win.__maestroTemAdministrador = () => {
    try { return Number(Object.values(win.MM.getModels().PremiumFeatures)[0].attributes.curator) > AGORA_S; }
    catch (e) { return false; }
  };
  const loja = {};
  const localStorage = {
    getItem: (k) => (k in loja ? loja[k] : null),
    setItem: (k, v) => { loja[k] = String(v); },
    removeItem: (k) => { delete loja[k]; },
  };
  const pedidosVG = () => pedidos.filter((u) => /command_overview/.test(u)).length;
  return { win, pedidos, pedidosVG, loja, localStorage };
}

/* Tirar o Administrador a um jogo já montado. */
function semAdministrador(j) {
  const g = j.win.MM.getModels;
  j.win.MM.getModels = () => Object.assign(g(), { PremiumFeatures: { k: { attributes: {} } } });
}

/* O núcleo do ficheiro na janela do jogo: `__maestroVisaoGeral` e companhia. */
function carregarNucleo(src, j) {
  const ctx = {
    uw: j.win,
    temAdministrador: () => j.win.__maestroTemAdministrador(), servidorTravado: () => false,
    avisarCaptcha: async () => {}, guardarNaCaixa: () => {}, seErroDeCodigo: () => {}, log: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(blocoNucleo(src), ctx);
}

/* Um módulo inteiro, pronto a correr. */
function modulo(src, nome, j) {
  const erros = [];
  const ctx = {
    /* `uw` é o do núcleo, no mesmo âmbito que os módulos no ficheiro verdadeiro. */
    uw: j.win, window: j.win, localStorage: j.localStorage, console: { log: () => {}, warn: () => {} },
    document: { createElement: () => ({ style: {} }), querySelector: () => null },
    seErroDeCodigo: (e, onde) => erros.push(`${onde}: ${e && e.message}`),
    limiteColonizador: () => 12.5, pareceColonizadorNC: () => false,
    registarPorque: () => {}, fbLer: async () => null, fbApagar: async () => {},
    /* Esperas curtas correm já; agendamentos longos (planos da esquiva) não. */
    setTimeout: (f, ms) => { if ((Number(ms) || 0) <= 5000) Promise.resolve().then(f); return 0; },
    clearTimeout: () => {},
  };
  vm.createContext(ctx);
  const mod = vm.runInContext(fabrica(src, nome) + `\n${nome}({ intervaloMin: 1 })`, ctx);
  return { mod, erros };
}

function contexto(j, reg) {
  return {
    uw: j.win, WORLD: 'pt125',
    log: (m) => reg.ecra.push(String(m)), logRotina: (m) => reg.rotina.push(String(m)),
    sleep: async () => {}, rand: () => 0,
    getMyTowns: () => [{ id: 111, name: 'Cidade 111' }, { id: 222, name: 'Cidade 222' }],
    avisarDiscord: async (canal, aviso) => { reg.discord.push({ canal, aviso }); },
    switchToTown: async () => {}, voltarEm: () => {}, ligado: () => true,
  };
}

/* Montar o jogo, carregar o núcleo e correr um módulo `passagens` vezes. */
async function correr(src, nome, op, passagens, antes) {
  const j = jogo(op);
  carregarNucleo(src, j);
  if (antes) antes(j);
  const { mod, erros } = modulo(src, nome, j);
  const reg = { ecra: [], rotina: [], discord: [] };
  const c = contexto(j, reg);
  for (let i = 0; i < (passagens || 1); i++) await mod.run(c);
  return { reg, erros, vg: j.pedidosVG(), j };
}

const ligar = (chave) => (j) => j.localStorage.setItem(chave, JSON.stringify({ ativo: true }));

/* Respostas da visão geral. */
const lista = (cmds, extra) => ({ corpo: { json: Object.assign({ data: { commands: cmds } }, extra || {}) } });
const ERRO = { corpo: { json: { error: 'Ocorreu um erro.' } } };
const LIMITADO = { status: 429, corpo: '' };

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Contador de verificações de um ficheiro de teste. */
function verificador(titulo) {
  let n = 0, falhas = 0;
  if (titulo) console.log(`\n${titulo}`);
  return {
    secao: (t) => console.log(`\n${t}`),
    verifica(nome, cond, extra) {
      n++;
      if (cond) console.log('  ok  ', nome);
      else {
        falhas++;
        console.log('  FALHA', nome, extra !== undefined ? JSON.stringify(extra, null, 1).slice(0, 1500) : '');
      }
    },
    fim() {
      console.log(`\n${n - falhas}/${n} verificações passaram.`);
      process.exit(falhas ? 1 : 0);
    },
  };
}

function ficheiroDoMaestro() {
  const c = process.argv[2] || 'maestro.user.js';
  if (!fs.existsSync(c)) {
    console.error(`Não encontrei ${c}. Uso: node ${process.argv[1]} caminho/para/maestro.user.js`);
    process.exit(2);
  }
  return ler(c);
}

module.exports = {
  AGORA_S, ler, tira, funcao, fabrica, blocoNucleo, jogo, semAdministrador, carregarNucleo, modulo,
  contexto, correr, ligar, lista, ERRO, LIMITADO, igual, verificador, ficheiroDoMaestro, vm,
};
