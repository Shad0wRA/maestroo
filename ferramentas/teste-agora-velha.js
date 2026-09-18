/* A ÁGORA VELHA NÃO PODE PASSAR POR FRESCA.
 *
 * "Não havia nada a refrescar" e "tentei e não consegui" devolviam ambos zero,
 * e o apoio dizia "as leituras ainda estão frescas". Numa conta, as leituras
 * envelheceram CINCO HORAS a dizer isso, e o apoio decidiu com esses números
 * (visto em jogo, 15/09: cidades entre 227 e 519 minutos).
 *
 *   node ferramentas/teste-agora-velha.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('ÁGORA VELHA');

function nucleo(cachePreenchida) {
  const loja = {};
  if (cachePreenchida) loja['grepoMaestro_apoioFora_v1'] = JSON.stringify(cachePreenchida);
  const ctx = {
    uw: {
      location: { origin: 'https://x' }, Game: { csrfToken: 'T' },
      /* A Ágora recusa: é o caso que interessa. */
      fetch: async () => { throw new Error('rede em baixo'); },
    },
    localStorage: { getItem: (k) => (k in loja ? loja[k] : null), setItem: (k, v) => { loja[k] = v; } },
    seErroDeCodigo: () => {}, console, Math, Number, Object, JSON, Date, Promise, setTimeout,
  };
  vm.createContext(ctx);
  const a = SRC.indexOf('  const APOIO_FORA_KEY =');
  const b = SRC.indexOf('\n  /* O que esta conta tem em CADA cidade apoiada', a);
  const api = vm.runInContext('(() => {\n' + SRC.slice(a, b)
    + '\nreturn { refrescar: refrescarApoioFora, ultima: () => ultimaLeitura };\n})()', ctx);
  return api;
}

(async () => {
  {
    /* A Ágora falha: zero lidas — mas NÃO é "estava tudo fresco". */
    const n = nucleo();
    const lidas = await n.refrescar([111, 222], 5);
    t.verifica('a Ágora falha: zero cidades lidas', lidas === 0, lidas);
    t.verifica('... e fica registado que se tentaram 2 e falharam 2',
      n.ultima().tentadas === 2 && n.ultima().falhadas === 2, n.ultima());
  }
  {
    /* Leituras dentro da validade: não há nada a tentar. */
    const agora = Date.now();
    const n = nucleo({ 111: { quando: agora, blocos: [] }, 222: { quando: agora, blocos: [] } });
    const lidas = await n.refrescar([111, 222], 5);
    t.verifica('tudo fresco: zero lidas e ZERO tentadas', lidas === 0 && n.ultima().tentadas === 0,
      n.ultima());
    t.verifica('... e nenhuma falhada — é o caso em que o silêncio é correcto',
      n.ultima().falhadas === 0, n.ultima());
  }
  {
    /* Leituras velhas: tenta, e falha — não pode passar por fresco. */
    const velho = Date.now() - 6 * 3600 * 1000;
    const n = nucleo({ 111: { quando: velho, blocos: [] } });
    await n.refrescar([111], 5);
    t.verifica('leitura de há 6 horas: tenta refrescar',
      n.ultima().tentadas === 1 && n.ultima().falhadas === 1, n.ultima());
  }
  t.secao('SÓ AS CIDADES DESTA CONTA');
  {
    /* Os modelos incluem blocos de apoio que estão NAS minhas cidades mas
     * pertencem a outras contas. A cidade de origem desses blocos não é minha,
     * e pedir a Ágora dela dá "esta cidade não lhe pertence" (15/09). */
    const ctx = {
      uw: { MM: { getModels: () => ({ Units: {
        meu: { attributes: { home_town_id: 111, current_town_id: 999 } },
        deOutraConta: { attributes: { home_town_id: 3104, current_town_id: 111 } },
      } }) } },
      localStorage: { getItem: () => '{}', setItem: () => {} },
      Set, Object, Number, console,
    };
    vm.createContext(ctx);
    const a = SRC.indexOf('  function cidadesComApoioFora(minhasIds) {');
    const b = SRC.indexOf('\n  /* ', a + 200);   // até ao comentário seguinte
    /* Só a função e a leitura da cache de que ela precisa. */
    const ca = SRC.indexOf('  function lerCacheApoioFora() {');
    const cb = SRC.indexOf('\n  }\n', ca) + 4;
    const f = vm.runInContext('(() => {\n  const APOIO_FORA_KEY = "k";\n'
      + SRC.slice(ca, cb) + SRC.slice(a, b) + '\nreturn cidadesComApoioFora;\n})()', ctx);
    const lista = f([111, 222]);
    t.verifica('a minha cidade com apoio fora entra na lista', lista.indexOf(111) >= 0, lista);
    t.verifica('a cidade de outra conta NÃO entra', lista.indexOf(3104) < 0, lista);
  }
  t.secao('ABRIR A ÁGORA ANTES DO SEPARADOR');
  {
    /* O jogo pede `culture` e só depois `units_beyond` (16/09). O maestro
     * pedia o segundo directamente e às vezes levava "erro interno". */
    const i = SRC.indexOf('O SEPARADOR SOZINHO NEM SEMPRE CHEGA');
    const bloco = SRC.slice(i, i + 1800);
    t.verifica('tenta primeiro o separador, como antes', i > 0
      && /let txt = await pedir\('units_beyond'\);/.test(bloco));
    t.verifica('... e só se vier sem conteúdo abre a Ágora e repete',
      /if \(semHtml\(txt\)\) \{/.test(bloco) && /await pedir\('culture'\);/.test(bloco));
    t.verifica('nos casos normais não há pedido a mais',
      bloco.indexOf("await pedir('culture')") > bloco.indexOf('if (semHtml(txt))'));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
