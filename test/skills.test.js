import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPromptWithSkill,
  filterSkills,
  listAgySkills,
} from '../src/skills.js';

test('listAgySkills discovers SKILL.md files from configured roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agygram-skills-'));
  try {
    await mkdir(path.join(root, 'skills', 'systematic-debugging'), { recursive: true });
    await mkdir(path.join(root, 'plugins', 'superpowers', 'skills', 'writing-plans'), { recursive: true });
    await writeFile(
      path.join(root, 'skills', 'systematic-debugging', 'SKILL.md'),
      '# Systematic Debugging\n\nUse when a bug needs careful diagnosis.\n',
    );
    await writeFile(
      path.join(root, 'plugins', 'superpowers', 'skills', 'writing-plans', 'SKILL.md'),
      '# Writing Plans\n\nUse when implementation needs a plan.\n',
    );

    const skills = await listAgySkills({
      env: { AGY_SKILL_ROOTS: [path.join(root, 'skills'), path.join(root, 'plugins')].join(path.delimiter) },
      homeDir: path.join(root, 'unused-home'),
    });

    assert.deepEqual(skills.map((skill) => skill.name), ['systematic-debugging', 'writing-plans']);
    assert.match(skills[0].description, /bug needs careful diagnosis/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filterSkills searches name and description', () => {
  const skills = [
    { name: 'cso', description: 'security audit' },
    { name: 'writing-plans', description: 'implementation planning' },
  ];

  assert.deepEqual(filterSkills(skills, 'security').map((skill) => skill.name), ['cso']);
  assert.deepEqual(filterSkills(skills, 'plans').map((skill) => skill.name), ['writing-plans']);
  assert.deepEqual(filterSkills(skills, '').map((skill) => skill.name), ['cso', 'writing-plans']);
});

test('buildPromptWithSkill prepends a stable Antigravity skill instruction', () => {
  assert.equal(
    buildPromptWithSkill('Fix the bug', 'systematic-debugging'),
    'Use the systematic-debugging skill for this request.\n\nFix the bug',
  );
  assert.equal(buildPromptWithSkill('Fix the bug', null), 'Fix the bug');
});
