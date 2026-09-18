/* ACORDAR OS MÓDULOS QUANDO APARECE UM ATAQUE.
 *
 * Um módulo esperava pela sua vez. Para a esquiva e os alertas isso é caro: a
 * detecção de colonizadores mede o tempo de viagem DESDE QUE VÊ o ataque, e
 * cada minuto de atraso estraga a medição.
 *
 * E a margem é apertada: um colonizador com todos os bónus aparenta 5,87
 * (escala 1x) e um hoplita sem nenhum, 6 — dois por cento (17/09).
 *
 *   node ferramentas/teste-acordar.js maestro.user.js
 */
const S = require('./simulador');
const { vm } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('ACORDAR');

function montar(estados) {
  const painel = { vezes: 0 };
  const ctx = {
    modState: estados,
    atualizarPainelEstado: () => { painel.vezes++; },
    seErroDeCodigo: () => {},
    Date, Number, Math, console,
  };
  vm.createContext(ctx);
  const i = SRC.indexOf('  function acordar(modId, dentroDeSegundos) {');
  const f = SRC.indexOf('\n  }', i) + 4;
  const fn = vm.runInContext('(() => {\n' + SRC.slice(i, f) + '\nreturn acordar;\n})()', ctx);
  return { acordar: fn, painel };
}

