/* FECHAR ILHA — as vagas quem as diz é o jogo.
 *
 * O mapa traz o que a conta viu e não esquece cidades que já lá não estão: na
 * ilha 381:470 dava 22 cidades quando o jogo dizia 9 e 11 vagas (12/09). O
 * `forceUpdate` da colonização devolve `uninhabited_place_count` e propõe um
 * lugar LIVRE, diferente de cada vez. O código REAL.
 *
 *   node ferramentas/teste-fechar-ilha-vagas.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, PEDIR_JOGO } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('FECHAR ILHA — VAGAS');
const FI = 'function makeFecharIlhaModule(opts)';

/* A ilha 381:470: 9 cidades, 11 vagas. O jogo propõe os lugares por esta
 * ordem, como fez em jogo (14, 7, 12…). */
function montar(propostas, formato) {
  const pedidos = [];
  const mUw = {
    location: { origin: 'https://pt126.grepolis.com' },
    Game: { csrfToken: 'TOK', player_id: 2379469 },
    fetch: async (url, op) => {
      pedidos.push(JSON.parse(decodeURIComponent(String(op.body).replace('json=', ''))));
      const lugar = propostas[Math.min(pedidos.length - 1, propostas.length - 1)];
      const dados = { enough_culture_points: true, target_x: 381, target_y: 470,
        target_number_on_island: lugar,
        island_info: { island_id: 55319, uninhabited_place_count: 11,
          town_list: Array.from({ length: 9 }, (_, i) => ({ id: i, name: 'C' + i })) } };
      /* O jogo devolve isto de duas maneiras: em models, ou dentro das
       * notificações, em texto escapado. */
      /* As três formas vistas em jogo (12/09). */
      const corpo = formato === 'notificacao'
        ? JSON.stringify({ json: { t_token: 1, notifications: [{ type: 'backbone',
          param_str: JSON.stringify({ Colonization: dados }) }] } })
        : formato === 'notificacao_data'
          ? JSON.stringify({ json: { t_token: 1, notifications: [
            { type: 'outra', param_str: '{}' },
            { type: 'backbone', param_str: JSON.stringify({ Colonization: { data: dados } }) }] } })
          : JSON.stringify({ json: { models: { Colonization: { data: dados } } } });
      return { status: 200, text: async () => corpo, json: async () => JSON.parse(corpo) };
    },
  };
  const ctx = { mUw, LUGARES: 20, seErroDeCodigo: () => {}, console, setTimeout, window: {} };
  vm.createContext(ctx);
  const txt = PEDIR_JOGO + funcao(SRC, '  async function vagasDaIlha(townId, x, y, lugarSugerido) {', FI)
    + funcao(SRC, '  async function lugarLivrePorUsar(townId, x, y, jaUsados) {', FI)
    + '\n({ vagas: vagasDaIlha, livre: lugarLivrePorUsar })';
  return { api: vm.runInContext(txt, ctx), pedidos };
}

