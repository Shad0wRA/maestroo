/* O BOTÃO DO MAESTRO — ao lado do nome da cidade.
 *
 * Já esteve a flutuar por cima do mapa, dentro da caixa do retrato (por trás
 * da moldura), ao lado do retrato (onde o DIO-Tools tem um painel por cima) e
 * fixo em coordenadas escritas à mão (ficava no sítio errado noutra janela).
 *
 * Agora mede o seletor de cidade e encosta-se a ele. Este teste tira do
 * `maestro.user.js` as duas peças reais — quem procura o seletor e quem
 * calcula o sítio — e corre-as contra um ecrã de mentira.
 *
 *   node ferramentas/teste-botao-seletor.js maestro.user.js
 */
const vm = require('vm');
const S = require('./simulador');

const SRC = S.ficheiroDoMaestro();
const t = S.verificador('O BOTÃO AO LADO DA CIDADE');

/* Tirar um troço do ficheiro, do cabeçalho até ao fecho ao mesmo nível. */
function troco(inicio, fecho) {
  const i = SRC.indexOf(inicio);
  if (i < 0) throw new Error('não encontrei: ' + inicio);
  const j = SRC.indexOf(fecho, i);
  if (j < 0) throw new Error('não encontrei o fecho de: ' + inicio);
  return SRC.slice(i, j + fecho.length);
}

/* Um elemento de mentira, com o tamanho e o sítio que lhe dermos. */
const el = (r) => ({ isConnected: true, getBoundingClientRect: () => r });

function montar(porNome, janela) {
  const btn = { style: {} };
  const ctx = {
    document: { querySelector: (s) => porNome[s] || null },
    window: janela || { innerWidth: 1300, innerHeight: 900, addEventListener: () => {} },
    btn, Math, Number, setTimeout: () => {}, setInterval: () => {}, console,
  };
  vm.createContext(ctx);
  vm.runInContext(troco('function acharSeletorDeCidade() {', '\n    }\n'), ctx);
  /* O `naBarraDoJogo` do ficheiro é isto mesmo: o que o procurador devolve. */
  vm.runInContext('globalThis.seletor = acharSeletorDeCidade();', ctx);
  return ctx;
}

/* O bloco real que calcula o sítio, corrido contra o ecrã de mentira. */
function posicionar(ctx) {
  /* O bloco real, tal e qual: a folga, os dois números da afinação e a conta
   * do sítio. Assim os números do teste são os do ficheiro. */
  vm.runInContext(`{
    const naBarraDoJogo = globalThis.seletor;
    ${troco('let alvo = naBarraDoJogo;', '\n      };\n')}
    acompanharSeletor();
  }`, ctx);
  return ctx.btn.style;
}

t.secao('ENCONTRAR O SELETOR');
{
  const ctx = montar({ '#town_name_area': el({ left: 500, top: 80, width: 200, height: 30, right: 700 }) });
  t.verifica('encontra o nome da cidade no topo', !!ctx.seletor);
}
{
  /* O jogo pode ter um elemento com o mesmo nome noutro sítio — o painel da
   * cidade, por exemplo. O que interessa é o do topo. */
  const ctx = montar({ '#town_name_area': el({ left: 500, top: 600, width: 200, height: 30, right: 700 }) });
  t.verifica('não aceita um que esteja a meio do ecrã', ctx.seletor === null);
}
{
  const ctx = montar({ '#town_name_area': el({ left: 0, top: 80, width: 1300, height: 30, right: 1300 }) });
  t.verifica('não aceita um do tamanho do ecrã', ctx.seletor === null);
}
{
  const ctx = montar({});
  t.verifica('sem seletor à vista, fica sem sítio (e o botão flutua como antes)',
    ctx.seletor === null);
}
{
  /* Se o primeiro nome não existir, tenta os outros. */
  const ctx = montar({ '.town_name': el({ left: 500, top: 80, width: 200, height: 30, right: 700 }) });
  t.verifica('tenta os outros nomes que o jogo usa', !!ctx.seletor);
}

t.secao('O SÍTIO, MEDIDO NO SELETOR');
{
  const ctx = montar({ '#town_name_area': el({ left: 500, top: 80, width: 200, height: 30, right: 700 }) });
  const s = posicionar(ctx);
  t.verifica('encosta à esquerda do nome da cidade, com a afinação dele',
    s.left === '450px', s.left);
  t.verifica('e um pouco acima do meio dele', s.top === '69px', s.top);
}
{
  /* Numa janela estreita o seletor fica encostado à esquerda: à esquerda dele
   * não há espaço, e o botão sairia do ecrã. */
  const ctx = montar({ '#town_name_area': el({ left: 10, top: 80, width: 200, height: 30, right: 210 }) });
  const s = posicionar(ctx);
  /* Do outro lado, a afinação tem de afastar na direcção contrária. */
  t.verifica('sem espaço à esquerda, passa para a direita e afasta-se na mesma',
    s.left === '232px', s.left);
}
{
  const janela = { innerWidth: 300, innerHeight: 200, addEventListener: () => {} };
  const ctx = montar({ '#town_name_area': el({ left: 240, top: 80, width: 200, height: 30, right: 440 }) }, janela);
  const s = posicionar(ctx);
  t.verifica('nunca fora do ecrã', parseInt(s.left, 10) <= 300 - 28 - 2 && parseInt(s.left, 10) >= 2, s.left);
}
{
  /* O jogo redesenha a barra ao mudar de cidade: se o elemento guardado saiu
   * da página, procura-se outro em vez de ficar parado num sítio velho. */
  const ctx = montar({ '#town_name_area': el({ left: 600, top: 80, width: 200, height: 30, right: 800 }) });
  /* O guardado saiu da página; na página está outro, mais à direita. */
  ctx.seletor = { isConnected: false,
    getBoundingClientRect: () => ({ left: 500, top: 80, width: 200, height: 30, right: 700 }) };
  const s = posicionar(ctx);
  t.verifica('se o seletor for substituído, procura-o outra vez', s.left === '550px', s.left);
}
{
  /* Escondido (outra vista do jogo): mexer nele punha-o no canto. */
  const ctx = montar({ '#town_name_area': el({ left: 500, top: 80, width: 200, height: 30, right: 700 }) });
  posicionar(ctx);
  ctx.seletor = el({ left: 0, top: 0, width: 0, height: 0, right: 0 });
  const s = posicionar(ctx);
  t.verifica('se o seletor estiver escondido, fica onde estava', s.left === '450px', s.left);
}

t.secao('O ASPECTO');
{
  t.verifica('é um círculo de 28 px', /'width:28px', 'height:28px', 'border-radius:50%',/.test(SRC));
  t.verifica('com o M maior', /font:700 15px\/1 "Trebuchet MS"/.test(SRC));
  /* Para acertar o sítio no jogo sem esperar por outra versão. */
  t.verifica('dá para afinar pela consola',
    /uw\.__maestroBotao = \(x, y\) => \{/.test(SRC)
    && /if \(Number\.isFinite\(x\)\) AJUSTE_X = Number\(x\);/.test(SRC));
  t.verifica('e vai para o corpo da página, fora das caixas do jogo',
    /Vai sempre para o corpo da página[\s\S]{0,140}document\.body\.appendChild\(btn\);/.test(SRC));
}
t.fim();
