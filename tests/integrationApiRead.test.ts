import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: '.env.local' });

const env = process.env;
const requiredKeys = ['LONGPORT_APP_KEY', 'LONGPORT_APP_SECRET', 'LONGPORT_ACCESS_TOKEN'];
const hasCreds = requiredKeys.every((key) => {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('your_');
});
const monitorSymbol = env['INTEGRATION_MONITOR_SYMBOL'] ?? env['MONITOR_SYMBOL_1'] ?? '';
const shouldRun = hasCreds && monitorSymbol.length > 0;
const skipReason = 'missing LONGPORT_* credentials or MONITOR_SYMBOL_1';

if (!shouldRun) {
  test('integration real api read-only pipeline', { skip: skipReason }, () => {});
} else {
  test('integration real api read-only pipeline', { timeout: 60_000 }, async () => {
    const runnerUrl = new URL('./integrationApiReadRunner.js', import.meta.url);
    const runnerPath = fileURLToPath(runnerUrl);

    const child = spawn(process.execPath, [runnerPath], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const exitCode: number = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });

    assert.equal(exitCode, 0, stderr || stdout);

    const outputLines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const jsonLine = outputLines.reverse().find((line) => line.startsWith('{')) ?? '';
    const payload = jsonLine ? (JSON.parse(jsonLine) as {
      readonly quoteOk: boolean;
      readonly candlesCount: number;
      readonly tradingDayChecked: boolean;
      readonly mainProgramSymbolsOk: boolean;
      readonly mainProgramQuoteOk: boolean;
    }) : null;

    assert.ok(payload);
    assert.equal(payload?.quoteOk, true);
    assert.ok((payload?.candlesCount ?? 0) > 0);
    assert.equal(payload?.tradingDayChecked, true);
    assert.equal(payload?.mainProgramSymbolsOk, true);
    assert.equal(payload?.mainProgramQuoteOk, true);
  });
}
