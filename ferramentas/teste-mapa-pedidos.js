/* OS PEDIDOS AO MAPA TÊM PAUSA E TRAVÃO.
 *
 * O `infoDaCidade` tinha quatro ciclos a pedir blocos do mapa, nenhum com
 * pausa nem a olhar para o travão do servidor. Com 63 cidades, um clique no
 * botão "actualizar" do Apoio disparava dezenas de pedidos seguidos e o
 * servidor recusava ao oitavo (visto em jogo, 16/09).
 *
 *   node ferramentas/teste-mapa-pedidos.js maestro.user.js
 */
const S = require('./simulador');
const { vm, PEDIR_JOGO } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('PEDIDOS AO MAPA');

function api(travado) {
  const pedidos = [];
  const ctx = {
    mUw: {
      location: { origin: 'https://x' }, Game: { csrfToken: 'T' },
      fetch: async (u) => { pedidos.push(String(u)); return { status: 200, text: async () => '{}' }; },
    },
    lerResposta: async () => ({ json: { data: { 0: { towns: {} } } } }),
    servidorTravadoAgora: () => travado,
    Math, Number, JSON, Promise, setTimeout, encodeURIComponent, console,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('  let pedidosAoMapa = 0;');
  const f = SRC.indexOf('\n  async function infoDaCidade(', i);
  const fn = vm.runInContext('(() => {' + PEDIR_JOGO + '\n' + SRC.slice(i, f)
    + '\nreturn { pedir: pedirBlocoDoMapa, quantos: () => pedidosAoMapa, zerar: () => { pedidosAoMapa = 0; } };\n})()', ctx);
  return { fn, pedidos };
}

(async () => {
  {
    const a = api(false);
    const r = await a.fn.pedir(1, 1, 35);
    t.verifica('um pedido normal passa', !!r && a.pedidos.length === 1);
  }
  {
    const a = api(true);
    const r = await a.fn.pedir(1, 1, 35);
    t.verifica('com o servidor travado não se pede nada', r === null && a.pedidos.length === 0);
  }
  {
    const a = api(false);
    for (let i = 0; i < 15; i++) await a.fn.pedir(i, i, 35);
    t.verifica('há um tecto de pedidos por chamada', a.pedidos.length === 12, a.pedidos.length);
  }
  {
    const a = api(false);
    const t0 = Date.now();
    await a.fn.pedir(1, 1, 35);
    await a.fn.pedir(2, 2, 35);
    const demorou = Date.now() - t0;
    t.verifica('entre pedidos há uma pausa de pelo menos meio segundo', demorou >= 600, demorou + 'ms');
  }
  {
    /* Todos os ciclos do infoDaCidade passam por aqui: não sobra nenhum
     * pedido solto ao mapa dentro da função. */
    const i = SRC.indexOf('  async function infoDaCidade(');
    const linhas = SRC.slice(i).split('\n');
    let fim = 0;
    for (let k = 1; k < linhas.length; k++) { if (linhas[k] === '  }') { fim = k; break; } }
    const corpo = linhas.slice(0, fim).join('\n');
    t.verifica('nenhum pedido ao mapa fora do travão',
      !/get_chunks/.test(corpo), (corpo.match(/get_chunks/g) || []).length + ' soltos');
    t.verifica('... e os ciclos param quando o travão diz que chega',
      (corpo.match(/if \(!bloco\) break;/g) || []).length >= 2);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
