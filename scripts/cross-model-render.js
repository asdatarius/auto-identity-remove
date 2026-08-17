#!/usr/bin/env node
/**
 * scripts/cross-model-render.js
 *
 * Turn the reviewer's JSON into a committed markdown report, and print
 * "<p1> <p2> <p3>" on stdout so the shell wrapper can set its exit code.
 *
 * Split out of cross-model-review.sh so the rendering is testable without
 * invoking a model. node rather than jq: node is already a hard dependency of
 * this project, jq is not.
 */

'use strict';

const fs = require('fs');

/** @param {unknown} raw @returns {{summary: string, findings: object[]}} */
function parseFindings(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return { summary: '', findings: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { summary: '', findings: [] };
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  return { summary: typeof parsed.summary === 'string' ? parsed.summary : '', findings };
}

function countBySeverity(findings) {
  const c = { P1: 0, P2: 0, P3: 0 };
  for (const f of findings) if (c[f && f.severity] !== undefined) c[f.severity]++;
  return c;
}

/** Markdown table cells cannot contain a raw pipe or newline. */
function cell(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

const ORDER = { P1: 0, P2: 1, P3: 2 };

function renderReport({ summary, findings }, meta) {
  const counts = countBySeverity(findings);
  const sorted = [...findings].sort((a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3));

  const lines = [];
  lines.push(`# Cross-model review - ${meta.head}`);
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| reviewer family | ${cell(meta.family)} |`);
  lines.push(`| tool | ${cell(meta.tool)} |`);
  lines.push(`| model | ${cell(meta.model)} |`);
  lines.push(`| base | ${cell(meta.base)} |`);
  lines.push(`| head | ${cell(meta.head)} |`);
  lines.push(`| files reviewed | ${meta.files.length} |`);
  lines.push(`| findings | P1: ${counts.P1}, P2: ${counts.P2}, P3: ${counts.P3} |`);
  lines.push('');

  if (summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(summary);
    lines.push('');
  }

  lines.push('## Files reviewed');
  lines.push('');
  for (const f of meta.files) lines.push(`- \`${f}\``);
  lines.push('');

  lines.push('## Findings');
  lines.push('');
  if (sorted.length === 0) {
    lines.push('None. The reviewer reported no findings at any severity.');
    lines.push('');
  } else {
    lines.push('Disposition is filled in by the maintainer: `fixed <sha>`, `wontfix <reason>`, or `not-a-bug <reason>`.');
    lines.push('');
    lines.push('| # | Sev | Location | Finding | Impact | Fix | Disposition |');
    lines.push('|---|-----|----------|---------|--------|-----|-------------|');
    sorted.forEach((f, i) => {
      const loc = f.file ? `\`${cell(f.file)}:${cell(f.line)}\`` : '';
      lines.push(
        `| ${i + 1} | ${cell(f.severity)} | ${loc} | ${cell(f.title)} | ${cell(f.impact)} | ${cell(f.fix)} | |`,
      );
    });
    lines.push('');
    lines.push('### Detail');
    lines.push('');
    sorted.forEach((f, i) => {
      lines.push(`#### ${i + 1}. [${cell(f.severity)}] ${cell(f.title)}`);
      lines.push('');
      lines.push(`- **Location:** \`${cell(f.file)}:${cell(f.line)}\``);
      lines.push(`- **What:** ${cell(f.what)}`);
      lines.push(`- **Trigger:** ${cell(f.trigger)}`);
      lines.push(`- **Impact:** ${cell(f.impact)}`);
      lines.push(`- **Fix:** ${cell(f.fix)}`);
      lines.push('- **Disposition:** _pending_');
      lines.push('');
    });
  }

  return lines.join('\n');
}

module.exports = { parseFindings, countBySeverity, renderReport, cell };

if (require.main === module) {
  const outJson = process.env.AIDR_OUT_JSON;
  const reportPath = process.env.AIDR_REPORT;
  const files = (process.env.AIDR_TARGETS || '').split('\n').map(s => s.trim()).filter(Boolean);

  const raw = fs.readFileSync(outJson, 'utf8');
  const data = parseFindings(raw);
  const counts = countBySeverity(data.findings);

  const md = renderReport(data, {
    family: 'OpenAI (non-Anthropic)',
    tool: process.env.AIDR_REVIEW_TOOL || 'codex CLI',
    model: process.env.AIDR_REVIEW_MODEL || 'codex default',
    base: process.env.AIDR_BASE || '',
    head: process.env.AIDR_HEAD || '',
    files,
  });

  fs.writeFileSync(reportPath, md);
  fs.writeFileSync(reportPath.replace(/\.md$/, '.json'), raw);
  process.stdout.write(`${counts.P1} ${counts.P2} ${counts.P3}`);
}
