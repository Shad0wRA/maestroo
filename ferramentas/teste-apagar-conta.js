/* APAGAR UMA CONTA DO MAESTRO.
 *
 * Uma conta banida não volta a correr o Maestro. Fica no sinal de vida a fazer
 * o vigia disparar, nas equipas dos colonizadores a contar para o equilíbrio,
 * e a publicar revoltas que ninguém vai defender (17/09).
 *
 * O botão apaga-a de todos os sítios. É definitivo: se voltar, republica.
 *
 *   node ferramentas/teste-apagar-conta.js maestro.user.js
 */
const S = require('./simulador');
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('APAGAR UMA CONTA');

(async () => {
  const i = SRC.indexOf('APAGAR UMA CONTA DO MAESTRO');
  const bloco = SRC.slice(i, i + 7000);

  t.verifica('há um botão em cada linha da frota', i > 0
    && /data-desligar="\$\{esc\(x\.conta\)\}"/.test(SRC));
  t.verifica('pede confirmação antes de apagar',
    /if \(!mUw\.confirm\(/.test(bloco) && /É definitivo/.test(bloco));

  t.secao('O QUE APAGA');
  t.verifica('o sinal de vida na frota',
    /await fb\.escrever\(`frota\/\$\{w\}`, fr\);/.test(bloco));
  t.verifica('... procurando pelo nome, não pela chave',
    /if \(String\(\(fr\[k\] \|\| \{\}\)\.conta \|\| k\) === conta\)/.test(bloco));
  t.verifica('as equipas dos colonizadores',
    /await fb\.escrever\(`equipas\/\$\{w\}`, eq\);/.test(bloco));
  t.verifica('as revoltas que publicou',
    /await fb\.escrever\(`revoltasMultis\/\$\{w\}`, rv\);/.test(bloco));
  t.verifica('e o lugar que tivesse no fechar ilha',
    /delete p\.atribuicoes\[conta\];/.test(bloco)
    && /if \(p\.enviados\) delete p\.enviados\[conta\];/.test(bloco));

  t.secao('CUIDADOS');
  t.verifica('o nome é limpo antes de ir para um caminho do Firebase',
    /const chave = String\(conta\)\.replace\(/.test(bloco));
  t.verifica('sem Firebase, não se finge que apagou',
    /sem Firebase configurado — não há de onde apagar/.test(bloco));
  t.verifica('diz o que apagou',
    /apagada do Maestro \(\$\{apagados\.join\(', '\)\}\)/.test(bloco));

  t.secao('EM TODOS OS MUNDOS');
  /* Quem leva ban leva-o na conta, não num mundo: apagar só do mundo actual
   * deixava-a nos outros a fazer o vigia disparar (17/09). */
  t.verifica('os mundos descobrem-se pelo que está publicado',
    /for \(const raiz of \['frota', 'equipas', 'revoltasMultis'\]\)/.test(bloco));
  t.verifica('... e o mundo actual entra sempre',
    /const s = new Set\(\[mWorld\]\);/.test(bloco));
  t.verifica('apaga-se em cada um deles',
    /for \(const w of mundos\) \{/.test(bloco));
  t.verifica('e o aviso diz que é em todos',
    /do Maestro, em TODOS os mundos\?/.test(SRC));
  t.verifica('... e diz quando não havia nada',
    /já não estava em lado nenhum/.test(bloco));
  t.verifica('cada sítio é apagado à parte: um erro não impede os outros',
    (bloco.match(/catch \(e\) \{ seErroDeCodigo\(e, 'Frota'\); \}/g) || []).length >= 4);
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
