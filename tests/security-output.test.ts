import { describe, expect, it } from 'vitest';
import { DomainError, InfraError } from '../src/errors.js';
import { createLogger } from '../src/logging/index.js';

describe('security-sensitive output', () => {
  it('構造化ログから Token、Authorization、URL query を除去する', () => {
    const lines: string[] = [];
    const logger = createLogger({
      format: 'json',
      token: 'secret-token',
      write: (line) => lines.push(line),
    });

    logger.info('download', {
      run_id: 'run-1',
      resource_id: 'page-1',
      authorization: 'Bearer secret-token',
      url: 'https://files.example/a.png?X-Amz-Signature=signed',
    });

    expect(lines[0]).toContain('run-1');
    expect(lines[0]).not.toContain('secret-token');
    expect(lines[0]).not.toContain('signed');
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('infoレベルでdebugログを出力せず、debugレベルで出力する', () => {
    const normal: string[] = [];
    const verbose: string[] = [];

    createLogger({
      format: 'json',
      level: 'info',
      write: (line) => normal.push(line),
    }).debug('plan action');
    createLogger({
      format: 'json',
      level: 'debug',
      write: (line) => verbose.push(line),
    }).debug('plan action');

    expect(normal).toEqual([]);
    expect(verbose).toHaveLength(1);
  });

  it('エラーメッセージから Token を除去し分類を保持する', () => {
    const domain = new DomainError('validation', 'bad secret-token', {
      secrets: ['secret-token'],
    });
    const infra = new InfraError('network', 'failed secret-token', {
      secrets: ['secret-token'],
    });

    expect(domain.message).toBe('bad [REDACTED]');
    expect(domain.category).toBe('validation');
    expect(infra.message).toBe('failed [REDACTED]');
    expect(infra.category).toBe('network');
  });
});
