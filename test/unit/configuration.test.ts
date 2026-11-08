import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config/configuration.js';

const valid = {
  PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'wagering',
  PGUSER: 'wagering', PGPASSWORD: 'local-development-only',
  AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://127.0.0.1:4566',
};

describe('configuração de startup', () => {
  test('aceita configuração local e fornece timeout/porta tipados', () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.HEALTH_TIMEOUT_MS).toBe(1000);
    expect(config.PGPORT).toBe(5432);
    expect(Object.isFrozen(config)).toBe(true);
  });

  test.each(['', '0', '-1', '65536', '3000.5', '1e3'])('rejeita porta inválida: %s', (PORT) => {
    expect(() => loadConfig({ ...valid, PORT })).toThrow('PORT');
  });

  test.each(['0', '-1', '99', '10001', 'Infinity'])('rejeita deadline inválido: %s', (HEALTH_TIMEOUT_MS) => {
    expect(() => loadConfig({ ...valid, HEALTH_TIMEOUT_MS })).toThrow('HEALTH_TIMEOUT_MS');
  });

  test('falha sem campos obrigatórios e não imprime valores sensíveis', () => {
    expect(() => loadConfig({ ...valid, PGPASSWORD: '', AWS_SECRET_ACCESS_KEY: '' }))
      .toThrow('Configuração inválida: PGPASSWORD, AWS_SECRET_ACCESS_KEY');
    expect(() => loadConfig({ ...valid, SQS_ENDPOINT: 'http://user:secret@localhost:4566' }))
      .toThrow(/^Configuração inválida: SQS_ENDPOINT$/);
  });
});
