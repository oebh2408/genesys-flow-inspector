import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileResult } from './format.js';
import { inspect } from './inspect.js';
import { normalizeInventory } from './inventory.js';
import { FlowParseError } from './parse.js';
import { rules } from './rules.js';
import type { InspectOptions, InspectResult, RuleSetting } from './types.js';

export interface OptionSources {
  config?: string;
  inventory?: string;
}

/** Reads the config file (default `.flowinspector.json` when present) and the inventory it or the caller points at. */
export function loadOptions(sources: OptionSources = {}): InspectOptions & { files: string[] } {
  const options: InspectOptions & { files: string[] } = { files: [] };
  const configPath = sources.config ?? (existsSync('.flowinspector.json') ? '.flowinspector.json' : undefined);
  let inventoryPath = sources.inventory;
  if (configPath) {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { rules?: Record<string, RuleSetting>; inventory?: string };
    options.rules = config.rules;
    options.files.push(configPath);
    for (const id of Object.keys(config.rules ?? {})) {
      if (!rules.some((r) => r.id === id)) throw new Error(`Unknown rule '${id}' in ${configPath}.`);
    }
    inventoryPath ??= config.inventory;
  }
  if (inventoryPath) {
    options.inventory = normalizeInventory(JSON.parse(readFileSync(inventoryPath, 'utf8')));
    options.files.push(inventoryPath);
  }
  return options;
}

/** Expands directories into the `.yaml` / `.yml` files inside them, skipping hidden folders and node_modules. */
export function collectFiles(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p).sort()) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(p, entry);
        if (statSync(full).isDirectory() || /\.ya?ml$/i.test(entry)) walk(full);
      }
    } else out.push(p);
  };
  paths.forEach(walk);
  return out;
}

/** Inspects one file. A file that cannot be parsed becomes a single `parse-error` issue instead of throwing. */
export function inspectFile(file: string, options: InspectOptions): FileResult & { result?: InspectResult } {
  try {
    const result = inspect(readFileSync(file, 'utf8'), options);
    return { file, issues: result.issues, result };
  } catch (err) {
    if (err instanceof FlowParseError) {
      return { file, issues: [{ rule: 'parse-error', severity: 'error', message: err.message, loc: err.loc }] };
    }
    throw err;
  }
}
