/* CANCELAR UM COMANDO — o jogo diz se o apagou mesmo.
 *
 * A resposta do `cancelCommand` traz `command_deleted` (espia, 11/09). Um
 * `false` explícito é uma recusa silenciosa: sem `error`, passava por
 * cancelado e a tropa seguia à mesma. Onde o campo não vem, fica como estava.
 * O `post` REAL do Encaixe e da Esquiva, e o cancelamento REAL do Apoio.
 *
 *   node ferramentas/teste-cancelamento.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('CANCELAR COMANDOS');

function ambiente(resposta) {
  const corpo = JSON.stringify({ json: resposta });
  return {
    mUw: {
      location: { origin: 'https://pt125.grepolis.com' },
      Game: { csrfToken: 'TOK' },
      fetch: async () => ({ status: 200, text: async () => corpo, json: async () => JSON.parse(corpo) }),
    },
    window: {}, seErroDeCodigo: () => {}, console,
    lerResposta: async (r) => JSON.parse(await r.text()),
    aplicarNotificacoes: () => {},
  };
}

/* O `post` do Encaixe (o segundo do ficheiro) e o da Esquiva. */
function posts(qual, resposta) {
  const ini = SRC.indexOf(qual === 'encaixe' ? 'MÓDULO: ENCAIXE DE COMANDOS' : 'MÓDULO: ESQUIVA DE ATAQUES');
  const a = SRC.indexOf('  async function post(url, payload) {', ini);
  const txt = SRC.slice(a, SRC.indexOf('\n  }\n', a) + 4) + '\npost';
  const ctx = ambiente(resposta);
  vm.createContext(ctx);
  return vm.runInContext(txt, ctx)('https://x', {});
}

/* O cancelamento do Apoio devolve true/false. */
function apoio(resposta) {
  const txt = funcao(SRC, '  async function cancelarOuRetirar(mov, alvoId) {') + '\ncancelarOuRetirar';
  const ctx = ambiente(resposta);
  ctx.registarEnvio = () => {};
  vm.createContext(ctx);
  return vm.runInContext(txt, ctx)({ command_id: 7, home_town_id: 111 }, 999);
}

(async () => {
  const CASOS = [
    ['o jogo apagou o comando', { success: 'O comando foi cancelado.', command_deleted: true }, true],
    ['o jogo NÃO apagou (recusa silenciosa)', { success: 'ok', command_deleted: false }, false],
    ['resposta sem o campo: fica como estava', { success: 'O comando foi cancelado.' }, true],
    ['erro do jogo', { error: 'O comando não existe.' }, false],
  ];
  for (const [nome, resp, esperado] of CASOS) {
    for (const qual of ['encaixe', 'esquiva']) {
      const r = await posts(qual, resp);
      t.verifica(`${qual}: ${nome}`, r.ok === esperado, r);
    }
    const r2 = await apoio(resp);
    t.verifica(`apoio: ${nome}`, r2 === esperado, r2);
  }
  {
    const r = await posts('encaixe', { success: 'ok', command_deleted: false });
    t.verifica('e diz porquê', /não apagou o comando/.test(r.msg), r.msg);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
