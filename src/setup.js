import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';

import dotenv from 'dotenv';

const TELEGRAM_API = 'api.telegram.org';
const SECRET_RE = /^\d{4,}:[A-Za-z0-9_-]{20,}$/u;

function parseArgs(argv) {
  const options = {
    discoverTelegram: true,
    interactive: true,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (seen.has(item)) throw new Error(`Duplicate option: ${item}`);
    seen.add(item);
    if (item === '--yes') options.yes = true;
    else if (item === '--non-interactive') options.interactive = false;
    else if (item === '--skip-telegram-discovery') options.discoverTelegram = false;
    else if ([
      '--config-file',
      '--data-dir',
      '--workspace-dir',
      '--agy-bin',
    ].includes(item)) {
      const value = argv[index + 1];
      if (value == null || value.startsWith('--')) throw new Error(`Missing value after ${item}`);
      index += 1;
      if (item === '--config-file') options.configFile = value;
      else if (item === '--data-dir') options.dataDir = value;
      else if (item === '--workspace-dir') options.workspaceDir = value;
      else options.agyBin = value;
    } else {
      throw new Error(`Unknown option: ${item}`);
    }
  }
  return options;
}

function defaultConfigFile(projectDir) {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'agygram', 'config', '.env');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'agygram', 'config', '.env');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agygram', '.env');
}

function defaultDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'agygram', 'data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'agygram', 'data');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'agygram', 'data');
}

function defaultWorkspaceDir() {
  return path.join(os.homedir(), 'agygram-workspace');
}

function envLiteral(value) {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Environment value contains control characters');
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !/\\[nr]/u.test(value)) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new Error('Value cannot be represented safely in dotenv format');
}

function setEnvValue(text, key, value) {
  const lines = text.split(/\r?\n/u);
  const active = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'u');
  const replacement = `${key}=${envLiteral(value)}`;
  let changed = false;
  let found = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (!active.test(lines[index])) continue;
    found = true;
    if (lines[index] !== replacement) {
      lines[index] = replacement;
      changed = true;
    }
  }
  if (!found) {
    lines.push(replacement);
    changed = true;
  }
  return changed ? `${lines.join('\n').replace(/\n+$/u, '')}\n` : text;
}

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    if (process.platform !== 'win32') {
      await chmod(path.dirname(file), 0o700);
      await chmod(file, 0o600);
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function resolveExecutable(configured) {
  if (configured) {
    const resolved = path.resolve(configured);
    await access(resolved, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return resolved;
  }
  const names = process.platform === 'win32' ? ['agy.exe'] : ['agy'];
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function requestTelegram(token, method, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const request = https.request({
      hostname: TELEGRAM_API,
      path: `/bot${token}/${method}`,
      method: payload ? 'POST' : 'GET',
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
      } : {},
      timeout: 30_000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(new Error('Telegram returned invalid JSON'));
          return;
        }
        if (!parsed.ok) {
          reject(new Error(parsed.description || `Telegram HTTP ${response.statusCode}`));
          return;
        }
        resolve(parsed.result);
      });
    });
    request.once('timeout', () => request.destroy(new Error('Telegram request timed out')));
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function promptSecret(message) {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question(message)).trim();
    } finally {
      rl.close();
    }
  }
  output.write(message);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.setRawMode(false);
      input.off('data', onData);
      output.write('\n');
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error('setup cancelled'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    input.on('data', onData);
  });
}

async function ask(rl, question, fallback) {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || '';
}

function latestPrivateUpdate(updates) {
  return [...updates]
    .reverse()
    .map((update) => update.message || update.edited_message)
    .find((message) => message?.chat?.type === 'private' && message.from?.id && message.chat?.id);
}

async function discoverTelegramIds(token, rl) {
  process.stdout.write('\nTelegram ID auto-detect\n');
  process.stdout.write('1. Open your bot in Telegram.\n');
  process.stdout.write('2. Send /start to the bot from the private chat you want to allow.\n');
  await rl.question('Press Enter after sending /start...');
  let offset = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let updates;
    try {
      updates = await requestTelegram(token, `getUpdates?timeout=10&offset=${offset}`);
    } catch (error) {
      process.stdout.write(`Telegram auto-detect skipped: ${error.message}\n`);
      return null;
    }
    for (const update of updates) {
      if (Number.isSafeInteger(update.update_id)) offset = Math.max(offset, update.update_id + 1);
    }
    const message = latestPrivateUpdate(updates);
    if (message) {
      const label = [
        message.from.first_name,
        message.from.last_name,
        message.from.username ? `@${message.from.username}` : null,
      ].filter(Boolean).join(' ');
      const confirmed = (await ask(rl, `Use this Telegram account (${label || 'private chat'}, user ${message.from.id})?`, 'yes')).toLowerCase();
      if (['y', 'yes', ''].includes(confirmed)) {
        return {
          allowedChatIds: String(message.chat.id),
          ownerUserIds: String(message.from.id),
        };
      }
      break;
    }
    process.stdout.write('Waiting for /start...\n');
  }
  return null;
}

