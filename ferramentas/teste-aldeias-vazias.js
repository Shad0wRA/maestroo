/* ALDEIAS — recolher muito e não render nada: pergunta-se ao jogo.
 *
 * Visto em jogo (12/09, conta sem Capitão): "Recolhidas 126 aldeia(s)
 * (~0 recursos)" durante mais de uma hora. Por pedido directo o servidor
 * aceita e não dá nada, sem recusa nenhuma. Então abre-se uma aldeia e
 * carrega-se em Recolher: se houver verificação, o jogo mostra-a. Só aí se
 * suspende. O código REAL da recolha, com os modelos simulados.
 *
 *   node ferramentas/teste-aldeias-vazias.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, tira } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('ALDEIAS — RECOLHA VAZIA');
const AL = 'function makeAldeiasModule(opts)';

/* `rende` de cada aldeia pronta; `apareceu` = o captcha aparece ao clicar. */
function montar(rende, apareceu) {
  const chamadas = { tratou: [], mostrou: 0, individual: 0 };
  const ctx = {
    mUw: { Game: { player_name: 'MultiX' } }, mWorld: 'pt126', seErroDeCodigo: () => {}, console,
    relacoesProntas: () => Array.from({ length: 126 }, (_, i) => ({ relationId: i, farmTownId: 900 + i, rende })),
    temCapitao: () => false,
    recolhaIndividual: async () => { chamadas.individual++; },
    recolherEmMassa: async () => ({ ok: true }),
    tratarCaptcha: async (c, onde) => { chamadas.tratou.push(onde); },
    mostrarCaptchaPelaRecolha: async () => { chamadas.mostrou++; return !!apareceu; },
    aldeiaParaMostrarCaptcha: () => ({ farmTownId: 900, townId: 111 }),
  };
  vm.createContext(ctx);
  const txt = funcao(SRC, '  async function fazerRecolha(ctx, towns) {', AL) + '\nfazerRecolha';
  const f = vm.runInContext(txt, ctx);
  const reg = { ecra: [], rotina: [] };
  const c = { log: (m) => reg.ecra.push(String(m)), logRotina: (m) => reg.rotina.push(String(m)),
    sleep: async () => {}, rand: () => 0 };
  return { reg, chamadas, correr: () => f(c, [{ id: 111 }]) };
}

(async () => {
  {
    const m = montar(1800, false);
    await m.correr();
    t.verifica('aldeias que rendem: recolhe como sempre, sem abrir nada',
      m.chamadas.individual === 1 && m.chamadas.mostrou === 0, m.chamadas);
  }
  {
    const m = montar(0, true);
    await m.correr();
    t.verifica('a zero: abre a aldeia e carrega em Recolher', m.chamadas.mostrou === 1, m.chamadas);
    t.verifica('... o captcha aparece: suspende e avisa', m.chamadas.tratou.length === 1
      && /render zero/.test(m.chamadas.tratou[0]), m.chamadas);
    t.verifica('... e não faz a recolha nessa passagem', m.chamadas.individual === 0, m.chamadas);
  }
  {
    const m = montar(0, false);
    await m.correr();
    t.verifica('a zero mas sem captcha: NÃO suspende', !m.chamadas.tratou.length, m.chamadas);
    t.verifica('... e a recolha segue na mesma', m.chamadas.individual === 1, m.chamadas);
    t.verifica('... com a razão na rotina', m.reg.rotina.some((x) => /nenhuma rende nada/.test(x)), m.reg.rotina);
  }
  /* A SUSPENSÃO: enquanto houver verificação, e não meia hora fixa. */
  {
    const suspensao = (haCaptcha, hMin) => {
      const loja = { 'grepoAldeias_captcha_v1': String(Date.now() - hMin * 60000) };
      const ctx = {
        armazem: { getItem: (k) => loja[k] || null, setItem: (k, v2) => { loja[k] = v2; },
          removeItem: (k) => { delete loja[k]; } },
        agoraServidorMs: () => Date.now(),
        window: { __maestroHaCaptcha: () => haCaptcha },
        CAPTCHA_KEY: 'grepoAldeias_captcha_v1',
        seErroDeCodigo: () => {},
      };
      vm.createContext(ctx);
      const f = vm.runInContext(funcao(SRC, '  function captchaAtivo() {', AL) + '\ncaptchaAtivo', ctx);
      return { activo: f(), marca: () => loja['grepoAldeias_captcha_v1'] };
    };
    const a = suspensao(true, 2);
    t.verifica('captcha ainda no ecrã: continua suspenso', a.activo === true);
    const b = suspensao(false, 2);
    t.verifica('resolvido ao fim de 2 min: retoma já', b.activo === false, b.activo);
    t.verifica('... e apaga a marca', !b.marca(), b.marca());
    const c2 = suspensao(true, 45);
    t.verifica('tecto de 30 min: não fica suspenso para sempre', c2.activo === false);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
