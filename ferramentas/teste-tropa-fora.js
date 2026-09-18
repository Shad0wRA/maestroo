/* QUEM MEXE NA TROPA QUE ESTÁ FORA DE CASA.
 *
 * Cinco módulos põem tropa em cidades que não são a de origem — apoio,
 * reforço sob ataque, sentinelas, esquiva e rotação de colonos. Este ficheiro
 * verifica que não se estragam uns aos outros.
 *
 *   node ferramentas/teste-tropa-fora.js maestro.user.js
 */
const S = require('./simulador');
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('TROPA FORA DE CASA');

const entre = (a, b) => {
  const i = SRC.indexOf(a);
  return i < 0 ? '' : SRC.slice(i, b ? SRC.indexOf(b, i) : i + 3000);
};

(async () => {
  t.secao('O APOIO');
  {
    const bloco = entre('O QUE NÃO É DO APOIO NÃO SE MEXE', 'for (const cidade of ondeTenho)');
    t.verifica('retira de alvos que já não estão na lista', bloco.length > 0);
    t.verifica('... mas não toca nas sentinelas, que têm registo próprio',
      (SRC.match(/doSentinelas\.has\(onde\)/g) || []).length === 2
      && /grepoSentinelas_enviadas_v1/.test(SRC));
    t.verifica('... nem no reforço sob ataque',
      (SRC.match(/doReforco\.has\(onde\)/g) || []).length === 2);
    t.verifica('só as MULTIS retiram o que não está no registo do apoio',
      (SRC.match(/!enviadoPorMim\.has\(onde\) && !souMulti\(\)/g) || []).length === 2);
    t.verifica('... e quem decide é o perfil',
      /String\(esc\.perfil \|\| ''\)\.toLowerCase\(\) === 'multi'/.test(SRC));
    t.verifica('... nem nos colonizadores da rotação',
      /if \(\(Number\(a\.colonize_ship\) \|\| 0\) > 0\) continue;/.test(SRC));
    t.verifica('... nem nas bases dos colonos',
      (SRC.match(/doColonos\.has\(onde\)/g) || []).length >= 2);
  }

  t.secao('O REFORÇO SOB ATAQUE');
  {
    t.verifica('não traz um bloco que tenha tropa de outros',
      /tem em \$\{nomeDe\(e\.destino\)\} mais do que o reforço/.test(SRC));
    t.verifica('retira pela hora marcada no envio, não por leitura',
      /const horaOrdem = Number\(e\.retirarAs\)/.test(SRC));
    t.verifica('e não defende contra as minhas próprias contas',
      /NÃO SE DEFENDE DE SI PRÓPRIO/.test(SRC));
  }

  t.secao('AS SENTINELAS');
  {
    t.verifica('não aparecem como defesa no painel da frota',
      /AS SENTINELAS NÃO SÃO DEFESA/.test(SRC) && /\.filter\(\(l\) => l\.total >= 10\)/.test(SRC));
    t.verifica('só decidem com leitura fresca da Ágora',
      /const frescas = \(\(api\.lidas && api\.lidas\(35 \* 60 \* 1000\)\) \|\| \[\]\)\.length;/.test(SRC));
  }

  t.secao('A ESQUIVA E OS COLONOS');
  {
    t.verifica('a esquiva não usa cidades com envio agendado do reforço',
      /TROPA JÁ COMPROMETIDA NÃO SE MANDA/.test(SRC));
    t.verifica('a rotação de colonos respeita os colonizadores reservados',
      /O QUE ESTÁ RESERVADO FICA MESMO EM CASA/.test(SRC));
    t.verifica('e a fundação também',
      /O QUE ESTÁ GUARDADO NÃO SE GASTA/.test(SRC));
  }
  t.secao('OS PEDIDOS E O PAINEL');
  {
    /* Um pedido de reforçar para uma cidade que saiu da lista não tem onde ser
     * entregue, e mantinha as contas a mandar tropa (16/09). */
    t.verifica('os pedidos de alvos fora da lista apagam-se',
      /E OS PEDIDOS DE REFORÇAR OU REPOR/.test(SRC)
      && /if \(alvoP && !vivos2\.has\(alvoP\)\) \{ delete pend\[k\]; mexeu2 = true; \}/.test(SRC));
    /* O Apoio fala com o Firebase pelo `fbLerM`/`fbEscreverM`. Chamei um
     * `fb()` que não existe lá e o módulo rebentou (16/09). */
    t.verifica('... usando o acesso ao Firebase que o Apoio tem',
      /const pend = \(await fbLerM\(fbCaminhoPedidos\(\)\)\) \|\| \{\};/.test(SRC)
      && /await fbEscreverM\(fbCaminhoPedidos\(\), pend\);/.test(SRC));
    {
      const a = SRC.indexOf('function makeApoioModule');
      const b = SRC.indexOf('\nfunction make', a + 10);
      t.verifica('... e não sobra nenhuma chamada a fb() no módulo',
        !/[^a-zA-Z_.]fb\(\)/.test(SRC.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, '')));
    }
    t.verifica('o painel da frota separa esta conta da frota inteira',
      /function htmlInventarioDaConta\(\)/.test(SRC)
      && /caixa\.innerHTML = \(qual === 'conta'\) \? htmlInventarioDaConta\(\) : htmlInventario\(contas\);/.test(SRC));
    t.verifica('... e lembra-se da aba escolhida',
      /localStorage\.setItem\('grepoFrota_aba_v1', qual\)/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
