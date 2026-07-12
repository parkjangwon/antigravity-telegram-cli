import path from 'node:path';

const SAFE_ENV_NAMES = new Set(
  [
    'PATH',
    'HOME',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TERM',
    'COLORTERM',
    'NO_COLOR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'DISPLAY',
    'WAYLAND_DISPLAY',
  ].map((name) => name.toUpperCase()),
);

const DENIED_ENV_NAMES = new Set([
  'BOT_TOKEN',
  'BOT_SECRET',
  'BOT_API_KEY',
  'DISCORD_TOKEN',
  'DISCORD_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'MATRIX_ACCESS_TOKEN',
  // Loader/shell startup injection remains denied even when mistakenly added
  // to AGY_ENV_ALLOWLIST. These can execute code before the intended tool.
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
]);

function isDeniedEnvironmentName(name) {
  const normalized = name.toUpperCase();
  return (
    DENIED_ENV_NAMES.has(normalized) ||
    normalized.startsWith('ALLOWED_') ||
    normalized.startsWith('OWNER_') ||
    normalized.startsWith('TELEGRAM_') ||
    /(?:^|_)BOT_(?:TOKEN|SECRET|API_KEY)$/.test(normalized)
  );
}

export function parseEnvironmentAllowlist(value) {
  return String(value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

export function sanitizeExecutablePath(value, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Set();
  const safe = [];
  for (const rawEntry of String(value || '').split(pathApi.delimiter)) {
    let entry = rawEntry;
    if (platform === 'win32') {
      entry = entry.trim();
      if (/^".*"$/u.test(entry)) entry = entry.slice(1, -1);
      const driveAbsolute = /^[A-Za-z]:[\\/]/u.test(entry);
      const uncAbsolute = /^\\\\[^\\]+\\[^\\]+/u.test(entry);
      if (!driveAbsolute && !uncAbsolute) continue;
    } else if (!pathApi.isAbsolute(entry)) {
      continue;
    }
    if (!entry || entry.includes('\0')) continue;
    const key = platform === 'win32' ? entry.toLocaleLowerCase('en-US') : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push(entry);
  }
  return safe.join(pathApi.delimiter);
}

export function buildAgyEnvironment(source = process.env, additionalNames = []) {
  const explicit = new Set(additionalNames.map((name) => name.toUpperCase()));
  const result = {};
  for (const [name, value] of Object.entries(source)) {
    if (value == null) continue;
    const normalized = name.toUpperCase();
    if (isDeniedEnvironmentName(normalized)) continue;
    if (SAFE_ENV_NAMES.has(normalized) || normalized.startsWith('LC_') || explicit.has(normalized)) {
      if (normalized === 'PATH') {
        const safePath = sanitizeExecutablePath(value);
        if (safePath) result[name] = safePath;
      } else {
        result[name] = String(value);
      }
    }
  }
  return result;
}

export const _private = { SAFE_ENV_NAMES, DENIED_ENV_NAMES, isDeniedEnvironmentName };
