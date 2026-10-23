import type { Inventory, ResourceKind } from './types.js';

const KINDS: ResourceKind[] = ['queue', 'dataAction', 'prompt', 'flow', 'scheduleGroup', 'schedule', 'user', 'group', 'skill'];

/**
 * Accept inventory files with singular or plural keys (`queue` or `queues`) and
 * either plain names or objects with a `name` field, as returned by the platform API.
 */
export function normalizeInventory(input: unknown): Inventory {
  if (typeof input !== 'object' || input === null) throw new Error('Inventory must be a JSON object.');
  const out: Inventory = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const kind = KINDS.find((k) => k === key || `${k}s` === key);
    // A raw API list response (`{ entities: [...] }`) works too.
    const list = Array.isArray(value) ? value : (value as { entities?: unknown })?.entities;
    if (!kind || !Array.isArray(list)) continue;
    out[kind] = list
      .map((v) => (typeof v === 'string' ? v : typeof v === 'object' && v && 'name' in v ? String((v as { name: unknown }).name) : undefined))
      .filter((v): v is string => !!v);
  }
  return out;
}
