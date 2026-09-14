/* ESQUIVA — a margem tem de chegar para a preparação.
 *
 * Eram 20 s entre a saída e o impacto. Mas entre o temporizador disparar e a
 * tropa sair passam-se segundos a actualizar contadores, carregar a ilha e
 * fazer os envios: numa cidade com três envios foram 36 s e a tropa saiu
 * DEPOIS do impacto (visto em jogo, 14/09, ataque às 11:17:58).
 *
 *   node ferramentas/teste-esquiva-margem.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('ESQUIVA — MARGEM');
const ES = 'function makeEsquivaModule(opts)';

function montar(guardado) {
  const loja = guardado == null ? {} : { grepoEsquiva_preparo_v1: String(guardado) };
  const ctx = {
    armazem: { getItem: (k) => (k in loja ? loja[k] : null), setItem: (k, v) => { loja[k] = v; } },
    seErroDeCodigo: () => {}, console, Number, Math,
    PREPARO_KEY: 'grepoEsquiva_preparo_v1',
  };
  vm.createContext(ctx);
  const api = vm.runInContext(funcao(SRC, '  function preparoConhecido() {', ES)
    + funcao(SRC, '  function anotarPreparo(segundos) {', ES)
    + '\n({ ler: preparoConhecido, anotar: anotarPreparo })', ctx);
  return { api, loja };
}

(async () => {
  {
    const m = montar(null);
    t.verifica('sem histórico: não acrescenta margem nenhuma', m.api.ler() === 0);
  }
  {
    const m = montar(null);
    m.api.anotar(36);
    t.verifica('uma esquiva que levou 36 s: passa a contar com 36', m.api.ler() === 36, m.api.ler());
  }
  {
    const m = montar(36);
    m.api.anotar(50);
    t.verifica('uma mais lenta: sobe já para 50', m.api.ler() === 50, m.api.ler());
  }
  {
    const m = montar(50);
    m.api.anotar(10);
    t.verifica('uma rápida: desce devagar, não confia num arranque bom', m.api.ler() > 30 && m.api.ler() < 50, m.api.ler());
    for (let i = 0; i < 20; i++) m.api.anotar(10);
    t.verifica('... mas ao fim de muitas rápidas aproxima-se delas', m.api.ler() <= 12, m.api.ler());
  }
  {
    const m = montar(null);
    m.api.anotar(600);
    t.verifica('um caso absurdo fica travado nos 3 min', m.api.ler() === 180, m.api.ler());
  }
  {
    const m = montar(null);
    m.api.anotar(-5);
    t.verifica('valor sem sentido não estraga nada', m.api.ler() === 0, m.api.ler());
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
