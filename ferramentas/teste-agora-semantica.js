/* A ÁGORA DIZ O QUE A LEITURA É.
 *
 * O `porAlvo` devolvia o que se leu. Vazio, não se sabia se não havia tropa
 * fora ou se a leitura falhou — e foi dessa confusão que vieram os erros que
 * ocuparam dois dias: o apoio a retirar com números de horas antes, as
 * sentinelas a duplicar tropa, o reforço a dar comandos por perdidos.
 *
 * Agora a leitura traz quando foi feita, que cidades cobre e quais faltam. E a
 * retirada — a decisão mais cara do módulo — só acontece nas cidades cuja
 * Ágora foi lida há pouco.
 *
 *   node ferramentas/teste-agora-semantica.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('ÁGORA — SEMÂNTICA');

const AGORA = Date.now();

/* `cache` são as leituras guardadas; `minhas` as cidades desta conta. */
function montar(cache, minhas) {
  const sem = (() => {
    const c = {}; vm.createContext(c);
    const i = SRC.indexOf('  function leitura(valor, opcoes) {');
    const f = SRC.indexOf('\n  try {\n    uw.__maestroLeitura', i);
    return vm.runInContext('(() => {\n' + SRC.slice(i, f)
      + '\nreturn { nova: leitura, podeAgir: podeAgirCom, porque: porqueNaoPosso };\n})()', c);
  })();

  const ctx = {
    uw: {
      __maestroLeitura: sem,
      ITowns: { towns: Object.fromEntries((minhas || []).map((id) => [id, {}])) },
    },
    lerCacheApoioFora: () => cache,
    apoioForaPorAlvo: () => ({ 500: { unidades: { sword: 10 } } }),
    APOIO_FORA_VALIDADE: 30 * 60 * 1000,
    Date, Number, Object, String, console,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('      leitura: (validadeMs) => {');
  const f = SRC.indexOf('\n      },', i) + 8;
  return vm.runInContext('(() => { const o = {\n' + SRC.slice(i, f) + '\n}; return o.leitura; })()', ctx);
}

(async () => {
  {
    /* Tudo lido agora: leitura completa. */
    const f = montar({ 111: { quando: AGORA }, 222: { quando: AGORA } }, [111, 222]);
    const l = f(35 * 60 * 1000);
    t.verifica('com todas as cidades lidas, a leitura é completa', l.completa === true, l);
    t.verifica('... e diz quais cobre', l.valor.cobertas.length === 2, l.valor);
    t.verifica('... e que não falta nenhuma', l.valor.emFalta.length === 0, l.valor);
  }
  {
    /* Metade lida: incompleta, e diz quais faltam. */
    const f = montar({ 111: { quando: AGORA } }, [111, 222]);
    const l = f(35 * 60 * 1000);
    t.verifica('com metade lida, a leitura é incompleta', l.completa === false, l);
    t.verifica('... e diz qual falta', l.valor.emFalta[0] === 222, l.valor);
    t.verifica('... com a razão escrita', /1 cidade\(s\) por ler/.test(l.razao), l.razao);
  }
  {
    /* Leitura velha: não conta como coberta. */
    const f = montar({ 111: { quando: AGORA - 3600 * 1000 } }, [111]);
    const l = f(35 * 60 * 1000);
    t.verifica('uma leitura de há uma hora não conta', l.valor.cobertas.length === 0, l.valor);
    t.verifica('... e a leitura dá-se por falhada', l.ok === false, l);
    t.verifica('... dizendo porquê', /não foi lida/.test(l.razao), l.razao);
  }
  {
    /* Sem cidades lidas de todo. */
    const f = montar({}, [111, 222]);
    const l = f(35 * 60 * 1000);
    t.verifica('sem nenhuma leitura: não está ok', l.ok === false && l.completa === false, l);
  }

  t.secao('A RETIRADA SÓ ONDE A LEITURA É FRESCA');
  {
    /* A Ágora é lida a duas cidades por passagem: exigir que cubra as 63
     * bloquearia a retirada para sempre. */
    t.verifica('guardam-se as cidades com leitura fresca',
      /cidadesComLeituraFresca = new Set\(\(est && est\.valor && est\.valor\.cobertas\) \|\| \[\]\);/.test(SRC));
    t.verifica('... e só dessas se retira',
      /if \(!cidadesComLeituraFresca\.has\(Number\(c\)\)\) ondeTenho\.delete\(c\);/.test(SRC));
    t.verifica('as outras ficam para a próxima passagem, com o motivo dito',
      /a Ágora delas não foi lida há pouco/.test(SRC));
    t.verifica('e não se exige a leitura toda',
      /NÃO SE EXIGE A LEITURA TODA — EXIGE-SE A DA CIDADE/.test(SRC));
  }
  t.secao('O RITMO DA LEITURA')
  {
    /* Com duas cidades por passagem e 63 cidades, uma volta completa demora
     * perto de uma hora — e as primeiras leituras já passaram dos 35 minutos
     * quando se chega ao fim. Com cinco, a volta faz-se em vinte e tal
     * minutos (17/09). */
    t.verifica('lêem-se cinco cidades por passagem',
      /api\.candidatas\(meus\) \|\| \[\]\)\)\), 5\);/.test(SRC));
    t.verifica('... e a volta completa cabe na validade da leitura',
      (() => {
        const CIDADES = 63, PORPASSAGEM = 5, PASSAGEM_MIN = 2, VALIDADE_MIN = 35;
        return Math.ceil(CIDADES / PORPASSAGEM) * PASSAGEM_MIN < VALIDADE_MIN;
      })(), Math.ceil(63 / 5) * 2 + ' min por volta, validade 35 min');
  }
  t.secao('O DONO DA CIDADE ONDE A TROPA ESTÁ');
  {
    /* Vem no bloco da leitura de uma vez e estava a ser deitado fora. É o que
     * permite saber que um alvo mudou de mãos: a 2385, tomada ao Jomaras,
     * aparecia no painel como dele e parecia um erro (17/09). */
    t.verifica('a leitura guarda o dono de cada bloco',
      /donoId: Number\(l\.player_id\) \|\| 0,/.test(SRC)
      && /donoNome: String\(l\.player_name \|\| ''\)\.trim\(\),/.test(SRC));
    t.verifica('... e chega ao resto do módulo',
      /if \(b\.donoId && !alvo\.donoId\) \{ alvo\.donoId = b\.donoId; alvo\.donoNome = b\.donoNome; \}/.test(SRC));
    t.verifica('o painel mostra o dono de agora, não o guardado',
      /O DONO DE AGORA, NÃO O DE QUANDO SE LEU/.test(SRC)
      && /donoAgora\[id\] \? \{ jogador: donoAgora\[id\] \} : \{\}/.test(SRC));
    t.verifica('... e mantém o guardado quando não há leitura',
      /const info = Object\.assign\(\{\}, guardado,/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
