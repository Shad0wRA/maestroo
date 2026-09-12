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
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
