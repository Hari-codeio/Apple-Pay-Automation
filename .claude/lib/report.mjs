/**
 * The one renderer for the domain-workflow reports.
 *
 * Shared deliberately. The whole value of these reports is that the layout is
 * byte-identical across runs and comparable across skills; two copies of the
 * rendering code is how that quietly stops being true. Lives outside
 * `.claude/skills/` so the skills loader never sees a directory without a
 * SKILL.md.
 *
 * Consumers own their own step LABELS and the logic that decides each status.
 * This file owns nothing but the shape.
 */

export const STATUS = {
  success: '✅ Success',
  failed: '❌ Failed',
  notRun: '⏸️ Not Run',
  finished: '✅ Finished',
  incomplete: '❌ Incomplete',
  /** Suffixed with the flag that caused it, so a reader never has to guess why. */
  skipped: (because) => `⏭️ Skipped (${because})`,
};

/**
 * Render the fixed report.
 *
 * Invariants, which the harnesses assert:
 *   - one row per label, always, in order, never omitted or renamed
 *   - every status begins at the same column
 *   - `Details:` is always present, `(none)` when empty, so the shape is stable
 *   - the last non-blank line is the pass/fail sentence
 */
export function renderReport({
  title,
  domain,
  labels,
  steps,
  details,
  overall,
}) {
  if (steps.length !== labels.length) {
    throw new Error(
      `renderReport: ${steps.length} statuses for ${labels.length} labels`,
    );
  }

  // Widest label plus a four-space gutter. Reproduces the 23-column register
  // table exactly, and adapts when a workflow has longer step names.
  const width = Math.max(...labels.map((l) => l.length)) + 4;
  const rule = '===========================================';
  const total = labels.length;

  const lines = [rule, title, rule, '', `Domain: ${domain}`, ''];
  labels.forEach((label, i) => {
    lines.push(`[${i + 1}/${total}] ${label.padEnd(width)}${steps[i]}`);
  });
  lines.push('', `Overall Status: ${overall}`, '', 'Details:');
  if (details.length === 0) lines.push('  (none)');
  for (const detail of details) lines.push(`  - ${detail}`);
  lines.push(
    '',
    overall === 'SUCCESS'
      ? 'Workflow completed successfully.'
      : 'Workflow failed.',
  );
  return `${lines.join('\n')}\n`;
}

/** Days between now and a MySQL `YYYY-MM-DD HH:MM:SS` UTC datetime. */
export function daysFromNow(mysqlUtc) {
  const at = new Date(`${mysqlUtc.replace(' ', 'T')}Z`).getTime();
  return Math.round((at - Date.now()) / 86_400_000);
}
