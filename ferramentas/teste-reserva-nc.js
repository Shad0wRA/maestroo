/* UM COLONIZADOR GUARDADO POR CONTA, SEMPRE.
 *
 * A reserva só se marcava quando a conta estava DISPONÍVEL — e estar
 * disponível exige ter colonizador. Se a rotação já os tinha gasto (manda-os
 * de 30 em 30 min), a conta nunca ficava disponível, nunca reservava, e nunca
 * entrava numa ilha. Circular.
 *
 *   node ferramentas/teste-reserva-nc.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('RESERVA DE COLONIZADOR');

function nucleo() {
  const loja = {};
  const ctx = {
    localStorage: { getItem: (k) => (k in loja ? loja[k] : null), setItem: (k, v) => { loja[k] = v; } },
    seErroDeCodigo: () => {}, console, Math, Number, Object, JSON, Date,
  };
  vm.createContext(ctx);
  const a = SRC.indexOf('  const QUER_NC_KEY =');
  const b = SRC.indexOf('\n  function pareceErro(msg) {', a);
  vm.runInContext(SRC.slice(a, b) + '\n({ querNC, jaNaoQuerNC, reservados: quantosNCReservados })', ctx);
  return ctx;
}

(async () => {
  {
    const n = nucleo();
    t.verifica('sem reservas: a rotação dispõe de tudo', n.quantosNCReservados('colonos') === 0);
  }
  {
    const n = nucleo();
    n.querNC('fecharilha', 60, 1);
    t.verifica('o fechar ilha guarda um: a rotação vê-o reservado',
      n.quantosNCReservados('colonos') === 1, n.quantosNCReservados('colonos'));
    t.verifica('... e a fundação também o respeita (prioridade abaixo)',
      n.quantosNCReservados('fundacao') === 1);
    t.verifica('... mas o próprio fechar ilha não se bloqueia a si',
      n.quantosNCReservados('fecharilha') === 0);
  }
  {
    const n = nucleo();
    n.querNC('fecharilha', 60, 1);
    n.querNC('fundacao', 45, 1);
    t.verifica('fechar ilha e fundação: a rotação vê os dois reservados',
      n.quantosNCReservados('colonos') === 2);
  }
  {
    const n = nucleo();
    n.querNC('fecharilha', 60, 1);
    n.jaNaoQuerNC('fecharilha');
    t.verifica('módulo desligado: larga o colonizador já',
      n.quantosNCReservados('colonos') === 0);
  }
  {
    const n = nucleo();
    n.querNC('fecharilha', -1, 1);   // marca já expirada
    t.verifica('uma marca expirada não bloqueia nada', n.quantosNCReservados('colonos') === 0);
  }
  t.secao('A FUNDAÇÃO RESPEITA O QUE ESTÁ GUARDADO');
  {
    /* A reserva travava a rotação mas não a fundação: com um colonizador
     * guardado para fechar ilha, ela mandou-o fundar noutro sítio (15/09). */
    t.verifica('a fundação consulta as reservas antes de fundar',
      /quantosNCReservados\('fundacao'\)/.test(SRC.slice(SRC.indexOf('O QUE ESTÁ GUARDADO NÃO SE GASTA'),
        SRC.indexOf('O QUE ESTÁ GUARDADO NÃO SE GASTA') + 2500)));
    t.verifica('... e não funda se o único colonizador estiver guardado',
      /emCasa - guardados < 1/.test(SRC));
    t.verifica('a última vaga de cidade também fica para o fechar ilha',
      /sobram <= 1/.test(SRC) && /__maestroFecharIlhaEspera/.test(SRC));
    t.verifica('... e a marca caduca, para não travar a fundação para sempre',
      /Date\.now\(\) - espera\) < 15 \* 60 \* 1000/.test(SRC));
  }
  t.secao('A ROTAÇÃO DESCONTA MESMO A RESERVA');
  {
    /* A reserva era calculada e escrita na rotina — e a seguir mandava-se
     * tudo. O fechar ilha ficou sem colonizador com a reserva activa
     * (15/09). */
    const i = SRC.indexOf('O QUE ESTÁ RESERVADO FICA MESMO EM CASA');
    const bloco = SRC.slice(i, i + 1600);
    t.verifica('a rotação guarda o número reservado', i > 0
      && /let porGuardar = Math\.max\(0, Number\(reservados\) \|\| 0\);/.test(bloco));
    t.verifica('... deixando-o em casa antes de mandar o resto',
      /const fica = Math\.min\(porGuardar, temAqui\);/.test(bloco)
      && /const n = temAqui - fica;/.test(bloco));
    t.verifica('... e conta por CONTA, não por cidade',
      /porGuardar -= fica;/.test(bloco));
    t.verifica('uma cidade que fica só com os reservados não envia nada',
      /if \(n <= 0\) \{/.test(bloco) && /estão reservados/.test(bloco));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
