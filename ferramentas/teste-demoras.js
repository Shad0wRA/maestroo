/* AS DEMORAS QUE O JOGO DÁ — comparar tempo com tempo.
 *
 * A janela de atacar devolve, para o alvo escolhido, quanto demora CADA
 * unidade, já com a distância, a velocidade do mundo e os bónus (visto em
 * jogo, 14/09: espadachim 625 s, colonizador 793 s…). É a única fonte na
 * MESMA ILHA, onde a distância entre ilhas é zero e não há velocidade para
 * medir.
 *
 *   node ferramentas/teste-demoras.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira, funcao, PEDIR_JOGO } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('DEMORAS');

function montar(resposta) {
  const pedidos = [];
  const loja = {};
  const corpo = JSON.stringify(resposta || {});
  const ctx = {
    uw: {
      location: { origin: 'https://pt126.grepolis.com' }, Game: { csrfToken: 'TOK' },
      GameData: {
        units: { sword: { speed: 26.4 }, hoplite: { speed: 19.8 },
          colonize_ship: { speed: 9, is_naval: true }, bireme: { speed: 49.5, is_naval: true } },
        powers: { unit_movement_boost: { meta_defaults: { percent: 30 } } },
      },
      fetch: async (u) => { pedidos.push(String(u)); return { status: 200, text: async () => corpo }; },
    },
    localStorage: { getItem: (k) => (k in loja ? loja[k] : null), setItem: (k, v) => { loja[k] = v; } },
    servidorTravado: () => false,
    lerRespostaComum: async (r) => JSON.parse(await r.text()),
    Math, Number, Object, JSON, Promise, Date, encodeURIComponent,
  };
  vm.createContext(ctx);
  const a = SRC.indexOf('  const FOLGA_MEDICAO_NC =');
  const b = SRC.indexOf('  try {\n    uw.__maestroDemoras = {', a);
  vm.runInContext(PEDIR_JOGO + SRC.slice(a, b) + '\n({})', ctx);
  return { ctx, pedidos, loja };
}

/* A janela real, com os números de 14/09. */
const JANELA = { json: { json: { runtime_setup_time: 300, units: {
  sword: { duration: 625, speed: 26.4 },
  hoplite: { duration: 734, speed: 19.8 },
  colonize_ship: { duration: 793, speed: 9 },
  bireme: { duration: 473, speed: 49.5 },
} } } };

(async () => {
  {
    const m = montar(JANELA);
    const d = await m.ctx.demorasPara(111, 999);
    t.verifica('lê as demoras da janela de atacar', d && d.u.colonize_ship === 793 && d.prep === 300, d);
    t.verifica('... com um pedido só', m.pedidos.length === 1, m.pedidos.length);
    const d2 = await m.ctx.demorasPara(111, 999);
    t.verifica('... e não repete o pedido: fica guardado', m.pedidos.length === 1 && d2.u.sword === 625);
  }
  {
    const m = montar(JANELA);
    const d = await m.ctx.demorasPara(111, 999);
    const r = m.ctx.unidadesQueExplicamPorTempo(d, 793);
    t.verifica('uma viagem de 793 s: o colonizador sem bónus explica-a',
      r.some((x) => x.id === 'colonize_ship'), r.map((x) => x.id));
  }
  {
    const m = montar(JANELA);
    const d = await m.ctx.demorasPara(111, 999);
    const r = m.ctx.unidadesQueExplicamPorTempo(d, 625);
    /* 625 s é o tempo do espadachim — mas um colonizador com cartografia,
     * farol, navegar e sereias também lá chega. Ambos explicam, logo fica a
     * dúvida: é o resultado honesto, e o lado seguro. */
    t.verifica('625 s: o espadachim explica, mas o colonizador com bónus também — fica a dúvida',
      r.some((x) => x.id === 'sword') && r.some((x) => x.id === 'colonize_ship'), r.map((x) => x.id));
    t.verifica('... e o espadachim é a explicação mais próxima', r[0].id === 'sword', r[0]);
  }
  {
    /* Colonizador com feitiço: 300 + (793-300)/1,30 = 679 s. */
    const m = montar(JANELA);
    const d = await m.ctx.demorasPara(111, 999);
    const r = m.ctx.unidadesQueExplicamPorTempo(d, 679);
    t.verifica('colonizador com o feitiço: continua a ser apanhado',
      r.some((x) => x.id === 'colonize_ship'), r);
  }
  {
    const m = montar(JANELA);
    const d = await m.ctx.demorasPara(111, 999);
    const r = m.ctx.unidadesQueExplicamPorTempo(d, 120);
    t.verifica('depressa de mais para tudo: nada explica', r.length === 0, r);
  }
  {
    const m = montar({ json: { json: { units: {} } } });
    const d = await m.ctx.demorasPara(111, 999);
    t.verifica('resposta sem demoras: devolve null (não inventa)', d === null, d);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
