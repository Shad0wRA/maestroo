/* O MAPA DO MUNDO, PELOS FICHEIROS DO SERVIDOR.
 *
 * O servidor publica o mundo inteiro em ficheiros de texto sem autenticação
 * (confirmado no pt126, 17/09): 5809 cidades com dono, ilha e LUGAR NA ILHA;
 * 917 jogadores com aliança; 117878 ilhas com os LUGARES LIVRES.
 *
 * São um pedido por hora a um ficheiro estático — não passam pela API do jogo
 * nem contam para o travão dos pedidos. As sentinelas deixam de precisar de um
 * pedido por ilha, que com 48 ilhas dava 429.
 *
 *   node ferramentas/teste-mapa-mundo.js maestro.user.js
 */
const S = require('./simulador');
const { vm, PEDIR_JOGO } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('MAPA DO MUNDO');

/* Linhas reais do pt126. */
const TOWNS = [
  '7397,2379469,35.1,390,500,16,12957',      // minha
  '35,2379469,55.1,499,507,0,13257',         // minha, LUGAR 0
  '9215,1923767,34.003,359,469,8,1423',      // de outro
  '9050,2440228,CANTABRIA,525,441,16,1461',  // de outro
  '5000,1923767,vizinha,499,507,4,900',      // aliado, na mesma ilha que a 55.1
].join('\n');
const PLAYERS = [
  '2379469,Shad0wRA,126,50000,1,67',
  '1923767,Jomaras,126,30000,2,40',
  '2440228,Estranho,,1000,300,2',
].join('\n');
const ALLIANCES = ['126,Berimbau+de+Xoxota,798039,120,17,12'].join('\n');
const ISLANDS = ['1,499,507,4,3,stone,iron', '2,390,500,27,0,iron,stone'].join('\n');

function nucleo(falhar) {
  const loja = {};
  const ctx = {
    WORLD: 'pt126',
    uw: {
      Game: { player_id: 2379469 },
      fetch: async (u) => {
        if (falhar) return { ok: false };
        const f = String(u).match(/data\/(\w+)\.txt/)[1];
        const m = { towns: TOWNS, players: PLAYERS, alliances: ALLIANCES, islands: ISLANDS }[f];
        return { ok: true, text: async () => m };
      },
    },
    localStorage: { getItem: (k) => (k in loja ? loja[k] : null), setItem: (k, v) => { loja[k] = v; } },
    Date, JSON, Number, Object, String, Promise, console, decodeURIComponent,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('  const MAPA_KEY =');
  const f = SRC.indexOf('\n  try {\n    uw.__maestroMapa', i);
  return vm.runInContext('(() => {' + PEDIR_JOGO + '\n' + SRC.slice(i, f)
    + '\nreturn { ler: buscarMapaDoMundo };\n})()', ctx);
}

(async () => {
  const api = nucleo(false);
  const m = await api.ler();
  {
    t.verifica('lê as cidades todas', m && m.nCidades === 5, m && m.nCidades);
    t.verifica('e os jogadores', m.nJogadores === 3, m.nJogadores);
  }
  {
    const naIlha = m.porIlha['499:507'] || [];
    t.verifica('agrupa as cidades por ilha', naIlha.length === 2, naIlha.length);
    const minha = naIlha.find((c) => c.id === 35);
    t.verifica('o LUGAR 0 é lido como 0, não como vazio', minha && minha.lugar === 0, minha);
  }
  {
    const j = m.jogadores[1923767];
    t.verifica('cada jogador traz a aliança', j && j.alianca === 126, j);
    t.verifica('e o nome da aliança resolve-se',
      (m.aliancas[126] || {}).nome === 'Berimbau de Xoxota', m.aliancas[126]);
    t.verifica('quem não tem aliança fica a zero', m.jogadores[2440228].alianca === 0);
  }
  {
    t.verifica('as ilhas trazem os lugares livres',
      m.ilhas['499:507'].livres === 3 && m.ilhas['390:500'].livres === 0, m.ilhas['499:507']);
  }
  {
    /* Os nomes vêm com + no lugar dos espaços. */
    t.verifica('os nomes são descodificados',
      m.aliancas[126].nome.indexOf('+') < 0, m.aliancas[126].nome);
  }
  {
    const api2 = nucleo(true);
    const r = await api2.ler();
    t.verifica('se os ficheiros falharem, não se inventa nada', r === null, r);
  }
  {
    /* A segunda leitura vem da memória: um pedido por hora. */
    let pedidos = 0;
    const antes = m.quando;
    const m2 = await api.ler();
    t.verifica('a segunda leitura não vai buscar outra vez', m2.quando === antes);
  }
  t.secao('QUEM USA O MAPA');
  {
    t.verifica('as sentinelas, para saber quem é aliado em cada ilha',
      /m\.porIlha\[coords\.x \+ ':' \+ coords\.y\]/.test(SRC)
      && /if \(!nomeAl \|\| !amigas\.has\(nomeAl\)\) continue;/.test(SRC));
    t.verifica('o fechar ilha, para saber que lugares estão ocupados',
      /if \(Number\.isFinite\(c\.lugar\)\) ocupados\.add\(Number\(c\.lugar\)\);/.test(SRC));
    t.verifica('... e calcula o total pelas cidades mais os livres',
      /const total = cidades\.length \+ Number\(ilha\.livres\);/.test(SRC));
    t.verifica('a fundação, para os lugares livres de cada ilha',
      /const livres = Number\(ilha\.livres\) \|\| 0;[\s\S]{0,400}doFicheiro: true/.test(SRC));
    t.verifica('todos mantêm a leitura do mapa como reserva',
      (SRC.match(/action=get_chunks/g) || []).length >= 3);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
