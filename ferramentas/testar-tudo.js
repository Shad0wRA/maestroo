/* CORRE TODOS OS TESTES contra um maestro.user.js.
 *
 *   node ferramentas/testar-tudo.js maestro.user.js
 *
 * Sai com erro se algum falhar — é o que se corre antes de entregar uma versão. */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ficheiro = process.argv[2] || 'maestro.user.js';
if (!fs.existsSync(ficheiro)) { console.error(`Não encontrei ${ficheiro}.`); process.exit(2); }

const aqui = __dirname;
const testes = fs.readdirSync(aqui).filter((f) => /^teste-.*\.js$/.test(f)).sort();
let mal = 0;
const resumo = [];
for (const f of testes) {
  const r = spawnSync(process.execPath, [path.join(aqui, f), ficheiro], { encoding: 'utf8', timeout: 300000 });
  const saida = (r.stdout || '') + (r.stderr || '');
  const linha = (saida.match(/(\d+)\/(\d+) verificações passaram\./) || [])[0] || 'REBENTOU';
  const ok = r.status === 0;
  if (!ok) { mal++; console.log(saida); }
  resumo.push(`${ok ? 'ok   ' : 'FALHA'} ${f.padEnd(34)} ${linha}`);
}
console.log('\n' + resumo.join('\n'));
console.log(mal ? `\n${mal} ficheiro(s) com falhas.` : '\nTudo a passar.');
process.exit(mal ? 1 : 0);
