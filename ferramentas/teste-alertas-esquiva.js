/* ALERTAS E ESQUIVA — a visão geral pelo núcleo, e o que dela se aproveita.
 *
 * O que tem de ser: um ataque inimigo que só a visão geral traz (started_at 0,
 * espia 11/09) é avisado e esquivado; voltas minhas, revoltas, apoios de outros
 * e comandos meus não; o mesmo ataque pelas duas fontes conta uma vez; uma
 * leitura falhada diz-se e não conta como desmentido; um pedido só para os dois.
 *
 *   node ferramentas/teste-alertas-esquiva.js maestro.user.js
 */
const S = require('./simulador');
const { AGORA_S, vm, tira, funcao, jogo, carregarNucleo, semAdministrador, correr, ligar, lista, ERRO, LIMITADO,
  igual } = S;
const SRC = S.ficheiroDoMaestro();

const t = S.verificador('ALERTAS E ESQUIVA');

const INIMIGO = { id: 701, type: 'attack', own_command: false, return: false, cmd_return: false, started_at: 0,
  origin_town_id: 9101, origin_town_name: 'Inimiga', origin_town_player_id: 77, origin_town_player_name: 'Vilão',
  destination_town_id: 111, arrival_at: AGORA_S + 5400 };
const OUTROS = [
  { id: 702, type: 'attack_land', own_command: true, return: true, cmd_return: true, started_at: AGORA_S - 1000,
    origin_town_id: 9102, origin_town_player_id: 88, destination_town_id: 111, arrival_at: AGORA_S + 600 },
  { id: 703, type: 'revolt', own_command: true, started_at: AGORA_S + 3600, origin_town_id: 9103,
    destination_town_id: 222, arrival_at: AGORA_S + 7200 },
  { id: 704, type: 'support', own_command: false, started_at: 0, origin_town_id: 9104,
    destination_town_id: 111, arrival_at: AGORA_S + 400 },
  { id: 705, type: 'attack_takeover', own_command: true, origin_town_id: 111, destination_town_id: 9999, arrival_at: AGORA_S + 800 },
  { id: 706, type: 'attack_sea', own_command: true, started_at: AGORA_S - 50, origin_town_id: 222,
    destination_town_id: 9998, arrival_at: AGORA_S + 900 },
];
const MODELO = (id) => ({ mX: { attributes: { id, type: 'attack', target_town_id: 111, home_town_id: 9101,
  town_name_origin: 'Inimiga', arrival_at: AGORA_S + 5400 } } });
const MODELO_222 = { m1: { attributes: { id: 601, type: 'attack', target_town_id: 222, home_town_id: 9005,
  town_name_origin: 'DoModelo', arrival_at: AGORA_S + 7000 } } };
const naAttack = (tid) => ({ attack: [{ town_id: tid, incoming: 1 }] });
const op = (cmds, mais) => Object.assign({ respostas: [lista(cmds)] }, naAttack(111), mais || {});
const ligaA = ligar('grepoAlertas_cfg_v1');
const ligaE = ligar('grepoEsquiva_cfg_v1');
const nada = (r) => r.reg.rotina.some((x) => /nenhum ataque a chegar/.test(x));
const desmentidas = (r) => JSON.parse(r.j.localStorage.getItem('grepoEsquiva_desmentidas_v1') || '{}');