async function runSetup(options, { projectDir = process.cwd() } = {}) {
  const configFile = path.resolve(options.configFile || defaultConfigFile(projectDir));
  let text;
  try {
    text = await readFile(configFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    text = [
      'BOT_TOKEN=',
      'ALLOWED_CHAT_IDS=',
      'OWNER_USER_IDS=',
      `AGY_BIN=${envLiteral(options.agyBin || '')}`,
      `DATA_DIR=${envLiteral(options.dataDir || defaultDataDir())}`,
      `WORKSPACE_DIR=${envLiteral(options.workspaceDir || defaultWorkspaceDir())}`,
      'DEFAULT_MODE=accept-edits',
      'DEFAULT_SANDBOX=true',
      'AUTH_FORCE_REMOTE=true',
      'AUTH_PRIVATE_ONLY=true',
      'REQUIRE_USER_ALLOWLIST_FOR_GROUPS=true',
      '',
    ].join('\n');
  }

  const parsed = dotenv.parse(text);
  if (!options.interactive && (!parsed.BOT_TOKEN || !parsed.ALLOWED_CHAT_IDS)) {
    throw new Error('setup needs BOT_TOKEN and ALLOWED_CHAT_IDS in non-interactive mode');
  }

  let rl;
  try {
    process.stdout.write(`agygram setup\nConfig: ${configFile}\n\n`);
    let botToken = parsed.BOT_TOKEN?.trim();
    if (!botToken) botToken = await promptSecret('Paste Telegram bot token from @BotFather: ');
    if (!SECRET_RE.test(botToken)) throw new Error('BOT_TOKEN does not look like a Telegram bot token');
    const bot = await requestTelegram(botToken, 'getMe');
    process.stdout.write(`Bot: @${bot.username || bot.first_name || 'unknown'}\n`);
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    let allowedChatIds = parsed.ALLOWED_CHAT_IDS || parsed.ALLOWED_CHAT_ID || '';
    let ownerUserIds = parsed.OWNER_USER_IDS || '';
    if ((!allowedChatIds || !ownerUserIds) && options.discoverTelegram) {
      const discovered = await discoverTelegramIds(botToken, rl);
      if (discovered) {
        allowedChatIds ||= discovered.allowedChatIds;
        ownerUserIds ||= discovered.ownerUserIds;
      }
    }
    if (!allowedChatIds) allowedChatIds = await ask(rl, 'Allowed Telegram chat ID');
    const ownerFallback = /^\d+$/u.test(allowedChatIds.trim()) ? allowedChatIds.trim() : '';
    if (!ownerUserIds) ownerUserIds = await ask(rl, 'Owner Telegram user ID', ownerFallback);
    if (!/^-?\d+(?:\s*,\s*-?\d+)*$/u.test(allowedChatIds)) throw new Error('ALLOWED_CHAT_IDS must be numeric IDs');
    if (!/^\d+(?:\s*,\s*\d+)*$/u.test(ownerUserIds)) throw new Error('OWNER_USER_IDS must be positive numeric IDs');

    const agyBin = await resolveExecutable(options.agyBin || parsed.AGY_BIN?.trim());
    if (!agyBin) throw new Error('agy was not found on PATH; rerun setup with --agy-bin <absolute path>');
    const dataDir = path.resolve(options.dataDir || parsed.DATA_DIR || defaultDataDir());
    const workspaceDir = path.resolve(options.workspaceDir || parsed.WORKSPACE_DIR || defaultWorkspaceDir());

    text = setEnvValue(text, 'BOT_TOKEN', botToken);
    text = setEnvValue(text, 'ALLOWED_CHAT_IDS', allowedChatIds);
    text = setEnvValue(text, 'OWNER_USER_IDS', ownerUserIds);
    text = setEnvValue(text, 'AGY_BIN', agyBin);
    text = setEnvValue(text, 'DATA_DIR', dataDir);
    text = setEnvValue(text, 'WORKSPACE_DIR', workspaceDir);
    text = setEnvValue(text, 'AUTH_FORCE_REMOTE', 'true');
    text = setEnvValue(text, 'AUTH_PRIVATE_ONLY', 'true');
    text = setEnvValue(text, 'REQUIRE_USER_ALLOWLIST_FOR_GROUPS', 'true');
    if (process.platform === 'win32' && !parsed.WINDOWS_ACL_VERIFIED) {
      text = setEnvValue(text, 'WINDOWS_ACL_VERIFIED', 'false');
    }

    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    await atomicWrite(configFile, text);
    process.stdout.write(`\nSaved: ${configFile}\n`);
    if (process.platform === 'win32') {
      process.stdout.write(
        'Windows: review the config/data ACLs, then set WINDOWS_ACL_VERIFIED=true before service install.\n',
      );
    }
    process.stdout.write('Next: start or update the managed service with the installer, then use /auth in Telegram.\n');
    return { configFile, dataDir, workspaceDir, agyBin };
  } finally {
    rl?.close();
  }
}

export async function setupCommand(argv = process.argv.slice(2), context = {}) {
  return runSetup(parseArgs(argv), context);
}

export const _private = {
  parseArgs,
  setEnvValue,
  envLiteral,
  latestPrivateUpdate,
};
