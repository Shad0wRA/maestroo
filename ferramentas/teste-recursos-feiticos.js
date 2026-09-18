/* RECURSOS POR FEITIÇO, A PEDIDO.
 *
 * Três feitiços dão recursos a QUALQUER cidade — a tua, de uma multi ou de um
 * aliado — e não têm tempo de espera entre lançamentos (valores lidos do jogo,
 * 17/09):
 *
 *   Oferta do oceano          25 favor → 800 madeira   (Poseidon)
 *   Oferta da natureza        30 favor → 650 pedra     (Ártemis)
 *   Tesouros do mundo mortos  30 favor → 500 prata     (Hades)
 *
 * Com vinte contas, 32 de madeira por favor. Conta-se o que cada feitiço dá,
 * por isso ninguém precisa de ver os recursos da cidade.
 *
 *   node ferramentas/teste-recursos-feiticos.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('RECURSOS POR FEITIÇO');
const FE = 'function makeFeiticosModule(opts)';

function montar(pedidos, favor, deuses, lancaOk) {
  const guardado = { valor: pedidos };
  const lancados = [];
  const registo = [];
  const ctx = {
    mWorld: 'pt126',
    mUw: {
      __maestroFb: {
        url: () => 'https://x',
        ler: async () => guardado.valor,
        escrever: async (c, d) => { guardado.valor = d; },
      },
      ITowns: {
        getTown: (id) => ({ god: () => deuses[id] || null }),
      },
    },
    favorDe: (d) => Number(favor[d]) || 0,
    lancar: async (power, alvo, de) => {
      lancados.push({ power, alvo, de });
      return lancaOk === false ? { ok: false, msg: 'recusado' } : { ok: true, msg: 'ok' };
    },
    log: (x) => registo.push(x),
    rotina: (x) => registo.push(x),
    seErroDeCodigo: () => {},
    Number, Object, String, Date, console,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('  const RECURSOS_POR_FEITICO = {');
  /* O bloco vive ao nível do módulo, a seguir ao `lancar`. */
  const fimCorpo = SRC.indexOf('\n    if (mexeu) await gravarPedidosDeRecursos(pedidos);', i);
  const f = SRC.indexOf('\n  }\n', fimCorpo) + 4;
  const api = vm.runInContext('(() => {\n' + SRC.slice(i, f)
    + '\nreturn { cumprir: cumprirPedidosDeRecursos, tabela: RECURSOS_POR_FEITICO };\n})()', ctx);
  return { api, guardado, lancados, registo };
}

const ctxFalso = { sleep: async () => {}, rand: () => 1 };
const towns = [{ id: 1 }, { id: 2 }];

(async () => {
  {
    const m = montar({}, {}, {}, true);
    t.verifica('os valores são os que o jogo diz',
      m.api.tabela.wood.favor === 25 && m.api.tabela.wood.da === 800
      && m.api.tabela.stone.da === 650 && m.api.tabela.iron.da === 500, m.api.tabela);
  }
  {
    /* Pedido de madeira, com Poseidon e favor: lança. */
    const m = montar({ r1: { alvo: 500, nome: 'X', quer: { wood: 2400 }, feito: {} } },
      { poseidon: 100 }, { 1: 'poseidon' }, true);
    await m.api.cumprir(ctxFalso, towns);
    t.verifica('lança o feitiço certo na cidade certa',
      m.lancados.length === 1 && m.lancados[0].power === 'kingly_gift'
      && m.lancados[0].alvo === 500, m.lancados);
    t.verifica('... e desconta o que deu',
      m.guardado.valor.r1.feito.wood === 800, m.guardado.valor.r1);
  }
  {
    /* Sem favor, não lança. */
    const m = montar({ r1: { alvo: 500, quer: { wood: 800 }, feito: {} } },
      { poseidon: 10 }, { 1: 'poseidon' }, true);
    await m.api.cumprir(ctxFalso, towns);
    t.verifica('sem favor que chegue, não lança', m.lancados.length === 0);
  }
  {
    /* Sem o deus certo, não lança. */
    const m = montar({ r1: { alvo: 500, quer: { stone: 650 }, feito: {} } },
      { artemis: 100 }, { 1: 'poseidon', 2: 'poseidon' }, true);
    await m.api.cumprir(ctxFalso, towns);
    t.verifica('sem cidade que venere o deus, não lança', m.lancados.length === 0);
  }
  {
    /* Pedido cumprido: sai da lista. */
    const m = montar({ r1: { alvo: 500, nome: 'X', quer: { wood: 800 }, feito: { wood: 800 } } },
      { poseidon: 100 }, { 1: 'poseidon' }, true);
    await m.api.cumprir(ctxFalso, towns);
    t.verifica('pedido cumprido sai da lista',
      !m.guardado.valor.r1 && m.registo.some((x) => /cumprido/.test(x)), m.guardado.valor);
  }
  {
    /* Um por passagem e por conta: as vinte somam depressa. */
    const m = montar({ r1: { alvo: 500, quer: { wood: 8000, stone: 8000 }, feito: {} } },
      { poseidon: 500, artemis: 500 }, { 1: 'poseidon', 2: 'artemis' }, true);
    await m.api.cumprir(ctxFalso, towns);
    t.verifica('um lançamento por passagem', m.lancados.length === 1, m.lancados);
  }
  {
    /* Sem pedidos, não faz nada. */
    const m = montar({}, { poseidon: 500 }, { 1: 'poseidon' }, true);
    const r = await m.api.cumprir(ctxFalso, towns);
    t.verifica('sem pedido, o módulo não faz nada', r === false && m.lancados.length === 0);
  }
  {
    /* O lançamento falha: não desconta. */
    const m = montar({ r1: { alvo: 500, quer: { wood: 800 }, feito: {} } },
      { poseidon: 100 }, { 1: 'poseidon' }, false);
    await m.api.cumprir(ctxFalso, towns);
    t.verifica('se o jogo recusar, não se desconta nada',
      !(m.guardado.valor.r1.feito || {}).wood, m.guardado.valor.r1);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
