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
  /* O `fazerRecolha` usa o `recursosEmCasa`, que vive ao nível do módulo. */
  const txt = 'let antesDeRecolher = -1;\nlet semEntrada = 0;\n'
    + 'let noLimiteHoje = new Set();\nlet diaDoLimite = new Date().getDate();\n'
    + funcao(SRC, '  function limparLimiteSeMudouODia() {', AL)
    + funcao(SRC, '  function recursosEmCasa() {', AL)
    + funcao(SRC, '  async function fazerRecolha(ctx, towns) {', AL) + '\nfazerRecolha';
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
  t.secao('RECOLHER E NADA ENTRAR NOS ARMAZÉNS');
  {
    /* O número do registo é o que as aldeias DEVIAM render, não o que entrou.
     * Com um captcha por resolver, o servidor aceita, não dá nada, e o registo
     * anuncia milhões — os armazéns é que não mexem (16/09). */
    const i = SRC.indexOf('OS RECURSOS QUE ESTAVAM NOS ARMAZÉNS ANTES DE RECOLHER');
    t.verifica('lê os armazéns antes de recolher', i > 0
      && /^    antesDeRecolher = recursosEmCasa\(\);$/m.test(SRC));
    t.verifica('... e compara depois', /const entrou = \(antesDeRecolher >= 0 && depois >= 0\)/.test(SRC));
    t.verifica('nada entrou duas vezes seguidas: abre uma aldeia para ver o captcha',
      /if \(semEntrada >= 2\) \{/.test(SRC) && /abro uma aldeia para ver se há verificação/.test(SRC));
    t.verifica('uma passagem só não chega — os armazéns podem estar cheios',
      /confirmo na passagem seguinte/.test(SRC));
    t.verifica('e o registo passa a dizer quanto entrou de facto',
      /entraram \$\{entrou\}/.test(SRC));
  }
  t.secao('AS FUNÇÕES ESTÃO AO ALCANCE UMAS DAS OUTRAS');
  {
    /* O `recursosEmCasa` estava declarado dentro do `fazerRecolha` e era usado
     * no `recolhaIndividual`, que é outra função: o módulo rebentava com
     * "recursosEmCasa is not defined" (16/09, na 9300). */
    const nivelDe = (marca) => {
      const linhas = SRC.split('\n');
      const i = linhas.findIndex((l) => l.includes(marca));
      for (let k = i; k >= 0; k--) {
        if (/^  (async )?function /.test(linhas[k])) return linhas[k].trim();
      }
      return '?';
    };
    t.verifica('o recursosEmCasa vive ao nível do módulo',
      nivelDe('  function recursosEmCasa() {').startsWith('function recursosEmCasa'),
      nivelDe('  function recursosEmCasa() {'));
    /* O mesmo erro, a segunda vez: o total de antes era declarado no
     * `fazerRecolha` e lido no `recolhaIndividual`. O módulo morria a cada
     * passagem e houve contas dez horas sem recolher (16/09). */
    t.verifica('o total de antes de recolher também',
      /^  let antesDeRecolher = -1;$/m.test(SRC)
      && /^    antesDeRecolher = recursosEmCasa\(\);$/m.test(SRC));
    t.verifica('... e nenhuma das duas é declarada dentro de uma função',
      !/const antesDeRecolher = recursosEmCasa\(\);/.test(SRC)
      && !/const recursosEmCasa = /.test(SRC));
    t.verifica('... e as duas funções que o usam alcançam-no',
      nivelDe('    antesDeRecolher = recursosEmCasa();').includes('fazerRecolha')
      && nivelDe('const depois = recursosEmCasa();').includes('recolhaIndividual'));
  }
  t.secao('NO LIMITE DIÁRIO NÃO É SINAL DE VERIFICAÇÃO');
  {
    /* Uma aldeia que já deu o que tinha hoje rende zero — e isso não tem nada
     * a ver com captchas. Numa conta com as 18 aldeias no limite, o módulo
     * abria uma aldeia a cada passagem e o clique fazia aparecer a verificação
     * que não existia antes (17/09, Lagostax no pt127). */
    t.verifica('as aldeias no limite ficam registadas',
      /noLimiteHoje\.add\(Number\(p\.farmTownId\)\)/.test(SRC));
    t.verifica('... e não contam para a sonda do captcha',
      /const foraDoLimite = prontas\.filter\(\(p\) => !noLimiteHoje\.has\(Number\(p\.farmTownId\)\)\);/.test(SRC));
    t.verifica('só se sonda quando há aldeias fora do limite que não rendem',
      /if \(foraDoLimite\.length\s*\n\s*&& foraDoLimite\.reduce/.test(SRC));
    t.verifica('e o registo esvazia-se quando o dia muda',
      /if \(hoje !== diaDoLimite\) \{ diaDoLimite = hoje; noLimiteHoje = new Set\(\); \}/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
