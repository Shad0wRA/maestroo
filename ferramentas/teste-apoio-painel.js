/* APOIO — nomes em lote e total por alvo.
 *
 * O botão "actualizar" pedia o nome de cada alvo à vez: com uma lista grande
 * o servidor respondia 429, e o 429 trava o maestro inteiro. O `get_chunks`
 * aceita vários blocos, por isso vão num pedido só. E o painel passa a mostrar
 * a tropa TOTAL no alvo (todas as contas), não só a desta conta.
 *
 *   node ferramentas/teste-apoio-painel.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('APOIO — PAINEL');
const AP = 'function makeApoioModule(opts)';

/* Alvos em duas ilhas: 9001/9002 no mesmo bloco do mapa, 9003 noutro. */
function ambiente(frota) {
  const pedidos = [];
  const cidade = (id, ix, iy, dono) => ({ id, name: 'Cidade ' + id, player_name: dono, island_x: ix, island_y: iy });
  const mUw = {
    location: { origin: 'https://pt125.grepolis.com' },
    Game: { csrfToken: 'TOK' },
    ITowns: { towns: { 111: {} } },
    GameData: { units: { sword: { name: 'espadachim' }, bireme: { name: 'birreme' } } },
    fetch: async (url) => {
      pedidos.push(String(url));
      const j = JSON.parse(decodeURIComponent((String(url).match(/json=([^&]+)/) || [])[1] || '{}'));
      const data = {};
      (j.chunks || []).forEach((c, i) => {
        const towns = {};
        if (c.x === 25 && c.y === 25) { towns[9001] = cidade(9001, 500, 500, 'Vilão'); towns[9002] = cidade(9002, 502, 505, 'Outro'); }
        if (c.x === 30 && c.y === 30) { towns[9003] = cidade(9003, 600, 600, 'Terceiro'); }
        data[i] = { towns };
      });
      const corpo = JSON.stringify({ json: { data } });
      return { status: 200, text: async () => corpo, json: async () => JSON.parse(corpo) };
    },
  };
  const ctx = {
    mUw, mWorld: 'pt125', CHUNK: 20, seErroDeCodigo: () => {}, console, setTimeout,
    cacheCidades: {}, gravarNomes: () => {},
    lerResposta: async (r) => JSON.parse(await r.text()),
    coordenadasPorMovimentos: (id) => ({ 9001: { x: 500, y: 500 }, 9002: { x: 502, y: 505 }, 9003: { x: 600, y: 600 } }[id] || null),
    fbUrlM: () => 'https://falso', fbLerM: async () => frota,
  };
  vm.createContext(ctx);
  const txt = funcao(SRC, '  async function nomesEmLote(ids, townIdBase) {', AP)
    + funcao(SRC, '  async function totaisNosAlvos() {', AP)
    + '\n({ nomesEmLote, totaisNosAlvos, cache: () => cacheCidades })';
  return { api: vm.runInContext(txt, ctx), pedidos };
}

const agora = Math.floor(Date.now() / 1000);
const FROTA = {
  multi1: { quando: agora - 60, apoio: { alvos: { 9001: { u: { sword: 300, bireme: 20 } } } } },
  multi2: { quando: agora - 120, apoio: { alvos: { 9001: { u: { sword: 200 } }, 9002: { u: { sword: 50 } } } } },
  parada: { quando: agora - 7200, apoio: { alvos: { 9001: { u: { sword: 9999 } } } } },
};

(async () => {
  {
    const { api, pedidos } = ambiente(FROTA);
    const n = await api.nomesEmLote([9001, 9002, 9003], 111);
    t.verifica('três alvos em dois blocos → UM pedido ao mapa', pedidos.length === 1, pedidos.length);
    t.verifica('... e descobre os três nomes', n === 3 && api.cache()[9001].nome === 'Cidade 9001'
      && api.cache()[9003].jogador === 'Terceiro', api.cache());
  }
  {
    const { api, pedidos } = ambiente(FROTA);
    await api.nomesEmLote([9001], 111);
    const antes = pedidos.length;
    const n2 = await api.nomesEmLote([9001], 111);
    t.verifica('um alvo já conhecido não custa pedido nenhum', n2 === 0 && pedidos.length === antes, pedidos.length);
  }
  {
    const { api } = ambiente(FROTA);
    const tt = await api.totaisNosAlvos();
    t.verifica('soma as contas vivas em cada alvo', igual(tt.porAlvo['9001'], { sword: 500, bireme: 20 })
      && igual(tt.porAlvo['9002'], { sword: 50 }), tt.porAlvo);
    t.verifica('... e ignora uma conta calada há duas horas', tt.contas === 2 && tt.ok, tt);
  }
  {
    const { api } = ambiente(null);
    const tt = await api.totaisNosAlvos();
    t.verifica('sem dados na frota: diz que leu, sem totais', tt.ok && !Object.keys(tt.porAlvo).length, tt);
  }
  /* QUANTOS ALVOS MAIS É QUE A TROPA EM CASA COBRE. */
  {
    /* O objectivo tem tropa terrestre: a conta precisa da população das
     * unidades e dos transportes que a levam. */
    const ctx = { Math, Number, Object, Infinity,
      mUw: { GameData: { units: { sword: { population: 1 }, archer: { population: 1 },
        hoplite: { population: 1 }, bireme: { is_naval: true, population: 1 } } } } };
    vm.createContext(ctx);
    const f = vm.runInContext(funcao(SRC, '  function quantosAlvosMais(casa, objetivo) {', AP) + '\nquantosAlvosMais', ctx);
    const obj = { sword: 3000, archer: 3000, hoplite: 3000, bireme: 1500 };
    t.verifica('tropa para três alvos, travada pelos birremes',
      igual(f({ sword: 12000, archer: 12000, hoplite: 12000, bireme: 5200, __capacidade: 999999 }, obj), { quantos: 3, limita: 'bireme' }),
      f({ sword: 12000, archer: 12000, hoplite: 12000, bireme: 5200, __capacidade: 999999 }, obj));
    t.verifica('sem tropa nenhuma: zero alvos', f({}, obj).quantos === 0);
    t.verifica('falta uma unidade do objectivo: conta zero, e diz qual',
      igual(f({ sword: 99999, archer: 99999, hoplite: 99999, __capacidade: 999999 }, obj), { quantos: 0, limita: 'bireme' }),
      f({ sword: 99999, archer: 99999, hoplite: 99999, __capacidade: 999999 }, obj));
    t.verifica('sem objectivo definido: não dá para contar', f({ sword: 100 }, {}) === null);
    /* Sem barcos, a tropa terrestre não sai da ilha. */
    t.verifica('tropa de sobra mas sem transportes: zero alvos, e diz que são eles',
      igual(f({ sword: 99999, archer: 99999, hoplite: 99999, bireme: 99999 }, obj),
        { quantos: 0, limita: 'transportes' }),
      f({ sword: 99999, archer: 99999, hoplite: 99999, bireme: 99999 }, obj));
    t.verifica('transportes para dois alvos, tropa para muitos: manda o menor',
      f({ sword: 99999, archer: 99999, hoplite: 99999, bireme: 99999, __capacidade: 18000 }, obj).quantos === 2,
      f({ sword: 99999, archer: 99999, hoplite: 99999, bireme: 99999, __capacidade: 18000 }, obj));
    t.verifica('objectivo com zeros é ignorado',
      f({ sword: 6000, __capacidade: 999999 }, { sword: 3000, archer: 0 }).quantos === 2,
      f({ sword: 6000, __capacidade: 999999 }, { sword: 3000, archer: 0 }));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
