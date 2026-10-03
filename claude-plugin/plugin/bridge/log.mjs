import { appendFileSync, mkdirSync } from 'node:fs';
import { config } from './config.mjs';

// stdout belongs to the MCP protocol; logs go to stderr and a file.
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

// As apiKeyHelper the process must print nothing but the key, so log only to the file.
const toStderr = process.argv[2] !== 'llm-key';

export function log(level, msg, extra) {
  const line = `${new Date().toISOString()} ${level} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`;
  if (toStderr) process.stderr.write(line);
  try {
    appendFileSync(config.paths.log, line, { mode: 0o600 });
  } catch {}
}

export const info = (m, e) => log('INFO', m, e);
export const warn = (m, e) => log('WARN', m, e);
export const error = (m, e) => log('ERROR', m, e);
