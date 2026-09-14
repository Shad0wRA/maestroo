/* FUNDAÇÃO — procurar ilhas sem levar 429.
 *
 * A procura pedia um bloco do mapa de cada vez, em rajada: ao guardar a
 * configuração saíram dezenas de pedidos seguidos, o servidor respondeu 429 a
 * quase todos, e cada 429 pára o maestro dois minutos (visto em jogo, 14/09:
 * 40 erros em segundos). O `get_chunks` aceita uma lista. O `pedirBlocos` REAL.
 *
 *   node ferramentas/teste-fundacao-mapa.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('FUNDAÇÃO — MAPA');
const FU = 'function makeFundacaoModule(opts)';

function montar(travadoAoFim) {
  const pedidos = [];
  let travado = false;
  const ctx = {
    mUw: {
      location: { origin: 'https://pt125.grepolis.com' }, Game: { csrfToken: 'TOK' },
      ITowns: { towns: { 111: {} } },
      fetch: async (url) => {
        const j = JSON.parse(decodeURIComponent((String(url).match(/json=([^&]+)/) || [])[1]));
        pedidos.push(j.chunks.length);
        if (travadoAoFim && pedidos.length >= travadoAoFim) travado = true;
        const data = {};
        j.chunks.forEach((c, i) => { data[i] = { chunk: c, islands: [{ x: c.x * 20, y: c.y * 20, id: 1 }] }; });
        const corpo = JSON.stringify({ json: { data } });
        return { status: 200, text: async () => corpo, json: async () => JSON.parse(corpo) };
      },
    },
    window: { __maestroServidorTravado: () => travado },
    lerResposta: async (r) => JSON.parse(await r.text()),
    seErroDeCodigo: () => {}, console, setTimeout,
  };
  vm.createContext(ctx);
  const f = vm.runInContext(funcao(SRC, '  function servidorTravadoAgora() {', FU)
    + funcao(SRC, '  async function pedirBlocos(lista, townIdBase) {', FU) + '\npedirBlocos', ctx);
  return { f, pedidos };
}

const blocos = (n) => Array.from({ length: n }, (_, i) => ({ x: i, y: i }));

(async () => {
  {
    const m = montar(0);
    const r = await m.f(blocos(25), 111);
    t.verifica('25 blocos → 5 pedidos de 6, não 25', m.pedidos.length === 5, m.pedidos);
    t.verifica('... e devolve os 25 blocos', r.length === 25, r.length);
  }
  {
    const m = montar(0);
    await m.f(blocos(4), 111);
    t.verifica('poucos blocos: um pedido só', m.pedidos.length === 1 && m.pedidos[0] === 4, m.pedidos);
  }
  {
    /* O servidor começa a recusar ao segundo pedido. */
    const m = montar(2);
    const r = await m.f(blocos(30), 111);
    t.verifica('servidor a recusar: pára em vez de insistir', m.pedidos.length === 2, m.pedidos.length);
    t.verifica('... e devolve o que já tinha', r.length === 12, r.length);
  }
  {
    const m = montar(0);
    const r = await m.f([], 111);
    t.verifica('nada a pedir: nenhum pedido', m.pedidos.length === 0 && r.length === 0);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
