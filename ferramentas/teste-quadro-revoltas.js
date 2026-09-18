/* O QUADRO DAS REVOLTAS ACTIVAS.
 *
 * Uma mensagem só, mandada pela conta principal, com todas as revoltas do
 * grupo — main e multis. Cada linha diz a cidade, de que conta é, quem a
 * revoltou, quanto falta e quanta tropa já lá está.
 *
 * Só sai quando a lista MUDA: uma revolta nova ou uma que acabou. Sem isso,
 * seria um quadro igual ao anterior de meia em meia hora (17/09).
 *
 *   node ferramentas/teste-quadro-revoltas.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('QUADRO DAS REVOLTAS');
const AP = 'function makeApoioModule(opts)';

const AGORA = Math.floor(Date.now() / 1000);

function montar(frota, guardadoInicial) {
  const loja = { grepoApoio_quadroRevoltas_v1: guardadoInicial || '' };
  const avisos = [];
  const ctx = {
    mWorld: 'pt126',
    fbLerM: async () => frota,
    fbUrlM: () => 'https://x',
    localStorage: {
      getItem: (k) => (k in loja ? loja[k] : null),
      setItem: (k, v) => { loja[k] = v; },
    },
    seErroDeCodigo: () => {},
    Date, Math, Number, Object, String, console,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('  const QUADRO_KEY =');
  const f = SRC.indexOf('\n  /* ============ SÓ A CONTA PRINCIPAL TIRA ALVOS', i);
  const api = vm.runInContext('(() => {\n' + SRC.slice(i, f)
    + '\nreturn { quadro: quadroDasRevoltas };\n})()', ctx);
  return { api, avisos, ctx: { avisarDiscord: async (c, m) => avisos.push(m) }, loja };
}

const revolta = (nome, quem, emR1, faltaMin) => ({
  nome, quem: [quem], emR1, ultima: AGORA + faltaMin * 60,
});

(async () => {
  {
    const m = montar({
      a: { conta: 'Multi1', quando: AGORA, apoio: { alvos: { 500: { u: { sword: 1500, bireme: 500 } } } } },
    });
    const r = await m.api.quadro(m.ctx, {
      revoltasAuto: { 500: revolta('55.6', 'Jomaras', true, 200) },
    });
    t.verifica('manda o quadro quando há revolta', r === true && m.avisos.length === 1);
    const q = m.avisos[0] || {};
    t.verifica('o título diz quantas são', /1/.test(q.titulo || ''), q.titulo);
    const linha = (q.campos || [])[0] || {};
    t.verifica('a linha tem a cidade', /55\.6/.test(linha.nome || ''), linha);
    t.verifica('... quem a revoltou', /Jomaras/.test(linha.valor || ''), linha.valor);
    t.verifica('... a fase e o tempo que falta',
      /R1/.test(linha.valor || '') && /200 min/.test(linha.valor || ''), linha.valor);
    t.verifica('... e a tropa que lá está',
      /2[\s.,]?000 de tropa/.test(linha.valor || ''), linha.valor);
  }
  {
    /* A mesma lista não se repete. */
    const m = montar({}, '');
    const lista = { revoltasAuto: { 500: revolta('55.6', 'X', true, 100) } };
    await m.api.quadro(m.ctx, lista);
    const r2 = await m.api.quadro(m.ctx, lista);
    t.verifica('não repete um quadro igual', r2 === false && m.avisos.length === 1, m.avisos.length);
  }
  {
    /* Uma revolta nova muda a lista. */
    const m = montar({}, '');
    await m.api.quadro(m.ctx, { revoltasAuto: { 500: revolta('A', 'X', true, 100) } });
    await m.api.quadro(m.ctx, {
      revoltasAuto: { 500: revolta('A', 'X', true, 100), 600: revolta('B', 'Y', false, 50) },
    });
    t.verifica('uma revolta nova gera quadro novo', m.avisos.length === 2, m.avisos.length);
  }
  {
    /* Mudar de R1 para R2 também conta. */
    const m = montar({}, '');
    await m.api.quadro(m.ctx, { revoltasAuto: { 500: revolta('A', 'X', true, 100) } });
    await m.api.quadro(m.ctx, { revoltasAuto: { 500: revolta('A', 'X', false, 60) } });
    t.verifica('passar de R1 a R2 gera quadro novo', m.avisos.length === 2, m.avisos.length);
  }
  {
    /* Acabaram todas: avisa uma vez. */
    const m = montar({}, '500:R1');
    const r = await m.api.quadro(m.ctx, { revoltasAuto: {} });
    t.verifica('quando acabam todas, diz que acabaram',
      r === true && /Sem revoltas/.test((m.avisos[0] || {}).titulo || ''), m.avisos);
  }
  {
    /* Sem revoltas e sem nada antes: não manda nada. */
    const m = montar({}, '');
    const r = await m.api.quadro(m.ctx, { revoltasAuto: {} });
    t.verifica('sem revoltas e sem histórico: silêncio', m.avisos.length === 0);
  }
  t.secao('AS REVOLTAS DAS MULTIS NÃO SE PERDEM');
  {
    /* A lista é escrita inteira por quem a grava. Como cada conta só conhece
     * as revoltas das cidades dela, gravar a lista inteira apagava as das
     * outras: a main escrevia as duas dela e as três das multis desapareciam
     * (17/09 — o quadro só mostrava as da main). */
    t.verifica('cada conta só tira as revoltas das SUAS cidades',
      /CADA CONTA SÓ TIRA AS REVOLTAS DAS SUAS CIDADES/.test(SRC)
      && /if \(minhasCidadesAqui\.size && !minhasCidadesAqui\.has\(Number\(id\)\)\) continue;/.test(SRC));
    t.verifica('... e as cidades vêm do próprio jogo',
      /const minhasCidadesAqui = new Set\(\s*\n\s*\(ctx\.getMyTowns\(\) \|\| \[\]\)\.map/.test(SRC));
  }
  {
    /* O bloco dos recursos por feitiço tem de viver ao nível do módulo. */
    const linhas = SRC.split('\n');
    const i = linhas.findIndex((l) => l.includes('async function cumprirPedidosDeRecursos'));
    let mod = '?';
    for (let k = i; k >= 0; k--) { if (/^function make/.test(linhas[k])) { mod = linhas[k]; break; } }
    t.verifica('o cumprirPedidosDeRecursos vive no módulo dos feitiços',
      /makeFeiticosModule/.test(mod), mod);
    t.verifica('... e não está dentro de outra função',
      /^  async function cumprirPedidosDeRecursos/.test(linhas[i] || ''), linhas[i]);
  }
  t.secao('UMA REVOLTA PERDIDA VOLTA A ENTRAR');
  {
    /* A lista só se gravava quando havia revoltas NOVAS, removidas ou
     * corrigidas. Uma detectada há horas não é nova — por isso, se o registo
     * dela se perdesse, nunca mais era reposto. Foi o que aconteceu à 5105 da
     * MacaquinhoChinês: a conta apoiava a cidade, via a revolta, e o
     * `revoltasAuto` continuava sem ela (17/09). */
    const i = SRC.indexOf('UMA REVOLTA QUE SE PERDEU DA LISTA VOLTA A ENTRAR');
    t.verifica('conta-se o que esta conta vê e não está registado', i > 0
      && /\.filter\(\(id\) => !guardadas\[String\(id\)\]\)/.test(SRC));
    t.verifica('... e isso chega para gravar a lista',
      /if \(novos\.length \|\| aRetirar\.length \|\| corrigidos\.length \|\| emFalta\.length\) \{/.test(SRC));
    t.verifica('o registo diz que as repôs', /volto a pô-las/.test(SRC));
    t.verifica('e a gravação leva TODAS as revoltas vistas, não só as novas',
      /for \(const r of revoltas\) \{\s*\n\s*auto\[String\(r\.id\)\]/.test(SRC));
  }
  t.secao('AS MULTIS PUBLICAM AS REVOLTAS DELAS');
  {
    /* A lista de alvos tem um dono único — a main — para as contas não se
     * atropelarem. Mas a detecção corria dentro do bloco da principal, e as
     * multis nunca a faziam: uma cidade de uma multi em revolta era apoiada,
     * mas nunca aparecia no registo das revoltas (17/09, a 5105). */
    const i = SRC.indexOf('AS MULTIS PUBLICAM AS REVOLTAS DELAS');
    t.verifica('cada conta escreve num sítio só dela', i > 0
      && /return `revoltasMultis\/\$\{mWorld\}\/\$\{conta\}`;/.test(SRC));
    t.verifica('... só com as cidades dela',
      /if \(!id \|\| !minhas\.has\(id\)\) continue;/.test(SRC));
    t.verifica('... e funciona sem Administrador, pelos modelos',
      /const r = revoltasPelosModelos\(agoraS\);/.test(SRC));
    t.verifica('escreve-se mesmo quando não há revoltas',
      /Escreve-se sempre, mesmo vazio/.test(SRC));
    t.verifica('a main lê o que as outras publicaram',
      /const dasOutras = await revoltasDasOutrasContas\(AGORA\);/.test(SRC));
    t.verifica('... ignora publicações velhas',
      /if \(!x\.quando \|\| \(agoraS - Number\(x\.quando\)\) > 6 \* 3600\) continue;/.test(SRC));
    t.verifica('... e junta-as às que vê', /if \(porCidade\[id\]\) continue;/.test(SRC));
    {
      /* A junção estava depois de a lista de revoltas já estar fixada: as
       * revoltas das multis entravam quando ninguém mais as ia buscar, e o
       * registo partilhado continuava só com as da main (17/09). */
      const linhas = SRC.split('\n');
      const le = linhas.findIndex((l) => l.includes('const dasOutras = await revoltasDasOutrasContas'));
      const junta = linhas.findIndex((l) => l.includes('for (const id of Object.keys(dasOutras))'));
      const fixa = linhas.findIndex((l) => l.includes('const revoltas = Object.keys(porCidade)'));
      t.verifica('a junção acontece ANTES de a lista fechar',
        le > 0 && le < junta && junta < fixa, { le: le + 1, junta: junta + 1, fixa: fixa + 1 });
    }
    /* A hora calcula-se na chamada: o `AGORA` do bloco da principal só existe
     * dentro dele, e usá-lo antes rebentava com "AGORA is not defined" em
     * todas as multis (17/09). */
    t.verifica('todas as contas publicam, a main incluída',
      /await publicarRevoltasDestaConta\(ctx, Math\.floor\(Date\.now\(\) \/ 1000\)\)/.test(SRC));
    t.verifica('... com a hora calculada fora do bloco da principal',
      !/publicarRevoltasDestaConta\(ctx, AGORA\)/.test(SRC));
  }
  t.secao('O NOME DA CIDADE E A CONTA');
  {
    /* No quadro, as cidades das outras contas apareciam pelo número: a main
     * não as conhece. Mas quem publica conhece-as (17/09). */
    t.verifica('quem publica vai buscar o nome ao próprio jogo',
      /O NOME VEM DE QUEM CONHECE A CIDADE/.test(SRC)
      && /if \(t && t\.getName\) nomeAqui = t\.getName\(\) \|\| nomeAqui;/.test(SRC));
    t.verifica('o quadro lê quem publicou cada revolta',
      /const pub = \(await fbLerM\(`revoltasMultis\/\$\{mWorld\}`\)\) \|\| \{\};/.test(SRC));
    t.verifica('... e usa esse nome quando só tem o número',
      /if \(n2 && rev\[id\] && \/\^\\d\+\$\/\.test\(String\(rev\[id\]\.nome \|\| ''\)\)\) rev\[id\]\.nome = n2;/.test(SRC));
    t.verifica('... e diz de que conta é a cidade',
      /const dono = contaDe\[id\] \|\| donoDe\[id\] \|\| '';/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