(async () => {
  for (const f of ['models', 'notificacao', 'notificacao_data']) {
    const m = montar([14], f);
    const v = await m.api.vagas(111, 381, 470);
    t.verifica(`resposta em ${f}: 11 vagas, 9 cidades, lugar 14`, v.ok && v.vagas === 11
      && v.cidades === 9 && v.lugar === 14, v);
  }
  {
    const m = montar([14], 'models');
    const r = await m.api.livre(111, 381, 470, new Set());
    t.verifica('nenhum lugar tomado: fica com o que o jogo deu', r.ok && r.lugar === 14
      && m.pedidos.length === 1, { r, p: m.pedidos.length });
  }
  {
    const m = montar([14, 7, 12], 'models');
    const r = await m.api.livre(111, 381, 470, new Set([14, 7]));
    t.verifica('lugares já usados por outras contas: pede outro até dar', r.ok && r.lugar === 12
      && m.pedidos.length === 3, { r, p: m.pedidos.length });
  }
  {
    const m = montar([14], 'models');
    const r = await m.api.livre(111, 381, 470, new Set([14]));
    t.verifica('o jogo insiste no mesmo: desiste e diz quais viu', !r.ok
      && /só me propôs lugares que outras contas/.test(r.msg), r);
  }
  {
    /* NUNCA se sugere um número: sugerir um ocupado dá "posição não válida"
     * e a conta desistia da ilha (14/09). */
    const m = montar([14, 7, 12], 'models');
    await m.api.livre(111, 381, 470, new Set([14, 7]));
    t.verifica('as tentativas seguintes não sugerem lugar nenhum',
      m.pedidos.every((p) => !('target_number_on_island' in (p.arguments || {}))),
      m.pedidos.map((p) => p.arguments));
  }
  {
    const m = montar([14], 'models');
    const r = await m.api.vagas(111, 381, 470, 9);
    t.verifica('pode sugerir-se um lugar ao jogo', m.pedidos[0].arguments.target_number_on_island === 9
      && r.ok, m.pedidos[0].arguments);
  }
  {
    const ctx = { mUw: { location: { origin: 'https://x' }, Game: {},
      fetch: async () => ({ text: async () => '{"json":{"t_token":1}}' }) },
      LUGARES: 20, seErroDeCodigo: () => {}, console, setTimeout, window: {} };
    vm.createContext(ctx);
    const f = vm.runInContext(PEDIR_JOGO + funcao(SRC, '  async function vagasDaIlha(townId, x, y, lugarSugerido) {', FI)
      + '\nvagasDaIlha', ctx);
    const v = await f(111, 381, 470);
    t.verifica('resposta sem a ficha da ilha: diz que não deu (não inventa vagas)', !v.ok, v);
  }
  t.secao('O LUGAR 0 É UM LUGAR');
  {
    /* Numa ilha vazia o jogo propõe mesmo o número 0 — confirmado com a espia
     * (15/09: 20 vagas, lugar proposto 0). Cheguei a recusá-lo e a conta
     * ficava sem fundar. */
    const m = montar([0], 'models');
    const v = await m.api.vagas(111, 410, 661);
    t.verifica('o jogo propõe o lugar 0: aceita-se', v.ok && v.lugar === 0, v);
    const r = await m.api.livre(111, 410, 661, new Set());
    t.verifica('... e usa-se para fundar', r.ok && r.lugar === 0, r);
  }
  {
    const m = montar([0], 'models');
    const r = await m.api.livre(111, 410, 661, new Set([0]));
    t.verifica('mas se outra conta já o usar, pede-se outro', !r.ok, r);
  }
  t.secao('O DONO REPARTE OS LUGARES');
  {
    /* Numa ilha VAZIA o jogo propõe sempre o primeiro livre: as vinte contas
     * recebiam o lugar 0 e ficavam à espera umas das outras (15/09). Mas o
     * jogo aceita o lugar que se lhe pede — pedi 0, 3, 7 e 19 e devolveu os
     * mesmos —, por isso o dono volta a repartir. */
    t.verifica('o plano atribui um lugar a cada conta',
      /atribuicoes\[n\] = \(i < livres\.length\) \? livres\[i\] : -1;/.test(SRC));
    t.verifica('... a partir dos lugares livres da ilha',
      /if \(!ocupados\.has\(n2\)\) livres\.push\(n2\);/.test(SRC));
    t.verifica('a conta usa o lugar que lhe deram',
      /let lugar = Number\(meuLugar\);/.test(SRC));
    t.verifica('... e só pede ao jogo quando não veio nenhum',
      /if \(!\(lugar >= 0\)\) \{/.test(SRC));
  }
  t.secao('NINGUÉM PARTE SEM TODOS PODEREM');
  {
    /* 17 colonizadores foram para uma ilha que precisava de 20, e três contas
     * ficaram sem vaga: os 17 ficam lá sem fechar nada (16/09). */
    const i = SRC.indexOf('NINGUÉM PARTE ENQUANTO TODOS NÃO PUDEREM');
    const bloco = SRC.slice(i, i + 1600);
    t.verifica('confirma-se que nenhuma conta do plano está impedida', i > 0
      && /const impedidas = Object\.keys\(plano\.atribuicoes \|\| \{\}\)\.filter/.test(bloco));
    t.verifica('... e quem já enviou não conta como impedida',
      /if \(plano\.enviados\[n2\]\) return false;/.test(bloco));
    t.verifica('... e o plano espera em vez de abortar',
      /Ninguém parte enquanto todas não puderem/.test(bloco));
  }
  {
    /* Com seis planos na fila, guardam-se seis colonizadores. */
    const i = SRC.indexOf('UMA VAGA E UM COLONIZADOR POR PLANO EM QUE ESTOU');
    const bloco = SRC.slice(i, i + 900);
    t.verifica('a reserva acompanha o número de planos', i > 0
      && /querNC\('fecharilha', 60, Math\.max\(1, meusPlanos\)\)/.test(bloco));
    t.verifica('... contando só os planos onde esta conta entra',
      /\(p2\.atribuicoes \|\| \{\}\)\[eu\] !== undefined/.test(bloco));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
