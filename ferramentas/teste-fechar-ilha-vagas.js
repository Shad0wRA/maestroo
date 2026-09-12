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
const { vm, funcao } = S;
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
      const corpo = formato === 'notificacao'
        ? JSON.stringify({ json: { t_token: 1, notifications: [{ type: 'backbone',
          param_str: JSON.stringify({ Colonization: dados }) }] } })
        : JSON.stringify({ json: { models: { Colonization: { data: dados } } } });
      return { status: 200, text: async () => corpo, json: async () => JSON.parse(corpo) };
    },
  };
  const ctx = { mUw, LUGARES: 20, seErroDeCodigo: () => {}, console, setTimeout, window: {} };
  vm.createContext(ctx);
  const txt = funcao(SRC, '  async function vagasDaIlha(townId, x, y, lugarSugerido) {', FI)
    + funcao(SRC, '  async function lugarLivrePorUsar(townId, x, y, jaUsados) {', FI)
    + '\n({ vagas: vagasDaIlha, livre: lugarLivrePorUsar })';
  return { api: vm.runInContext(txt, ctx), pedidos };
}

(async () => {
  for (const f of ['models', 'notificacao']) {
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
    t.verifica('o jogo insiste no mesmo: desiste e diz porquê', !r.ok
      && /não encontrei um lugar livre/.test(r.msg), r);
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
    const f = vm.runInContext(funcao(SRC, '  async function vagasDaIlha(townId, x, y, lugarSugerido) {', FI)
      + '\nvagasDaIlha', ctx);
    const v = await f(111, 381, 470);
    t.verifica('resposta sem a ficha da ilha: diz que não deu (não inventa vagas)', !v.ok, v);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
