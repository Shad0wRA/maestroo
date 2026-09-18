/* O BROKER: TODOS OS PEDIDOS AO JOGO PASSAM POR AQUI.
 *
 * Corrigi a mesma falha três vezes numa semana, sempre noutro sítio: o
 * `infoDaCidade` com quatro ciclos a pedir ao mapa sem pausa; o botão do apoio
 * a disparar dezenas de pedidos seguidos; a fundação a varrer o mapa e a
 * trazer quarenta erros. Cada correcção foi um remendo local, e o quarto sítio
 * havia de aparecer (18/09).
 *
 *   node ferramentas/teste-broker.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('BROKER DE PEDIDOS');

function montar(travado) {
  const registo = { pedidos: [], horas: [] };
  const ctx = {
    uw: {
      fetch: async (u) => {
        registo.pedidos.push(String(u));
        registo.horas.push(Date.now());
        return { ok: true, status: 200 };
      },
      __maestroServidorTravado: () => !!travado,
    },
    seErroDeCodigo: () => {},
    Date, Math, Number, Promise, setTimeout, Object, console,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('  const PEDIDOS_PAUSA_MIN = 250;');
  const f = SRC.indexOf('\n  try {\n    uw.__maestroPedir', i);
  const api = vm.runInContext('(() => {\n' + SRC.slice(i, f)
    + '\nreturn { pedir: pedirAoJogo, estado: () => pedidosEstado };\n})()', ctx);
  return { api, registo };
}

(async () => {
  t.secao('UM DE CADA VEZ');
  {
    const m = montar(false);
    /* Três ao mesmo tempo, como um ciclo faria. */
    const r = await Promise.all([
      m.api.pedir('/a', {}, 5), m.api.pedir('/b', {}, 5), m.api.pedir('/c', {}, 5),
    ]);
    t.verifica('os três saem', m.registo.pedidos.length === 3, m.registo.pedidos);
    const intervalos = m.registo.horas.slice(1)
      .map((h, i) => h - m.registo.horas[i]);
    t.verifica('e nunca dois ao mesmo tempo',
      intervalos.every((x) => x >= 200), intervalos);
  }

  t.secao('PRIORIDADE');
  {
    const m = montar(false);
    /* Um varrimento primeiro, depois a esquiva: a esquiva passa à frente. */
    const p = [
      m.api.pedir('/mapa1', {}, 9), m.api.pedir('/mapa2', {}, 9),
      m.api.pedir('/esquiva', {}, 0),
    ];
    await Promise.all(p);
    /* O primeiro já ia a caminho; dos que esperaram, a esquiva vem à frente. */
    t.verifica('quem tem pressa passa à frente dos varrimentos',
      m.registo.pedidos.indexOf('/esquiva') < m.registo.pedidos.indexOf('/mapa2'),
      m.registo.pedidos);
  }
  {
    const m = montar(false);
    await Promise.all([
      m.api.pedir('/primeiro', {}, 5), m.api.pedir('/segundo', {}, 5),
    ]);
    t.verifica('com a mesma prioridade, quem chegou primeiro sai primeiro',
      m.registo.pedidos[0] === '/primeiro', m.registo.pedidos);
  }

  t.secao('O TRAVÃO');
  {
    const m = montar(true);
    const r = await m.api.pedir('/x', {}, 5);
    t.verifica('com o servidor travado, o pedido nem sai', m.registo.pedidos.length === 0);
    t.verifica('... e quem pediu recebe resposta, não fica pendurado',
      r && r.status === 429 && r.travado === true, r);
    t.verifica('... e a resposta é legível como qualquer outra',
      typeof r.text === 'function' && typeof r.json === 'function');
  }

  t.secao('QUANDO O PEDIDO REBENTA');
  {
    const registo = { pedidos: [] };
    const ctx = {
      uw: { fetch: async () => { throw new Error('rede em baixo'); },
        __maestroServidorTravado: () => false },
      seErroDeCodigo: () => {}, Date, Math, Number, Promise, setTimeout, Object, console,
    };
    vm.createContext(ctx);
    const i = SRC.indexOf('  const PEDIDOS_PAUSA_MIN = 250;');
    const f = SRC.indexOf('\n  try {\n    uw.__maestroPedir', i);
    const api = vm.runInContext('(() => {\n' + SRC.slice(i, f)
      + '\nreturn { pedir: pedirAoJogo };\n})()', ctx);
    const r = await api.pedir('/x', {}, 5);
    t.verifica('uma falha de rede não deixa ninguém pendurado', !!r && r.ok === false, r);
    t.verifica('... e diz o que aconteceu', /rede em baixo/.test(r.erro || ''), r);
  }

  t.secao('CONTAS');
  {
    const m = montar(false);
    await Promise.all([m.api.pedir('/a', {}, 5), m.api.pedir('/b', {}, 5)]);
    const e = m.api.estado();
    t.verifica('conta os pedidos feitos', e.feitos === 2, e);
    t.verifica('e a fila fica vazia no fim', e.naFila === 0, e);
  }

  t.secao('TODO O CÓDIGO PASSA POR AQUI');
  {
    /* O que interessa não é o broker existir: é mais ninguém pedir por fora. */
    const i = SRC.indexOf('  async function correrFila() {');
    const f = SRC.indexOf('\n  try {\n    uw.__maestroPedir', i);
    const foraDoBroker = (SRC.slice(0, i) + SRC.slice(f))
      .match(/await (mUw|uw)\.fetch\(/g) || [];
    t.verifica('não sobrou nenhum pedido directo ao jogo',
      foraDoBroker.length === 0, foraDoBroker.length + ' sobraram');
    t.verifica('e há muitos a passar pelo broker',
      (SRC.match(/await pedirJogo\(/g) || []).length > 80,
      (SRC.match(/await pedirJogo\(/g) || []).length);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
