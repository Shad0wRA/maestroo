/* APOIO — transportes só quando o alvo está noutra ilha.
 *
 * Na mesma ilha a tropa vai a pé e o jogo não pede transportes. O Apoio
 * pedia-os sempre, e uma cidade sem eles saltava: "sem transportes para levar
 * a tropa; salto". O código REAL do Apoio (as funções e as duas linhas onde se
 * decide), com as ilhas simuladas.
 *
 *   node ferramentas/teste-apoio-transportes.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira, funcao, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('APOIO — TRANSPORTES');
const APOIO = 'function makeApoioModule(opts)';

/* As minhas cidades: 111 na ilha 100:100, 222 na 100:110. `transportes` diz
 * quantos transportes rápidos tem cada uma. */
function montar(transportes) {
  const ilhas = { 111: [100, 100], 222: [100, 110] };
  const mUw = {
    ITowns: {
      towns: { 111: {}, 222: {} },
      getTown: (id) => ({
        getIslandCoordinateX: () => ilhas[id][0], getIslandCoordinateY: () => ilhas[id][1],
        units: () => Object.assign({ sword: 500 }, (transportes || {})[id] ? { small_transporter: transportes[id] } : {}),
        researches: () => ({ attributes: {} }),
      }),
    },
    GameData: { units: { sword: { population: 1 } } },
  };
  const txt = tira(SRC, '  const CAPACIDADE = {', "const TERRESTRES = ['sword', 'slinger', 'archer', 'hoplite', 'rider', 'chariot', 'catapult'];", APOIO)
    + '\n' + funcao(SRC, '  function temBeliche(townId) {', APOIO)
    + funcao(SRC, '  function popDaUnidade(u) {', APOIO)
    + funcao(SRC, '  function juntarTransportes(townId, pacote, c) {', APOIO)
    + funcao(SRC, '  function mesmaIlhaQueOAlvo(townId, alvoId) {', APOIO)
    + '\nfunction decidir(t, alvo, carga, c) {\n'
    + tira(SRC, '        const aPe = mesmaIlhaQueOAlvo(t.id, alvo) === true;', 'juntarTransportes(t.id, carga, c);\n', APOIO)
    + '        return cargaFinal;\n}\n({ decidir, mesmaIlhaQueOAlvo })';
  /* Alvos de outros jogadores: um na ilha da 111, outro noutra ilha. */
  const ctx = { mUw, seErroDeCodigo: () => {},
    cacheCidades: { 9001: { nome: 'Vizinha', ilha: { x: 100, y: 100 } }, 9002: { nome: 'Longe', ilha: { x: 300, y: 300 } } } };
  vm.createContext(ctx);
  return vm.runInContext(txt, ctx);
}
const temAlgo = (carga) => Object.keys(carga).some((u) => (Number(carga[u]) || 0) > 0);

(async () => {
  {
    const a = montar();
    t.verifica('alvo de outro jogador na mesma ilha → mesma ilha', a.mesmaIlhaQueOAlvo(111, 9001) === true);
    t.verifica('alvo de outro jogador noutra ilha → outra ilha', a.mesmaIlhaQueOAlvo(111, 9002) === false);
    t.verifica('alvo que é cidade minha noutra ilha → outra ilha', a.mesmaIlhaQueOAlvo(111, 222) === false);
    t.verifica('alvo de que não se sabe a ilha → null (fica como estava)', a.mesmaIlhaQueOAlvo(111, 9999) === null);
  }
  {
    const a = montar();   // sem transportes nenhuns
    const c = a.decidir({ id: 111 }, 9001, { sword: 100 }, {});
    t.verifica('sem transportes, alvo na mesma ilha: a tropa vai a pé', temAlgo(c) && igual(c, { sword: 100 }), c);
    const l = a.decidir({ id: 111 }, 9002, { sword: 100 }, {});
    t.verifica('sem transportes, alvo noutra ilha: não há como levar (salta, como antes)', !temAlgo(l), l);
    const d = a.decidir({ id: 111 }, 9999, { sword: 100 }, {});
    t.verifica('sem transportes, ilha do alvo desconhecida: como antes (salta)', !temAlgo(d), d);
  }
  {
    const a = montar({ 111: 20 });
    const l = a.decidir({ id: 111 }, 9002, { sword: 100 }, {});
    t.verifica('com transportes, alvo noutra ilha: juntam-se os transportes', (l.small_transporter || 0) > 0 && l.sword === 100, l);
    const c = a.decidir({ id: 111 }, 9001, { sword: 100 }, {});
    t.verifica('com transportes, alvo na mesma ilha: não se levam transportes', !c.small_transporter && c.sword === 100, c);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
