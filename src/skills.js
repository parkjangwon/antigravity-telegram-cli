import os from 'node:os';
import path from 'node:path';
import { opendir, readFile, stat } from 'node:fs/promises';

const DEFAULT_MAX_SKILLS = 500;
const DEFAULT_MAX_DEPTH = 8;
const SKILL_FILE = 'SKILL.md';
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.cache',
  'dist',
  'build',
]);

function configuredRoots(env = process.env) {
  return String(env.AGY_SKILL_ROOTS || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
}

export function defaultSkillRoots(homeDir = os.homedir()) {
  return [
    path.join(homeDir, '.gemini', 'antigravity-cli', 'skills'),
    path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'skills'),
    path.join(homeDir, '.gemini', 'antigravity-cli', 'plugins'),
    path.join(homeDir, '.gemini', 'antigravity', 'skills'),
    path.join(homeDir, '.gemini', 'antigravity', 'builtin', 'skills'),
    path.join(homeDir, '.gemini', 'antigravity', 'plugins'),
    path.join(homeDir, '.gemini', 'extensions'),
  ];
}

function descriptionFromMarkdown(markdown) {
  const lines = String(markdown || '').split(/\r?\n/u);
  const useful = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    useful.push(line.replace(/\s+/gu, ' '));
    if (useful.join(' ').length >= 180) break;
  }
  return useful.join(' ').slice(0, 220);
}

function skillNameFromPath(filePath) {
  return path.basename(path.dirname(filePath));
}

async function existsDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function* walkSkillFiles(root, {
  maxDepth = DEFAULT_MAX_DEPTH,
  signal,
} = {}, depth = 0) {
  if (signal?.aborted || depth > maxDepth) return;
  let directory;
  try {
    directory = await opendir(root);
  } catch {
    return;
  }
  for await (const entry of directory) {
    if (signal?.aborted) return;
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === SKILL_FILE) {
      yield fullPath;
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    yield* walkSkillFiles(fullPath, { maxDepth, signal }, depth + 1);
  }
}

export async function listAgySkills({
  env = process.env,
  homeDir = os.homedir(),
  maxSkills = DEFAULT_MAX_SKILLS,
  signal,
} = {}) {
  const roots = configuredRoots(env);
  if (roots.length === 0) roots.push(...defaultSkillRoots(homeDir));
  const seenFiles = new Set();
  const byName = new Map();
  for (const root of roots) {
    if (!(await existsDirectory(root))) continue;
    for await (const file of walkSkillFiles(root, { signal })) {
      const resolvedFile = path.resolve(file);
      if (seenFiles.has(resolvedFile)) continue;
      seenFiles.add(resolvedFile);
      const name = skillNameFromPath(resolvedFile);
      if (!name || byName.has(name)) continue;
      let markdown = '';
      try {
        markdown = await readFile(resolvedFile, 'utf8');
      } catch {
        continue;
      }
      byName.set(name, {
        name,
        description: descriptionFromMarkdown(markdown),
      });
      if (byName.size >= maxSkills) break;
    }
    if (byName.size >= maxSkills) break;
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'en-US', { sensitivity: 'base' }));
}

export function filterSkills(skills, query) {
  const normalized = String(query || '').trim().toLocaleLowerCase('en-US');
  if (!normalized) return skills;
  return skills.filter((skill) =>
    skill.name.toLocaleLowerCase('en-US').includes(normalized) ||
    skill.description.toLocaleLowerCase('en-US').includes(normalized));
}

export function buildPromptWithSkill(prompt, skillName) {
  if (!skillName) return prompt;
  return `Use the ${skillName} skill for this request.\n\n${prompt}`;
}
