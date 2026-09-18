/* PARTIR CERCOS — mundos de cerco.
 *
 * Num mundo de cerco, um ataque com colonizador que vence a defesa deixa a
 * cidade cercada durante sete ou oito horas. Para partir, é preciso limpar a
 * frota que a segura.
 *
 * O módulo não espera pelo cerco: assim que vê um colonizador a caminho,
 * agenda ataques para baterem NO MESMO SEGUNDO do impacto. A razão é uma regra
 * do jogo — ao mesmo segundo, a ordem é a de quem enviou primeiro, e o
 * colonizador já partiu. Bate ele, cria o cerco, e os nossos batem logo a
 * seguir, antes dos apoios que o adversário mandar (desenhado com o Rafa,
 * 18/09).
 *
 *   node ferramentas/teste-partir-cerco.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('PARTIR CERCOS');
const PC = 'function makePartirCercoModule(opts)';

const AGORA = Math.floor(Date.now() / 1000);

function montar(movimentos, deRevolta) {
  const ctx = {
    mUw: {
      Game: { player_id: 111, player_name: 'Eu' },
      ITowns: { towns: { 10: {}, 20: {} }, getTown: (id) => ({ getName: () => 'c' + id }) },
      MM: {
        getModels: () => (deRevolta
          ? { MovementsUnits: movimentos, MovementsRevoltDefender: {} }
          : { MovementsUnits: movimentos }),
      },
    },
    seErroDeCodigo: () => {},
    Date, Math, Number, Object, Set, String, console,
  };
  vm.createContext(ctx);
  return vm.runInContext(
    funcao(SRC, '  function mundoDeCerco() {', PC)
    + funcao(SRC, '  function colonizadoresAChegar() {', PC)
    + funcao(SRC, '  function nomeDaCidade(id) {', PC)
    + '\n({ cerco: mundoDeCerco, ver: colonizadoresAChegar })', ctx);
}

const mov = (tipo, alvo, jogador, chega) => ({
  attributes: { id: 1, command_id: 99, type: tipo, target_town_id: alvo,
    player_id: jogador, arrival_at: chega, town_name_origin: 'deles' },
});

(async () => {
  t.secao('QUE MUNDO É ESTE');
  {
    t.verifica('sem a colecção das revoltas, é de cerco', montar({}, false).cerco() === true);
    t.verifica('com ela, é de revolta', montar({}, true).cerco() === false);
  }

  t.secao('QUE COLONIZADORES INTERESSAM');
  {
    const a = montar({ x: mov('attack_takeover', 10, 999, AGORA + 3600) }, false);
    const r = a.ver();
    t.verifica('um ataque de conquista a uma cidade minha entra', r.length === 1, r);
    t.verifica('... com a hora do impacto', r[0] && r[0].chega === AGORA + 3600, r[0]);
  }
  {
    const a = montar({ x: mov('attack', 10, 999, AGORA + 3600) }, false);
    t.verifica('um ataque normal não conta', a.ver().length === 0);
  }
  {
    const a = montar({ x: mov('attack_takeover', 99, 999, AGORA + 3600) }, false);
    t.verifica('um colonizador para outro jogador não conta', a.ver().length === 0);
  }
  {
    const a = montar({ x: mov('attack_takeover', 10, 111, AGORA + 3600) }, false);
    t.verifica('o meu próprio colonizador não conta', a.ver().length === 0);
  }
  {
    const a = montar({ x: mov('attack_takeover', 10, 999, AGORA - 10) }, false);
    t.verifica('um que já bateu não conta', a.ver().length === 0);
  }

  t.secao('O PLANO');
  {
    t.verifica('as cidades ordenam-se da mais próxima à mais distante',
      /cidades\.sort\(\(a, b\) => \(a\.viagem \|\| 1e9\) - \(b\.viagem \|\| 1e9\)\);/.test(SRC));
    t.verifica('as que cabem na janela agendam',
      /const cabe = cid\.viagem > 0 && \(cid\.viagem \+ 30\) <= faltam;/.test(SRC));
    t.verifica('... e as outras vão directas',
      /if \(cabe\) agendar\.push\(\{ \.\.\.cid, leva \}\);\s*\n\s*else directos\.push/.test(SRC));
    t.verifica('o pacote é repartido até esgotar',
      /const leva = Math\.min\(cid\.farois, porMandar\);/.test(SRC));
    t.verifica('e diz-se quando não chega',
      /faltaram \$\{plano\.emFalta\} farol/.test(SRC));
  }

  t.secao('O AGENDAMENTO');
  {
    t.verifica('bate no segundo do impacto, nunca antes',
      /toleranciaAntes: 0,/.test(SRC) && /SÓ DEPOIS DO IMPACTO/.test(SRC));
    t.verifica('... com tolerância só para depois',
      /desvioAntes: Number\(p\.toleranciaAntes\) \|\| 0,/.test(SRC));
    t.verifica('o Encaixe expõe o agendamento a outros módulos',
      /uwj\.__maestroAgendarEncaixe = async \(p\) => \{/.test(SRC));
    t.verifica('... e o cálculo da viagem',
      /uwj\.__maestroDuracaoPrevista = \(origemId, alvoId, unidades\) => \{/.test(SRC));
    t.verifica('... e o envio directo',
      /uwj\.__maestroEnviarComando = async \(origemId, alvoId, unidades, tipo\) => \{/.test(SRC));
  }

  t.secao('O GRUPO');
  {
    t.verifica('cada conta publica os colonizadores que lhe vêm',
      /await fb\.escrever\(`\$\{caminhoAvisos\(\)\}\/\$\{conta\}`/.test(SRC));
    t.verifica('... e lê os das outras',
      /async function cercosDoGrupo\(\)/.test(SRC));
    t.verifica('publicações velhas não contam',
      /if \(!x\.quando \|\| \(agoraS - Number\(x\.quando\)\) > 3600\) continue;/.test(SRC));
    t.verifica('um cerco já tratado não se repete',
      /const porFazer = todos\.filter\(\(x\) => !feitos\[String\(x\.cmd\)\]\);/.test(SRC));
    t.verifica('e o vigia acorda o módulo quando vê um colonizador',
      /if \(novos\.some\(\(a\) => \/takeover\/i\.test\(String\(a\.type \|\| ''\)\)\)\) \{/.test(SRC));
  }

  t.secao('CUIDADOS');
  {
    t.verifica('num mundo de revolta o módulo não faz nada',
      /este mundo é de revolta — não há cercos a partir/.test(SRC));
    t.verifica('o risco está escrito no painel',
      /se a defesa aguentar e o colonizador não passar/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
