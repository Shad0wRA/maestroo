/* VIGIA — um módulo que corre e não faz nada.
 *
 * A frota já dizia quando cada módulo correu; correr não é fazer. A recolha a
 * render zero e o fechar ilha a ver vagas a mais passaram horas a correr sem
 * produzir nada e ninguém deu por isso (12/09). O núcleo passa a marcar a hora
 * de cada linha de ECRÃ (as de rotina não contam) e o vigia avisa.
 *
 *   node ferramentas/teste-vigia-mudo.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('VIGIA — MÓDULO MUDO');

/* A marcação no núcleo. */
function nucleo() {
  const loja = {};
  const ctx = {
    localStorage: { getItem: (k) => loja[k] || null, setItem: (k, v) => { loja[k] = v; } },
    setInterval: () => 0, uw: {}, seErroDeCodigo: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(tira(SRC, '  /* A última vez que cada módulo fez alguma coisa', '  const MODULES = [];'), ctx);
  return ctx;
}

/* O troço do vigia que decide quem está mudo. */
function vigia(modulos, agora) {
  const ctx = { seErroDeCodigo: () => {}, agora, x: { modulos } };
  vm.createContext(ctx);
  const txt = tira(SRC, '  const VIGIADOS = {', '  };\n')
    + 'const parados = [];\n'
    + tira(SRC, '      try {\n        for (const id of Object.keys(VIGIADOS)) {', '      } catch (e) { seErroDeCodigo(e, \'Frota\'); }\n')
    + '\nparados';
  return vm.runInContext(txt, ctx);
}

const h = (n) => Math.floor(Date.now() / 1000) - n * 3600;
const agora = Math.floor(Date.now() / 1000);

(async () => {
  {
    const n = nucleo();
    n.marcarFeito('aldeias');
    const antes = n.uw.__maestroUltimoFeito().aldeias;
    t.verifica('marcar: guarda a hora do módulo', antes > 0 && Math.abs(Date.now() - antes) < 2000, antes);
    n.marcarFeito('apoio');
    t.verifica('... por módulo, sem misturar', igual(Object.keys(n.uw.__maestroUltimoFeito()).sort(), ['aldeias', 'apoio']));
  }
  {
    t.verifica('aldeias a correr e a fazer: nada a dizer',
      igual(vigia({ aldeias: { a: 1, u: agora - 300, f: agora - 600 } }, agora), []));
    t.verifica('aldeias a correr há 3 h sem fazer nada: avisa',
      igual(vigia({ aldeias: { a: 1, u: agora - 300, f: h(4) } }, agora), ['aldeias']));
    t.verifica('aldeias desligadas: não avisa',
      igual(vigia({ aldeias: { a: 0, u: agora - 300, f: h(9) } }, agora), []));
    t.verifica('módulo que nem está a correr: não avisa (é outro problema)',
      igual(vigia({ aldeias: { a: 1, u: h(5), f: h(9) } }, agora), []));
    t.verifica('nunca fez nada desde o arranque: não avisa (f a zero)',
      igual(vigia({ aldeias: { a: 1, u: agora - 300, f: 0 } }, agora), []));
    t.verifica('recrutamento calado 6 h: ainda não (espera 12 h)',
      igual(vigia({ recrutamento: { a: 1, u: agora - 300, f: h(6) } }, agora), []));
    t.verifica('recrutamento calado 13 h: avisa',
      igual(vigia({ recrutamento: { a: 1, u: agora - 300, f: h(13) } }, agora), ['recrutamento']));
    t.verifica('módulos que passam dias sem ter o que fazer não são vigiados',
      igual(vigia({ expansao: { a: 1, u: agora - 300, f: h(48) },
        fecharilha: { a: 1, u: agora - 300, f: h(48) } }, agora), []));
    t.verifica('dois mudos ao mesmo tempo: ambos na lista',
      igual(vigia({ aldeias: { a: 1, u: agora - 60, f: h(5) },
        tique: { a: 1, u: agora - 60, f: h(9) } }, agora).sort(), ['aldeias', 'tique']));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
