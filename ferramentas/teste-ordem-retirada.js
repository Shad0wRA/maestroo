/* ORDEM DE RETIRADA MARCADA AO ENVIAR, E TECTO DE 14 HORAS.
 *
 * A retirada dependia de LER — a visão geral e a Ágora. Quando a leitura
 * falha, a tropa ficava no alvo indefinidamente (visto em jogo, 15/09). A
 * ordem marca-se no envio: um minuto depois do impacto. E um alvo não fica na
 * lista mais do que uma revolta pode durar: 7 h + 7 h = 14 h.
 *
 *   node ferramentas/teste-ordem-retirada.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('ORDEM DE RETIRADA');
const AP = 'function makeApoioModule(opts)';

/* O tecto das 14 h, com o relógio na mão. */
function tecto(entradas, agoraMs) {
  const loja = { grepoApoio_entradaAlvo_v1: JSON.stringify(entradas || {}) };
  const ctx = {
    armazem: { getItem: (k) => (k in loja ? loja[k] : null), setItem: (k, v) => { loja[k] = v; } },
    seErroDeCodigo: () => {}, console, Math, Number, Object, JSON, Set,
    Date: new Proxy(Date, { get: (o, p) => (p === 'now' ? () => agoraMs : o[p]) }),
  };
  vm.createContext(ctx);
  /* Do TECTO até ao fim do `alvosPassadosDoTecto`. */
  const a = SRC.indexOf('  const TECTO_ALVO_MS = 14 * 3600 * 1000;');
  const b = SRC.indexOf('\n  function faltaRepor(alvoId) {', a);
  const api = vm.runInContext('(() => {\n' + SRC.slice(a, b)
    + '\nreturn { marcar: marcarEntrada, passados: alvosPassadosDoTecto, ver: lerEntradas };\n})()', ctx);
  return { api, loja };
}

const H = 3600 * 1000;

(async () => {
  const agora = 1000 * H;
  {
    const m = tecto({}, agora);
    m.api.marcar([111, 222]);
    t.verifica('um alvo novo fica marcado com a hora de entrada',
      Object.keys(m.api.ver()).length === 2, m.api.ver());
    t.verifica('acabado de entrar: não passa do tecto', m.api.passados([111, 222]).length === 0);
  }
  {
    const m = tecto({ 111: agora - 13 * H, 222: agora - 15 * H }, agora);
    t.verifica('13 h fica, 15 h sai', igual(m.api.passados([111, 222]), [222]), m.api.passados([111, 222]));
  }
  {
    const m = tecto({ 111: agora - 20 * H }, agora);
    m.api.marcar([222]);
    t.verifica('um alvo tirado da lista deixa de ser contado',
      !m.api.ver()[111] && !!m.api.ver()[222], m.api.ver());
  }
  {
    const m = tecto({ 111: agora - 2 * H }, agora);
    m.api.marcar([111]);
    t.verifica('marcar de novo não reinicia o relógio', m.api.ver()[111] === agora - 2 * H, m.api.ver());
  }
  t.secao('REFORÇO — A HORA MARCADA AO ENVIAR');
  {
    /* O registo do envio passa a levar `retirarAs` = impacto + 1 min. */
    const i = SRC.indexOf('        const impactoNovo = Math.max(');
    t.verifica('o envio guarda a hora da retirada', i > 0 && /retirarAs: impactoNovo \? impactoNovo \+ 60 : 0/.test(SRC.slice(i, i + 1400)));
  }
  {
    const i = SRC.indexOf('      const horaOrdem = Number(e.retirarAs)');
    t.verifica('a retirada usa essa hora, com recurso ao impacto nos envios antigos',
      i > 0 && /\|\| \(Number\(e\.impacto\) \? Number\(e\.impacto\) \+ 60 : 0\)/.test(SRC.slice(i, i + 200)));
  }
  {
    const i = SRC.indexOf('      if (aindaAtacadas.has(Number(e.destino))) {');
    const bloco = SRC.slice(i, i + 700);
    t.verifica('outro ataque à mesma cidade adia a ordem em vez de a cancelar',
      /e\.retirarAs = proximo \+ 60/.test(bloco), bloco.slice(0, 200));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
