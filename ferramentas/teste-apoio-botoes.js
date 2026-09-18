/* APOIO — reforçar e repor.
 *
 * "Reforçar" contava ENVIOS, e um envio era o pacote — que desapareceu com o
 * modo sem objectivo (5000): o botão deixou de mandar seja o que for.
 * "Repor" era o que ESTA conta perdeu, por isso nem aparecia na main quando
 * ela não tinha enviado nada. Agora: reforçar é tropa a mais, repor é encher
 * até ao objectivo. O código REAL do módulo.
 *
 *   node ferramentas/teste-apoio-botoes.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, tira, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('APOIO — REFORÇAR E REPOR');
const AP = 'function makeApoioModule(opts)';

function montar(guardado) {
  const loja = guardado ? { grepoApoio_reforcar_v1: JSON.stringify(guardado) } : {};
  const escritos = [];
  const ctx = {
    armazem: { getItem: (k) => (k in loja ? loja[k] : null), setItem: (k, v) => { loja[k] = v; } },
    seErroDeCodigo: () => {}, console, JSON, Object, Number, Math,
    fbUrlM: () => 'https://falso', fbLerM: async () => ({}),
    fbEscreverM: async (p, v) => { escritos.push(v); return { ok: true }; },
    fbCaminhoPedidos: () => 'pedidos/pt125',
  };
  vm.createContext(ctx);
  const api = vm.runInContext(funcao(SRC, '  function lerReforco() {', AP)
    + funcao(SRC, '  function gravarReforco(d) {', AP)
    + funcao(SRC, '  async function publicarPedido(tipo, alvoId, quanto) {', AP)
    + '\n({ ler: lerReforco, gravar: gravarReforco, publicar: publicarPedido })', ctx);
  return { api, escritos, loja };
}

(async () => {
  {
    const m = montar();
    m.api.gravar({ 5512: { sword: 500, bireme: 200 } });
    t.verifica('o reforço guarda-se como tropa, por alvo',
      igual(m.api.ler(), { 5512: { sword: 500, bireme: 200 } }), m.api.ler());
  }
  {
    const m = montar({ 5512: { sword: 500 } });
    await m.api.publicar('reforcar', 5512, { sword: 500, bireme: 200 });
    const p = m.escritos[0].reforcar_5512;
    t.verifica('o pedido viaja com as unidades, não com um número de envios',
      igual(p.unidades, { sword: 500, bireme: 200 }) && p.tipo === 'reforcar' && p.alvo === 5512, p);
  }
  {
    const m = montar();
    await m.api.publicar('repor', 5512, 1);
    const p = m.escritos[0].repor_5512;
    t.verifica('o pedido de repor não leva unidades (é o objectivo que manda)',
      p.tipo === 'repor' && p.unidades === null && p.quanto === 1, p);
  }
  {
    /* O desconto: o que sai abate ao reforço pedido. */
    const m = montar({ 5512: { sword: 500, bireme: 200 } });
    const ctx2 = {
      armazem: { getItem: () => JSON.stringify({ 5512: { sword: 500, bireme: 200 } }),
        setItem: (k, v) => { ctx2.__ultimo = JSON.parse(v); } },
      seErroDeCodigo: () => {}, console,
      alvo: 5512, cargaFinal: { sword: 300, bireme: 200 },
      lerReforco: m.api.ler, gravarReforco: (d) => { ctx2.__ultimo = d; },
      Math, Number, Object, JSON,
    };
    vm.createContext(ctx2);
    vm.runInContext(tira(SRC, '        try {\n          const extra = lerReforco();\n          const pedido = extra[alvo];',
      '        } catch (e) { seErroDeCodigo(e, \'Apoio\'); }\n'), ctx2);
    t.verifica('o que sai desconta ao reforço; o que ficou por mandar mantém-se',
      igual(ctx2.__ultimo, { 5512: { sword: 200 } }), ctx2.__ultimo);
  }
  t.secao('O REFORÇO CONTA UMA VEZ SÓ, NA QUOTA');
  {
    /* O reforço soma-se ao objectivo de propósito. Mas a retirada do excesso
     * olhava só para o objectivo: cada conta mandava o extra e retirava-o a
     * seguir (15/09). A quota é o sítio certo — é dela que sai o que falta
     * mandar E o que conta por excesso. */
    t.verifica('a quota inclui o reforço pedido',
      /const extra = lerReforco\(\)\[alvoId\] \|\| \{\};/.test(SRC)
      && /out\[u\] = \(out\[u\] \|\| 0\) \+ n;/.test(SRC));
    t.verifica('... e já não é somado outra vez ao que há a mandar',
      /O REFORÇO JÁ ESTÁ NA QUOTA/.test(SRC));
    t.verifica('o reforço de um alvo que saiu da lista é apagado',
      /não tem onde ser entregue/.test(SRC));
  }
  t.secao('ALVOS QUE NÃO EXPIRAM');
  {
    /* O tecto das 14 h foi pensado para revoltas. Mas a lista serve também
     * para apoios de longa duração — cidades tomadas a um adversário — e
     * esses estavam a ser tirados a cada passagem (17/09). */
    const i = SRC.indexOf('OS ALVOS MARCADOS PARA FICAR NÃO EXPIRAM');
    const bloco = SRC.slice(i, i + 1400);
    t.verifica('há um registo de alvos fixos', i > 0
      && /const FIXOS_KEY = 'grepoApoio_alvosFixos_v1';/.test(bloco));
    t.verifica('o tecto salta os que estão marcados',
      /\.filter\(\(id\) => !fixos\[id\]\)/.test(SRC));
    t.verifica('e o painel tem o visto por alvo',
      /<input type="checkbox" data-fixo="\$\{id\}"/.test(SRC)
      && /marcarFixo\(id, !!cb\.checked\);/.test(SRC));
  }
  t.secao('QUEM TIRA ALVOS DA LISTA');
  {
    /* A remoção lê a lista, tira o que expirou e reescreve-a inteira. Com
     * vinte contas a fazer isso ao mesmo tempo, a última repõe o que as
     * outras tiraram — a mensagem repetia-se a cada passagem e os alvos
     * nunca saíam (17/09: a 3058 e a 652, quatro vezes em sete minutos). */
    const i = SRC.indexOf('SÓ A CONTA PRINCIPAL TIRA ALVOS DA LISTA');
    const bloco = SRC.slice(i, i + 1400);
    t.verifica('a remoção é só da conta principal', i > 0
      && /const velhos = souAPrincipal \? alvosPassadosDoTecto\(alvos\) : \[\];/.test(SRC));
    t.verifica('... e sabe-se pela marca do painel',
      /localStorage\.getItem\('grepoMaestro_principal_v1'\) === '1'/.test(bloco));
    t.verifica('a limpeza dos pedidos segue a mesma regra',
      /if \(souAPrincipal && typeof fbLerM === 'function'/.test(SRC));
    t.verifica('as outras contas continuam a marcar a entrada de cada alvo',
      /marcarEntrada\(alvos\);/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
