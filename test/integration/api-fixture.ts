import type { AppConfig } from '../../src/config/configuration.js';

export async function startApi(config: AppConfig, extra: Record<string,string> = {}) {
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const env = Object.fromEntries(Object.entries(config).map(([key,value]) => [key,String(value)]));
  const child = Bun.spawn([process.execPath,'dist/src/main.js'],{
    env: { ...process.env, ...env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', ...extra },
    stdout: 'pipe', stderr: 'pipe',
  });
  let output='';
  const read=async (stream: ReadableStream<Uint8Array>) => { const decoder=new TextDecoder(); for await (const chunk of stream) output+=decoder.decode(chunk,{ stream: true }); };
  const logs=Promise.all([read(child.stdout),read(child.stderr)]).then(() => output);
  const url = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now()+20_000;
    while (Date.now()<deadline) {
      if (child.exitCode!==null) throw new Error(`API encerrou: ${await logs}`);
      try { if ((await fetch(`${url}/health/live`,{ signal: AbortSignal.timeout(1000) })).ok) break; }
      catch { /* aguarda socket da própria API */ }
      await Bun.sleep(50);
    }
    if (!(await fetch(`${url}/health/live`,{ signal: AbortSignal.timeout(1000) })).ok) throw new Error('API não iniciou');
  } catch (error) { child.kill('SIGKILL'); await child.exited; throw error; }
  return {
    child, url, logs,output: () => output,
    async request(path: string, body?: unknown, headers: Record<string,string> = {}) {
      const response = await fetch(`${url}${path}`,{ method: body===undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
        ...(body===undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.json() as Record<string,unknown> };
    },
    async close() { if (child.exitCode!==null) return; child.kill('SIGTERM'); await Promise.race([child.exited,Bun.sleep(5000)]); if (child.exitCode===null) { child.kill('SIGKILL'); await child.exited; } },
  };
}
