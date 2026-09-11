/* FEITIÇOS, DEUSES, REFORÇO — a visão geral pelo leitor do núcleo.
 *
 * O que tem de ser: a lista certa das duas chaves; "não consegui ler" nunca é
 * "não há nada" (o reforço não traz tropa às cegas, o farm não ataca sem saber
 * o favor a caminho); sem Administrador não se pede; os três juntos fazem um
 * pedido só.
 *
 *   node ferramentas/teste-leitores.js maestro.user.js
 */
const S = require('./simulador');
const { AGORA_S, vm, tira, funcao, jogo, carregarNucleo, semAdministrador, correr, ligar, lista, ERRO, LIMITADO,
  igual } = S;
const SRC = S.ficheiroDoMaestro();

const t = S.verificador('FEITIÇOS, DEUSES, REFORÇO');

const COMANDOS = [
  { id: 1, type: 'attack', origin_town_id: 900, origin_town_name: 'Inimiga', destination_town_id: 111,
    destination_town_name: 'A', arrival_at: AGORA_S + 3600 },
  { id: 2, type: 'attack', origin_town_id: 901, destination_town_id: 222, arrival_at: AGORA_S + 7200 },
  { id: 3, type: 'attack', return: true, origin_town_id: 902, destination_town_id: 111, arrival_at: AGORA_S + 60 },
  { id: 4, type: 'attack', origin_town_id: 333, destination_town_id: 111, arrival_at: AGORA_S + 100 },
  { id: 5, type: 'support', origin_town_id: 903, destination_town_id: 111, arrival_at: AGORA_S + 50 },
  { id: 6, type: 'attack', origin_town_id: 904, destination_town_id: 555, arrival_at: AGORA_S + 50 },
  { id: 7, type: 'attack', origin_town_id: 111, destination_town_id: 700, godsent: 10, arrival_at: AGORA_S + 900 },
  { id: 8, type: 'attack', origin_town_id: 222, destination_town_id: 701, godsent: 4, cmd_return: true, arrival_at: AGORA_S + 900 },
  { id: 9, type: 'attack', origin_town_id: 950, destination_town_id: 702, godsent: 20, arrival_at: AGORA_S + 900 },
];
const MOVIMENTOS = {
  m1: { attributes: { id: 50, type: 'attack', target_town_id: 222, home_town_id: 905, town_name_origin: 'SóModelo',
    town_name_destination: 'B', arrival_at: AGORA_S + 500 } },
  m2: { attributes: { id: 51, type: 'attack', target_town_id: 111, home_town_id: 900, town_name_origin: 'Inimiga',
    town_name_destination: 'A', arrival_at: AGORA_S + 3600 } },
};

async function feiticos(j) {
  const txt = funcao(SRC, '  async function ataquesContraMim() {\n    /* SEM REPETIDOS');
  const ctx = { mUw: j.win, window: j.win, seErroDeCodigo: () => {},
    armazem: { getItem: (k) => (k === 'grepoEsquiva_cidadesGrupo_v1' ? JSON.stringify({ ids: [333] }) : null) } };
  vm.createContext(ctx);
  const f = vm.runInContext("let razaoVisaoGeral = '';\n" + txt + '\n({ f: ataquesContraMim, razao: () => razaoVisaoGeral })', ctx);
  return { lista: await f.f(), razao: f.razao() };
}

async function reforco(j, passagens) {
  const ctx = { window: j.win, localStorage: j.localStorage, seErroDeCodigo: () => {}, console };
  vm.createContext(ctx);
  const mod = vm.runInContext(S.fabrica(SRC, 'makeReforcoModule') + '\nmakeReforcoModule({ intervaloMin: 2 })', ctx);
  const reg = { ecra: [], rotina: [] };
  const c = { uw: j.win, log: (m) => reg.ecra.push(m), logRotina: (m) => reg.rotina.push(m),
    sleep: async () => {}, rand: () => 0, getMyTowns: () => [{ id: 111 }, { id: 222 }] };
  for (let i = 0; i < (passagens || 1); i++) await mod.run(c);
  return reg;
}
const reforcoLigado = (j) => {
  j.localStorage.setItem('grepoReforco_cfg_v1', JSON.stringify({ ativo: true }));
  j.localStorage.setItem('grepoReforco_envios_v1', JSON.stringify({
    k1: { origem: 111, destino: 222, impacto: AGORA_S - 600, carga: { sword: 100 } } }));
};
const BLOCO = { u1: { attributes: { id: 4242, home_town_id: 111, current_town_id: 222, sword: 100 } } };
const sendBacks = (j) => j.pedidos.filter((u) => /send_back/.test(u)).length;

async function deuses(j) {
  const chamadas = { emCasa: 0 };
  const ctx = { mUw: j.win, window: j.win, localStorage: j.localStorage, seErroDeCodigo: () => {},
    favorPorDeus: () => ({ zeus: 10 }), deusDa: (id) => ({ 111: 'zeus', 222: 'zeus' }[id] || null),
    pedidoDe: () => null, NOMES: { zeus: 'Zeus' }, chavePorPerfil: (k) => k,
    enviadosEmCasa: () => { chamadas.emCasa++; return 0; },
    escudoDisponivel: () => 0, alvosNaIlha: async () => [], proximoAlvo: () => null,
    enviarAtaque: async () => ({ ok: true }), ilhaDa: () => ({ x: 1, y: 1 }),
    minimoAprendido: () => 0, anotarMinimo: () => {}, recusaNormal: () => false, firebaseUrl: () => '' };
  vm.createContext(ctx);
  const f = vm.runInContext('let farmFalhasVisao = 0;\n' + funcao(SRC, '  async function farmarFavor(ctx, c, towns) {')
    + '\nfarmarFavor', ctx);
  const reg = { ecra: [], rotina: [] };
  await f({ log: (m) => reg.ecra.push(m), logRotina: (m) => reg.rotina.push(m),
    getMyTowns: () => [{ id: 111 }, { id: 222 }], sleep: async () => {}, rand: () => 0 },
  { multis: ['multi1'], cidadesFarm: { 111: true }, favorParaAtacar: 100, favorPorEnviado: 5 }, [{ id: 111, name: 'A' }]);
  return { reg, chamadas };
}

