// Builds the honest coverage statement shown in the panel and with search results.
import type { Coverage, CoverageSignal, MessageSummary } from './types.ts';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function computeCoverage(messages: readonly MessageSummary[], adapterSignals: readonly CoverageSignal[]): Coverage {
  const rendered = messages.filter((m) => m.rendered);
  const notRendered = messages.length - rendered.length;
  const branchPoints = rendered.filter((m) => m.branch && m.branch.total > 1).length;
  const signals: CoverageSignal[] = [...adapterSignals];

  if (notRendered > 0) {
    signals.push({
      code: 'not-rendered',
      severity: 'warning',
      count: notRendered,
      message: `${plural(notRendered, 'message was', 'messages were')} seen earlier but ${notRendered === 1 ? 'is' : 'are'} no longer loaded in the page. ${notRendered === 1 ? 'It stays' : 'They stay'} searchable, but jumping needs claude.ai to show ${notRendered === 1 ? 'it' : 'them'} again.`,
    });
  }

  const base = {
    renderedCount: rendered.length,
    knownCount: messages.length,
    notRenderedCount: notRendered,
    humanCount: messages.filter((m) => m.role === 'human').length,
    assistantCount: messages.filter((m) => m.role === 'assistant').length,
    branchPoints,
    signals,
  };

  if (messages.length === 0) {
    return { ...base, level: 'none', statement: 'No messages are indexed.' };
  }
  const partial = signals.some((s) => s.severity === 'warning');
  const statement = [
    `Indexed ${plural(rendered.length, 'message', 'messages')} loaded in this claude.ai page` +
      (notRendered > 0 ? ` (plus ${notRendered} seen earlier)` : '') +
      '.',
    partial
      ? 'Coverage is partial: some of this conversation is not loaded or not readable.'
      : 'Folio cannot confirm that claude.ai has loaded the whole conversation.',
    branchPoints > 0 ? `Only the version shown at ${plural(branchPoints, 'branch point', 'branch points')} is indexed.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { ...base, level: partial ? 'partial' : 'loaded-only', statement };
}
