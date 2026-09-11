/* NÚCLEO — o leitor da visão geral (`__maestroVisaoGeral`): o código REAL,
 * tirado do maestro.user.js, contra um jogo simulado. Cópia, `fresca`,
 * esquecer, pedidos ao mesmo tempo, 429, erros, sem Administrador.
 *
 *   node ferramentas/teste-nucleo.js maestro.user.js
 */
const fs = require('fs');
const vm = require('vm');

const ficheiro = process.argv[2] || 'maestro.user.js';
const src = fs.readFileSync(ficheiro, 'utf8');

const ini = src.indexOf('  async function lerRespostaComum(resposta) {');
const fim = src.indexOf('  /* ============ AVISO DE VERIFICAÇÃO DE BOT');
if (ini < 0 || fim < 0 || fim < ini) throw new Error('não encontrei o bloco do núcleo');
const bloco = src.slice(ini, fim);

let falhas = 0;
let n = 0;
function verifica(nome, cond, extra) {
  n++;
  if (cond) console.log('  ok  ', nome);
  else { falhas++; console.log('  FALHA', nome, extra !== undefined ? JSON.stringify(extra) : ''); }
}

/* Um jogo novo para cada cenário. `respostas` é uma fila: cada pedido tira a
 * primeira. Cada resposta: { status, corpo (objecto ou texto), atraso (ms) }. */
function montar(opcoes) {
  const op = opcoes || {};
  const pedidos = [];
  const caixa = [];
  const captchas = [];
  const travoes = [];
  const respostas = (op.respostas || []).slice();
  let agora = 1_000_000;
  const premium = op.premium === undefined ? { k: { attributes: { curator: 9e9 } } } : op.premium;

  const uw = {
    location: { origin: 'https://pt125.grepolis.com' },
    Game: { csrfToken: 'TOK', townId: 999 },
    ITowns: { towns: op.semCidades ? {} : { 111: {}, 222: {} } },
    MM: { getModels: () => ({ PremiumFeatures: premium }) },
    fetch: async (url, o) => {
      pedidos.push({ url, o });
      const r = respostas.shift() || { status: 200, corpo: { json: { commands: [] } } };
      if (r.lanca) throw new Error(r.lanca);
      if (r.atraso) await new Promise((res) => setTimeout(res, r.atraso));
      const texto = typeof r.corpo === 'string' ? r.corpo : JSON.stringify(r.corpo);
      return { status: r.status || 200, text: async () => texto };
    },
  };

  const ctx = {
    uw,
    Date: Object.assign(function () {}, { now: () => agora }),
    JSON, Object, Array, Number, String, Math, Promise, Error, encodeURIComponent,
    setTimeout,
    temAdministrador: () => !!(op.temAdm !== false),
    servidorTravado: () => !!op.travado,
    avisarCaptcha: async (onde) => { captchas.push(onde); },
    guardarNaCaixa: (m, t) => { caixa.push(t); },
    seErroDeCodigo: () => {},
    log: () => {},
  };
  /* `Date` falso só com o `now`; o resto (new Date) não é usado no leitor,
   * excepto no estado — aí vai o verdadeiro. */
  ctx.Date = new Proxy(Date, { get: (t, p) => (p === 'now' ? () => agora : t[p]) });
  vm.createContext(ctx);
  /* O leitor comum chama `uw.__maestroTravar` no 429. */
  uw.__maestroTravar = (min) => travoes.push(min);
  vm.runInContext(bloco, ctx);
  return {
    uw, pedidos, caixa, captchas, travoes,
    avancar: (ms) => { agora += ms; },
    vg: (o) => uw.__maestroVisaoGeral(o),
    esquecer: () => uw.__maestroVisaoGeralEsquecer(),
    estado: () => uw.__maestroVisaoGeralEstado(),
  };
}

const LISTA = [
  { id: 1, type: 'attack', origin_town_id: 5, destination_town_id: 111, arrival_at: 2000 },
  { id: 2, type: 'support', origin_town_id: 111, destination_town_id: 7, arrival_at: 3000 },
];
const ok = (lista) => ({ status: 200, corpo: { json: { commands: lista } } });
const okData = (lista) => ({ status: 200, corpo: { json: { data: { commands: lista } } } });

