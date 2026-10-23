import { analyze } from './analysis.js';
import { parseFlow } from './parse.js';
import { rules } from './rules.js';
import type { Flow, InspectOptions, InspectResult, Issue } from './types.js';

const ORDER = { error: 0, warning: 1, info: 2 } as const;

/** Parse a flow and run every enabled rule on it. */
export function inspect(source: string | Flow, options: InspectOptions = {}): InspectResult {
  const flow = typeof source === 'string' ? parseFlow(source) : source;
  const analysis = analyze(flow);
  const issues: Issue[] = [];

  for (const rule of rules) {
    const setting = options.rules?.[rule.id] ?? rule.severity;
    if (setting === 'off') continue;
    for (const found of rule.check({ flow, analysis, inventory: options.inventory })) {
      issues.push({ rule: rule.id, severity: setting, ...found });
    }
  }

  issues.sort((a, b) => (a.loc?.line ?? 0) - (b.loc?.line ?? 0) || ORDER[a.severity] - ORDER[b.severity]);
  return { flow, issues };
}
