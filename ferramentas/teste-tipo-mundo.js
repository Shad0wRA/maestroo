/* CADA MÓDULO NO SEU TIPO DE MUNDO.
 *
 * O apoio distribuído só faz sentido onde há revoltas para aguentar; o partir
 * cercos só onde há cercos. Ter os dois na barra em todo o lado confundia, e
 * um deles estava sempre a correr sem ter o que fazer (18/09).
 *
 * O tipo descobre-se no jogo: só os mundos de revolta carregam a colecção
 * `MovementsRevoltDefender` — confirmado no pt126 (tem) e no pt125 (não tem).
 *
 *   node ferramentas/teste-tipo-mundo.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('TIPO DE MUNDO');

function montar(deRevolta, mundo) {
  const ctx = {
    WORLD: mundo || 'pt126',
    uw: {
      /* Um mundo real tem sempre dezenas de modelos carregados; o que
       * distingue é a presença da colecção das revoltas. */
      MM: { getModels: () => (deRevolta === null ? null
        : (deRevolta
          ? { Town: {}, Units: {}, MovementsRevoltDefender: {} }
          : { Town: {}, Units: {} })) },
    },
    console,
  };
  vm.createContext(ctx);
  /* O `tipoSabido` guarda a resposta: os modelos podem ser recarregados e
   * ficar por instantes sem a colecção das revoltas, e isso faria um mundo de
   * revolta parecer de cerco (18/09). */
  const i = SRC.indexOf('  let tipoSabido = \'\';');
  const f = SRC.indexOf('\n  try { uw.__maestroTipoDoMundo', i);
  return vm.runInContext('(() => {\n' + SRC.slice(i, f)
    + '\nreturn { tipo: tipoDoMundo, aplica: modAplicaAoMundo };\n})()', ctx);
}

(async () => {
  t.secao('O TIPO');
  {
    t.verifica('com a colecção das revoltas, é de revolta', montar(true).tipo() === 'revolta');
    t.verifica('sem ela, é de cerco', montar(false).tipo() === 'cerco');
  }

  t.secao('QUEM CORRE ONDE');
  {
    const r = montar(true);
    t.verifica('num mundo de revolta, o apoio corre',
      r.aplica({ id: 'apoio', tipoDeMundo: 'revolta' }) === true);
    t.verifica('... e o partir cercos não',
      r.aplica({ id: 'partircerco', tipoDeMundo: 'cerco' }) === false);
  }
  {
    const c = montar(false);
    t.verifica('num mundo de cerco, o partir cercos corre',
      c.aplica({ id: 'partircerco', tipoDeMundo: 'cerco' }) === true);
    t.verifica('... e o apoio não',
      c.aplica({ id: 'apoio', tipoDeMundo: 'revolta' }) === false);
  }
  {
    const r = montar(true);
    t.verifica('um módulo sem tipo corre em todo o lado',
      r.aplica({ id: 'construcao' }) === true);
  }
  {
    /* Se não se souber o tipo, mais vale um módulo a mais do que a menos.
     * Acontece no arranque, antes de o jogo carregar os modelos: devolver
     * "cerco" fazia o apoio desaparecer da barra num mundo de revolta
     * (apanhado em teste, 18/09). */
    const x = montar(null);
    t.verifica('sem modelos, o tipo fica por saber', x.tipo() === '');
    t.verifica('... e deixa-se passar tudo',
      x.aplica({ id: 'apoio', tipoDeMundo: 'revolta' }) === true
      && x.aplica({ id: 'partircerco', tipoDeMundo: 'cerco' }) === true);
  }
  {
    const r = montar(true, 'pt126');
    t.verifica('a lista de mundos continua a valer',
      r.aplica({ id: 'x', worlds: ['pt999'] }) === false);
    t.verifica('... e combina-se com o tipo',
      r.aplica({ id: 'x', worlds: ['pt126'], tipoDeMundo: 'revolta' }) === true);
  }

  t.secao('OS MÓDULOS ESTÃO MARCADOS');
  {
    t.verifica('o apoio é de revolta',
      /nome: 'Apoio distribuído',[\s\S]{0,400}tipoDeMundo: 'revolta',/.test(SRC));
    t.verifica('o partir cercos é de cerco',
      /nome: 'Partir cercos',[\s\S]{0,300}tipoDeMundo: 'cerco',/.test(SRC));
  }
  t.secao('QUANDO O TIPO SÓ SE SABE DEPOIS');
  {
    /* A barra é desenhada no arranque, e nessa altura os modelos ainda não
     * estão carregados: passavam os módulos todos e ficava o Apoio na barra de
     * um mundo de cerco. Reabrir o painel não o tirava, porque a lista já
     * estava feita (18/09). */
    t.verifica('a barra refaz-se quando o tipo passa a ser conhecido',
      /O TIPO DO MUNDO SÓ SE SABE DEPOIS DE O JOGO CARREGAR/.test(SRC)
      && /if \(tipoDoMundo\(\)\) \{ clearInterval\(espreitar\); desenhar\(\); return; \}/.test(SRC));
    t.verifica('... e desiste ao fim de um minuto',
      /if \(tentativas > 60\) clearInterval\(espreitar\);/.test(SRC));
    t.verifica('uma vez sabido, não se volta a perguntar',
      /if \(tipoSabido\) return tipoSabido;/.test(SRC)
      && /tipoSabido = m\.MovementsRevoltDefender \? 'revolta' : 'cerco';/.test(SRC));
  }
  {
    /* E a resposta guardada não muda se os modelos desaparecerem. */
    const a = montar(true);
    t.verifica('o tipo guardado resiste a uma recarga dos modelos',
      a.tipo() === 'revolta' && a.tipo() === 'revolta');
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
