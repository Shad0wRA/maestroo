/* FECHAR ILHA — cada conta escreve só a sua chave.
 *
 * Vinte contas à partida a ler o plano inteiro, mexer na sua parte e gravá-lo
 * inteiro: ganhava a última a gravar. O que cada conta fez (enviei, falhei,
 * desisti, mudei de lugar) vai para a chave dela, e quem lê o plano junta
 * tudo. O código REAL do módulo, com um Firebase de mentira partilhado por
 * várias contas (cada uma com o seu módulo).
 *
 *   node ferramentas/teste-fechar-ilha.js maestro.user.js
 */
const S = require('./simulador');
const { vm, tira } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('FECHAR ILHA');

/* Um Firebase de mentira: caminhos com "/", cópias à entrada e à saída. */
function firebase() {
  const raiz = {};
  const partes = (p) => String(p).split('/').filter(Boolean);
  const copia = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    raiz,
    url: () => 'https://falso',
    ler: async (p) => { let n = raiz; for (const k of partes(p)) { if (!n || typeof n !== 'object') return null; n = n[k]; } return copia(n); },
    escrever: async (p, v) => {
      const ks = partes(p); let n = raiz;
      for (const k of ks.slice(0, -1)) { if (!n[k] || typeof n[k] !== 'object') n[k] = {}; n = n[k]; }
      n[ks[ks.length - 1]] = copia(v); return { ok: true };
    },
  };
}

/* O troço do módulo que lê e grava o plano, para uma conta. */
function conta(fb, nome) {
  const txt = tira(SRC, '  /* ---------------------- o plano, no Firebase -------------------------- */',
    '  /* ---------------------- leitura da ilha ------------------------------- */')
    + '\n' + tira(SRC, '  const chaveSegura = (ch) =>', ';\n')
    + '\n({ lerPlano, gravarPlano, registarMeu: (p, campos) => registarMeu(p, eu, campos), lerFila, planoActivo })';
  const ctx = { mWorld: 'pt125', eu: nome, janela: () => ({ __maestroFb: fb }), seErroDeCodigo: () => {}, console };
  vm.createContext(ctx);
  return vm.runInContext(txt, ctx);
}

const PLANO = { chave: '365:460', x: 365, y: 460, estado: 'lancar', criadoPor: 'Dono',
  atribuicoes: { A: 1, B: 2, 'Jo.ao': 3, Dono: 4 }, enviados: { Dono: 100 } };
async function montar() {
  const fb = firebase();
  await fb.escrever('fecharIlhaFila/pt125', { planos: [JSON.parse(JSON.stringify(PLANO))], parada: false });
  return fb;
}

