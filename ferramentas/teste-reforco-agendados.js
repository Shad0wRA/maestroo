/* REFORÇO — tropa já comprometida não se manda.
 *
 * A esquiva e o encaixe agendam envios: a tropa está em casa, mas já tem
 * destino e hora. Se o reforço a levar, o plano chega à hora e não encontra
 * nada. Uma cidade com envio agendado fica de fora do reforço.
 *
 *   node ferramentas/teste-reforco-agendados.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('REFORÇO — AGENDADOS');
const RE = 'function makeReforcoModule(opts)';

function montar(esquiva, encaixe, agora) {
  const loja = {
    grepoEsquiva_planos_v1: JSON.stringify(esquiva || {}),
    grepoEncaixe_planos_v1: JSON.stringify(encaixe || {}),
  };
  const ctx = {
    mUw: { Timestamp: { now: () => agora || 1000 } },
    armazem: { getItem: (k) => (k in loja ? loja[k] : null) },
    seErroDeCodigo: () => {}, console, Math, Number, Set, Object, JSON, Date,
  };
  vm.createContext(ctx);
  return vm.runInContext(funcao(SRC, '  function cidadesComEnvioAgendado() {', RE)
    + '\ncidadesComEnvioAgendado', ctx);
}

(async () => {
  {
    const f = montar({ 'a@1': { townId: 111, S: 1200 } }, {});
    t.verifica('cidade com plano de esquiva: fica de fora', [...f()].join() === '111', [...f()]);
  }
  {
    const f = montar({}, { 'b@2': { townId: 222, S: 1100 } });
    t.verifica('cidade com plano de encaixe: também', [...f()].join() === '222', [...f()]);
  }
  {
    const f = montar({ 'a@1': { townId: 111, S: 1200 } }, { 'b@2': { townId: 222, S: 1100 } });
    t.verifica('os dois módulos somam-se', igual([...f()].sort(), [111, 222]), [...f()]);
  }
  {
    /* Um plano cuja hora passou há mais de uma hora já não prende nada. */
    const f = montar({ 'velho@1': { townId: 111, S: 1000 - 7200 } }, {}, 1000);
    t.verifica('plano velho não prende a cidade', [...f()].length === 0, [...f()]);
  }
  {
    const f = montar({}, {});
    t.verifica('sem planos: nenhuma cidade de fora', [...f()].length === 0);
  }
  {
    const f = montar({ 'x': { S: 1200 } }, {});
    t.verifica('plano sem cidade: ignora-se em vez de rebentar', [...f()].length === 0);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
