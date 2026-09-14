/* ACÇÕES QUE RESPONDEM CALADAS, E ESCRITAS QUE FALHAM EM SILÊNCIO.
 *
 * "Não veio erro" contava por feito, e um `catch` vazio à volta de uma
 * escrita perdia definições sem dizer nada. Nenhuma das duas coisas mudava de
 * comportamento — mudavam de visibilidade, que é o primeiro passo para as
 * corrigir com dados.
 *
 *   node ferramentas/teste-silencios.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('SILÊNCIOS');

function nucleo() {
  const caixa = [];
  const ctx = {
    uw: {}, guardarNaCaixa: (m, txt) => caixa.push(txt), console, Object, Number, String,
  };
  vm.createContext(ctx);
  const a = SRC.indexOf('  const respostasMudas = {};');
  const b = SRC.indexOf('\n  function seErroDeCodigo(e, onde) {', a);
  vm.runInContext(SRC.slice(a, b), ctx);
  return { ctx, caixa };
}

(async () => {
  {
    const n = nucleo();
    n.ctx.anotarRespostaMuda('https://pt126.grepolis.com/game/building_barracks?town_id=1&action=build&h=X');
    t.verifica('regista a acção que respondeu calada',
      n.ctx.uw.__maestroRespostasMudas()['building_barracks:build'] === 1,
      n.ctx.uw.__maestroRespostasMudas());
    t.verifica('... e deixa uma linha na caixa, uma só',
      n.caixa.length === 1 && /sem confirmação/.test(n.caixa[0]), n.caixa);
    n.ctx.anotarRespostaMuda('https://pt126.grepolis.com/game/building_barracks?town_id=1&action=build&h=X');
    t.verifica('a segunda vez conta mas não repete a linha',
      n.ctx.uw.__maestroRespostasMudas()['building_barracks:build'] === 2 && n.caixa.length === 1);
  }
  {
    const n = nucleo();
    n.ctx.anotarRespostaMuda('https://x/game/town_info?action=send_units&h=Y');
    n.ctx.anotarRespostaMuda('https://x/game/frontend_bridge?action=execute&h=Y');
    t.verifica('acções diferentes ficam separadas',
      Object.keys(n.ctx.uw.__maestroRespostasMudas()).length === 2,
      n.ctx.uw.__maestroRespostasMudas());
  }
  {
    /* Uma escrita que falha por falta de espaço passa a ser reportada. */
    const vistos = [];
    const ctx = { log: (m, txt) => vistos.push(txt), errosJaVistos: new Set(), console };
    vm.createContext(ctx);
    const i = SRC.indexOf('  function seErroDeCodigo(e, onde) {');
    const f = SRC.indexOf('\n  }\n', i) + 4;
    vm.runInContext(SRC.slice(i, f) + '\nseErroDeCodigo', ctx);
    ctx.seErroDeCodigo(new Error('QuotaExceededError: persistent storage'), 'Apoio');
    t.verifica('falha a guardar: reportada', vistos.some((x) => /Apoio/.test(x)), vistos);
    ctx.seErroDeCodigo(new Error('coisa qualquer prevista'), 'Apoio');
    t.verifica('falha prevista: continua em silêncio', vistos.length === 1, vistos);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
