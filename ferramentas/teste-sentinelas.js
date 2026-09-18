/* SENTINELAS — não mandar outra só porque não se viu a que lá está.
 *
 * A leitura da Ágora cobre só ALGUMAS das minhas cidades de cada vez. Uma
 * sentinela enviada de uma cidade por ler não aparece — e concluir daí que a
 * aliada está a descoberto punha lá outra, e outra: apareceram cidades com 15
 * sentinelas (visto em jogo, 13/09). O `tenhoTropaEm` REAL.
 *
 *   node ferramentas/teste-sentinelas.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('SENTINELAS');
const SE = 'function makeSentinelasModule(opts)';

/* As minhas cidades são 111 e 222. `porAlvo` é o que a Ágora deu; `lidas` são
 * as minhas cidades que essa leitura cobre; `modelos` é o que a página tem. */
function montar(porAlvo, lidas, modelos) {
  const ctx = {
    mUw: {
      ITowns: { towns: { 111: {}, 222: {} } },
      MM: { getModels: () => ({ Units: modelos || {} }) },
      __maestroApoioFora: porAlvo === undefined ? undefined
        : { porAlvo: () => porAlvo, lidas: () => lidas || [] },
    },
    seErroDeCodigo: () => {}, console, Date, Number,
  };
  /* A semântica das leituras, que o núcleo expõe: uma leitura diz quando foi
   * feita, se está completa e de onde veio, e o módulo pergunta se pode agir
   * com ela (17/09). */
  ctx.window = {
    __maestroLeitura: (() => {
      const i = SRC.indexOf('  function leitura(valor, opcoes) {');
      const f = SRC.indexOf('\n  try {\n    uw.__maestroLeitura', i);
      const c = {}; vm.createContext(c);
      return vm.runInContext('(() => {\n' + SRC.slice(i, f)
        + '\nreturn { nova: leitura, podeAgir: podeAgirCom, porque: porqueNaoPosso };\n})()', c);
    })(),
  };
  vm.createContext(ctx);
  return vm.runInContext(funcao(SRC, '  function tenhoTropaEm(townId) {', SE)
    + funcao(SRC, '  function tenhoTropaEmPelosModelos(townId) {', SE) + '\ntenhoTropaEm', ctx);
}

const COM_SENTINELA = { 9001: { unidades: { sword: 3 } } };
const MODELO_LA = { u1: { attributes: { id: 1, home_town_id: 111, current_town_id: 9001, sword: 3 } } };

(async () => {
  {
    const f = montar(COM_SENTINELA, [111, 222]);
    t.verifica('a sentinela aparece na leitura: está lá', f(9001) === true);
  }
  {
    const f = montar({}, [111, 222]);
    t.verifica('leitura completa e sem nada lá: está mesmo a descoberto', f(9001) === false);
  }
  {
    /* A pergunta é sobre a ALIADA, não sobre as minhas cidades: basta haver
     * leitura fresca. Exigir a conta toda lida parava o módulo (15/09). */
    const f = montar({}, [111]);
    t.verifica('leitura fresca de uma cidade minha: já chega para decidir', f(9001) === false);
  }
  {
    const f = montar({}, []);
    t.verifica('sem nenhuma leitura fresca: não sei', f(9001) === null);
  }
  {
    const f = montar(null, []);
    t.verifica('sem leitura nenhuma: não sei', f(9001) === null);
  }
  {
    const f = montar(undefined);
    t.verifica('sem a Ágora sequer: não sei', f(9001) === null);
  }
  {
    const f = montar({}, [111], MODELO_LA);
    t.verifica('os modelos mostram a tropa lá: chega para dizer que está', f(9001) === true);
  }
  {
    const f = montar(COM_SENTINELA, [111, 222]);
    t.verifica('outra cidade aliada, essa vazia: está a descoberto', f(9002) === false);
  }
  t.secao('AS ALIADAS VÊM DO MAPA DO MUNDO');
  {
    /* Era um pedido ao jogo por cada ilha: com 48 ilhas, 48 pedidos a
     * concorrer com tudo o resto (17/09). */
    const i = SRC.indexOf('PRIMEIRO OS FICHEIROS DO SERVIDOR');
    const bloco = SRC.slice(i, i + 1800);
    t.verifica('as sentinelas lêem o mapa antes de perguntar ao jogo', i > 0
      && /const m = await api\.ler\(\);/.test(bloco));
    t.verifica('... procuram a ilha pelas coordenadas',
      /m\.porIlha\[coords\.x \+ ':' \+ coords\.y\]/.test(bloco));
    t.verifica('... saltam as minhas cidades e quem não tem aliança',
      /if \(c\.dono === eu\) continue;/.test(bloco) && /if \(!j \|\| !j\.alianca\) continue;/.test(bloco));
    t.verifica('... e só contam as alianças amigas',
      /if \(!nomeAl \|\| !amigas\.has\(nomeAl\)\) continue;/.test(bloco));
    t.verifica('se o mapa não trouxer nada, pergunta-se ao jogo como antes',
      /island_info\?town_id=/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
