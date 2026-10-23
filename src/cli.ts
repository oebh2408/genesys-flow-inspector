#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { format, type FileResult, type Format } from './format.js';
import { inspect } from './inspect.js';
import { normalizeInventory } from './inventory.js';
import { FlowParseError } from './parse.js';
import { renderHtml } from './render.js';
import { rules } from './rules.js';
import type { InspectOptions, RuleSetting } from './types.js';

const USAGE = `Usage:
  flow-inspector lint <file or directory>... [options]
  flow-inspector view <file> [-o out.html] [options]
  flow-inspector rules

Options:
  --inventory <file>    JSON file with the queues, prompts, data actions... that exist in the org
  --config <file>       Config file (default: .flowinspector.json if present)
  --format <name>       text, json, github or sarif (lint only, default text)
  --max-warnings <n>    Exit with code 1 when there are more than n warnings
  -o, --output <file>   Output file for view (default: <flow>.html)
`;

interface Args {
  command?: string;
  paths: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { paths: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-o') args.flags.output = argv[++i] ?? '';
    else if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      args.flags[key] = inline ?? argv[++i] ?? '';
    } else if (!args.command) args.command = a;
    else args.paths.push(a);
  }
  return args;
}

function loadOptions(flags: Record<string, string>): InspectOptions {
  const options: InspectOptions = {};
  const configPath = flags.config ?? (existsSync('.flowinspector.json') ? '.flowinspector.json' : undefined);
  let inventoryPath = flags.inventory;
  if (configPath) {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { rules?: Record<string, RuleSetting>; inventory?: string };
    options.rules = config.rules;
    for (const id of Object.keys(config.rules ?? {})) {
      if (!rules.some((r) => r.id === id)) throw new Error(`Unknown rule '${id}' in ${configPath}.`);
    }
    inventoryPath ??= config.inventory;
  }
  if (inventoryPath) options.inventory = normalizeInventory(JSON.parse(readFileSync(inventoryPath, 'utf8')));
  return options;
}

function collectFiles(paths: string[]): string[] {
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

function inspectFile(file: string, options: InspectOptions): FileResult & { result?: ReturnType<typeof inspect> } {
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

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args.command || args.flags.help !== undefined || args.command === 'help') {
    process.stdout.write(USAGE);
    return args.command ? 0 : 2;
  }

  if (args.command === 'rules') {
    for (const r of rules) process.stdout.write(`${r.id.padEnd(22)} ${r.severity.padEnd(8)} ${r.description}\n`);
    return 0;
  }

  const options = loadOptions(args.flags);

  if (args.command === 'lint') {
    if (!args.paths.length) throw new Error('lint needs at least one file or directory.');
    const results = collectFiles(args.paths).map((f) => {
      const { file, issues } = inspectFile(f, options);
      return { file: relative(process.cwd(), file) || file, issues };
    });
    const fmt = (args.flags.format ?? 'text') as Format;
    if (!['text', 'json', 'github', 'sarif'].includes(fmt)) throw new Error(`Unknown format '${fmt}'.`);
    const out = format(results, fmt);
    if (out) process.stdout.write(out + '\n');
    const all = results.flatMap((r) => r.issues);
    const errors = all.filter((i) => i.severity === 'error').length;
    const warnings = all.filter((i) => i.severity === 'warning').length;
    const maxWarnings = args.flags['max-warnings'] !== undefined ? Number(args.flags['max-warnings']) : Infinity;
    return errors > 0 || warnings > maxWarnings ? 1 : 0;
  }

  if (args.command === 'view') {
    const file = args.paths[0];
    if (!file) throw new Error('view needs a flow file.');
    const { result, issues } = inspectFile(file, options);
    if (!result) {
      process.stderr.write(`${file}: ${issues[0]?.message}\n`);
      return 1;
    }
    const output = args.flags.output || file.replace(/\.ya?ml$/i, '') + '.html';
    writeFileSync(output, renderHtml(result, { source: basename(file) }));
    process.stdout.write(`Wrote ${output} (${result.issues.length} issue${result.issues.length === 1 ? '' : 's'})\n`);
    return 0;
  }

  throw new Error(`Unknown command '${args.command}'.\n\n${USAGE}`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`flow-inspector: ${(err as Error).message}\n`);
  process.exitCode = 2;
}
