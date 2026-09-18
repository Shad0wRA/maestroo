/* AS EQUIPAS DOS COLONIZADORES DISTRIBUEM-SE SOZINHAS.
 *
 * A lista de nomes estava escrita no código — a do Rafa. Quem usasse o Maestro
 * noutro grupo, noutro PC e com outro Firebase, ficava de fora e tinha de
 * configurar conta a conta (17/09).
 *
 * Agora a conta principal do perfil multi divide as contas que a frota conhece
 * e publica. Uma divisão só; quem chegar depois entra na equipa mais pequena,
 * sem mexer em quem já lá está.
 *
 *   node ferramentas/teste-equipas.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('EQUIPAS');

const AGORA = Math.floor(Date.now() / 1000);

function montar(frota, equipas) {
  const guardado = { valor: equipas };
  const registo = [];
  const ctx = {
    WORLD: 'pt126',
    uw: {
      __maestroFb: {
        url: () => 'https://x',
        ler: async (c) => (c === 'frota/pt126' ? frota : guardado.valor),
        escrever: async (c, d) => { guardado.valor = d; },
      },
    },
    log: (m, x) => registo.push(x),
    seErroDeCodigo: () => {},
    Date, Object, Number, String, console,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('  const EQUIPAS_KEY = () =>');
  const f = SRC.indexOf('\n  try {\n    uw.__maestroEquipas', i);
  const api = vm.runInContext('(() => {\n' + SRC.slice(i, f)
    + '\nreturn { ler: equipasPublicadas, distribuir: distribuirEquipas };\n})()', ctx);
  return { api, guardado, registo };
}

const conta = (nome, perfil, ha) => ({ conta: nome, perfil, quando: AGORA - (ha || 0) });

(async () => {
  {
    /* Quatro multis e uma main: a main fica de fora. */
    const m = montar({
      a: conta('Alfa', 'multi'), b: conta('Beta', 'multi'),
      c: conta('Gama', 'multi'), d: conta('Delta', 'multi'),
      e: conta('AMain', 'main'),
    }, null);
    const r = await m.api.distribuir();
    t.verifica('divide as multis em duas equipas', Object.keys(r).length === 4, r);
    const a = Object.values(r).filter((x) => x === 'A').length;
    const b = Object.values(r).filter((x) => x === 'B').length;
    t.verifica('... metade para cada', a === 2 && b === 2, { a, b });
    t.verifica('a main fica de fora', !r.AMain, r);
  }
  {
    /* Já há equipas: quem chega entra na mais pequena, sem mexer no resto. */
    const m = montar({
      a: conta('Alfa', 'multi'), b: conta('Beta', 'multi'), c: conta('Novo', 'multi'),
    }, { Alfa: 'A', Beta: 'A' });
    const r = await m.api.distribuir();
    t.verifica('quem já tem equipa fica onde estava', r.Alfa === 'A' && r.Beta === 'A', r);
    t.verifica('o novo entra na equipa mais pequena', r.Novo === 'B', r);
  }
  {
    /* Uma conta calada mantém o lugar mas não conta para o equilíbrio. */
    const m = montar({
      a: conta('Alfa', 'multi'), b: conta('Beta', 'multi', 99999),
      c: conta('Novo', 'multi'),
    }, { Alfa: 'A', Beta: 'B' });
    const r = await m.api.distribuir();
    t.verifica('a conta calada mantém a equipa', r.Beta === 'B', r);
    t.verifica('... e o novo vai para a equipa com menos contas VIVAS',
      r.Novo === 'B', r);
  }
  {
    /* Sem multis vivas, não se inventa nada. */
    const m = montar({ e: conta('AMain', 'main') }, null);
    const r = await m.api.distribuir();
    t.verifica('sem multis, não distribui', r === null, r);
  }
  {
    /* Nada mudou: não se reescreve. */
    const m = montar({ a: conta('Alfa', 'multi') }, { Alfa: 'A' });
    const antes = m.guardado.valor;
    await m.api.distribuir();
    t.verifica('sem contas novas, não mexe no que está publicado',
      m.guardado.valor === antes, m.guardado.valor);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
