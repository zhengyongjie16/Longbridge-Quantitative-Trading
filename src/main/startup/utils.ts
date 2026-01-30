import type { RunMode, StartupGateMode, RuntimeGateMode } from '../../types/index.js';

export function resolveRunMode(env: NodeJS.ProcessEnv): RunMode {
  const raw = env['RUN_MODE'];
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return normalized === 'dev' ? 'dev' : 'prod';
}

export function resolveGatePolicies(runMode: RunMode): {
  readonly startupGate: StartupGateMode;
  readonly runtimeGate: RuntimeGateMode;
} {
  if (runMode === 'dev') {
    return { startupGate: 'skip', runtimeGate: 'skip' };
  }
  return { startupGate: 'strict', runtimeGate: 'strict' };
}
