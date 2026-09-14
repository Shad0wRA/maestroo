/* REFORÇO — não dar a tropa por perdida só porque os modelos não a mostram.
 *
 * Os modelos `Units` são incompletos. Uma lista sem o bloco passava por
 * "morreu no ataque ou foi retirada": o registo era apagado e a tropa ficava
 * parada no destino para sempre (visto em jogo, 14/09 — quatro cidades de uma
 * vez em 55.9). Agora confirma-se na Ágora da origem. O `blocosEm` REAL.
 *
 *   node ferramentas/teste-reforco-blocos.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('REFORÇO — BLOCOS');
const RE = 'function makeReforcoModule(opts)';

/* `modelos`: o que a página tem. `agora`: o que a Ágora responde
 * (null = não consegui ler; lista = o que está fora daquela cidade). */
function montar(modelos, agora) {
  const pedidos = [];
  const ctx = {
    mUw: {
      MM: { getModels: () => ({ Units: modelos || {} }) },
      GameData: { units: { sword: {}, archer: {}, hoplite: {}, bireme: {} } },
      __maestroApoioFora: agora === undefined ? undefined : {
        daCidade: async (id) => { pedidos.push(id); return agora; },
      },
    },
    seErroDeCodigo: () => {}, console,
  };
  vm.createContext(ctx);
  const f = vm.runInContext(funcao(SRC, '  async function blocosEm(origemId, destinoId) {', RE)
    + funcao(SRC, '  function blocosPelosModelos(origemId, destinoId) {', RE) + '\nblocosEm', ctx);
  return { f, pedidos };
}

const MODELO = { m1: { attributes: { id: 417043, home_town_id: 55013, current_town_id: 55009, archer: 559, hoplite: 493 } } };
const OUTRO = { m2: { attributes: { id: 999, home_town_id: 55027, current_town_id: 55009, archer: 10 } } };

(async () => {
  {
    const m = montar(MODELO);
    const r = await m.f(55013, 55009);
    t.verifica('o bloco está nos modelos: usa-o, sem perguntar à Ágora',
      r.length === 1 && r[0].id === 417043 && igual(r[0].unidades, { archer: 559, hoplite: 493 }), r);
  }
  {
    /* O caso de 14/09: há modelos, mas não o desta origem. */
    const m = montar(OUTRO, [{ alvoId: 55009, unitsId: 417043, unidades: { archer: 559 } }]);
    const r = await m.f(55013, 55009);
    t.verifica('modelos sem o bloco, mas a Ágora tem-no: a tropa ESTÁ lá',
      r.length === 1 && r[0].id === 417043 && m.pedidos[0] === 55013, { r, p: m.pedidos });
  }
  {
    const m = montar(OUTRO, []);
    const r = await m.f(55013, 55009);
    t.verifica('a Ágora responde e não tem nada: aí sim, já não está', igual(r, []), r);
  }
  {
    const m = montar(OUTRO, [{ alvoId: 55018, unitsId: 5, unidades: { sword: 3 } }]);
    const r = await m.f(55013, 55009);
    t.verifica('a Ágora só mostra apoio noutra cidade: já não está em 55.9', igual(r, []), r);
  }
  {
    const m = montar(OUTRO, null);
    const r = await m.f(55013, 55009);
    t.verifica('a Ágora não conseguiu ler: NÃO SEI (mantém o registo)', r === null, r);
  }
  {
    const m = montar({}, [{ alvoId: 55009, unitsId: 1, unidades: { sword: 1 } }]);
    const r = await m.f(55013, 55009);
    t.verifica('modelos por carregar: não sei, sem sequer perguntar', r === null && !m.pedidos.length, { r, p: m.pedidos });
  }
  {
    const m = montar(OUTRO, undefined);
    const r = await m.f(55013, 55009);
    t.verifica('sem a Ágora disponível: não sei (não apaga o registo)', r === null, r);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
