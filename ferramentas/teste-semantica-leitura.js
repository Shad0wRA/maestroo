/* TODA A LEITURA DIZ O QUE É.
 *
 * Uma lista vazia pode querer dizer "não há nada" ou "não consegui ler".
 * Confundi-las custou caro, e sempre da mesma maneira: as sentinelas a
 * concluir "está a descoberto" sem saber; o reforço a dar tropa por perdida
 * com modelos incompletos; o apoio a decidir retiradas com números da Ágora
 * de cinco horas antes; a esquiva a tomar falta de dados por ausência de
 * ataque. Quatro módulos, o mesmo buraco (15-17/09).
 *
 * Agora uma leitura traz quando foi feita, se está completa e de onde veio —
 * e há uma regra única: não se age sobre uma leitura incompleta ou velha.
 *
 *   node ferramentas/teste-semantica-leitura.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('SEMÂNTICA DA LEITURA');

function api() {
  const ctx = { Date, Number, console };
  vm.createContext(ctx);
  const i = SRC.indexOf('  function leitura(valor, opcoes) {');
  const f = SRC.indexOf('\n  try {\n    uw.__maestroLeitura', i);
  return vm.runInContext('(() => {\n' + SRC.slice(i, f)
    + '\nreturn { nova: leitura, podeAgir: podeAgirCom, porque: porqueNaoPosso };\n})()', ctx);
}

(async () => {
  const a = api();
  {
    const l = a.nova([1, 2, 3]);
    t.verifica('uma leitura normal traz os dados', l.valor.length === 3 && l.ok);
    t.verifica('... e diz-se completa por omissão', l.completa === true);
    t.verifica('... com a hora e a origem', l.quando > 0 && l.origem === 'servidor', l);
    t.verifica('e pode agir-se com ela', a.podeAgir(l) === true);
  }
  {
    /* O caso que custou caro: lista vazia mas leitura boa. */
    const l = a.nova([], { completa: true });
    t.verifica('lista vazia com leitura completa: pode agir-se',
      a.podeAgir(l) === true && l.valor.length === 0);
  }
  {
    /* E o inverso: lista vazia porque não se conseguiu ler. */
    const l = a.nova([], { ok: false, completa: false, razao: 'sem Administrador' });
    t.verifica('lista vazia por falha: NÃO se age', a.podeAgir(l) === false);
    t.verifica('... e diz-se porquê', /Administrador/.test(a.porque(l)), a.porque(l));
  }
  {
    const l = a.nova([1], { completa: false });
    t.verifica('leitura incompleta: não se age', a.podeAgir(l) === false);
    t.verifica('... e diz-se que está incompleta', /incompleta/.test(a.porque(l)), a.porque(l));
  }
  {
    const velha = a.nova([1], { quando: Date.now() - 3600 * 1000 });
    t.verifica('leitura de há uma hora, com validade de 35 min: não se age',
      a.podeAgir(velha, 35 * 60 * 1000) === false);
    t.verifica('... e diz há quanto tempo é', /60 min/.test(a.porque(velha, 35 * 60 * 1000)),
      a.porque(velha, 35 * 60 * 1000));
    t.verifica('sem validade pedida, a idade não conta', a.podeAgir(velha) === true);
  }
  {
    t.verifica('sem leitura nenhuma: não se age', a.podeAgir(null) === false);
  }

  t.secao('QUEM JÁ A USA');
  {
    t.verifica('a visão geral diz se está completa e de onde veio',
      /completa: true,\s*\n\s*origem: daCopia \? 'copia' : 'servidor',/.test(SRC));
    t.verifica('... e uma falha marca-se como incompleta',
      /completa: false, origem: 'servidor',/.test(SRC));
    t.verifica('as sentinelas perguntam se podem agir',
      /if \(l && !l\.podeAgir\(daAgora\)\) return null;/.test(SRC));
    t.verifica('... e mantêm a regra antiga se a semântica faltar',
      /if \(!l && !frescas\) return null;/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
