/* PAINEL DOS RELATÓRIOS — o botão Guardar.
 *
 * O visto dos transportes nunca esteve no HTML, e o `.checked` de um campo
 * que não existe rebentava o Guardar inteiro: não se guardava nada, nem o
 * resto. O painel REAL, desenhado num DOM de mentira.
 *
 *   node ferramentas/teste-painel-relatorios.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('PAINEL DOS RELATÓRIOS');

/* Um DOM só com o que o painel usa: ids, checked, value e onclick. */
function dom(html) {
  const els = {};
  const re = /id=\\?"([a-z-]+)\\?"([^>]*)/g;
  let m;
  while ((m = re.exec(html))) {
    const resto = m[2] || '';
    els[m[1]] = { checked: / checked/.test(resto), value: (resto.match(/value=\\?"([^"\\]*)/) || [])[1] || '' };
  }
  return { querySelector: (s) => els[s.replace('#', '')] || null, els };
}

function painel(cfgInicial) {
  const loja = { 'grepoRelatorios_cfg_v1': JSON.stringify(cfgInicial || {}) };
  const guardado = [];
  /* O módulo inteiro, com o `armazem` e o `normalizar` que ele espera. */
  const txt = S.fabrica(SRC, 'makeRelatoriosModule')
    + "\nmakeRelatoriosModule({ intervaloMin: 60 })";
  const ctx = {
    window: { __maestroArmazem: {
      getItem: (k) => (k in loja ? loja[k] : null),
      setItem: (k, v) => { loja[k] = v; try { guardado.push(JSON.parse(v)); } catch (e) {} },
    } },
    localStorage: { getItem: () => null, setItem: () => {} },
    seErroDeCodigo: () => {}, console,
  };
  vm.createContext(ctx);
  return { mod: vm.runInContext(txt, ctx), guardado, loja };
}

(async () => {
  let p;
  try { p = painel({ ativo: true, apoios: true, transportes: false, ler: true, lerMax: 7 }); }
  catch (e) { console.error('não consegui montar o painel:', e.message); process.exit(2); }

  /* Desenhar o painel: recolhe-se o HTML que ele produz. */
  let html = '';
  const container = {
    set innerHTML(v) { html = v; Object.assign(this, dom(v)); },
    get innerHTML() { return html; },
    querySelector: () => null,
  };
  p.mod.painel(container, { log: () => {}, uw: {} });

  t.verifica('o painel tem o visto dos transportes', !!container.querySelector('#rel-transp'),
    Object.keys(container.els || {}));
  t.verifica('... e o visto de ler os relatórios', !!container.querySelector('#rel-ler'));

  const g = container.querySelector('#rel-guardar');
  t.verifica('o botão Guardar existe', !!g);
  if (g && g.onclick) {
    let rebentou = '';
    try { g.onclick(); } catch (e) { rebentou = e.message; }
    t.verifica('Guardar não rebenta', !rebentou, rebentou);
    const ultimo = p.guardado[p.guardado.length - 1] || {};
    t.verifica('... e guarda o que estava no painel', ultimo.ativo === true && ultimo.apoios === true
      && ultimo.ler === true && ultimo.lerMax === 7, ultimo);
  }

  /* Um painel a que falte um campo (versão antiga do HTML, ou outro tema). */
  const c2 = { innerHTML: '', querySelector: (s) => (s === '#rel-guardar' ? c2.__g : null) };
  c2.__g = {};
  try {
    p.mod.painel(c2, { log: () => {}, uw: {} });
    let rebentou2 = '';
    if (c2.__g.onclick) { try { c2.__g.onclick(); } catch (e) { rebentou2 = e.message; } }
    t.verifica('com os campos todos em falta, Guardar continua sem rebentar', !rebentou2, rebentou2);
  } catch (e) { t.verifica('com os campos todos em falta, Guardar continua sem rebentar', false, e.message); }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
