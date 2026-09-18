/* CAPTCHA NO ECRÃ — o núcleo pára o ciclo E avisa no Discord.
 *
 * O troço REAL do ciclo (tick) e o `avisarCaptcha` REAL, com o relógio
 * simulado. Com o ciclo parado param os módulos que avisavam; é o núcleo que
 * tem de avisar — logo, e depois de meia em meia hora.
 *
 *   node ferramentas/teste-captcha.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('CAPTCHA NO ECRÃ');

async function simular(passos) {
  let agora = 1_800_000_000_000;
  let captcha = null;
  const discord = [], registo = [], loja = {};
  const ctx = {
    uw: { Game: { player_name: 'MultiX', world_id: 'pt126' },
      __maestroAvisarDiscord: async (tipo, a) => { discord.push({ tipo, campos: a.campos }); } },
    localStorage: { getItem: (k) => (k in loja ? loja[k] : null), setItem: (k, v) => { loja[k] = String(v); } },
    log: (m, x) => registo.push(x), captchaNoEcra: () => captcha,
    naoTrocarDeCidade: false,
  };
  ctx.Date = new Proxy(Date, { get: (tt, p) => (p === 'now' ? () => agora : tt[p]) });
  vm.createContext(ctx);
  const txt = tira(SRC, "  const CAPTCHA_AVISO_KEY = 'grepoMaestro_captchaAvisado_v1';", 'try { uw.__maestroAvisarCaptcha = avisarCaptcha; } catch (e) {}')
    + '\nlet captchaNoEcraDesde = 0, captchaAvisadoEm = 0, captchaIgnorarAte = 0;\nlet naoTrocarDeCidade = false;\nasync function passo() {\n'
    + tira(SRC, '    const vistoNoEcra = (Date.now() < captchaIgnorarAte) ? null : captchaNoEcra();',
      "        log('core', '▶️ O captcha saiu do ecrã — a recolha pode continuar.');\n      }\n    }\n")
    + "  return 'segue';\n}\npasso";
  const passo = vm.runInContext(txt, ctx);
  const out = [];
  for (const p of passos) {
    agora += (p.min || 0) * 60000;
    captcha = p.captcha ? { desc: 'iframe 300×150 em 400,300' } : null;
    const r = await passo();
    await new Promise((res) => setImmediate(res));
    out.push({ parado: r !== 'segue', discord: discord.length });
  }
  return { out, discord, registo };
}

(async () => {
  /* Passagens: sem captcha · aparece · +10 min · +55 · +20 (passa a hora
   * desde o aviso) · sai. */
  const d = await simular([{ min: 0 }, { min: 1, captcha: true }, { min: 10, captcha: true },
    { min: 55, captcha: true }, { min: 20, captcha: true }, { min: 3 }]);

  /* O CAPTCHA JÁ NÃO PÁRA O MAESTRO INTEIRO (16/09).
   *
   * Quem fica bloqueado é a recolha das aldeias, que se suspende sozinha. A
   * construção, o apoio e a esquiva não têm culpa — uma esquiva perdida por
   * causa de um captcha das aldeias é um mau negócio. */
  t.verifica('o ciclo continua, mesmo com o captcha no ecrã',
    d.out.every((p) => !p.parado), d.out);
  t.verifica('mas trava a troca de cidade enquanto ele lá estiver',
    /if \(naoTrocarDeCidade\) return false;/.test(SRC));

  /* UM MINUTO ANTES DE AVISAR (17/09).
   *
   * O aviso saía assim que o captcha aparecia — e quem está a jogar resolve-o
   * em segundos, ficando o Discord cheio de avisos de coisas já resolvidas. */
  t.verifica('no primeiro minuto não avisa ninguém', d.out[1].discord === 0, d.out);
  t.verifica('passado o minuto, avisa', d.out[2].discord === 1, d.out);
  t.verifica('... e não repete a cada passagem', d.out[3].discord === 1, d.out);
  t.verifica('... mas repete ao fim de uma hora', d.discord.length >= 2, d.discord.length);
  t.verifica('a recolha suspende-se logo, sem esperar pelo aviso',
    /captchaNoEcraDesde = Date\.now\(\);\s*\n\s*captchaAvisadoEm = 0;/.test(SRC));

  t.verifica('o registo diz o que ficou suspenso e quando voltou',
    d.registo.some((x) => /a recolha fica suspensa/.test(x))
    && d.registo.some((x) => /a recolha pode continuar/.test(x)), d.registo);
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
