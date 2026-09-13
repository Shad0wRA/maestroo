/* ENCAIXE — as composições enchem os barcos até cima.
 *
 * A capacidade saía da tabela base (10 e 26) e ignorava a pesquisa de porões
 * (16 e 32). Com 138 transportes rápidos davam-se 1380 lugares em vez de 2208:
 * as composições levavam menos 293 de tropa (visto em jogo, 13/09). O
 * enchimento REAL do módulo.
 *
 *   node ferramentas/teste-encaixe-carga.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('ENCAIXE — CARGA');

/* A cidade da imagem: 950 espadachins, 965 arqueiros, 481 hoplitas, 138
 * transportes rápidos. */
const TENHO = { sword: 950, archer: 965, hoplite: 481, small_transporter: 138 };
const GD = {
  sword: { population: 1 }, archer: { population: 1 }, hoplite: { population: 1 },
  small_transporter: { is_naval: true, capacity: 10 }, big_transporter: { is_naval: true, capacity: 26 },
};

function encher(carga, poroes, tenho) {
  const ctx = {
    gd: GD, tenho: tenho || TENHO, carga,
    t: { researches: () => ({ attributes: poroes ? { berth: true } : {} }) },
    seErroDeCodigo: () => {}, Number, Object, Math,
  };
  vm.createContext(ctx);
  vm.runInContext(tira(SRC, '            try {\n              /* OS PORÕES CONTAM.', '            } catch (e) { seErroDeCodigo(e, \'Encaixe\'); }\n'), ctx);
  return ctx.carga;
}
const soma = (c) => Object.keys(c).filter((u) => !GD[u].is_naval)
  .reduce((s, u) => s + (Number(c[u]) || 0) * (GD[u].population || 1), 0);

(async () => {
  {
    const c = encher({ small_transporter: 138 }, true);
    t.verifica('com porões: 138 transportes = 2208 lugares, cheios', soma(c) === 2208, { c, soma: soma(c) });
    t.verifica('... e sobra hoplitas para os 293 lugares que faltavam',
      c.sword === 950 && c.archer === 965 && c.hoplite === 293, c);
  }
  {
    const c = encher({ small_transporter: 138 }, false);
    t.verifica('sem porões: 1380 lugares (era isto que dava sempre)', soma(c) === 1380, soma(c));
  }
  {
    const c = encher({ small_transporter: 138, big_transporter: 1 }, true);
    t.verifica('com um barco grande: mais 32 lugares', soma(c) === 2240, soma(c));
  }
  {
    const c = encher({ small_transporter: 400 }, true);
    t.verifica('barcos a mais do que tropa: leva a tropa toda e não inventa',
      soma(c) === 950 + 965 + 481, { c, soma: soma(c) });
  }
  {
    const c = encher({}, true);
    t.verifica('sem transportes: não leva tropa nenhuma', soma(c) === 0, c);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
