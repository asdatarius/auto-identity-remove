'use strict';
/*
 * lib/cli-map.js - pure argument-to-target mapping for the `aidr` CLI.
 *
 * resolveCommand(args) takes everything after `node bin/aidr.js` and returns a
 * descriptor of what to spawn. It performs NO spawning, NO filesystem access,
 * and NO network - it is a pure function so it can be unit-tested directly.
 *
 * Subcommand flags are verified against watcher.js argv parsing and
 * dashboard/server.js MODE_ARGS.
 */

const PROGRAM = 'aidr';

// name -> { file, flags, cwd, desc }
// flags are the watcher.js flags this subcommand injects before passthrough.
const COMMANDS = {
  setup:     { file: 'setup.js',            flags: [],              cwd: 'root',      desc: 'Interactive first-run setup (creates config.json, schedules monthly job)' },
  run:       { file: 'watcher.js',          flags: [],              cwd: 'root',      desc: 'Run the opt-out pass now (submits forms)' },
  preview:   { file: 'watcher.js',          flags: ['--preview'],   cwd: 'root',      desc: 'Dry-run: fill forms but submit nothing' },
  verify:    { file: 'watcher.js',          flags: ['--verify'],    cwd: 'root',      desc: 'Re-search brokers and report whether you still appear' },
  dashboard: { file: 'dashboard/server.js', flags: [],              cwd: 'dashboard', desc: 'Start the local web dashboard and print its URL + login' },
  score:     { file: 'watcher.js',          flags: ['--serp-scan'], cwd: 'root',      desc: 'Scan search engines for where your name still ranks' },
  report:    { file: 'watcher.js',          flags: ['--pending'],   cwd: 'root',      desc: 'List brokers awaiting an email-confirmation click' },
  doctor:    { file: 'watcher.js',          flags: ['--doctor'],    cwd: 'root',      desc: 'Self-diagnose environment and configuration' },
};

const HELP_FLAGS = new Set(['--help', '-h', 'help']);
const VERSION_FLAGS = new Set(['--version', '-v']);

function resolveCommand(args) {
  const list = Array.isArray(args) ? args : [];
  const first = list[0];

  if (first === undefined || HELP_FLAGS.has(first)) {
    return { ok: true, target: 'help' };
  }
  if (VERSION_FLAGS.has(first)) {
    return { ok: true, target: 'version' };
  }

  const spec = COMMANDS[first];
  if (!spec) {
    return { ok: false, target: 'help', error: `unknown command: ${first}` };
  }

  const passthrough = list.slice(1);
  return {
    ok: true,
    target: 'node',
    command: first,
    file: spec.file,
    cwd: spec.cwd,
    args: [spec.file, ...spec.flags, ...passthrough],
  };
}

function buildHelp() {
  const lines = [];
  lines.push(`${PROGRAM} - automated data-broker opt-out runner`);
  lines.push('');
  lines.push(`Usage: ${PROGRAM} <command> [options]`);
  lines.push('');
  lines.push('Commands:');
  const width = Math.max(...Object.keys(COMMANDS).map(k => k.length));
  for (const name of Object.keys(COMMANDS)) {
    lines.push(`  ${name.padEnd(width)}  ${COMMANDS[name].desc}`);
  }
  lines.push('');
  lines.push('Other:');
  lines.push(`  --help, -h     Show this help`);
  lines.push(`  --version, -v  Show the installed version`);
  lines.push('');
  lines.push('Examples:');
  lines.push(`  ${PROGRAM} setup`);
  lines.push(`  ${PROGRAM} preview`);
  lines.push(`  ${PROGRAM} run --only Spokeo`);
  lines.push(`  ${PROGRAM} dashboard`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { PROGRAM, COMMANDS, resolveCommand, buildHelp };
