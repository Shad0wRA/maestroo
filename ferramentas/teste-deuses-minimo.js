/* DEUSES — o mínimo do jogo é em HABITANTES.
 *
 * "Uma tropa de ataque tem de ser constituída pelo menos por 86 habitantes."
 * O módulo comparava CONTAGENS: 36 enviados contavam 36, quando valem 3 de
 * população cada (108). Cidades que já cumpriam o mínimo juntavam espadachins
 * à toa e, sem eles, ficavam à espera — visto em jogo (14/09, 34.3 e 34.4).
 *
 *   node ferramentas/teste-deuses-minimo.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('DEUSES — MÍNIMO');

/* O troço real da decisão, com o mínimo, os enviados e os espadachins. */
function decidir({ minimo, quantos, swords }) {
  const reg = [];
  const ctx = {
    mUw: {
      GameData: { units: { godsent: { population: 3 }, sword: { population: 1 } } },
      ITowns: { getTown: () => ({ units: () => ({ sword: swords }) }) },
    },
    UNIDADE_ENVIADO: 'godsent',
    minimoAprendido: () => minimo,
    t: { id: 111, name: 'Cidade' },
    quantos,
    ctx: { log: (m) => reg.push(String(m)), logRotina: (m) => reg.push(String(m)) },
    Math, Number,
  };
  vm.createContext(ctx);
  /* Do comentário até ao fim do bloco do mínimo (o `}` que fecha o `if`). */
  const i = SRC.indexOf('      /* O MÍNIMO DO JOGO É EM HABITANTES, NÃO EM UNIDADES.');
  const fim = SRC.indexOf('\n      /* VÁRIOS ATAQUES EM CURSO SÃO PERMITIDOS.', i);
  const corpo = SRC.slice(i, fim);
  /* `continue` só vale dentro de um ciclo: embrulha-se num. */
  /* `escudoExtra` é `let` dentro do ciclo: leva-se para fora numa variável
   * do contexto. */
  vm.runInContext('var resultado = null;\nfor (let i = 0; i < 1; i++) {\n' + corpo
    + '\n  resultado = escudoExtra;\n}', ctx);
  return { escudoExtra: ctx.resultado, reg };
}

(async () => {
  {
    /* O caso real: 36 enviados = 108 habitantes, mínimo 80. Chega de sobra. */
    const r = decidir({ minimo: 80, quantos: 36, swords: 44 });
    t.verifica('36 enviados (108 hab.) com mínimo 80: ataca sem espadachins nenhuns',
      r.escudoExtra === 0 && !r.reg.some((x) => /espero/.test(x)), r);
  }
  {
    /* 20 enviados = 60 habitantes, mínimo 86: faltam 26 espadachins. */
    const r = decidir({ minimo: 86, quantos: 20, swords: 100 });
    t.verifica('faltam habitantes: junta exactamente os espadachins precisos',
      r.escudoExtra === 26 && r.reg.some((x) => /junto 26 espadachins/.test(x)), r);
  }
  {
    const r = decidir({ minimo: 86, quantos: 20, swords: 26 });
    t.verifica('tem mesmo os que faltam: não guarda nenhum em casa (falhava por um)',
      r.escudoExtra === 26, r);
  }
  {
    const r = decidir({ minimo: 86, quantos: 5, swords: 10 });
    t.verifica('nem com tudo chega: espera, e diz os habitantes',
      r.reg.some((x) => /não chegam ao mínimo de 86 habitantes/.test(x)), r.reg);
  }
  {
    const r = decidir({ minimo: 0, quantos: 5, swords: 0 });
    t.verifica('sem mínimo aprendido: não mexe em nada', r.escudoExtra === 0, r);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
