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
  };
  ctx.Date = new Proxy(Date, { get: (tt, p) => (p === 'now' ? () => agora : tt[p]) });
  vm.createContext(ctx);
  const txt = tira(SRC, "  const CAPTCHA_AVISO_KEY = 'grepoMaestro_captchaAvisado_v1';", 'try { uw.__maestroAvisarCaptcha = avisarCaptcha; } catch (e) {}')
    + '\nlet captchaNoEcraDesde = 0, captchaAvisadoEm = 0, captchaIgnorarAte = 0;\nasync function passo() {\n'
    + tira(SRC, '    const vistoNoEcra = (Date.now() < captchaIgnorarAte) ? null : captchaNoEcra();',
      "      log('core', '▶️ O captcha saiu do ecrã — retomo o trabalho.');\n    }\n")
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
  const d = await simular([{ min: 0 }, { min: 1, captcha: true }, { min: 10, captcha: true }, { min: 10, captcha: true },
    { min: 11, captcha: true }, { min: 2, captcha: true }, { min: 3 }]);
  t.verifica('com o captcha no ecrã, o ciclo pára', igual(d.out.slice(0, 5).map((x) => x.parado), [false, true, true, true, false]), d.out);
  t.verifica('avisa no Discord logo que o vê', d.out[1].discord === 1, d.out);
  t.verifica('... com a conta e o mundo', /MultiX/.test(JSON.stringify(d.discord[0])) && /pt126/.test(JSON.stringify(d.discord[0])), d.discord[0]);
  t.verifica('... não repete aos 10 e 20 min', d.out[2].discord === 1 && d.out[3].discord === 1, d.out);
  t.verifica('... e lembra outra vez passada meia hora', d.out[4].discord === 2, d.out);
  t.verifica('o registo do ecrã diz que parou e que retomou', d.registo.some((x) => /Há um captcha no ecrã/.test(x))
    && d.registo.some((x) => /30 min parado/.test(x)), d.registo);
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
