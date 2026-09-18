/* A PARTILHA PELO NOME DO FICHEIRO.
 *
 * O Gist separava a main das multis pelo NOME: `recrutamento-templates-main-pt126`
 * contra `-multi-pt126`. Na 7600 mandei tudo para um caminho construído a
 * partir de uma chave de perfil que não existe, e a main ficou com os alvos
 * das multis (15/09).
 *
 * Isto prova o que tem de ser verdade: com a mesma configuração, a main e a
 * multi vão a sítios DIFERENTES.
 *
 *   node ferramentas/teste-partilha.js maestro.user.js
 */
const S = require('./simulador');
const { vm, funcao } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('PARTILHA');

/* O `ficheiroGist` real do recrutamento, com o perfil que o painel guarda. */
function nomeDoFicheiro(perfil, mundo) {
  const loja = { grepoMaestro_modulos_v1: JSON.stringify({ perfil }) };
  const ctx = {
    armazem: { getItem: (k) => (k in loja ? loja[k] : null) },
    GIST: { filename: 'recrutamento-templates.json' },
    mWorld: mundo, seErroDeCodigo: () => {}, console, String, JSON,
  };
  vm.createContext(ctx);
  return vm.runInContext(funcao(SRC, '  function ficheiroGist() {', 'function makeRecrutamentoModule(opts)')
    + '\nficheiroGist()', ctx);
}

/* A chave do Firebase a partir desse nome. */
function chave(nome) {
  const ctx = { String, console };
  vm.createContext(ctx);
  const i = SRC.indexOf('  function chaveGistNoFirebase(nomeFicheiro) {');
  const f = SRC.indexOf('\n  }\n', i) + 4;
  return vm.runInContext(SRC.slice(i, f) + '\nchaveGistNoFirebase(' + JSON.stringify(nome) + ')', ctx);
}

(async () => {
  const main = nomeDoFicheiro('main', 'pt126');
  const multi = nomeDoFicheiro('multi', 'pt126');
  t.verifica('a main tem o seu ficheiro', main === 'recrutamento-templates-main-pt126.json', main);
  t.verifica('as multis têm outro', multi === 'recrutamento-templates-multi-pt126.json', multi);
  t.verifica('E SÃO DIFERENTES — foi isto que falhou na 7600', main !== multi);

  const km = chave(main), kx = chave(multi);
  t.verifica('a chave do Firebase mantém a separação', km !== kx, { km, kx });
  t.verifica('... e é a mesma que a cópia usou', km === 'gist/recrutamento-templates-main-pt126', km);

  const outro = nomeDoFicheiro('main', 'pt127');
  t.verifica('mundos diferentes também não se misturam', chave(outro) !== km, chave(outro));

  t.verifica('o recrutamento lê do Firebase antes do Gist',
    SRC.indexOf('PRIMEIRO O FIREBASE, COM O NOME DO FICHEIRO') > 0);
  t.verifica('... e grava lá com a mesma chave',
    /const r = await p\.escrever\(ficheiroGist\(\), t\);/.test(SRC));
  t.secao('OS OUTROS MÓDULOS');
  {
    const liga = (marca) => SRC.indexOf(marca) > 0;
    t.verifica('construção lê do Firebase',
      (SRC.match(/const d = await p\.ler\(ficheiroGist\(\)\)/g) || []).length >= 4);
    t.verifica('e grava lá',
      (SRC.match(/await p\.escrever\(ficheiroGist\(\)/g) || []).length >= 4);
    t.verifica('os colonos usam o nome deles', liga('const d = await p.ler(FICHEIRO());'));
    t.verifica('o perfil também', liga('if (p) dadosFb = await p.ler(ficheiroPerfil(nome));'));
    t.verifica('... e o que vem do Firebase segue o mesmo caminho de aplicação',
      liga('let conteudoFb = null;') && liga('if (dadosFb) conteudoFb = JSON.stringify(dadosFb);'));
  }
  t.secao('A PRINCIPAL PUBLICA SOZINHA');
  {
    /* Exigia o Gist: ao tirar as credenciais, a principal deixou de publicar e
     * as multis ficaram com as definições antigas (15/09). */
    const i = SRC.indexOf('A PUBLICAÇÃO NÃO PODE DEPENDER DO GIST');
    const bloco = SRC.slice(i, i + 2200);
    t.verifica('publica com Firebase, sem precisar do Gist', i > 0
      && /if \(!temFirebase && \(!GIST_ID_GLOBAL \|\| !GIST_TOKEN_GLOBAL\)\) return;/.test(bloco));
    t.verifica('... e só quando alguma definição mudou',
      /if \(agora && agora === assinaturaPublicada\) return;/.test(bloco));
    t.verifica('... de cinco em cinco minutos, não de meia em meia hora',
      /\}, 5 \* 60 \* 1000\);/.test(bloco));
    t.verifica('buscar o perfil também não precisa do Gist',
      /if \(souPrincipal\(\) \|\| \(!GIST_ID_GLOBAL && !temFb\)\) return;/.test(SRC));
  }
  t.secao('O PERFIL VAI COM A DATA');
  {
    /* Gravei só as chaves quando passei o perfil para o Firebase (8000). Quem
     * lê precisa da DATA para saber se é novo: sem ela, a verificação "isto é
     * mais recente do que o que já apliquei?" falhava sempre e o perfil NUNCA
     * era aplicado — numa multi, a última aplicação foi a 15/09 às 03:58, pelo
     * Gist (visto em jogo, 16/09). */
    t.verifica('a gravação leva perfil, mundo, data e chaves',
      /await p\.escrever\(ficheiroPerfil\(nome\), \{\s*\n\s*perfil: nome, mundo: WORLD, quando: Date\.now\(\), chaves,/.test(SRC));
    t.verifica('... e a leitura aceita os perfis antigos, sem embrulho',
      /if \(dadosFb && !dadosFb\.chaves && Object\.keys\(dadosFb\)\.some/.test(SRC));
    t.verifica('a aplicação continua a ignorar o que não é mais recente',
      /if \(!r\.quando \|\| r\.quando <= antes\) return;/.test(SRC));
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
