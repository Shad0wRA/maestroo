/* LER RELATÓRIOS — o que o jogo diz em cada um.
 *
 * Formato confirmado em jogo (11/09): o HTML vem em `plain.html`, no topo da
 * resposta; cada tropa é `data-unit_id`/`data-unit_count`; o lado está na
 * classe do bloco à volta; as perdas em `report_losts`; o assunto em
 * `<span class="subject">`. O código REAL do módulo contra relatórios com
 * esse formato.
 *
 *   node ferramentas/teste-relatorios.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('LER RELATÓRIOS');

function leitor() {
  /* Do início do leitor até ao fim do `anotar`: é tudo o que se precisa. */
  /* Do início do leitor até ao fim do `anotar` — o que não faz pedidos. */
  const i = SRC.indexOf('  const LIDOS_KEY =');
  const f = SRC.indexOf('  /* Um relatório: pedir e ler.', i);
  const txt = SRC.slice(i, f)
    + '\n({ lerRelatorio, anotar, ver: () => lerJSON(INIMIGOS_KEY, {}) })';
  const loja = {};
  const ctx = { seErroDeCodigo: () => {}, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    escape, decodeURIComponent, unescape,
    armazem: { getItem: (k) => (k in loja ? loja[k] : null), setItem: (k, v) => { loja[k] = v; } } };
  vm.createContext(ctx);
  return vm.runInContext(txt, ctx);
}

const bloco = (lado, u, n, perdeu) => `<div class="report_side_${lado}_unit">`
  + `<div class="report_unit unit report_side_${lado} unit_${u} unit_icon40x40 ${u}" `
  + `data-unit_id="${u}" data-unit_count="${n}"><span class="bold">${n}</span></div>`
  + (perdeu != null ? `<span class="report_losts">-${perdeu}</span>` : '') + '</div>';
const spy = (u, n) => `<div class="report_unit unit unit_${u} spy unit_icon40x40 ${u}" `
  + `data-unit_id="${u}" data-unit_count="${n}"></div>`;
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const cabecalho = (origem, destino) => `<div id="report_sending_town">`
  + `<a href="#${b64({ id: 421, ix: 502, iy: 512, tp: 'town', name: 'Cidade' })}" class="gp_town_link">Cidade</a>`
  + `<a href="#${b64({ name: origem, id: 2225917 })}" class="gp_player_link">${origem}</a></div>`
  + `<div id="report_receiving_town">`
  + `<a href="#${b64({ name: destino, id: 2379469 })}" class="gp_player_link">${destino}</a></div>`;

/* Os quatro casos que a espia mostrou. */
const ATAQUE = `<span class="subject">126-55-002 (Godfather) está a atacar 45.9</span>`
  + cabecalho('Godfather', 'Shad0wRA')
  + bloco('attacker', 'rider', 35, 35)
  + bloco('defender', 'bireme', 3110, 0) + bloco('defender', 'sword', 4500, 13)
  + bloco('defender', 'militia', 375, 1);
const MEU_ATAQUE = `<span class="subject">55.25 está a atacar 45 - 02 (RJFS23)</span>`
  + cabecalho('Shad0wRA', 'RJFS23')
  + bloco('attacker', 'attack_ship', 298, 298) + bloco('defender', 'bireme', 400, 12);
const ESPIA_OK = `<span class="subject">55.13 está a espiar 55 - 04 (RJFS23)</span>`
  + cabecalho('Shad0wRA', 'RJFS23') + spy('sword', 1486) + spy('archer', 1558) + spy('bireme', 90);
const ESPIA_MA = `<span class="subject">Espião de 126-55-002 (Godfather) descoberto na cidade 45.9</span>`
  + cabecalho('Godfather', 'Shad0wRA');

(async () => {
  const L = leitor();
  {
    const d = L.lerRelatorio(ATAQUE);
    t.verifica('ataque recebido: a tropa do atacante e o que perdeu', igual(d.atacante, { rider: 35 })
      && igual(d.perdasAtacante, { rider: 35 }), d);
    t.verifica('... e a defesa, com as perdas', d.defensor.bireme === 3110 && d.defensor.sword === 4500
      && d.perdasDefensor.sword === 13 && !d.perdasDefensor.bireme, d);
    t.verifica('... quem ataca e quem é atacado', d.jogadorOrigem === 'Godfather' && d.jogadorDestino === 'Shad0wRA', d);
  }
  {
    const d = L.lerRelatorio(MEU_ATAQUE);
    t.verifica('ataque meu: o atacante sou eu, o defensor é o outro', d.jogadorOrigem === 'Shad0wRA'
      && d.jogadorDestino === 'RJFS23' && d.atacante.attack_ship === 298 && d.defensor.bireme === 400, d);
  }
  {
    const d = L.lerRelatorio(ESPIA_OK);
    t.verifica('espionagem certa: a tropa da cidade espiada', igual(d.espiada, { sword: 1486, archer: 1558, bireme: 90 })
      && !Object.keys(d.atacante).length, d);
  }
  {
    const d = L.lerRelatorio(ESPIA_MA);
    t.verifica('espião apanhado: sem tropas, mas com o assunto e os jogadores',
      !Object.keys(d.espiada).length && /descoberto/.test(d.assunto) && d.jogadorOrigem === 'Godfather', d);
  }
  {
    const L2 = leitor();
    L2.anotar('Vilão', 'atacou', { sword: 100 }, 1000);
    L2.anotar('Vilão', 'atacou', { sword: 500, rider: 50 }, 2000);
    L2.anotar('Vilão', 'atacou', { sword: 10 }, 3000);
    const j = L2.ver()['Vilão'];
    t.verifica('guarda a maior força que o jogador já trouxe', igual(j.atacou, { sword: 500, rider: 50 })
      && j.atacouQuando === 2000, j);
    t.verifica('... e conta as vezes e a última', j.vezes === 3 && j.ultimo === 3000, j);
    L2.anotar('Vilão', 'espiado', { hoplite: 900 }, 4000);
    t.verifica('... o que se lhe viu em casa fica à parte', igual(L2.ver()['Vilão'].espiado, { hoplite: 900 })
      && igual(L2.ver()['Vilão'].atacou, { sword: 500, rider: 50 }));
    t.verifica('sem tropas não se anota nada', L2.anotar('Outro', 'atacou', {}, 5000) === false && !L2.ver().Outro);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
