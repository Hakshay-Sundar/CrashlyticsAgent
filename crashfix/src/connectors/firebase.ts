import type { ConnectorFactory } from './contract.js';

// ponytail: stub for task-9. Task 9 will implement the real Firebase connector.
export const firebaseFactory: ConnectorFactory = () => {
  throw new Error('firebase connector not yet implemented (task 9)');
};
