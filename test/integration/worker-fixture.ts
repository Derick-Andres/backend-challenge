import type { AppConfig } from '../../src/config/configuration.js';

export async function startWorker(config: AppConfig, extra: Record<string,string> = {}) {
  const env = Object.fromEntries(Object.entries(config).map(([key,value]) => [key,String(value)]));
  const messages: unknown[] = [];
  const child = Bun.spawn([process.execPath,'dist/src/workers.js'],{
    env: { ...process.env,...env,NODE_ENV: 'test',...extra },stdout: 'pipe',stderr: 'pipe',
    ipc: (message: unknown) => { messages.push(message); },
  });
  let output = '';
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output+=decoder.decode(chunk,{ stream: true });
  };
  const logs = Promise.all([read(child.stdout),read(child.stderr)]).then(() => output);
  const deadline = Date.now()+20000;
  while (!output.includes('workers_started')) {
    if (child.exitCode!==null) throw new Error(`Worker encerrou: ${await logs}`);
    if (Date.now()>deadline) { child.kill('SIGKILL'); await child.exited; throw new Error(`Worker não iniciou: ${output}`); }
    await Bun.sleep(20);
  }
  return { child, logs, messages, output: () => output,
    async close() { if (child.exitCode!==null) return; child.kill('SIGTERM'); await Promise.race([child.exited,Bun.sleep(5000)]); if (child.exitCode===null) { child.kill('SIGKILL'); await child.exited; } },
  };
}

export async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now()+timeoutMs;
  let value: T;
  do { value=await read(); if (accepts(value)) return value; await Bun.sleep(25); } while (Date.now()<deadline);
  throw new Error('Condição de teste não ocorreu dentro do deadline');
}
