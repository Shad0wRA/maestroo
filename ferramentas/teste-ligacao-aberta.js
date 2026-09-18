/* LIGAÇÃO ABERTA AO FIREBASE.
 *
 * Uma conta só sabia de uma mudança quando ia perguntar — na passagem do
 * módulo, até dois minutos depois. O Firebase sabe avisar: mantém uma ligação
 * aberta e manda o que mudou (18/09).
 *
 * A ligação NÃO substitui a leitura: só diz "há coisa nova", e quem recebe vai
 * ler como sempre. Se falhar ou repetir, o pior que acontece é uma leitura a
 * mais.
 *
 *   node ferramentas/teste-ligacao-aberta.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('LIGAÇÃO ABERTA');

/* Um EventSource de mentira, para se poder provocar tudo. */
function fazerEventSource(registo) {
  return class {
    constructor(url) {
      this.url = url;
      this.ouvintes = {};
      registo.abertas.push(url);
      this.fechado = false;
    }
    addEventListener(nome, fn) { (this.ouvintes[nome] = this.ouvintes[nome] || []).push(fn); }
    close() { this.fechado = true; registo.fechadas.push(this.url); }
    /* provocar */
    disparar(nome, dados) {
      for (const fn of (this.ouvintes[nome] || [])) fn({ data: JSON.stringify(dados) });
    }
    erro() { if (this.onerror) this.onerror(); }
    aberta() { if (this.onopen) this.onopen(); }
  };
}

function montar(comEventSource) {
  const registo = { abertas: [], fechadas: [], log: [] };
  const criadas = [];
  const ES = fazerEventSource(registo);
  const ctx = {
    uw: comEventSource
      ? { EventSource: function (u) { const e = new ES(u); criadas.push(e); return e; } }
      : {},
    firebaseUrl: () => 'https://x.firebasedatabase.app',
    log: (m, x) => registo.log.push(x),
    seErroDeCodigo: () => {},
    Date, Map, Object, String, JSON, console,
  };
  if (comEventSource) ctx.uw.EventSource.prototype = ES.prototype;
  vm.createContext(ctx);
  const i = SRC.indexOf('  const LIGACOES_MAX = 1;');
  const f = SRC.indexOf('\n  try {\n    uw.__maestroLigacao', i);
  const api = vm.runInContext('(() => {\n' + SRC.slice(i, f)
    + '\nreturn { abrir: ligacaoAberta, fechar: fecharLigacoes, estado: () => ligacoesEstado };\n})()', ctx);
  return { api, registo, criadas };
}

