/* APOIO (revoltas), FUNDAÇÃO e EXPANSÃO — a visão geral pelo núcleo.
 *
 * Apoio: cópia partilhada. Fundação e Expansão: sempre fresca, porque um
 * colonizador enviado agora tem de contar já. E "não consegui ler" nunca é
 * "nenhum colonizador a caminho": a fundação não funda, a barreira não deixa
 * sair nenhum.
 *
 *   node ferramentas/teste-colonizadores-revoltas.js maestro.user.js
 */
const S = require('./simulador');
const { AGORA_S, vm, tira, funcao, jogo, carregarNucleo, semAdministrador, correr, ligar, lista, ERRO, LIMITADO,
  igual } = S;
const SRC = S.ficheiroDoMaestro();

const t = S.verificador('APOIO, FUNDAÇÃO, EXPANSÃO');

async function apoio(j) {
  const seg = tira(SRC, '            const temAdm = (() => {', 'const visaoOk = !!vg.ok;');
  const porque = tira(SRC, "              const porque = !temAdm ? 'esta conta não tem Administrador'", ';\n');
  const ctx = { mUw: j.win, window: j.win, console };
  vm.createContext(ctx);
  return vm.runInContext(`(async () => {\n${seg}\n${porque}\nreturn { cmdsLidos, visaoOk, porque }; })()`, ctx);
}
async function fundacao(j) {
  const f = tira(SRC, "  let razaoColonizadores = '';", '\n    return out;\n  }\n');
  const ctx = { mUw: j.win, window: j.win, console, seErroDeCodigo: () => {}, coordenadasDoLinkDestino: () => null };
  vm.createContext(ctx);
  const r = await vm.runInContext(f + '\nilhasComColonizadorAcaminho(111)', ctx);
  return { r, razao: vm.runInContext('razaoColonizadores', ctx) };
}
function expansao(j) {
  const txt = tira(SRC, '  const jogo = () => (typeof unsafeWindow', '\n')
    + tira(SRC, '  let colonizacoesQuando = 0;', '\n')
    + funcao(SRC, '  async function refrescarColonizacoes() {')
    + tira(SRC, '  function podeFundarNaIlha(uw, ctx, x, y) {', "\n    return { pode: true, porque: '' };\n  }\n")
    + '\n({ refrescar: refrescarColonizacoes, pode: (x, y) => podeFundarNaIlha(window, '
    + '{ getMyTowns: () => [{ id: 111 }, { id: 222 }] }, x, y) })';
  const loja = {};
  const ctx = { window: j.win, console, seErroDeCodigo: () => {},
    localStorage: { getItem: (k) => loja[k] || null, setItem: (k, v) => { loja[k] = v; } } };
  vm.createContext(ctx);
  return vm.runInContext(txt, ctx);
}

const REVOLTAS = [
  { id: 'revolt_901', type: 'revolt', started_at: AGORA_S + 3000, origin_town_id: 9001, destination_town_id: 222, arrival_at: AGORA_S + 9000 },
  { id: 902, type: 'attack', started_at: 0, origin_town_id: 9002, destination_town_id: 111, arrival_at: AGORA_S + 500 },
];
const COLONO = { id: 'colonization_5120', type: 'colonization', origin_town_id: 111, island_x: 365, island_y: 460,
  number_on_island: 1, arrival_at: AGORA_S + 4000 };
const COLONO_FEITO = Object.assign({}, COLONO, { id: 'colonization_5121', island_x: 300, island_y: 300,
  colonization_finished_at: AGORA_S - 10 });

