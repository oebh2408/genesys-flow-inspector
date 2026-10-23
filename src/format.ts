import type { Issue, Severity } from './types.js';
import { rules } from './rules.js';

export interface FileResult {
  file: string;
  issues: Issue[];
}

export type Format = 'text' | 'json' | 'github' | 'sarif';

export function format(results: FileResult[], kind: Format): string {
  switch (kind) {
    case 'json':
      return JSON.stringify(results, null, 2);
    case 'github':
      return results.flatMap((r) => r.issues.map((i) => githubAnnotation(r.file, i))).join('\n');
    case 'sarif':
      return JSON.stringify(sarif(results), null, 2);
    default:
      return text(results);
  }
}

function text(results: FileResult[]): string {
  const lines: string[] = [];
  const total = { error: 0, warning: 0, info: 0 };
  for (const r of results) {
    if (!r.issues.length) continue;
    lines.push(r.file);
    const width = Math.max(...r.issues.map((i) => location(i).length));
    for (const i of r.issues) {
      total[i.severity]++;
      lines.push(`  ${location(i).padEnd(width)}  ${i.severity.padEnd(7)}  ${i.message}  ${i.rule}`);
    }
    lines.push('');
  }
  const summary = (Object.keys(total) as Severity[]).map((s) => `${total[s]} ${s}${total[s] === 1 ? '' : 's'}`).join(', ');
  lines.push(`${results.length} file${results.length === 1 ? '' : 's'} checked: ${summary}`);
  return lines.join('\n');
}

function location(i: Issue): string {
  return i.loc ? `${i.loc.line}:${i.loc.column}` : '-';
}

function githubAnnotation(file: string, i: Issue): string {
  const level = i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'notice';
  const pos = i.loc ? `,line=${i.loc.line},col=${i.loc.column}` : '';
  const msg = i.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::${level} file=${file}${pos},title=${i.rule}::${msg}`;
}

function sarif(results: FileResult[]) {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'genesys-flow-inspector',
            informationUri: 'https://github.com/oebh2408/genesys-flow-inspector',
            rules: rules.map((r) => ({ id: r.id, shortDescription: { text: r.description }, defaultConfiguration: { level: sarifLevel(r.severity) } })),
          },
        },
        results: results.flatMap((r) =>
          r.issues.map((i) => ({
            ruleId: i.rule,
            level: sarifLevel(i.severity),
            message: { text: i.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: r.file },
                  ...(i.loc ? { region: { startLine: i.loc.line, startColumn: i.loc.column } } : {}),
                },
              },
            ],
          })),
        ),
      },
    ],
  };
}

function sarifLevel(s: Severity): string {
  return s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'note';
}