(async () => {
  t.secao('ABRIR');
  {
    const m = montar(true);
    const avisos = [];
    const r = m.api.abrir('apoio/pt126', (x) => avisos.push(x));
    t.verifica('abre a ligação ao caminho certo',
      m.registo.abertas[0] === 'https://x.firebasedatabase.app/apoio/pt126.json', m.registo.abertas);
    t.verifica('e devolve o estado', !!r);
  }
  {
    const m = montar(false);
    t.verifica('sem EventSource no navegador, não rebenta',
      m.api.abrir('apoio/pt126', () => {}) === null);
  }
  {
    const m = montar(true);
    m.api.abrir('a', () => {});
    const segunda = m.api.abrir('b', () => {});
    t.verifica('respeita o limite de ligações', segunda === null, m.registo.abertas);
    t.verifica('... e diz porquê', m.registo.log.some((x) => /limite/.test(x)), m.registo.log);
  }
  {
    const m = montar(true);
    m.api.abrir('a', () => {});
    const outra = m.api.abrir('a', () => {});
    t.verifica('não abre duas vezes o mesmo caminho', m.registo.abertas.length === 1);
  }

  t.secao('RECEBER');
  {
    const m = montar(true);
    const avisos = [];
    m.api.abrir('apoio/pt126', (x) => avisos.push(x));
    const es = m.criadas[0];

    /* A primeira mensagem é o estado actual, não uma mudança. */
    es.disparar('put', { path: '/', data: { alvos: [1, 2] } });
    t.verifica('a primeira mensagem não conta como mudança', avisos.length === 0, avisos);

    es.disparar('put', { path: '/alvos', data: [1, 2, 3] });
    t.verifica('a segunda já avisa', avisos.length === 1, avisos);
    t.verifica('... e diz o caminho e o tipo',
      avisos[0].tipo === 'put' && avisos[0].caminho === '/alvos', avisos[0]);

    es.disparar('patch', { path: '/x', data: { y: 1 } });
    t.verifica('também avisa nas alterações parciais', avisos.length === 2, avisos);
  }
  {
    const m = montar(true);
    const avisos = [];
    m.api.abrir('a', (x) => avisos.push(x));
    const es = m.criadas[0];
    es.disparar('put', { path: '/', data: null });
    es.disparar('keep-alive', {});
    t.verifica('o keep-alive não avisa ninguém', avisos.length === 0);
  }
  {
    const m = montar(true);
    const avisos = [];
    m.api.abrir('a', (x) => avisos.push(x));
    const es = m.criadas[0];
    es.disparar('put', { path: '/', data: null });
    for (const fn of (es.ouvintes.put || [])) fn({ data: 'isto não é json' });
    t.verifica('uma mensagem estragada não rebenta nem avisa', avisos.length === 0);
  }

  t.secao('QUANDO CORRE MAL');
  {
    const m = montar(true);
    m.api.abrir('a', () => {});
    const es = m.criadas[0];
    for (let i = 0; i < 9; i++) es.erro();
    t.verifica('aguenta falhas sem desistir', !es.fechado, m.api.estado());
    es.erro();
    t.verifica('ao fim de dez desiste', es.fechado, m.api.estado());
    t.verifica('... e diz que continua a ler como antes',
      m.registo.log.some((x) => /continua a ler como antes/.test(x)), m.registo.log);
  }
  {
    const m = montar(true);
    m.api.abrir('a', () => {});
    const es = m.criadas[0];
    es.disparar('cancel', {});
    t.verifica('se o servidor cancelar, fecha-se', es.fechado);
    t.verifica('... e deixa de contar como aberta', m.api.estado().abertas === 0, m.api.estado());
  }
  {
    const m = montar(true);
    m.api.abrir('a', () => {});
    m.api.fechar();
    t.verifica('o fechar fecha tudo', m.registo.fechadas.length === 1 && m.api.estado().abertas === 0);
  }

  t.secao('O QUE A LIGAÇÃO NÃO FAZ');
  {
    t.verifica('não substitui a leitura — quem recebe vai ler',
      /O QUE ISTO NÃO É: não substitui a leitura/.test(SRC));
    t.verifica('o aviso acorda o módulo, não decide nada',
      /acordar\('apoio', 0\);/.test(SRC) && /acordar\('partircerco', 0\);/.test(SRC));
    /* Há uma ligação por conta, e deve ser gasta no que aquele mundo usa: nos
     * de revolta é a lista do apoio; nos de cerco o apoio nem corre (18/09). */
    t.verifica('e o caminho depende do tipo do mundo',
      /const caminho = deCerco \? `cercos\/\$\{WORLD\}` : `apoio\/\$\{WORLD\}`;/.test(SRC));
    t.verifica('e o orçamento de ligações está escrito',
      /O ORÇAMENTO DE LIGAÇÕES/.test(SRC) && /const LIGACOES_MAX = 1;/.test(SRC));
  }
  t.secao('O PAINEL MOSTRA O ESTADO');
  {
    t.verifica('há um sítio no painel da frota',
      /<div id="frota-ligacao"/.test(SRC));
    t.verifica('diz quando está ligada e quantos avisos recebeu',
      /\$\{e\.avisos\} aviso\(s\) recebido\(s\)/.test(SRC));
    t.verifica('... e quando não está, explica que não se perde nada',
      /o Maestro lê como sempre/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