(async () => {
  t.secao('APOIO — revoltas');
  {
    const j = jogo({ respostas: [lista(REVOLTAS)] }); carregarNucleo(SRC, j);
    const d = await apoio(j);
    t.verifica('leitura boa: a lista toda', d.visaoOk && d.cmdsLidos.length === 2, d);
  }
  {
    const j = jogo({ respostas: [ERRO] }); carregarNucleo(SRC, j);
    const d = await apoio(j);
    t.verifica('erro do jogo: leitura falhada (não é "nenhuma revolta"), e diz porquê', !d.visaoOk && d.cmdsLidos === null
      && d.porque === 'Ocorreu um erro.', d);
  }
  {
    const j = jogo({ respostas: [LIMITADO] }); carregarNucleo(SRC, j);
    let travou = 0; j.win.__maestroTravar = () => { travou++; };
    const d = await apoio(j);
    t.verifica('429: leitura falhada, e o núcleo trava', !d.visaoOk && travou === 1, { d, travou });
  }
  {
    const j = jogo({ respostas: [lista(REVOLTAS)] }); carregarNucleo(SRC, j); semAdministrador(j);
    const d = await apoio(j);
    t.verifica('sem Administrador: nenhum pedido, e diz porquê', !d.visaoOk && j.pedidosVG() === 0 && /não tem Administrador/.test(d.porque), d);
  }
  {
    const j = jogo({ respostas: [lista(REVOLTAS)] }); carregarNucleo(SRC, j);
    await j.win.__maestroVisaoGeral();
    const d = await apoio(j);
    t.verifica('com uma cópia recente: usa-a, sem pedido novo', d.visaoOk && j.pedidosVG() === 1, j.pedidosVG());
  }

  t.secao('FUNDAÇÃO — colonizadores em viagem');
  {
    const j = jogo({ respostas: [lista([COLONO, COLONO_FEITO])] }); carregarNucleo(SRC, j);
    const d = await fundacao(j);
    t.verifica('"365:460", como quem chama procura; o que já fundou fica de fora', d.r.has('365:460') && d.r.size === 1, [...d.r]);
  }
  {
    const j = jogo({ respostas: [lista([]), lista([COLONO])] }); carregarNucleo(SRC, j);
    await j.win.__maestroVisaoGeral();
    const d = await fundacao(j);
    t.verifica('com uma cópia de antes do envio: vai ao servidor e vê o colonizador', d.r && d.r.has('365:460') && j.pedidosVG() === 2,
      { r: d.r && [...d.r], pedidos: j.pedidosVG() });
  }
  {
    const j = jogo({ respostas: [ERRO] }); carregarNucleo(SRC, j);
    const d = await fundacao(j);
    t.verifica('leitura falhada: null (não funda nesta passagem), com a razão', d.r === null && d.razao === 'Ocorreu um erro.', d);
  }
  {
    const j = jogo({ respostas: [lista([COLONO])] }); carregarNucleo(SRC, j); semAdministrador(j);
    const d = await fundacao(j);
    t.verifica('sem Administrador: como sempre (vazio), sem pedido', d.r && d.r.size === 0 && j.pedidosVG() === 0, d);
  }

  t.secao('EXPANSÃO — a lista e a barreira');
  {
    const j = jogo({ respostas: [lista([COLONO, COLONO_FEITO])] }); carregarNucleo(SRC, j);
    const e = expansao(j); await e.refrescar();
    t.verifica('a lista dos que vão a caminho', igual(j.win.__maestroColonizacoesEmCurso.map((x) => x.id), ['colonization_5120']),
      j.win.__maestroColonizacoesEmCurso);
    t.verifica('a barreira trava a ilha com colonizador e deixa as outras', !e.pode(365, 460).pode && e.pode(500, 500).pode,
      [e.pode(365, 460), e.pode(500, 500)]);
    await e.refrescar();
    t.verifica('não volta a perguntar antes de um minuto', j.pedidosVG() === 1, j.pedidosVG());
  }
  {
    const j = jogo({ respostas: [ERRO, lista([])] }); carregarNucleo(SRC, j);
    const e = expansao(j); await e.refrescar();
    const p = e.pode(365, 460);
    t.verifica('leitura falhada: a barreira não deixa sair nenhum, e diz porquê', p.pode === false
      && /não consegui ler os colonizadores em viagem \(Ocorreu um erro\.\)/.test(p.porque), p);
    await e.refrescar();
    t.verifica('... na passagem seguinte volta a ler e, lida, deixa sair', e.pode(500, 500).pode === true && j.pedidosVG() === 2,
      { p: e.pode(500, 500), pedidos: j.pedidosVG() });
  }
  {
    const j = jogo({ respostas: [lista([COLONO])] }); carregarNucleo(SRC, j); semAdministrador(j);
    const e = expansao(j); await e.refrescar();
    t.verifica('sem Administrador: como sempre (lista vazia, a barreira deixa), sem pedido',
      e.pode(365, 460).pode === true && igual(j.win.__maestroColonizacoesEmCurso, []) && j.pedidosVG() === 0);
  }
  {
    const j = jogo({ respostas: [lista([]), lista([COLONO])] }); carregarNucleo(SRC, j);
    await j.win.__maestroVisaoGeral();
    const e = expansao(j); await e.refrescar();
    t.verifica('com uma cópia de antes do envio: vai ao servidor e trava a ilha', e.pode(365, 460).pode === false && j.pedidosVG() === 2);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
