import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ChangeNotification, NotificationProvider } from './types';

function quote(value: string) {
  return value
    .split(/\r?\n/)
    .map(line => `> ${line}`)
    .join('\n');
}

export function formatMarkdownReport(event: ChangeNotification) {
  const lines = [
    `# Changes for ${event.monitorName}`,
    '',
    `Date: ${event.date}`,
    `Monitor: ${event.monitorId}`,
    `Run: ${event.runId}`,
    '',
  ];
  for (const change of event.changes) {
    lines.push(`## ${change.sourceId}`, '', `Status: ${change.status}`);
    if (change.route) lines.push(`Route: ${change.route}`);
    if (change.reason) lines.push(`Reason: ${change.reason}`);
    if (change.evidence) {
      lines.push(
        `Source: ${change.evidence.sourceUrl}`,
        '',
        'Before:',
        quote(change.evidence.beforeExcerpt || '(empty)'),
        '',
        'After:',
        quote(change.evidence.afterExcerpt || '(empty)'),
      );
    } else {
      lines.push('Evidence is unavailable in this run.');
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** Example provider: one idempotent Markdown report per changed scheduled run. */
export class MarkdownReportProvider implements NotificationProvider {
  readonly id = 'markdown-report';

  constructor(private readonly directory: string) {}

  async notify(event: ChangeNotification) {
    await mkdir(this.directory, { recursive: true });
    const key = createHash('sha256').update(`${event.monitorId}\0${event.runId}`).digest('hex');
    const path = join(this.directory, `${key}.md`);
    try {
      await writeFile(path, formatMarkdownReport(event), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
