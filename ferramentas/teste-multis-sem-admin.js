/* AS MULTIS SEM ADMINISTRADOR.
 *
 * Sem Administrador a visão geral devolve zero comandos. A esquiva sabia que
 * havia ataque (a colecção `Attack` marca a cidade) mas não tinha a hora nem a
 * origem, e nunca agia — custou tropa num farm atrás do outro (15/09). Os
 * movimentos da página trazem esses ataques com a hora certa.
 *
 * E o reforço não deve defender contra as PRÓPRIAS contas: cada enviado do
 * farm morreria contra a tropa que ele lá pôs.
 *
 *   node ferramentas/teste-multis-sem-admin.js maestro.user.js
 */
const S = require('./simulador');
const { vm, igual } = S;
const SRC = S.ficheiroDoMaestro();
const t = S.verificador('MULTIS SEM ADMINISTRADOR');

(async () => {
  {
    const i = SRC.indexOf('        if (!cmds.length && /sem Administrador/i.test(');
    const bloco = SRC.slice(i, i + 1800);
    t.verifica('a esquiva tem caminho para quando falta o Administrador', i > 0);
    t.verifica('... e só o usa nas cidades que a página marca como atacadas',
      /Number\(m\.target_town_id\) === Number\(tid\)/.test(bloco), bloco.slice(0, 120));
    t.verifica('... só conta movimentos que ainda não chegaram',
      /Number\(m\.arrival_at\) > agoraJogo\(\)/.test(bloco));
    t.verifica('... e usa a hora do próprio movimento',
      /arrival_at: Number\(m\.arrival_at\)/.test(bloco));
  }
  {
    const i = SRC.indexOf('NÃO SE DEFENDE DE SI PRÓPRIO');
    const bloco = SRC.slice(i, i + 1800);
    t.verifica('o reforço sabe quem são as minhas contas', i > 0 && /frota\/\$\{mWorld\}/.test(bloco));
    t.verifica('... e tira da lista os ataques que vêm delas',
      /minhasContas\.has\(quem\)/.test(bloco), bloco.slice(0, 150));
    t.verifica('... sem mexer em nada quando não consegue saber quem são',
      /if \(minhasContas\) \{/.test(bloco));
  }
  {
    /* O campo ausente ou vazio não serve; o número 0 serve, e o jogo
     * propõe-no mesmo numa ilha vazia (15/09). */
    const i = SRC.indexOf('      /* O LUGAR 0 É UM LUGAR.');
    const bloco = SRC.slice(i, i + 1200);
    t.verifica('o fechar ilha não aceita um lugar que o jogo não deu', i > 0
      && /o jogo não disse que lugar usar/.test(bloco));
    t.verifica('... mas aceita o lugar 0', /lugar < 0/.test(bloco) && !/lugar === 0/.test(bloco));
  }
  {
    /* A partilha do recrutamento foi DESFEITA: usava um perfil que não existe
     * e punha a main e as multis no mesmo caminho — os alvos da main foram
     * substituídos pelos das multis (15/09). */
    t.verifica('os alvos de recrutamento voltam a ser locais',
      SRC.indexOf('caminhoFbRecruta') < 0, 'ainda há caminho partilhado');
    const i = SRC.indexOf('     * ============ A PARTILHA PELO FIREBASE FOI DESFEITA');
    t.verifica('... e fica escrito porquê, para não se repetir',
      SRC.indexOf('A PARTILHA PELO FIREBASE FOI DESFEITA') > 0);
  }
  t.fim();
})().catch((e) => { console.error('O TESTE REBENTOU:', e); process.exit(2); });