(async () => {
  t.secao('ALERTAS');
  {
    const r = await correr(SRC, 'makeAlertasModule', Object.assign({ respostas: [lista(OUTROS)], movimentos: MODELO_222 },
      naAttack(222)), 1, ligaA);
    t.verifica('ataque que os modelos trazem: um aviso', r.reg.discord.length === 1, r.reg);
  }
  {
    const r = await correr(SRC, 'makeAlertasModule', op([INIMIGO].concat(OUTROS)), 1, ligaA);
    t.verifica('ataque inimigo só na visão geral (started_at 0): um aviso, com o nome do atacante',
      r.reg.discord.length === 1 && /Vilão/.test(JSON.stringify(r.reg.discord)), r.reg.discord);
    t.verifica('... sem erros de código', r.erros.length === 0, r.erros);
  }
  {
    const r = await correr(SRC, 'makeAlertasModule', op(OUTROS), 1, ligaA);
    t.verifica('voltas minhas, revoltas, apoio de outro, conquista e ataque meus: nenhum aviso', r.reg.discord.length === 0, r.reg.discord);
  }
  for (const [nome, id] of [['com o mesmo número', 701], ['com outro número', 99701]]) {
    const r = await correr(SRC, 'makeAlertasModule', op([INIMIGO].concat(OUTROS), { movimentos: MODELO(id) }), 1, ligaA);
    t.verifica(`o mesmo ataque nos modelos e na visão geral, ${nome}: um aviso só`, r.reg.discord.length === 1, r.reg.discord);
  }
  {
    const j = jogo(op([INIMIGO].concat(OUTROS), { movimentos: MODELO(99701) })); carregarNucleo(SRC, j); ligaA(j);
    const m = S.modulo(SRC, 'makeAlertasModule', j).mod;
    const reg = { ecra: [], rotina: [], discord: [] }; const c = S.contexto(j, reg);
    await m.run(c);
    j.win.MM.getModels = () => ({ PremiumFeatures: { k: { attributes: { curator: 9e12 } } }, MovementsUnits: {} });
    j.win.__maestroVisaoGeralEsquecer();
    await m.run(c);
    t.verifica('passagem seguinte, o mesmo ataque pelo outro número: não repete o aviso', reg.discord.length === 1, reg.discord.length);
  }
  {
    const r = await correr(SRC, 'makeAlertasModule', { respostas: [ERRO] }, 2, ligaA);
    t.verifica('leitura falhada: diz no ecrã, com a razão', r.reg.ecra.length === 1
      && /não consegui ler a visão geral \(Ocorreu um erro\.\)/.test(r.reg.ecra[0]), r.reg);
    t.verifica('... a segunda vez vai para a rotina, e um pedido por passagem', r.reg.rotina.some((m) => /não consegui ler/.test(m))
      && r.vg === 2, { rotina: r.reg.rotina, vg: r.vg });
  }
  {
    const r = await correr(SRC, 'makeAlertasModule', { respostas: [LIMITADO] }, 1, ligaA);
    t.verifica('429: diz que o servidor limitou', /429/.test(r.reg.ecra[0] || ''), r.reg.ecra);
  }

  t.secao('ESQUIVA');
  {
    const r = await correr(SRC, 'makeEsquivaModule', op([INIMIGO].concat(OUTROS)), 1, ligaE);
    t.verifica('ataque inimigo só na visão geral: vê-o (não diz "nenhum ataque a chegar")', !nada(r), r.reg);
    t.verifica('... sem erros de código', r.erros.length === 0, r.erros);
  }
  {
    const r = await correr(SRC, 'makeEsquivaModule', op(OUTROS), 1, ligaE);
    t.verifica('voltas, revoltas, apoios e comandos meus: nenhum ataque', nada(r), r.reg);
  }
  {
    const so = await correr(SRC, 'makeEsquivaModule', op(OUTROS, { movimentos: MODELO(701) }), 1, ligaE);
    for (const [nome, id] of [['com o mesmo número', 701], ['com outro número', 99701]]) {
      const r = await correr(SRC, 'makeEsquivaModule', op([INIMIGO].concat(OUTROS), { movimentos: MODELO(id) }), 1, ligaE);
      t.verifica(`o mesmo ataque nas duas fontes, ${nome}: faz o mesmo que só com o modelo`,
        igual(so.reg.ecra, r.reg.ecra) && igual(so.reg.rotina, r.reg.rotina), { so: so.reg, r: r.reg });
    }
  }
  {
    const r = await correr(SRC, 'makeEsquivaModule', op([OUTROS[4]]), 1, ligaE);
    t.verifica('servidor responde e não confirma: conta um desmentido, e diz porquê',
      (desmentidas(r)['111'] || {}).falhas === 1
      && r.reg.rotina.some((m) => /devolveu 1 comando\(s\) mas nenhum para esta cidade/.test(m)), { d: desmentidas(r), rotina: r.reg.rotina });
  }
  {
    const r = await correr(SRC, 'makeEsquivaModule', Object.assign({ respostas: [ERRO] }, naAttack(111)), 10, ligaE);
    t.verifica('10 leituras falhadas: nenhum desmentido, nenhuma quarentena', !desmentidas(r)['111']
      && !r.reg.rotina.some((m) => /deixo de perguntar/.test(m)), desmentidas(r));
    t.verifica('... diz porquê na rotina', r.reg.rotina.some((m) =>
      /não consegui ler a visão geral \(Ocorreu um erro\.\).*não conta como desmentido/.test(m)), r.reg.rotina);
    t.verifica('... no ecrã uma vez só, sem dizer "nenhum ataque a chegar"',
      r.reg.ecra.filter((m) => /não consegui ler/.test(m)).length === 1 && !nada(r), r.reg);
  }
  {
    const r = await correr(SRC, 'makeEsquivaModule', Object.assign({ respostas: [LIMITADO] }, naAttack(111)), 1, ligaE);
    t.verifica('429: diz que o servidor está a limitar', /429/.test(r.reg.ecra[0] || ''), r.reg.ecra);
  }
  {
    const r = await correr(SRC, 'makeEsquivaModule', op([INIMIGO]), 1, (j) => { ligaE(j); semAdministrador(j); });
    t.verifica('sem Administrador: nenhum pedido, conta o desmentido como sempre, e diz porquê',
      r.vg === 0 && (desmentidas(r)['111'] || {}).falhas === 1 && r.reg.rotina.some((m) => /\(sem Administrador\)/.test(m)),
      { vg: r.vg, d: desmentidas(r), rotina: r.reg.rotina });
  }
  {
    const r = await correr(SRC, 'makeEsquivaModule', { respostas: [lista([INIMIGO])] }, 1, ligaE);
    t.verifica('leitura global (nada na colecção Attack): um pedido só', r.vg === 1, r.vg);
  }

  t.secao('OS DOIS NA MESMA PASSAGEM');
  {
    const j = jogo(op([INIMIGO].concat(OUTROS))); carregarNucleo(SRC, j); ligaA(j); ligaE(j);
    const reg = { ecra: [], rotina: [], discord: [] }; const c = S.contexto(j, reg);
    await S.modulo(SRC, 'makeAlertasModule', j).mod.run(c);
    await S.modulo(SRC, 'makeEsquivaModule', j).mod.run(c);
    t.verifica('alertas + esquiva seguidos → 1 pedido à visão geral', j.pedidosVG() === 1, j.pedidosVG());
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
