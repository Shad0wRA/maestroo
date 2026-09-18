/* AS PEÇAS NOVAS NÃO SE ESTRAGAM UMAS ÀS OUTRAS.
 *
 * Num dia entraram o broker, a ligação aberta, o partir cercos e o reforço
 * partilhado — e várias mexem no mesmo sítio. Este ficheiro guarda as três
 * interacções que estavam erradas quando se foi ver (18/09).
 *
 *   node ferramentas/teste-interacoes-novas.js maestro.user.js
 */
const S = require('./simulador');
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('INTERACÇÕES');

(async () => {
  t.secao('O BROKER E O ENCAIXE');
  {
    /* O broker impõe uma pausa entre pedidos — é o que evita as rajadas. Mas
     * o Encaixe existe para acertar ao segundo: um envio que espera 600 ms na
     * fila chega tarde e o trabalho todo dele fica perdido. */
    t.verifica('há uma via sem fila para quem acerta ao segundo',
      /O QUE ACERTA AO SEGUNDO NÃO ESPERA/.test(SRC)
      && /if \(prioridade === -1\) \{/.test(SRC));
    t.verifica('... e o encaixe usa-a',
      /if \(p\) return p\(url, opcoes, -1\);/.test(SRC));
    t.verifica('a via sem fila não espera nem verifica a pausa',
      /pedidosEstado\.feitos\+\+;\s*\n\s*ultimoPedidoEm = Date\.now\(\);\s*\n\s*try \{ return uw\.fetch/.test(SRC));
    t.verifica('e é a ÚNICA excepção — mais ninguém usa a prioridade -1',
      (SRC.match(/, -1\);/g) || []).length === 1,
      (SRC.match(/, -1\);/g) || []).length + ' sítios');
  }

  t.secao('O REFORÇO E O PARTIR CERCOS');
  {
    /* Os dois reagiam ao mesmo colonizador: o reforço enchia a cidade de
     * tropa e o partir cercos mandava as vinte contas atacá-la. Ou a defesa
     * aguentava e os faróis batiam na tropa que acabámos de lá pôr, ou caía e
     * perdeu-se tropa a mais. */
    t.verifica('num mundo de cerco, o reforço não trata de colonizadores',
      /NUM MUNDO DE CERCO, UM COLONIZADOR É OUTRO CASO/.test(SRC)
      && /ataques = ataques\.filter\(\(x\) => !\/takeover\/i\.test\(String\(x\.tipo \|\| x\.type \|\| ''\)\)\);/.test(SRC));
    t.verifica('... e diz porquê no registo',
      /ficam para o "Partir cercos"/.test(SRC));
    t.verifica('o tipo do ataque é guardado, senão não havia como distinguir',
      /tipo: String\(x\.type \|\| ''\)/.test(SRC));
    t.verifica('... também no caminho sem Administrador',
      /out\.set\(chaveDe\(0, alvo, chega\), \{ alvo, chega, tipo, semHora: !chega \}\);/.test(SRC));
    t.verifica('e nos mundos de revolta nada disto se aplica',
      /Nos mundos de revolta isto não se aplica/.test(SRC));
  }

  t.secao('A LIGAÇÃO ABERTA E O TIPO DO MUNDO');
  {
    /* Há uma ligação por conta. Nos mundos de cerco ficava presa à lista do
     * apoio, que lá nem corre. */
    t.verifica('a ligação vai para o que aquele mundo usa',
      /const caminho = deCerco \? `cercos\/\$\{WORLD\}` : `apoio\/\$\{WORLD\}`;/.test(SRC));
    t.verifica('... e acorda o módulo certo de cada lado',
      /if \(deCerco\) \{\s*\n\s*acordar\('partircerco', 0\);/.test(SRC));
  }

  t.secao('O QUE JÁ ESTAVA CERTO');
  {
    t.verifica('o apoio e o partir cercos nunca correm no mesmo mundo',
      /tipoDeMundo: 'revolta',/.test(SRC) && /tipoDeMundo: 'cerco',/.test(SRC));
    t.verifica('o vigia acorda o partir cercos só com colonizadores',
      /if \(novos\.some\(\(a\) => \/takeover\/i\.test\(String\(a\.type \|\| ''\)\)\)\) \{/.test(SRC));
    t.verifica('e o reforço partilhado manda apoio, não ataque',
      /tipo: 'support',/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
