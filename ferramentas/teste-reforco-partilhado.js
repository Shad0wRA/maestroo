/* O REFORÇO SOB ATAQUE, PARTILHADO ENTRE AS CONTAS.
 *
 * Cada conta só defendia as suas cidades — e uma multi sozinha raramente tem
 * tropa que chegue. Agora um ataque a qualquer cidade do grupo é defendido por
 * todas (desenhado com o Rafa, 18/09).
 *
 * E o envio passa pelo ENCAIXE, a chegar um segundo antes do impacto: o
 * adversário não tem tempo de ajustar o ataque. Desvio só para antes — tropa
 * que chega depois não defende nada.
 *
 *   node ferramentas/teste-reforco-partilhado.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, PEDIR_JOGO } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('REFORÇO PARTILHADO');
const RF = 'function makeReforcoModule(opts)';

const AGORA = Math.floor(Date.now() / 1000);

function montar(publicado, frota) {
  const escritos = {};
  const ctx = {
    mUw: {
      Game: { world_id: 'pt126', player_name: 'Eu' },
      __maestroFb: {
        url: () => 'https://x',
        ler: async (c) => (/^frota/.test(c) ? frota : publicado),
        escrever: async (c, d) => { escritos[c] = d; },
      },
    },
    seErroDeCodigo: () => {},
    Date, Math, Number, Object, String, console,
  };
  vm.createContext(ctx);
  const api = vm.runInContext(PEDIR_JOGO
    + funcao(SRC, '  async function publicarAtaques(ataques) {', RF)
    + funcao(SRC, '  async function ataquesDoGrupo() {', RF)
    + funcao(SRC, '  async function quotaDestaConta(objetivo) {', RF)
    + "\nconst caminhoAtaques = () => `reforcoAtaques/${mUw.Game.world_id}`;"
    + '\n({ publicar: publicarAtaques, ler: ataquesDoGrupo, quota: quotaDestaConta })', ctx);
  return { api, escritos };
}

(async () => {
  t.secao('PUBLICAR');
  {
    const m = montar({}, {});
    await m.api.publicar([{ cid: '7', alvo: 500, alvoNome: '55.1', chega: AGORA + 600 }]);
    const d = m.escritos['reforcoAtaques/pt126/Eu'];
    t.verifica('publica os ataques que me chegam', !!d && !!d.ataques['7'], d);
    t.verifica('... com a cidade, o nome e a hora',
      d.ataques['7'].alvo === 500 && d.ataques['7'].nome === '55.1'
      && d.ataques['7'].chega === AGORA + 600, d.ataques['7']);
    t.verifica('... e diz de que conta é', d.ataques['7'].conta === 'Eu');
  }

  t.secao('LER OS DOS OUTROS');
  {
    const m = montar({
      Outra: { quando: AGORA, ataques: { 9: { alvo: 800, nome: '34.2', chega: AGORA + 900, conta: 'Outra' } } },
    }, {});
    const r = await m.api.ler();
    t.verifica('lê os ataques das outras contas', r.length === 1, r);
    t.verifica('... com a conta a que pertencem', r[0].conta === 'Outra', r[0]);
  }
  {
    /* Uma publicação velha não é de confiança: a conta pode ter fechado. */
    const m = montar({
      Velha: { quando: AGORA - 7200, ataques: { 9: { alvo: 800, chega: AGORA + 900 } } },
    }, {});
    t.verifica('publicações velhas não contam', (await m.api.ler()).length === 0);
  }
  {
    const m = montar({
      Outra: { quando: AGORA, ataques: { 9: { alvo: 800, chega: AGORA - 10 } } },
    }, {});
    t.verifica('um ataque que já bateu não conta', (await m.api.ler()).length === 0);
  }

  t.secao('A QUOTA');
  {
    const frota = {};
    for (let i = 0; i < 20; i++) frota['c' + i] = { quando: AGORA };
    const m = montar({}, frota);
    const q = await m.api.quota({ sword: 4500, bireme: 1000 });
    t.verifica('o objectivo divide-se pelas contas vivas',
      q.sword === 225 && q.bireme === 50, q);
  }
  {
    const m = montar({}, { a: { quando: AGORA } });
    const q = await m.api.quota({ sword: 4500 });
    t.verifica('com uma conta só, manda-se o objectivo inteiro', q.sword === 4500, q);
  }
  {
    /* Contas caladas não contam para a divisão. */
    const m = montar({}, { a: { quando: AGORA }, b: { quando: AGORA - 99999 } });
    const q = await m.api.quota({ sword: 4500 });
    t.verifica('contas caladas não contam', q.sword === 4500, q);
  }
  {
    const m = montar({}, null);
    const q = await m.api.quota({ sword: 4500 });
    t.verifica('sem frota, manda-se tudo — mais vale a mais', q.sword === 4500, q);
  }

  t.secao('O ENVIO PELO ENCAIXE');
  {
    t.verifica('chega antes do impacto, não depois',
      /const chegadaAlvo = \(Number\(a\.chega\) \|\| 0\) - \(Number\(c\.segundosAntes\) \|\| 1\);/.test(SRC));
    t.verifica('... com desvio só para antes',
      /toleranciaAntes: Number\(c\.toleranciaAntes\) \|\| 3,\s*\n\s*toleranciaDepois: 0,/.test(SRC));
    t.verifica('vai como apoio, não como ataque',
      /tipo: 'support',\s*\n\s*chegada: chegadaAlvo,/.test(SRC));
    t.verifica('sem encaixe, envia-se como antes',
      /\} else \{\s*\n\s*r = await enviarApoio\(origem\.id, id, carga\);\s*\n\s*\}/.test(SRC));
    t.verifica('e só se agenda o que ainda chega a tempo',
      /chegadaAlvo > Math\.floor\(Date\.now\(\) \/ 1000\) \+ viagem/.test(SRC));
  }

  t.secao('O BOTÃO NA BARRA DO JOGO');
  {
    /* Onde o botão fica, e o que acontece quando o seletor se mexe ou some,
     * está agora todo no teste-botao-seletor. Aqui fica só o que este
     * ficheiro tinha de próprio: que ele existe e não se arrasta (18/09). */
    t.verifica('procura o nome da cidade para se encostar a ele',
      /function acharSeletorDeCidade\(\) \{/.test(SRC));
    t.verifica('na barra não se arrasta nem se restaura posição',
      /Na barra do jogo não há posição a restaurar nem arrastar/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
