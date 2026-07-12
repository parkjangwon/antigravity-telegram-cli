import path from 'node:path';

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function assertCleanPath(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty path`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} cannot contain control characters`);
  }
}

export function parseFileRunnerArguments(argv, platform = process.platform) {
  if (!Array.isArray(argv)) throw new TypeError('file-runner argv must be an array');
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== '--data-dir') {
    throw new Error('file-runner accepts only --data-dir <absolute-path>');
  }
  assertCleanPath(argv[1], 'file-runner data directory');
  if (!pathFor(platform).isAbsolute(argv[1])) {
    throw new Error('file-runner data directory must be absolute');
  }
  return { dataDir: argv[1] };
}

export function resolveServiceDataDir({
  projectDir,
  configuredDataDir,
  env = process.env,
  platform = process.platform,
}) {
  const pathApi = pathFor(platform);
  assertCleanPath(projectDir, 'project directory');
  if (!pathApi.isAbsolute(projectDir)) throw new Error('project directory must be absolute');

  let selected = configuredDataDir ?? env.DATA_DIR;
  if (selected == null || selected === '') {
    selected = platform === 'win32' && env.LOCALAPPDATA
      ? pathApi.join(env.LOCALAPPDATA, 'agygram', 'data')
      : 'data';
  }
  assertCleanPath(selected, 'service data directory');
  return pathApi.resolve(projectDir, selected);
}

export function buildServiceRuntimePaths(dataDir, platform = process.platform) {
  const pathApi = pathFor(platform);
  assertCleanPath(dataDir, 'service data directory');
  if (!pathApi.isAbsolute(dataDir)) throw new Error('service data directory must be absolute');
  const serviceDir = pathApi.join(dataDir, 'runtime', 'service');
  return {
    dataDir,
    serviceDir,
    environmentPath: pathApi.join(serviceDir, 'environment.json'),
    controlScriptPath: pathApi.join(serviceDir, 'task-control.ps1'),
    definitionPath: pathApi.join(serviceDir, 'antigravity-telegram-cli.xml'),
    stopRequestPath: pathApi.join(serviceDir, 'stop.request.json'),
    logPath: pathApi.join(dataDir, 'logs', 'service.log'),
  };
}

export const _private = { pathFor, assertCleanPath };
