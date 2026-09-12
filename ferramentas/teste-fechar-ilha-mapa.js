/* FECHAR ILHA — ler a ilha no mapa.
 *
 * A grelha do mapa é de 20: com 10 o servidor devolve outro pedaço e a ilha
 * vinha sem cidade nenhuma — "20 lugares livres" numa ilha com 22 cidades
 * (visto em jogo, 12/09, ilha 381:470). E uma leitura falhada não pode contar
 * como ilha vazia. O `estadoDaIlha` REAL.
 *
 *   node ferramentas/teste-fechar-ilha-mapa.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('FECHAR ILHA — MAPA');
const FI = 'function makeFecharIlhaModule(opts)';

/* A ilha 381:470 como o jogo a devolveu: cidades nos lugares 0..20 e 23,
 * mais aldeias sem lugar (nr nulo). Só responde à grelha certa. */
function montar(grelhaBoa, falha) {
  const pedidos = [];
  const towns = {};
  [...Array(21).keys()].concat([23]).forEach((nr, i) => {
    towns['t' + i] = { x: 381, y: 470, nr, name: 'Cidade ' + nr, player_id: 100 + i, alliance_id: 7 };
  });
  for (let i = 0; i < 6; i++) towns['f' + i] = { x: 381, y: 470, nr: null, name: 'Aldeia' };
  towns['outra'] = { x: 382, y: 470, nr: 3, name: 'De outra ilha' };
  const mUw = {
    location: { origin: 'https://pt125.grepolis.com' }, Game: { csrfToken: 'TOK' },
    fetch: async (url) => {
      pedidos.push(String(url));
      if (falha) throw new Error('rede em baixo');
      const j = JSON.parse(decodeURIComponent((String(url).match(/json=([^&]+)/) || [])[1]));
      const c = (j.chunks || [])[0] || {};
      /* O servidor só devolve as cidades quando o bloco é o certo. */
      const certo = c.x === Math.floor(381 / grelhaBoa) && c.y === Math.floor(470 / grelhaBoa);
      const corpo = JSON.stringify({ json: { data: { 0: { chunk: c, towns: certo ? towns : {} } } } });
      return { status: 200, text: async () => corpo, json: async () => JSON.parse(corpo) };
    },
  };
  const ctx = { mUw, LUGARES: 20, seErroDeCodigo: () => {}, console, window: {} };
  vm.createContext(ctx);
  const f = vm.runInContext(funcao(SRC, '  async function estadoDaIlha(ix, iy, townIdBase) {', FI) + '\nestadoDaIlha', ctx);
  return { f, pedidos };
}

(async () => {
  {
    const m = montar(20, false);
    const r = await m.f(381, 470, 111);
    t.verifica('pede o bloco da grelha de 20', /%22x%22%3A19/.test(m.pedidos[0]) || /"x":19/.test(decodeURIComponent(m.pedidos[0])), m.pedidos[0].slice(0, 120));
    t.verifica('vê as 22 cidades da ilha (e ignora as de outra ilha)', r.ocupados === 22, r.ocupados);
    t.verifica('a ilha tem 24 lugares, porque há cidade no 23', r.total === 24, r.total);
    t.verifica('livres: só o 21 e o 22', igual(r.livres, [21, 22]), r.livres);
    t.verifica('e diz que leu', r.lido === true);
  }
  {
    const m = montar(10, false);   // se o módulo pedisse com 10, não via nada
    const r = await m.f(381, 470, 111);
    t.verifica('com a grelha errada não viria nada — é o erro que isto apanha',
      r.ocupados === 0 && r.livres.length === 20, { o: r.ocupados, l: r.livres.length });
  }
  {
    const m = montar(20, true);
    const r = await m.f(381, 470, 111);
    t.verifica('pedido falhado: diz que NÃO leu (não é ilha vazia)', r.lido === false, r);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
