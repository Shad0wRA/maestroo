/* O PAINEL — o que ocupa espaço e o que não precisa de lá estar.
 *
 * A lista do estado tinha os vinte e dois módulos, um por linha, e enchia meio
 * painel com "Auto-construção, 6 min" — que não diz nada. E a configuração que
 * se mexe uma vez por conta estava toda aberta (16/09).
 *
 *   node ferramentas/teste-painel.js maestro.user.js
 */
const S = require('./simulador');
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('PAINEL');

(async () => {
  {
    const i = SRC.indexOf('SÓ O QUE ESTÁ A CORRER E O QUE ESTÁ ATRASADO');
    const bloco = SRC.slice(i, i + 2000);
    t.verifica('a lista do estado mostra o que corre e o que está atrasado', i > 0
      && /ligados\.filter\(\(m\) => \(modState\[m\.id\] \|\| \{\}\)\.aCorrer \|\| atrasado\(m\)\)/.test(bloco));
    t.verifica('... conta o resto numa linha só',
      /\$\{emDia\} módulo\(s\) em dia/.test(bloco));
    t.verifica('... e atrasado é ter passado da hora por mais de um minuto',
      /\(Date\.now\(\) - st\.proximaExec\) > 60 \* 1000/.test(bloco));
  }
  {
    t.verifica('a configuração de perfil e partilha está numa secção fechada',
      /<summary style="cursor:pointer;font-size:11px;font-weight:600">perfil e partilha<\/summary>/.test(SRC));
    t.verifica('a caixa do Gist saiu do painel',
      !/maestro-gist-id/.test(SRC) && !/maestro-gist-guardar/.test(SRC));
    t.verifica('... mas a leitura do Gist fica como reserva',
      /api\.github\.com\/gists/.test(SRC));
  }
  {
    const i = SRC.indexOf('<div id="maestro-modulos"></div>');
    const bloco = SRC.slice(i - 9000, i);
    t.verifica('as secções do painel abrem e fecham todas',
      (bloco.match(/<details/g) || []).length === (bloco.match(/<\/details>/g) || []).length,
      (bloco.match(/<details/g) || []).length + ' vs ' + (bloco.match(/<\/details>/g) || []).length);
  }
  t.secao('O BOTÃO E O FECHAR');
  {
    /* Metido dentro da caixa do retrato, o botão ficava por trás da moldura:
     * existia, tinha tamanho e estava visível, mas não se via (18/09). */
    /* Primeiro foi uma barra a flutuar por cima do mapa; depois um botão com
     * o nome, que ficou escondido por trás da moldura do retrato. O que
     * faltava era parecer parte do jogo: um círculo pequeno com um M, no
     * espaço livre à esquerda do retrato (18/09). */
    /* Quatro sítios até acertar: a flutuar por cima do mapa, dentro da caixa
     * do retrato (por trás da moldura), ao lado do retrato (espaço do
     * DIO-Tools) e fixo em coordenadas escritas à mão — pequeno e no sítio
     * errado. Agora encosta ao nome da cidade e é maior; onde exactamente,
     * está no teste-botao-seletor (18/09). */
    t.verifica('é um círculo com um M, ao lado do nome da cidade',
      /UM CÍRCULO, COMO OS DO JOGO/.test(SRC)
      && /AO LADO DO SELETOR DE CIDADE/.test(SRC)
      && /'width:28px', 'height:28px', 'border-radius:50%',/.test(SRC));
    t.verifica('... com um M e não o nome todo',
      /btn\.innerHTML = '<span id="maestro-btn-luz"><\/span><span>M<\/span>';/.test(SRC));
    t.verifica('... e fixo: arrastá-lo punha-o fora do ecrã',
      /if \(naBarraDoJogo\) return;\s*\n\s*aArrastar = true; moveu = false;/.test(SRC));
    t.verifica('a luz do estado passa a ser o anel à volta',
      /if \(naBarraDoJogo\) el\.style\.borderColor = cor;/.test(SRC));
    /* Dentro das caixas do jogo já ficou escondido duas vezes: por trás da
     * moldura do retrato, e por baixo de um painel do DIO-Tools. */
    t.verifica('... e não depende de nenhum contentor do jogo',
      /Vai sempre para o corpo da página/.test(SRC)
      && /document\.body\.appendChild\(btn\);/.test(SRC));
  }
  {
    /* O painel tapa meio ecrã e só fechava carregando outra vez no botão —
     * que às vezes fica por baixo dele (18/09). */
    t.verifica('o Esc fecha o painel',
      /if \(ev\.key !== 'Escape'\) return;/.test(SRC));
    t.verifica('... mas não enquanto se escreve num campo',
      /if \(act && \/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(act\.tagName\)\) return;/.test(SRC));
    t.verifica('clicar fora também fecha',
      /if \(pn\.contains\(ev\.target\) \|\| btn\.contains\(ev\.target\)\) return;/.test(SRC));
    t.verifica('... e o clique que abre não o fecha logo a seguir',
      /try \{ ev\.stopPropagation\(\); \} catch \(e\) \{\}/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
