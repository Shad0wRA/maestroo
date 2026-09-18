/* A REVOLTA QUE EU LANÇO NÃO É PARA APOIAR.
 *
 * O `revoltasPelosModelos` escrevia `destination_town_player_id: eu` — dava o
 * destino como meu fosse de quem fosse. O filtro que exige "o destino é meu e
 * a origem não" passava sempre a dar certo por construção.
 *
 * Visto em jogo (17/09): as cidades 55.18 e 45.9, de onde o Rafa lançou
 * revoltas contra o Jomaras, entraram na lista de apoio e as vinte multis
 * mandaram tropa para elas. O aviso dizia "em revolta por ?" — o "?" era ele.
 *
 *   node ferramentas/teste-revoltas-minhas.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('REVOLTAS — QUEM LANÇOU');
const AP = 'function makeApoioModule(opts)';

const EU = 111;

/* `defs` são as fases de revolta; `takeover` diz quem as lançou. */
function ler(defs, takeover, agora) {
  const ctx = {
    mUw: {
      Game: { player_id: EU },
      MM: { getModels: () => ({ MovementsRevoltDefender: defs, Takeover: takeover }) },
    },
    seErroDeCodigo: () => {}, console, Number, String, Object,
  };
  vm.createContext(ctx);
  const f = vm.runInContext(funcao(SRC, '  function revoltasPelosModelos(agoraS) {', AP)
    + '\nrevoltasPelosModelos', ctx);
  return f(agora);
}

const agora = 1000000;
const fase = (rid, alvo, dono) => ({
  attributes: { revolt_id: rid, target_town_id: alvo, finished_at: agora + 3600,
    started_at: agora - 600, player_id: dono, town_name: 'cidade ' + alvo, arising: false },
});
const quem = (rid, jogador, nome) => ({
  attributes: { command: { id: rid, type: 'revolt' },
    origin_town: { player_id: jogador, player_name: nome } },
});

(async () => {
  {
    /* Um adversário revolta uma cidade minha: é para apoiar. */
    const r = ler({ a: fase(7, 500, EU) }, { t: quem(7, 999, 'Jomaras') }, agora);
    t.verifica('revolta do adversário numa cidade minha: entra', r.lista.length === 1, r.lista);
    t.verifica('... com o nome de quem a lançou',
      r.lista[0] && r.lista[0].origin_player_name === 'Jomaras', r.lista[0]);
  }
  {
    /* Eu revolto uma cidade dele: NÃO é para apoiar. */
    const r = ler({ a: fase(8, 600, 999) }, { t: quem(8, EU, 'Eu') }, agora);
    t.verifica('revolta que EU lancei: fica de fora', r.lista.length === 0, r.lista);
  }
  {
    /* Sem saber quem lançou, não se arrisca. */
    const r = ler({ a: fase(9, 700, EU) }, {}, agora);
    t.verifica('sem saber quem a lançou: não arrisca', r.lista.length === 0, r.lista);
  }
  {
    const r = ler({ a: fase(10, 800, EU) }, { t: quem(10, 999, 'Jomaras') }, agora + 99999);
    t.verifica('revolta já acabada: esquecida', r.lista.length === 0, r.lista);
  }
  {
    const r = ler({ a: fase(11, 900, EU) }, { t: quem(11, 999, 'X') }, agora);
    /* Isto vem da colecção das revoltas em que sou o DEFENSOR: a cidade é
     * minha, sempre. Na 0700 li o dono do `player_id`, que é o jogador que
     * REVOLTA — e as revoltas das multis deixaram de chegar à lista
     * partilhada (17/09: a 5105 da MacaquinhoChinês, revoltada pelo
     * 2438668). */
    t.verifica('o dono do destino sou eu, mesmo quando o player_id é do atacante',
      r.lista[0] && r.lista[0].destination_town_player_id === EU, r.lista[0]);
  }
  {
    /* O caso real: o `player_id` da fase é o do atacante. */
    const faseComAtacante = {
      attributes: { revolt_id: 20, target_town_id: 5105, finished_at: agora + 3600,
        started_at: agora - 600, player_id: 2438668, town_name: '5105', arising: true },
    };
    const r = ler({ a: faseComAtacante }, { t: quem(20, 2438668, 'Outro') }, agora);
    t.verifica('a revolta da própria conta entra na lista', r.lista.length === 1, r.lista);
    t.verifica('... com o destino marcado como meu',
      r.lista[0] && r.lista[0].destination_town_player_id === EU, r.lista[0]);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
