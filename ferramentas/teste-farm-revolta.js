/* AS CIDADES EM REVOLTA FICAM DE FORA DO FARM DE FAVORES.
 *
 * O farm ataca as multis para gerar favor. Se uma está em revolta, está a
 * receber apoio das outras dezanove — e atacá-la mata essa tropa e os enviados
 * divinos que lá vão (17/09).
 *
 * Sai de fora quem cumpre as DUAS coisas: em revolta E na lista de apoio.
 *
 *   node ferramentas/teste-farm-revolta.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('FARM E REVOLTAS');

const AGORA = Math.floor(Date.now() / 1000);

function montar(lista) {
  const ctx = {
    mWorld: 'pt126',
    mUw: { __maestroFb: { url: () => 'https://x', ler: async () => lista } },
    seErroDeCodigo: () => {},
    Date, Number, Object, Set, console,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('  let emRevoltaEApoiadas = null;');
  const f = SRC.indexOf('\n  async function alvosNaIlha', i);
  return vm.runInContext('(() => {\n' + SRC.slice(i, f)
    + '\nreturn cidadesAPoupar;\n})()', ctx);
}

(async () => {
  {
    const f = montar({
      alvos: [500, 600],
      revoltasAuto: { 500: { ultima: AGORA + 3600 }, 700: { ultima: AGORA + 3600 } },
    });
    const r = await f();
    t.verifica('poupa a cidade em revolta que está na lista', r.has(500), [...r]);
    t.verifica('... mas não a que está em revolta e não defendo', !r.has(700), [...r]);
    t.verifica('... nem a que está na lista sem revolta', !r.has(600), [...r]);
  }
  {
    /* Uma revolta que já acabou não conta. */
    const f = montar({ alvos: [500], revoltasAuto: { 500: { ultima: AGORA - 10 } } });
    const r = await f();
    t.verifica('revolta acabada: volta a poder ser atacada', !r.has(500), [...r]);
  }
  {
    const f = montar({});
    const r = await f();
    t.verifica('sem revoltas, não se poupa ninguém', r.size === 0);
  }
  {
    /* A leitura vale cinco minutos. */
    const i = SRC.indexOf('Vale por cinco minutos');
    t.verifica('a lista não é lida a cada ataque', i > 0
      && /\(Date\.now\(\) - emRevoltaLidoEm\) < 5 \* 60 \* 1000/.test(SRC));
  }
  {
    t.verifica('o filtro aplica-se aos alvos da ilha',
      /\.filter\(\(v\) => !poupar\.has\(Number\(v\.id\)\)\);/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
