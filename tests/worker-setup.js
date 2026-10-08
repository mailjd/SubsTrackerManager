/** Existing Workers API suites exercise an already-upgraded application.
 * Gate itself is NOT bypassed in tests/upgrade/protection.test.mjs and disk upgrade integration.
 * Keep this fixture only in test config, never import into production.
 */
import {vi} from 'vitest';
vi.mock('../src/data/upgrade-gate.js',()=>({handleUpgradeGate:async()=>null,upgradeReady:async()=>true}));
