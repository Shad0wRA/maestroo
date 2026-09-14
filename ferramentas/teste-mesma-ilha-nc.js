/* MESMA ILHA — não dá para medir, logo avisa-se.
 *
 * A velocidade calcula-se com a distância entre ILHAS; na mesma ilha é zero e
 * não há nada para medir. O código assumia que um colonizador não vinha da
 * própria ilha — e vem: uma conquista dentro da ilha foi anunciada como
 * "tropa terrestre a pé" (visto em jogo, 14/09, 45.1, de 494:506 para
 * 494:506). O `classificar` e o `pareceNC` REAIS.
 *
 *   node ferramentas/teste-mesma-ilha-nc.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('MESMA ILHA');

function alertas() {
  const ctx = {
    uw: { GameData: { units: { colonize_ship: { speed: 9, is_naval: true }, bireme: { speed: 45, is_naval: true } },
      powers: { unit_movement_boost: { meta_defaults: { percent: 30 } } } } },
    seErroDeCodigo: () => {}, console, Math, Number, Object,
  };
  vm.createContext(ctx);
  const a = SRC.indexOf('  const FOLGA_MEDICAO_NC =');
  const b = SRC.indexOf('  try {\n    uw.__maestroNC = {', a);
  return vm.runInContext(SRC.slice(a, b)
    + funcao(SRC, '  function classificar(vel, mesmaIlha) {') + '\nclassificar', ctx);
}

/* `demoras` = o que o jogo já disse sobre este par de cidades (ou null, se
 * ainda não se sabe). */
function esquiva(mesmaIlha, demoras, durou) {
  const pedidos = [];
  const ctx = {
    mUw: {}, seErroDeCodigo: () => {}, console, Math, Number, Promise,
    coordsOrigem: () => ({ x: 494, y: 506 }),
    primeiraVezQueVi: () => ({ quando: 9000 - (durou || 0), novo: false }),
    vistoNoArranque: () => false, agoraJogo: () => 2000,
    tempoPreparacao: () => 0, rotina: () => {},
    pareceColonizadorNC: () => ({ nc: false }),
    ilhaDe: () => null,
    window: { __maestroDemoras: {
      guardadas: () => demoras || null,
      ler: async () => { pedidos.push(1); return demoras || null; },
      explicam: (d, seg) => (d && d.explicam ? d.explicam(seg) : []),
    } },
  };
  vm.createContext(ctx);
  const f = vm.runInContext(funcao(SRC, '  function mesmaIlhaTrazNC(a, alvo) {')
    + funcao(SRC, '  function pareceNC(a, alvo, c) {') + '\npareceNC', ctx);
  const alvo = mesmaIlha ? { ix: 494, iy: 506 } : { ix: 500, iy: 500 };
  return { r: f({ arrival_at: 9000, home_town_id: 1, target_town_id: 2 }, alvo, { K: 100 }), pedidos };
}

(async () => {
  const cl = alertas();
  {
    const r = cl(18, true);
    t.verifica('mesma ilha: diz que não dá para medir e marca como possível colonizador',
      r.nc === true && r.grave === true && !r.certo && /mesma ilha/i.test(r.cat), r);
  }
  {
    const r = cl(45, false);
    t.verifica('entre ilhas continua a distinguir: birreme não é colonizador', !r.nc, r);
  }
  {
    const r = cl(9, false);
    t.verifica('entre ilhas, velocidade de colonizador: acusa', r.nc, r);
  }
  {
    const x = esquiva(true, null, 800);
    t.verifica('mesma ilha sem demoras sabidas: assume o pior e vai pedi-las',
      x.r === true && x.pedidos.length === 1, x);
  }
  {
    /* Já se sabe: 800 s só é explicado pelo colonizador. */
    const dem = { explicam: () => [{ id: 'colonize_ship', bonus: 'sem bónus' }] };
    t.verifica('mesma ilha, demora de colonizador: acusa', esquiva(true, dem, 800).r === true);
  }
  {
    const dem = { explicam: () => [{ id: 'sword', bonus: 'sem bónus' }] };
    t.verifica('mesma ilha, demora de tropa a pé: já NÃO acusa', esquiva(true, dem, 620).r === false);
  }
  {
    const dem = { explicam: () => [] };
    t.verifica('nada explica o tempo: assume o pior', esquiva(true, dem, 100).r === true);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
