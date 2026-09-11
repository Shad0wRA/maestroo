# Testes do Maestro

Cada teste tira do `maestro.user.js` o código **real** — uma função, um módulo
inteiro, um troço do núcleo — e corre-o contra um jogo simulado
(`simulador.js`). Se o código mudar, o teste corre o código novo.

## Correr

Precisa de Node 18 ou mais recente. Na raiz do repositório:

```
node ferramentas/testar-tudo.js maestro.user.js
```

Um só: `node ferramentas/teste-encaixe.js maestro.user.js`

**Regra:** uma versão só se entrega com tudo a passar. Uma mudança de
comportamento traz o teste que a prova — e, se possível, a prova de que o teste
falha sem ela (estragar o código de propósito e ver a falha).

## O que cada um verifica

| Ficheiro | O que tem de ser |
|---|---|
| `teste-nucleo.js` | O leitor da visão geral: cópia de 20 s, `fresca`, esquecer depois de um envio, pedidos ao mesmo tempo, 429, erros, sem Administrador. `ok: false` nunca é lista vazia. |
| `teste-leitores.js` | Feitiços, Deuses e Reforço: a lista certa; o Reforço não traz tropa às cegas; o farm não ataca sem saber o favor a caminho; os três fazem um pedido só. |
| `teste-alertas-esquiva.js` | Um ataque inimigo que só a visão geral traz é avisado e esquivado; voltas, revoltas, apoios de outros e comandos meus não; o mesmo ataque pelas duas fontes conta uma vez; leitura falhada não é desmentido. |
| `teste-encaixe.js` | A leitura é sempre fresca (tem de ver o comando que acabou de sair); a razão de uma falha fica registada. |
| `teste-colonizadores-revoltas.js` | Apoio (revoltas), Fundação e Expansão: sem saber que colonizadores vão a caminho, não sai nenhum. |
| `teste-captcha.js` | Com um captcha no ecrã o ciclo pára **e** o núcleo avisa no Discord (logo, e de meia em meia hora). |

## Formatos confirmados em jogo (espia, 11/09)

- A lista da visão geral vem em `json.data.commands` (lê-se também `json.commands`).
- Todas as cidades dão a mesma visão geral.
- Comandos de outros jogadores: `started_at: 0`, `own_command: false`.
- As minhas voltas: `return: true`, com origem e destino trocados.
- Revoltas: `started_at` = fim da R1.
- Colonizadores: `id` em texto (`colonization_5120`), `island_x`, `island_y`, `number_on_island`.
- Modelos e visão geral partilham o número do comando.

## Acrescentar um teste

Um ficheiro `teste-<coisa>.js` nesta pasta (o `testar-tudo.js` apanha-o
sozinho). O `simulador.js` dá o jogo (`jogo`), o núcleo (`carregarNucleo`), um
módulo a correr (`correr`), as respostas (`lista`, `ERRO`, `LIMITADO`) e o
contador (`verificador`).
