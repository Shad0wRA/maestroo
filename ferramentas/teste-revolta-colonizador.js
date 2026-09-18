/* NUM MUNDO DE REVOLTA, O COLONIZADOR TEM HORA.
 *
 * Só entra na R2. Logo: uma cidade que não está em revolta não pode receber
 * colonizador, e uma que está só dentro da janela da R2.
 *
 * Sem isto, todos os ataques da mesma ilha eram tratados como podendo trazer
 * colonizador — na mesma ilha não há distância e não se mede velocidade
 * (6200) — e a esquiva deixava a tropa em casa "para o matar". Numa revolta o
 * adversário ataca da mesma ilha vezes sem conta: nove alarmes seguidos em
 * duas cidades (visto em jogo, 17/09).
 *
 *   node ferramentas/teste-revolta-colonizador.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('REVOLTA E COLONIZADOR');

const AGORA = 1000000;

/* `defs` = as fases de revolta que o jogo carrega. */
function montar(defs) {
  const ctx = {
    mUw: { MM: { getModels: () => (defs === null ? {} : { MovementsRevoltDefender: defs }) } },
    agoraJogo: () => AGORA,
    Number, Object, console,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('      const mundoDeRevolta = (() => {');
  const f = SRC.indexOf('\n      let temNC =', i);
  return vm.runInContext('(() => {\n' + SRC.slice(i, f).replace(/^ {6}/gm, '')
    + '\nreturn { revolta: mundoDeRevolta, janela: janelaDoColonizador };\n})()', ctx);
}

const fase = (alvo, r1) => ({
  attributes: { target_town_id: alvo, finished_at: AGORA + 3600, arising: r1 },
});

(async () => {
  {
    const a = montar(null);
    t.verifica('sem a colecção, o mundo é de cerco', a.revolta === false);
  }
  {
    const a = montar({});
    t.verifica('com a colecção, o mundo é de revolta', a.revolta === true);
  }
  {
    /* A cidade não está em revolta: não pode vir colonizador. */
    const a = montar({ x: fase(999, false) });
    t.verifica('cidade sem revolta: o colonizador NÃO pode entrar', a.janela(500) === false);
  }
  {
    /* Em R1: ainda não. */
    const a = montar({ x: fase(500, true) });
    t.verifica('cidade em R1: ainda não pode', a.janela(500) === false);
  }
  {
    /* Em R2: pode. */
    const a = montar({ x: fase(500, false) });
    t.verifica('cidade em R2: aí sim', a.janela(500) === true);
  }
  {
    /* Duas fases, uma em R1 e outra em R2: basta uma em R2. */
    const a = montar({ x: fase(500, true), y: fase(500, false) });
    t.verifica('duas revoltas na mesma cidade: basta uma em R2', a.janela(500) === true);
  }
  {
    /* Uma revolta que já acabou não conta. */
    const velha = { attributes: { target_town_id: 500, finished_at: AGORA - 10, arising: false } };
    const a = montar({ x: velha });
    t.verifica('revolta acabada: não conta', a.janela(500) === false);
  }

  t.secao('O QUE MUDA NA DECISÃO');
  {
    t.verifica('só se desliga a suspeita em mundos de revolta',
      /if \(temNC && mundoDeRevolta\) \{/.test(SRC));
    t.verifica('... e só quando a janela diz que não pode',
      /if \(pode === false\) \{\s*\n\s*temNC = false;/.test(SRC));
    t.verifica('a mensagem passa a dizer "PODE trazer"',
      /PODE trazer colonizador e não consigo trazer a tropa a tempo/.test(SRC));
    t.verifica('e a janela de cancelamento vem do jogo',
      /\(\(mUw\.GameData \|\| \{\}\)\.cancel_times \|\| \{\}\)\.unit_movements/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
