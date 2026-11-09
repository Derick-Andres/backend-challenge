import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { loadConfig } from '../src/config/configuration.js';

const requiredVersion=(await Bun.file('.bun-version').text()).trim();
if (Bun.version!==requiredVersion) throw new Error(`Use Bun ${requiredVersion}`);
const config=loadConfig(process.env);
if (!['127.0.0.1','localhost','::1'].includes(config.PGHOST) || !['127.0.0.1','localhost','[::1]'].includes(new URL(config.SQS_ENDPOINT).hostname)) {
  throw new Error('A validação atua exclusivamente nos endpoints locais do desafio');
}
const challengeHash='47795fce2fc38cae5f1b91368ebaf80b7a2ed1fe147f36704b665faf0613812e';
const checksum=async (file: string) => createHash('sha256').update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest('hex');
if (await checksum('CHALLENGE.md')!==challengeHash) throw new Error('CHALLENGE.md difere do enunciado preservado');
const stamp=new Date().toISOString().replaceAll(':','-');
const directory=`artifacts/validation/${stamp}`;
await mkdir(directory,{ recursive: true });
const steps: { name: string; command: string[]; status: string; seconds?: number; summary?: string }[]=[
  { name: 'install',command: [process.execPath,'install','--frozen-lockfile'],status: 'pending' },
  { name: 'infra',command: ['docker','compose','up','-d','--wait','--wait-timeout','120'],status: 'pending' },
  { name: 'build',command: [process.execPath,'run','build'],status: 'pending' },
  { name: 'database',command: [process.execPath,'scripts/database/setup.ts'],status: 'pending' },
  { name: 'typecheck',command: [process.execPath,'run','typecheck'],status: 'pending' },
  { name: 'unit',command: [process.execPath,'run','test'],status: 'pending' },
  { name: 'integration',command: [process.execPath,'test','--timeout','60000','test/integration'],status: 'pending' },
  { name: 'smoke',command: [process.execPath,'test','--timeout','120000','test/smoke.test.ts'],status: 'pending' },
  { name: 'migration-pending',command: [process.execPath,'run','orm','migration:pending','--config','./dist/mikro-orm.config.js'],status: 'pending' },
];
const report={ startedAt: new Date().toISOString(),bun: Bun.version,challengeSha256: challengeHash,steps };
async function save() {
  await Bun.write(`${directory}/report.json`,`${JSON.stringify(report,null,2)}\n`);
  const text=steps.map((step) => `| ${step.name} | ${step.status} | ${step.seconds ?? ''} | ${step.summary ?? ''} |`).join('\n');
  await Bun.write('VALIDATION.md',`# Evidências da validação\n\nExecução iniciada em ${report.startedAt}, Bun ${Bun.version}. Logs: ${directory}.\n\n| Verificação | Estado | Segundos | Resultado |\n|---|---|---|---|\n${text}\n\nCHALLENGE SHA-256: ${challengeHash}.\n\nReproduza com \`bun run verify\`, após preparar .env conforme README. Integração e smoke usam serviços reais; interrompem temporariamente somente PostgreSQL/LocalStack deste Compose e restauram-nos. Não execute outras suítes nesses serviços ao mesmo tempo.\n`);
}
await save();
for (const step of steps) {
  step.status='running'; await save();
  console.log(`Verificando ${step.name}...`);
  const started=performance.now();
  const child=Bun.spawn(step.command,{ stdout: 'pipe',stderr: 'pipe' });
  const output=Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
  const ticker=setInterval(() => console.log(`${step.name}: em execução (${Math.floor((performance.now()-started)/1000)}s)`),20000);
  const exitCode=await child.exited; clearInterval(ticker);
  const log=(await output).join('\n');
  await Bun.write(`${directory}/${step.name}.log`,log);
  step.seconds=Math.round((performance.now()-started)/10)/100;
  step.status=exitCode===0 ? 'passed' : 'failed';
  const passed=log.match(/\b([0-9]+) pass\b/); const failed=log.match(/\b([0-9]+) fail\b/);
  step.summary=passed ? `${passed[1]} passaram; ${failed?.[1] ?? '?'} falharam` : exitCode===0 ? 'Concluído' : `Exit ${exitCode}`;
  await save(); console.log(`${step.name}: ${step.status} — ${step.summary}`);
  if (exitCode!==0) { console.error(`Veja ${directory}/${step.name}.log`); process.exitCode=exitCode ?? 1; break; }
}
if (await checksum('CHALLENGE.md')!==challengeHash) throw new Error('Enunciado alterado durante validação');
console.log('Relatório: VALIDATION.md');