(async () => {
  t.secao('FEITIÇOS — lista do painel');
  for (const [nome, resp] of [['json.data.commands', lista(COMANDOS)], ['json.commands', { corpo: { json: { commands: COMANDOS } } }]]) {
    const j = jogo({ respostas: [resp], movimentos: MOVIMENTOS }); carregarNucleo(SRC, j);
    const r = await feiticos(j);
    t.verifica(`${nome}: 3 ataques contra mim, sem repetidos nem os do meu grupo`,
      igual(r.lista.map((x) => x.cid), [50, 51, 2]) && r.razao === '', r);
  }
  {
    const j = jogo({ respostas: [ERRO], movimentos: MOVIMENTOS }); carregarNucleo(SRC, j);
    const r = await feiticos(j);
    t.verifica('leitura falhada: ficam os dos modelos, e a razão para o painel', r.lista.length === 2
      && r.razao === 'Ocorreu um erro.', r);
  }
  {
    const j = jogo({ respostas: [lista(COMANDOS)], movimentos: MOVIMENTOS, semAdm: true }); carregarNucleo(SRC, j);
    const r = await feiticos(j);
    t.verifica('sem Administrador: nenhum pedido, ficam os modelos', j.pedidosVG() === 0 && r.lista.length === 2
      && r.razao === 'sem Administrador', r);
  }

  t.secao('REFORÇO');
  {
    const j = jogo({ respostas: [lista(COMANDOS)], units: BLOCO }); carregarNucleo(SRC, j); reforcoLigado(j);
    const r = await reforco(j);
    t.verifica('há outro ataque à cidade: a tropa fica', sendBacks(j) === 0
      && r.rotina.some((m) => /a tropa fica em 222/.test(m)), r);
  }
  {
    const j = jogo({ respostas: [lista(COMANDOS.filter((x) => x.destination_town_id !== 222))], units: BLOCO });
    carregarNucleo(SRC, j); reforcoLigado(j);
    const r = await reforco(j);
    t.verifica('acabaram os ataques: traz a tropa de volta', sendBacks(j) === 1
      && r.ecra.some((m) => /acabaram os ataques/.test(m)), r);
    t.verifica('... e o envio de volta esquece a cópia da visão geral',
      j.win.__maestroVisaoGeralEstado().copia === 'nenhuma', j.win.__maestroVisaoGeralEstado());
  }
  {
    const j = jogo({ respostas: [ERRO], units: BLOCO }); carregarNucleo(SRC, j); reforcoLigado(j);
    const r = await reforco(j, 3);
    t.verifica('leitura falhada: não traz nada', sendBacks(j) === 0, r);
    t.verifica('... avisa no ecrã uma vez, com a razão', r.ecra.length === 1
      && /não consegui ler a visão geral \(Ocorreu um erro\.\)/.test(r.ecra[0]), r.ecra);
    t.verifica('... as repetições vão para a rotina', r.rotina.filter((m) => /não consegui ler/.test(m)).length === 2, r.rotina);
    t.verifica('... e o registo do envio fica', !!JSON.parse(j.localStorage.getItem('grepoReforco_envios_v1')).k1);
  }
  {
    const j = jogo({ respostas: [lista(COMANDOS)], units: BLOCO, semAdm: true }); carregarNucleo(SRC, j); reforcoLigado(j);
    const r = await reforco(j);
    t.verifica('sem Administrador: nenhum pedido, não traz nada, diz porquê', j.pedidosVG() === 0 && sendBacks(j) === 0
      && /sem Administrador/.test(r.ecra[0] || ''), r);
  }

  t.secao('DEUSES — favor que vem a caminho');
  {
    const j = jogo({ respostas: [lista(COMANDOS)] }); carregarNucleo(SRC, j);
    const r = await deuses(j);
    t.verifica('conta só os enviados que vão (Zeus +50) e segue para os ataques',
      r.reg.rotina.includes('Farm: já vem a caminho Zeus +50.') && r.chamadas.emCasa === 1, r);
  }
  {
    const j = jogo({ respostas: [ERRO] }); carregarNucleo(SRC, j);
    const r = await deuses(j);
    t.verifica('leitura falhada: não ataca, e diz porquê', r.chamadas.emCasa === 0
      && /não consegui ler a visão geral \(Ocorreu um erro\.\)/.test(r.reg.ecra[0] || ''), r);
  }
  {
    const j = jogo({ respostas: [lista(COMANDOS)], semAdm: true }); carregarNucleo(SRC, j);
    const r = await deuses(j);
    t.verifica('sem Administrador: fica como sempre (ataca), sem pedido', r.chamadas.emCasa === 1 && j.pedidosVG() === 0, r);
  }

  t.secao('OS TRÊS JUNTOS');
  {
    const j = jogo({ respostas: [lista(COMANDOS)], movimentos: MOVIMENTOS }); carregarNucleo(SRC, j);
    await deuses(j); await feiticos(j);
    j.localStorage.setItem('grepoReforco_cfg_v1', JSON.stringify({ ativo: true }));
    await reforco(j);
    t.verifica('deuses + feitiços + reforço seguidos → 1 pedido à visão geral', j.pedidosVG() === 1, j.pedidosVG());
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
