// Barreiras IPC exclusivas dos ensaios de falha. Nunca ativadas por entrada HTTP/SQS.
let used = false;
export async function testGate(point: string, ids: Record<string,string> = {}): Promise<void> {
  if (process.env['NODE_ENV']!=='test' || process.env['TEST_GATE']!==point || used) return;
  used=true;
  if (!process.send) throw new Error('Test gate exige canal IPC');
  await new Promise<void>((resolve) => {
    const release = (message: unknown) => {
      if (message && typeof message==='object' && 'release' in message && message.release===point) {
        process.off('message',release); resolve();
      }
    };
    process.on('message',release);
    process.send!({ event: 'test_gate',point,...ids });
  });
}