(async () => {
  console.log('\nLEITURA');
  {
    const j = montar({ respostas: [ok(LISTA)] });
    const r = await j.vg();
    verifica('json.commands → ok com a lista', r.ok && r.comandos.length === 2 && r.razao === '', r);
    const u = j.pedidos[0].url;
    verifica('pedido: GET à command_overview, primeira cidade, token, json',
      /\/game\/town_overviews\?town_id=111&action=command_overview&h=TOK&json=/.test(u)
      && !(j.pedidos[0].o || {}).method, u);
    verifica('pedido com x-requested-with e credenciais',
      j.pedidos[0].o.headers['x-requested-with'] === 'XMLHttpRequest'
      && j.pedidos[0].o.credentials === 'include');
  }
  {
    const j = montar({ respostas: [okData(LISTA)] });
    const r = await j.vg();
    verifica('json.data.commands → ok com a lista', r.ok && r.comandos.length === 2, r);
  }
  {
    const j = montar({ respostas: [ok([])] });
    const r = await j.vg();
    verifica('lista vazia de verdade → ok com []', r.ok && Array.isArray(r.comandos) && r.comandos.length === 0, r);
  }
  {
    const j = montar({ respostas: [{ status: 200, corpo: { json: { outra: 1 } } }] });
    const r = await j.vg();
    verifica('resposta sem lista → ok:false, comandos null, diz as chaves',
      !r.ok && r.comandos === null && /não traz a lista.*outra/.test(r.razao), r);
    verifica('... e fica na caixa da rotina', j.caixa.length === 1, j.caixa);
  }
  {
    const j = montar({ semCidades: true, respostas: [ok(LISTA)] });
    const r = await j.vg();
    verifica('sem ITowns → usa Game.townId', r.ok && /town_id=999&/.test(j.pedidos[0].url), j.pedidos[0]);
  }

  console.log('\nFALHAS');
  {
    const j = montar({ respostas: [{ status: 200, corpo: { json: { error: 'Algo correu mal' } } }] });
    const r = await j.vg();
    verifica('erro do jogo → ok:false com a razão', !r.ok && r.comandos === null && r.razao === 'Algo correu mal', r);
  }
  {
    const j = montar({ respostas: [{ status: 429, corpo: '' }] });
    const r = await j.vg();
    verifica('429 → ok:false e o núcleo trava', !r.ok && /recusar/.test(r.razao) && j.travoes.length === 1, r);
  }
  {
    const j = montar({ respostas: [{ status: 200, corpo: '<html>erro</html>' }] });
    const r = await j.vg();
    verifica('página de erro → ok:false', !r.ok && /página de erro/.test(r.razao), r);
  }
  {
    const j = montar({ respostas: [{ status: 200, corpo: '' }] });
    const r = await j.vg();
    verifica('resposta vazia → ok:false', !r.ok && /não respondeu/.test(r.razao), r);
  }
  {
    const j = montar({ respostas: [{ lanca: 'NetworkError' }] });
    const r = await j.vg();
    verifica('fetch rebenta → ok:false', !r.ok && /pedido falhou: NetworkError/.test(r.razao), r);
  }
  {
    const j = montar({ respostas: [{ status: 200, corpo: { json: { error: 'backend_requested_verification' } } }] });
    const r = await j.vg();
    verifica('verificação de bot → ok:false e avisa', !r.ok && /verificação/.test(r.razao)
      && j.captchas.length === 1, { r, captchas: j.captchas });
  }
  {
    const j = montar({ travado: true, respostas: [ok(LISTA)] });
    const r = await j.vg();
    verifica('servidor travado → ok:false SEM pedido', !r.ok && j.pedidos.length === 0 && /limitar/.test(r.razao), r);
  }

  console.log('\nADMINISTRADOR');
  {
    const j = montar({ temAdm: false, respostas: [ok(LISTA)] });
    const r = await j.vg();
    verifica('sem Administrador → ok:false SEM pedido', !r.ok && r.razao === 'sem Administrador'
      && j.pedidos.length === 0, r);
    verifica('... calado (nada na caixa)', j.caixa.length === 0, j.caixa);
  }
  {
    const j = montar({ premium: {}, temAdm: false, respostas: [ok(LISTA)] });
    const r = await j.vg();
    verifica('modelo das assinaturas por carregar → pede e decide o servidor',
      r.ok && j.pedidos.length === 1, r);
  }
  {
    const j = montar({ respostas: [
      { status: 200, corpo: { json: { error: 'Necessita do administrador para aceder às visões gerais' } } },
      ok(LISTA)] });
    const r1 = await j.vg();
    const r2 = await j.vg({ fresca: true });
    verifica('servidor diz "administrador" → ok:false', !r1.ok && r1.razao === 'sem Administrador', r1);
    verifica('... e não volta a pedir durante 30 min (nem com fresca)', !r2.ok && j.pedidos.length === 1, r2);
    j.avancar(31 * 60 * 1000);
    const r3 = await j.vg();
    verifica('... passados 30 min volta a pedir', r3.ok && j.pedidos.length === 2, r3);
  }

  console.log('\nCÓPIA PARTILHADA');
  {
    const j = montar({ respostas: [ok(LISTA), ok(LISTA.slice(0, 1))] });
    const r1 = await j.vg();
    j.avancar(10 * 1000);
    const r2 = await j.vg();
    verifica('dentro de 20 s → da cópia, sem pedido', r2.ok && r2.daCopia && j.pedidos.length === 1, r2);
    verifica('... com a hora da leitura original', r2.quando === r1.quando);
    j.avancar(11 * 1000);
    const r3 = await j.vg();
    verifica('passados 20 s → pedido novo', !r3.daCopia && j.pedidos.length === 2 && r3.comandos.length === 1, r3);
  }
  {
    const j = montar({ respostas: [ok(LISTA), ok(LISTA.slice(0, 1))] });
    await j.vg();
    const r = await j.vg({ fresca: true });
    verifica('fresca → salta a cópia', j.pedidos.length === 2 && r.comandos.length === 1 && !r.daCopia, r);
    const r2 = await j.vg();
    verifica('... e a leitura fresca passa a ser a cópia', r2.daCopia && r2.comandos.length === 1, r2);
  }
  {
    const j = montar({ respostas: [ok(LISTA), ok(LISTA.slice(0, 1))] });
    await j.vg();
    j.esquecer();
    const r = await j.vg();
    verifica('esquecer → o pedido seguinte vai ao servidor', j.pedidos.length === 2 && !r.daCopia, r);
  }
  {
    const j = montar({ respostas: [ok(LISTA)] });
    const a = await j.vg();
    a.comandos[0].type = 'MEXIDO';
    a.comandos.push({ id: 99 });
    const b = await j.vg();
    verifica('cada módulo recebe a sua cópia (mexer numa não mexe na outra)',
      b.comandos.length === 2 && b.comandos[0].type === 'attack', b.comandos);
  }
  {
    const j = montar({ respostas: [ok(LISTA)] });
    const r = await j.vg();
    j.avancar(5000);
    const e = j.estado();
    verifica('estado na consola', e.pedidos === 1 && /2 comando\(s\), de há 5 s/.test(e.copia)
      && e.administrador === 'sim', e);
    void r;
  }
  {
    const j = montar({ respostas: [{ status: 200, corpo: { json: { error: 'x' } } }, ok(LISTA)] });
    await j.vg();
    const r = await j.vg();
    verifica('uma falha não fica como cópia (o seguinte pede de novo)', r.ok && j.pedidos.length === 2, r);
  }

  console.log('\nPEDIDOS AO MESMO TEMPO');
  {
    const j = montar({ respostas: [{ ...ok(LISTA), atraso: 30 }] });
    const [a, b, c] = await Promise.all([j.vg(), j.vg(), j.vg()]);
    verifica('três pedidos ao mesmo tempo → um só pedido ao servidor',
      j.pedidos.length === 1 && a.ok && b.ok && c.ok, j.pedidos.length);
    verifica('... o primeiro fez o pedido, os outros partilharam',
      !a.daCopia && b.daCopia && c.daCopia && j.estado().partilhados === 2, j.estado());
    verifica('... e cada um com a sua cópia', a.comandos !== b.comandos && b.comandos !== c.comandos);
  }
  {
    const j = montar({ respostas: [{ ...ok(LISTA), atraso: 30 }, ok(LISTA)] });
    const pa = j.vg();
    const pb = j.vg({ fresca: true });
    await Promise.all([pa, pb]);
    verifica('fresca não aproveita um pedido já a caminho', j.pedidos.length === 2, j.pedidos.length);
  }
  {
    /* Envio a meio de uma leitura: a lista que vem pode não ter o envio. */
    const j = montar({ respostas: [{ ...ok(LISTA), atraso: 30 }, ok(LISTA.slice(0, 1))] });
    const pa = j.vg();
    await new Promise((r) => setTimeout(r, 5));
    j.esquecer();                                    // um módulo mandou tropa
    const pb = j.vg();                               // pede depois do envio
    const [a, b] = await Promise.all([pa, pb]);
    verifica('esquecer a meio: quem pediu antes recebe a lista antiga', a.ok && a.comandos.length === 2, a);
    verifica('... quem pediu depois NÃO partilha o pedido antigo', j.pedidos.length === 2
      && b.comandos.length === 1, { pedidos: j.pedidos.length, b });
    const c = await j.vg();
    verifica('... e a cópia que fica é a nova', c.daCopia && c.comandos.length === 1, c);
  }
  {
    const j = montar({ respostas: [{ ...ok(LISTA), atraso: 30 }] });
    const pa = j.vg();
    await new Promise((r) => setTimeout(r, 5));
    j.esquecer();
    await pa;
    const e = j.estado();
    verifica('esquecer a meio: a resposta antiga não fica como cópia', e.copia === 'nenhuma', e);
  }
  {
    const j = montar({ respostas: [{ status: 200, corpo: { json: { error: 'x' } }, atraso: 20 }] });
    const [a, b] = await Promise.all([j.vg(), j.vg()]);
    verifica('falha partilhada → os dois recebem ok:false', !a.ok && !b.ok && j.pedidos.length === 1);
  }

  console.log(`\n${n - falhas}/${n} verificações passaram.`);
  process.exit(falhas ? 1 : 0);
})();