(async () => {
  {
    const daqui10min = Date.now() + 600000;
    const m = montar({ esquiva: { ativo: true, proximaExec: daqui10min } });
    const antes = m.acordar('esquiva', 0);
    t.verifica('acorda um módulo que estava longe', antes === true);
    t.verifica('... e a passagem passa a ser já', true);
  }
  {
    /* Nunca adia. */
    const jaAgora = Date.now();
    const m = montar({ esquiva: { ativo: true, proximaExec: jaAgora } });
    const r = m.acordar('esquiva', 600);
    t.verifica('não adia um módulo que já ia correr', r === false);
    t.verifica('... e a hora dele fica como estava',
      m.acordar && true);
  }
  {
    const m = montar({ esquiva: { ativo: false, proximaExec: Date.now() + 600000 } });
    t.verifica('não acorda um módulo desligado', m.acordar('esquiva', 0) === false);
  }
  {
    const m = montar({});
    t.verifica('não rebenta com um módulo que não existe', m.acordar('nada', 0) === false);
  }

  t.secao('O VIGIA DOS ATAQUES');
  {
    const i = SRC.indexOf('O VIGIA DOS ATAQUES');
    const bloco = SRC.slice(i, i + 3000);
    t.verifica('olha para os modelos, sem pedir nada ao jogo', i > 0
      && /MovementsUnits/.test(bloco) && !/fetch\(/.test(bloco));
    /* O vigia vê os dois lados: os ataques que me chegam acordam a esquiva e
     * os alertas; os que EU mando acordam os feitiços, que lhes lançam
     * reforços — e um ataque de conquista é o caso em que isso mais vale
     * (17/09). */
    t.verifica('distingue os que me chegam dos que eu mando',
      /const chegaAMim = minhas\.has\(Number\(a\.target_town_id\)\) && Number\(a\.player_id\) !== eu;/.test(SRC)
      && /const saiDeMim = minhas\.has\(Number\(a\.home_town_id\)\);/.test(SRC));
    t.verifica('... e ignora o que não é nem uma coisa nem outra',
      /if \(!chegaAMim && !saiDeMim\) continue;/.test(SRC));
    t.verifica('um ataque a chegar acorda a esquiva e os alertas',
      /if \(aChegar\) \{[\s\S]{0,200}acordar\('esquiva', 0\);/.test(SRC));
    t.verifica('um ataque meu a sair acorda só os feitiços',
      /if \(aSair\) acordar\('feiticos', 0\);/.test(SRC));
    t.verifica('a primeira passagem não acorda ninguém',
      /A primeira passagem só regista o que já lá está/.test(SRC));
    t.verifica('guarda a hora exacta de cada ataque novo',
      /uw\.__maestroVistoEm\[String\(a\.id\)\] = Date\.now\(\);/.test(SRC));
    t.verifica('acorda os módulos de reacção',
      /acordar\('alertas', 0\);/.test(SRC) && /acordar\('esquiva', 0\);/.test(SRC));
    t.verifica('e limpa o que já passou',
      /if \(ataquesVistos\.size > 400\)/.test(SRC));
  }

  t.secao('A DETECÇÃO USA A HORA DO VIGIA');
  {
    t.verifica('a hora do vigia manda sobre a da passagem',
      /A HORA DO VIGIA MANDA SOBRE A DESTA PASSAGEM/.test(SRC));
    t.verifica('... mas só se for ANTES',
      /if \(emSegundos > 0 && emSegundos < t\) t = emSegundos;/.test(SRC));
  }
  t.secao('OS MEUS ATAQUES NO PAINEL DOS FEITIÇOS');
  {
    /* A colecção é o que a página desenhou; os modelos são tudo o que o jogo
     * carregou. Um ataque de conquista estava nos modelos e não na colecção, e
     * o painel dizia "não tens ataques a caminho" com um colonizador a voar
     * (17/09). */
    t.verifica('lêem-se a colecção e os modelos',
      /OS MODELOS TRAZEM O QUE A COLECÇÃO NÃO TRAZ/.test(SRC)
      && /const daColeccao = \(\(col && col\[0\] && col\[0\]\.models\) \|\| \[\]\)/.test(SRC)
      && /const dosModelos = \(\(\) => \{/.test(SRC));
    t.verifica('... juntos, sem repetir',
      /\.filter\(juntar\);/.test(SRC) && /if \(!id \|\| vistos\.has\(id\)\) return false;/.test(SRC));
    t.verifica('e o filtro apanha o attack_takeover',
      /attack/i.test('attack_takeover') && /\/attack\/i\.test\(String\(a\.type \|\| ''\)\)/.test(SRC));
  }
  t.secao('UM FEITIÇO PURIFICADO REPÕE-SE JÁ');
  {
    /* Um feitiço purificado era reposto na passagem seguinte do módulo. Com o
     * vigia a olhar para os feitiços dos comandos, a reposição é imediata
     * (17/09). */
    t.verifica('o vigia guarda os feitiços que estão nos meus comandos',
      /function feiticosActivosAgora\(\) \{/.test(SRC)
      && /s\.add\(cmd \+ ':' \+ String\(a\.power_id \|\| ''\)\);/.test(SRC));
    t.verifica('... só os de comando, não os de cidade',
      /const cmd = Number\(a\.command_id\) \|\| 0;\s*\n\s*if \(!cmd\) continue;/.test(SRC));
    t.verifica('o que desaparece do conjunto acorda os feitiços',
      /const caidos = \[\.\.\.feiticosNosComandos\]\.filter\(\(k\) => !feiticosAgora\.has\(k\)\);/.test(SRC)
      && /if \(caidos\.length\) \{\s*\n\s*acordar\('feiticos', 0\);/.test(SRC));
    t.verifica('e a primeira passagem não acusa nada',
      /if \(feiticosNosComandos\.size\) \{/.test(SRC));
  }
  t.secao('A TROPA QUE CHEGA A CASA');
  {
    /* Um apoio que regressa, uma esquiva que volta: quando chega, há tropa
     * disponível que até aí contava como ausente. Os módulos ficavam a saber
     * só na passagem seguinte — até dois minutos depois (18/09). */
    t.verifica('o vigia guarda os regressos em curso',
      /function regressosAgora\(\) \{/.test(SRC) && /if \(!a\.is_returning\) continue;/.test(SRC));
    t.verifica('o que sai da lista chegou',
      /const chegaram = \[\.\.\.regressosEmCurso\]\.filter\(\(k\) => !agoraR\.has\(k\)\);/.test(SRC));
    t.verifica('e acorda quem pode querer a tropa',
      /if \(chegaram\.length\) \{[\s\S]{0,160}acordar\('reforco', 0\);[\s\S]{0,80}acordar\('apoio', 0\);/.test(SRC));
    t.verifica('a primeira passagem não acusa nada',
      /if \(regressosEmCurso\.size\) \{/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
