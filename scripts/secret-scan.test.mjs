
import { describe, expect, it } from 'vitest';

import { scanContent } from './secret-scan.mjs';

const ruleIds = (content) => scanContent(content).map((f) => f.rule);

describe('scanContent', () => {
  it('reports nothing for ordinary source', () => {
    expect(scanContent('const client = createClient(config.rpcUrl);\n')).toEqual([]);
  });

  it('treats placeholders as placeholders', () => {
    expect(ruleIds('apiKey: "${HELIUS_API_KEY}"')).toEqual([]);
    expect(ruleIds('const apiKey = process.env.HELIUS_KEY;')).toEqual([]);
    expect(ruleIds('password = "your-password-here"')).toEqual([]);
    expect(ruleIds('auth_token = "<your-token-goes-here>"')).toEqual([]);
  });

  it('reports a hardcoded assignment', () => {
    expect(ruleIds('const apiKey = "9f2c4b1ea77d3056";')).toEqual(['generic-assigned-secret']);
  });

  /**
   * Regression: the allowlist used to skip the whole line, so a live credential
   * sharing a line with any placeholder became invisible.
   */
  it('reports a credential sharing a line with a placeholder', () => {
    const line = 'const cfg = { key: process.env.X, aws: "AKIA' + 'IOSFODNN7ABCDEFG" };';

    expect(ruleIds(line)).toEqual(['aws-access-key-id']);
  });

  it('does not let the word "example" excuse a credential-shaped string', () => {
    expect(ruleIds('// example: AKIA' + 'IOSFODNN7ABCDEFG')).toEqual(['aws-access-key-id']);
  });

  it('reports every occurrence on a line', () => {
    const line = ['AKIA' + 'IOSFODNN7ABCDEFG', 'ASIA' + 'IOSFODNN7ABCDEFG'].join(' ');

    expect(ruleIds(line)).toEqual(['aws-access-key-id', 'aws-access-key-id']);
  });

  it('reports the 1-based line number of each finding', () => {
    const content = ['clean', 'also clean', 'AKIA' + 'IOSFODNN7ABCDEFG'].join('\n');

    expect(scanContent(content, 'a.ts')).toEqual([
      {
        file: 'a.ts',
        line: 3,
        rule: 'aws-access-key-id',
        description: 'AWS access key id',
      },
    ]);
  });

  it('reports key material', () => {
    expect(ruleIds('-----BEGIN OPENSSH PRIVATE KEY-----')).toEqual(['private-key-block']);
    expect(ruleIds(`[${Array.from({ length: 64 }, (_, i) => i % 256).join(',')}]`)).toEqual([
      'solana-keypair-array',
    ]);
    expect(ruleIds('https://mainnet.helius-rpc.com/?api-key=0123456789abcdef0123')).toEqual([
      'rpc-url-with-key',
    ]);
  });
});