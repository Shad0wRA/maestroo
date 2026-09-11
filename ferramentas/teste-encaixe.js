/* ENCAIXE — a leitura da visão geral, SEMPRE fresca.
 *
 * O encaixe pergunta a seguir a enviar: uma cópia de há 20 s não tem o comando
 * que acabou de sair. E uma leitura falhada deixa sempre a razão registada
 * (sai na linha [diagnóstico]).
 *
 *   node ferramentas/teste-encaixe.js maestro.user.js
 */
const S = require('./simulador');
const { AGORA_S, vm, tira, funcao, jogo, carregarNucleo, semAdministrador, correr, ligar, lista, ERRO, LIMITADO,
  igual } = S;
const SRC = S.ficheiroDoMaestro();

const t = S.verificador('ENCAIXE');

function encaixe(j) {
  const ini = SRC.indexOf('MÓDULO: ENCAIXE DE COMANDOS');
  const marcas = tira(SRC, '  let semAdmAte = 0;', "  let ultimaRazaoVazio = '';\n", 'MÓDULO: ENCAIXE DE COMANDOS');
  const txt = marcas + funcao(SRC, '  async function lerResposta(resposta) {', 'MÓDULO: ENCAIXE DE COMANDOS')
    + funcao(SRC, "  async function comandosDoServidor(townId) {\n    if (semAdministrador())", 'MÓDULO: ENCAIXE DE COMANDOS')
    + '\n({ ler: comandosDoServidor, razao: () => ultimaRazaoVazio })';
  void ini;
  const ctx = { mUw: j.win, window: j.win, uw: j.win, seErroDeCodigo: () => {}, console };
  vm.createContext(ctx);
  return vm.runInContext(txt, ctx);
}

const CMDS = [
  { id: 801, type: 'attack_land', own_command: true, started_at: AGORA_S - 5, origin_town_id: 111,
    destination_town_id: 5555, arrival_at: AGORA_S + 3600, cancelable: true },
  { id: 802, type: 'attack_land', own_command: true, return: true, started_at: AGORA_S - 900, origin_town_id: 5556,
    destination_town_id: 111, arrival_at: AGORA_S + 60 },
  { id: 803, type: 'support', own_command: true, started_at: AGORA_S - 30, origin_town_id: 222,
    destination_town_id: 5557, arrival_at: AGORA_S + 1200, cancelable: false },
];

(async () => {
  for (const [nome, corpo] of [['json.data.commands', { json: { data: { commands: CMDS } } }], ['json.commands', { json: { commands: CMDS } }]]) {
    const j = jogo({ respostas: [{ corpo }] }); carregarNucleo(SRC, j);
    const d = await encaixe(j).ler(111);
    t.verifica(`${nome}: os comandos, sem a volta`, igual(d.map((x) => x.command_id), [801, 803]) && d[0].cancelavel === true, d);
  }
  {
    const j = jogo({ respostas: [lista(CMDS.slice(1)), lista(CMDS)] }); carregarNucleo(SRC, j);
    const outro = await j.win.__maestroVisaoGeral();
    const d = await encaixe(j).ler(111);
    t.verifica('com uma cópia recente sem o comando novo: vai ao servidor e encontra-o',
      outro.ok && j.pedidosVG() === 2 && d.some((x) => x.command_id === 801), { pedidos: j.pedidosVG(), d });
    const depois = await j.win.__maestroVisaoGeral();
    t.verifica('... e a leitura dele passa a ser a cópia dos outros', depois.daCopia && depois.comandos.some((x) => x.id === 801));
  }
  {
    const j = jogo({ respostas: [lista(CMDS)] }); carregarNucleo(SRC, j);
    const e = encaixe(j); await e.ler(111); await e.ler(111); await e.ler(111);
    t.verifica('três leituras seguidas depois de enviar → três pedidos (nada vem da cópia)', j.pedidosVG() === 3, j.pedidosVG());
  }
  for (const [nome, resp, re] of [['erro do jogo', ERRO, /^Ocorreu um erro\.$/], ['lista vazia', lista([]), /veio sem comandos/],
    ['429', LIMITADO, /recusar/], ['resposta sem lista', { corpo: { json: { data: { outra: 1 } } } }, /não traz a lista/]]) {
    const j = jogo({ respostas: [resp] }); carregarNucleo(SRC, j);
    const e = encaixe(j); const d = await e.ler(111);
    t.verifica(`${nome}: lista vazia e a razão registada`, d.length === 0 && re.test(e.razao()), e.razao());
  }
  {
    const j = jogo({ respostas: [{ corpo: { json: { error: 'Necessita do administrador para aceder às visões gerais' } } }] });
    carregarNucleo(SRC, j);
    const e = encaixe(j); await e.ler(111); const r1 = e.razao(); await e.ler(111);
    t.verifica('o servidor diz que falta o Administrador: diz porquê e não volta a pedir', /falta o Administrador/.test(r1)
      && j.pedidosVG() === 1, { r1, pedidos: j.pedidosVG() });
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