(async () => {
  {
    /* A MANEIRA ANTIGA, com o código de agora: ler, mexer, gravar tudo. */
    const fb = await montar();
    const a = conta(fb, 'A'); const dono = conta(fb, 'Dono');
    const pa = await a.lerPlano(); const pd = await dono.lerPlano();
    pa.enviados.A = 200; await a.gravarPlano(pa);
    pd.estado = 'feito'; await dono.gravarPlano(pd);
    const fim = (await fb.ler('fecharIlhaFila/pt125')).planos[0];
    t.verifica('a maneira antiga perde o envio de uma conta (é por isto que mudou)', !fim.enviados.A, fim.enviados);
  }
  {
    const fb = await montar();
    const a = conta(fb, 'A'); const dono = conta(fb, 'Dono'); const outra = conta(fb, 'B');
    const pa = await a.lerPlano(); const pd = await dono.lerPlano();
    await a.registarMeu(pa, { enviado: 200, lugar: 1 });
    pd.estado = 'feito'; await dono.gravarPlano(pd);
    const visto = await outra.lerPlano() || (await outra.lerFila()).planos[0];
    const fila = (await fb.ler('fecharIlhaFila/pt125')).planos[0];
    t.verifica('agora: o envio da conta fica, e o estado do dono também', fila.estado === 'feito'
      && (await fb.ler('fecharIlhaEnvios/pt125/365_460/A')).enviado === 200, { fila, visto });
  }
  {
    /* Ordem inversa: o dono grava primeiro, a conta depois. */
    const fb = await montar();
    const a = conta(fb, 'A'); const dono = conta(fb, 'Dono'); const outra = conta(fb, 'B');
    const pa = await a.lerPlano(); const pd = await dono.lerPlano();
    pd.estado = 'preparar'; pd.marca = 'do dono'; await dono.gravarPlano(pd);
    await a.registarMeu(pa, { falhou: 'sem vaga' });
    const fila = (await fb.ler('fecharIlhaFila/pt125')).planos[0];
    t.verifica('a conta já não desfaz o que o dono gravou', fila.marca === 'do dono' && fila.estado === 'preparar', fila);
    const p = await outra.lerPlano();
    t.verifica('... e quem lê vê a falha da conta', p && p.falhados && p.falhados.A === 'sem vaga', p && p.falhados);
  }
  {
    const fb = await montar();
    const b = conta(fb, 'B'); const dono = conta(fb, 'Dono');
    await b.registarMeu(await b.lerPlano(), { falhou: '4 tentativas', lugar: 7 });
    const pd = await dono.lerPlano();
    t.verifica('o lugar que a conta usou entra no plano de quem lê', pd.atribuicoes.B === 7, pd.atribuicoes);
    pd.atribuicoes.C = pd.atribuicoes.B; delete pd.atribuicoes.B; await dono.gravarPlano(pd);
    const p2 = await dono.lerPlano();
    t.verifica('se o dono passar o lugar a outra conta, ganha o dono', p2.atribuicoes.B === undefined && p2.atribuicoes.C === 7, p2.atribuicoes);
  }
  {
    const fb = await montar();
    const a = conta(fb, 'A');
    const p = await a.lerPlano();
    await a.registarMeu(p, { tentativas: 2 });
    await a.registarMeu(p, { enviado: 300 });
    const rec = await fb.ler('fecharIlhaEnvios/pt125/365_460/A');
    t.verifica('o registo da conta junta o que já lá estava (tentativas e envio)', rec.tentativas === 2 && rec.enviado === 300, rec);
  }
  {
    const fb = await montar();
    const j = conta(fb, 'Jo.ao'); const dono = conta(fb, 'Dono');
    await j.registarMeu(await j.lerPlano(), { enviado: 400 });
    const pd = await dono.lerPlano();
    t.verifica('nome com ponto: a chave fica segura e o envio vai para o nome certo', pd.enviados['Jo.ao'] === 400
      && (await fb.ler('fecharIlhaEnvios/pt125/365_460/Jo_ao')).conta === 'Jo.ao', pd.enviados);
  }
  /* A FILA LIMPA TEM DE FICAR LIMPA. */
  {
    const fb = firebase();
    /* Como o Firebase faz: uma lista vazia não se guarda. */
    const escreverReal = fb.escrever;
    fb.escrever = async (p, v) => {
      const c = JSON.parse(JSON.stringify(v || {}));
      if (c && Array.isArray(c.planos) && !c.planos.length) delete c.planos;
      return escreverReal(p, c);
    };
    await fb.escrever('fecharIlha/pt125', { chave: '100:100', atribuicoes: { A: 0 }, estado: 'preparar' });
    const c = conta(fb, 'A');
    const antes = await c.lerFila();
    t.verifica('sem fila nenhuma: aproveita o plano do formato antigo', antes.planos.length === 1, antes);
    await fb.escrever('fecharIlhaFila/pt125', { planos: [], parada: false });
    const dep = await c.lerFila();
    t.verifica('fila gravada vazia: fica vazia (não ressuscita o plano antigo)', dep.planos.length === 0, dep);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
