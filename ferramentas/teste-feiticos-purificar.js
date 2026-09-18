/* FEITIÇOS — purificar antes de repetir, sem deitar fora o que é meu.
 *
 * A Ira de Zeus falhou num ataque que já tinha feitiço e o jogo respondeu
 * "Ocorreu um erro interno!" — sem dizer porquê (visto em jogo, 15/09). A
 * purificação resolve, e é barata ao lado do que a Ira faz.
 *
 * Mas a purificação limpa os feitiços ACTIVOS, sejam de quem forem: se já lá
 * estiver um dos meus que fica activo — a Saudade, por exemplo — purificar
 * seria deitá-lo fora. A Ira e a tempestade não ficam activas (confirmado
 * contigo, 15/09).
 *
 *   node ferramentas/teste-feiticos-purificar.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('FEITIÇOS — PURIFICAR');
const FE = 'function makeFeiticosModule(opts)';

function api() {
  const ctx = { console, String, Number, Object };
  vm.createContext(ctx);
  const i = SRC.indexOf('  const FICAM_ACTIVOS = [');
  const f = SRC.indexOf('\n  function nomeDoFeitico(id) {', i);
  return vm.runInContext('(() => {\n' + SRC.slice(i, f)
    + '\nreturn { fica: feiticoFicaActivo, lista: FICAM_ACTIVOS };\n})()', ctx);
}

(async () => {
  const a = api();
  {
    /* Os oito que ficam activos, pelos nomes que o jogo usa. */
    for (const [id, nome] of [
      ['ares_army', 'Exército de Ares'], ['bloodlust', 'Sede de Sangue'],
      ['fair_wind', 'Vento favorável'], ['desire', 'Saudade'],
      ['strength_of_heroes', 'Poder heroico'], ['resurrection', 'Retorno do mundo dos mortos'],
      ['cap_of_invisibility', 'Elmo da invisibilidade'], ['effort_of_the_huntress', 'Alvo da caçadora'],
    ]) {
      t.verifica(`${nome} fica activo`, a.fica(id) === true, id);
    }
  }
  {
    t.verifica('a Ira de Zeus NÃO fica activa', a.fica('transformation') === false);
    t.verifica('a tempestade no mar também não', a.fica('sea_storm') === false);
    t.verifica('a purificação não conta', a.fica('cleanse') === false);
  }
  {
    /* O "erro interno" passa a contar como ocupado — é o que o jogo
     * respondeu. */
    const ctx = { console };
    vm.createContext(ctx);
    const i = SRC.indexOf("        ocupado: /j[áa] foi lan[çc]ado");
    const bloco = SRC.slice(i, i + 220);
    /* Cheguei a pôr o "erro interno" como alvo ocupado, e estava errado:
     * purificou-se, o alvo estava limpo, e a Ira falhou na mesma. Era o
     * identificador do comando (15/09). */
    t.verifica('"erro interno" NÃO conta como ocupado', !/erro interno/.test(bloco), bloco.slice(0, 120));
  }
  {
    t.verifica('não se purifica por cima de um feitiço meu',
      /não purifico para não o deitar fora/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
