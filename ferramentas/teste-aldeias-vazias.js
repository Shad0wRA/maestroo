/* ALDEIAS — recolher muito e não render nada é o sinal da verificação.
 *
 * Visto em jogo (12/09, conta sem Capitão): "Recolhidas 126 aldeia(s)
 * (~0 recursos)" durante mais de uma hora. O jogo aceita o pedido, responde
 * sem erro e não dá nada: a recusa `backend_requested_verification` nunca
 * chega. O código REAL da recolha, com os modelos simulados.
 *
 *   node ferramentas/teste-aldeias-vazias.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, tira } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('ALDEIAS — RECOLHA VAZIA');
const AL = 'function makeAldeiasModule(opts)';

/* `rende` de cada aldeia pronta; o resto é só o que a função toca. */
function montar(rende) {
  const chamadas = { tratou: [], mostrou: 0, individual: 0, massa: 0 };
  const ctx = {
    mUw: { Game: { player_name: 'MultiX' } }, mWorld: 'pt126', seErroDeCodigo: () => {}, console,
    relacoesProntas: () => Array.from({ length: 126 }, (_, i) => ({ relationId: i, farmTownId: 900 + i, rende })),
    temCapitao: () => false,
    recolhaIndividual: async () => { chamadas.individual++; },
    recolherEmMassa: async () => { chamadas.massa++; return { ok: true }; },
    tratarCaptcha: async (c, onde) => { chamadas.tratou.push(onde); },
    mostrarCaptchaPelaRecolha: async () => { chamadas.mostrou++; },
    aldeiaParaMostrarCaptcha: () => ({ farmTownId: 900, townId: 111 }),
  };
  vm.createContext(ctx);
  const txt = tira(SRC, '  /* Passagens seguidas em que as aldeias prontas não renderam nada. */', '\n  }\n', AL)
    + '\n({ recolha: fazerRecolha, vazias: () => vaziasSeguidas })';
  const api = vm.runInContext(txt, ctx);
  const reg = { ecra: [], rotina: [] };
  const c = { log: (m) => reg.ecra.push(String(m)), logRotina: (m) => reg.rotina.push(String(m)),
    sleep: async () => {}, rand: () => 0 };
  return { api, reg, chamadas, correr: () => api.recolha(c, [{ id: 111 }]) };
}

(async () => {
  {
    const m = montar(1800);
    await m.correr();
    t.verifica('aldeias que rendem: recolhe como sempre', m.chamadas.individual === 1
      && !m.chamadas.tratou.length, m.chamadas);
  }
  {
    const m = montar(0);
    await m.correr();
    t.verifica('primeira passagem a zero: ainda recolhe, mas avisa na rotina', m.chamadas.individual === 1
      && !m.chamadas.tratou.length && m.reg.rotina.some((x) => /confirmo na passagem seguinte/.test(x)), m.reg.rotina);
    await m.correr();
    t.verifica('segunda passagem a zero: suspende e mostra o captcha', m.chamadas.tratou.length === 1
      && /sem render nada/.test(m.chamadas.tratou[0]) && m.chamadas.mostrou === 1, m.chamadas);
    t.verifica('... e não faz a recolha nessa passagem', m.chamadas.individual === 1, m.chamadas);
  }
  {
    const m = montar(0);
    await m.correr();
    const m2 = montar(1800);
    await m2.correr();
    t.verifica('uma passagem a zero seguida de uma boa: o contador volta a zero', m2.api.vazias() === 0
      && !m2.chamadas.tratou.length, { v: m2.api.vazias(), c: m2.chamadas });
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
