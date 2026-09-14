/* DETECTAR COLONIZADOR — sem a hora de partida.
 *
 * Os ataques dos outros vêm SEMPRE com `started_at: 0` (confirmado em jogo,
 * 12/09), por isso a viagem é estimada e a velocidade sai errada — 37 numa
 * leitura em que o limite do colonizador era 11,5. O que decide sem precisar
 * da partida é o tempo que FALTA: se ainda faltam T horas para percorrer D, a
 * velocidade não pode passar de D/T.
 *
 * As velocidades do jogo já vêm com o factor do mundo (pt126, ×3: colonizador
 * 9 = 3×3, birreme 45 = 15×3), por isso a comparação é na mesma escala.
 *
 *   node ferramentas/teste-colonizador.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao, tira } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('COLONIZADOR');

function montar() {
  const ctx = {
    uw: { GameData: { powers: { unit_movement_boost: { meta_defaults: { percent: 30 } } }, units: {
      colonize_ship: { speed: 9, is_naval: true },
      bireme: { speed: 45, is_naval: true },
      small_transporter: { speed: 45, is_naval: true },
      attack_ship: { speed: 60, is_naval: true },
      sword: { speed: 20 },
    } } },
    Math, Number, Object,
    localStorage: { getItem: () => null },
  };
  vm.createContext(ctx);
  /* Do início das constantes até ao fim do `pareceColonizadorNC`. */
  const a = SRC.indexOf('  const FOLGA_MEDICAO_NC =');
  const b = SRC.indexOf('  try {\n    uw.__maestroNC = {', a);
  return vm.runInContext(SRC.slice(a, b)
    + '\n({ parece: pareceColonizadorNC, limite: limiteColonizador })', ctx);
}

(async () => {
  const api = montar();
  /* Todos os bónus juntos: cartografia, farol, navegar, feitiço e 4 sereias. */
  const TECTO = 9 * 1.10 * 1.15 * 1.10 * 1.30 * Math.pow(1.02, 4);
  t.verifica('o tecto do colonizador junta cartografia, farol, navegar, feitiço e sereias',
    Math.abs(api.limite() - TECTO) < 0.05, { limite: api.limite(), esperado: TECTO });
  {
    const r = api.parece(9, false);
    t.verifica('velocidade igual à do colonizador: é colonizador, com certeza', r.nc && r.certo, r);
  }
  {
    const r = api.parece(45, false);
    t.verifica('velocidade de birreme: não é colonizador', !r.nc, r);
  }
  {
    /* O caso real: velocidade estimada alta (37), mas o tempo que falta prova
     * que não pode andar a mais de 10. */
    const r = api.parece(37, false, 10);
    t.verifica('o que falta da viagem prova colonizador, mesmo com a estimativa alta',
      r.nc && r.certo && /já não dá para mais nada/.test(r.porque), r);
  }
  {
    const r = api.parece(10, false, 50);
    t.verifica('10 é a velocidade do colonizador com cartografia: é colonizador, com certeza',
      r.nc && r.certo, r);
  }
  {
    /* Abaixo do limite, mas sem bater certo com nenhuma unidade nem com os
     * bónus conhecidos: suspeita, não certeza. */
    const r = api.parece(6, false);
    t.verifica('lento de mais para tudo menos o colonizador: suspeita', r.nc && !r.certo, r);
  }
  {
    const r = api.parece(0, false);
    t.verifica('sem velocidade nenhuma: não afirma nada', !r.nc && !r.certo, r);
  }
  /* O ELMO DA INVISIBILIDADE esconde os primeiros 10% da viagem, e nada na
   * resposta do jogo o denuncia nos ataques dos outros: a velocidade medida
   * vem ~11% inflada. */
  {
    /* Acima do tecto e fora da folga de medição, mas dentro da margem do
     * elmo (tecto ÷ 0,9). */
    const r = api.parece(TECTO * 1.10, false);
    t.verifica('acima do limite mas dentro da margem do elmo: suspeita, não exclusão',
      r.nc && !r.certo && /elmo/.test(r.porque), r);
  }
  {
    const r = api.parece(TECTO * 1.5, false);
    t.verifica('bem acima da margem do elmo: não é colonizador', !r.nc && r.certo, r);
  }
  {
    /* O máximo pelo tempo que falta SÓ SERVE PARA ACUSAR: um máximo alto não
     * prova nada, porque a velocidade real pode ser qualquer uma abaixo. */
    const r = api.parece(9, false, 999);
    t.verifica('máximo alto não desfaz uma certeza medida', r.nc && r.certo, r);
  }
  /* O FEITIÇO DE MOVIMENTO (+30%, lido do jogo) entra nas combinações. */
  {
    /* O "navegar" (+10%) só acelera o colonizador: uma velocidade que só ele
     * explica tem de ser reconhecida. */
    const r = api.parece(9 * 1.10, false);
    t.verifica('velocidade que só o navegar explica: é colonizador', r.nc && r.certo, r);
  }
  {
    /* 9 × 1,30 = 11,7: um colonizador só com o feitiço. */
    const r = api.parece(11.7, false);
    t.verifica('velocidade que só o feitiço explica: é colonizador, com certeza',
      r.nc && r.certo && /colonizador/.test(r.porque), r);
  }
  {
    /* 9 × 1,10 × 1,15 × 1,30 = 14,8: tudo junto. */
    const r = api.parece(TECTO, false);
    t.verifica('colonizador com tudo: continua a ser apanhado', r.nc, r);
  }
  {
    const r = api.parece(45, false);
    t.verifica('birreme continua fora de suspeita, mesmo com a folga maior', !r.nc, r);
  }
  /* O VISTO DO MUNDO OLIMPO acrescenta o grande templo (+15%). */
  {
    const comOlimpo = (() => {
      const ctx2 = {
        uw: { GameData: { units: { colonize_ship: { speed: 9, is_naval: true }, bireme: { speed: 45, is_naval: true } },
          powers: { unit_movement_boost: { meta_defaults: { percent: 30 } } } } },
        Math, Number, Object, localStorage: { getItem: () => '1' },
      };
      vm.createContext(ctx2);
      const a = SRC.indexOf('  const FOLGA_MEDICAO_NC =');
      const b = SRC.indexOf('  try {\n    uw.__maestroNC = {', a);
      return vm.runInContext(SRC.slice(a, b) + '\n({ limite: limiteColonizador, parece: pareceColonizadorNC })', ctx2);
    })();
    t.verifica('mundo Olimpo: o tecto sobe 15%',
      Math.abs(comOlimpo.limite() - TECTO * 1.15) < 0.05,
      { olimpo: comOlimpo.limite(), normal: TECTO });
    t.verifica('... e uma velocidade que só o templo explica passa a ser apanhada',
      comOlimpo.parece(TECTO * 1.14, false).nc && !api.parece(TECTO * 1.14, false).nc);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
