import type { Connector, ConnectorDeps, ConnectorFactory } from './contract.js';
import type { CrashfixConfig } from '../config.js';
import { firebaseFactory } from './firebase.js';

export { fakeConnector } from './fake.js';
export type { FetchParams, Connector, ConnectorDeps, ConnectorFactory, RunWorker } from './contract.js';

export const connectorRegistry: Record<string, ConnectorFactory> = {
  firebase: firebaseFactory,
};

export function selectConnector(
  key: string,
  cfg: CrashfixConfig,
  deps: Omit<ConnectorDeps, 'mcp'>
): Connector {
  const factory = connectorRegistry[key];
  if (!factory) {
    throw new Error(
      `unknown issue source "${key}". available: ${Object.keys(connectorRegistry).join(', ')}`
    );
  }
  let mcp = cfg.connectors[key]?.mcp;
  // Target the configured Firebase project at the MCP process itself, so the
  // server doesn't depend on a `.firebaserc` / `firebase use` in the cwd.
  if (mcp && cfg.firebase?.projectId && !mcp.args?.includes('--project')) {
    mcp = { ...mcp, args: [...(mcp.args ?? []), '--project', cfg.firebase.projectId] };
  }
  return factory({ ...deps, mcp, project: cfg.firebase });
}
