#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const WORK_DIR = join(process.cwd(), '.tmp-repos');
const OUT_DIR = join(process.cwd(), 'dist');

// 第一梯队内置源配置（有 tag 的源优先 pin 到最新 release tag）
const SOURCES = [
  {
    id: 'anthropics/skills',
    repo: 'anthropics/skills',
    url: 'https://github.com/anthropics/skills.git',
    pinMode: 'branch', // 'branch' | 'latest-tag'
    defaultBranch: 'main',
    defaultLicense: 'Apache-2.0',
  },
  {
    id: 'google-labs-code/stitch-skills',
    repo: 'google-labs-code/stitch-skills',
    url: 'https://github.com/google-labs-code/stitch-skills.git',
    pinMode: 'branch',
    defaultBranch: 'main',
    defaultLicense: 'Apache-2.0',
  },
  {
    id: 'wshobson/agents',
    repo: 'wshobson/agents',
    url: 'https://github.com/wshobson/agents.git',
    pinMode: 'latest-tag',
    defaultBranch: 'main',
    defaultLicense: 'MIT',
  },
  {
    id: 'sickn33/agentic-awesome-skills',
    repo: 'sickn33/agentic-awesome-skills',
    url: 'https://github.com/sickn33/agentic-awesome-skills.git',
    pinMode: 'latest-tag',
    defaultBranch: 'main',
    defaultLicense: 'MIT',
    // 可选：限制单仓最大收录数或按白名单过滤，避免首版体量过大
    maxItems: 300,
  },
];

const CATEGORY_KEYWORDS = [
  ['security', /\b(security|vuln|audit|auth|secret|cve|xss|csrf)\b/i],
  ['testing', /\b(test|jest|vitest|playwright|cypress|qa|e2e)\b/i],
  ['git', /\b(git|github|pr|pull request|commit|branch|merge)\b/i],
  ['docs', /\b(doc|pdf|docx|pptx|xlsx|markdown|readme|slide|report)\b/i],
  ['browser', /\b(browser|web|scrape|crawl|dom|puppeteer)\b/i],
  ['ui', /\b(ui|ux|css|tailwind|react|vue|design|figma|stitch|frontend)\b/i],
  ['devops', /\b(docker|k8s|kubernetes|ci|cd|deploy|terraform|aws|gcp)\b/i],
  ['data', /\b(sql|postgres|sqlite|csv|parquet|pandas|analytics|db)\b/i],
  ['debug', /\b(debug|trace|log|profil|error|fix)\b/i],
  ['ai', /\b(llm|prompt|agent|mcp|rag|embedding|model)\b/i],
  ['workflow', /\b(workflow|plan|task|review|spec|scrum)\b/i],
  ['research', /\b(research|paper|arxiv|search|summar)\b/i],
  ['automation', /\b(automat|cron|hook|script|cli|bash)\b/i],
  ['media', /\b(image|video|audio|tts|ffmpeg|svg)\b/i],
  ['dev', /\b(code|typescript|python|rust|go|refactor|api)\b/i],
];

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function resolveRef(source) {
  if (source.pinMode === 'latest-tag') {
    try {
      const out = git(['ls-remote', '--tags', '--sort=-v:refname', source.url]);
      const line = out.split('\n').find((l) => l.includes('refs/tags/v') && !l.endsWith('^{}'));
      if (line) return line.split('refs/tags/')[1].trim();
    } catch {
      // 回退默认分支
    }
  }
  return source.defaultBranch;
}

function parseFrontmatter(md) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!match) return { meta: {}, body: md };
  const meta = {};
  let currentKey = null;
  let blockMode = false;

  for (const rawLine of match[1].split(/\r?\n/)) {
    if (blockMode && (/^\s+/.test(rawLine) || rawLine.trim() === '')) {
      meta[currentKey] = `${meta[currentKey] ? `${meta[currentKey]} ` : ''}${rawLine.trim()}`.trim();
      continue;
    }
    blockMode = false;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    currentKey = kv[1];
    const val = kv[2].trim();
    if (val === '|' || val === '>') {
      meta[currentKey] = '';
      blockMode = true;
    } else {
      meta[currentKey] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return { meta, body: md.slice(match[0].length).trim() };
}

function inferCategory(name, desc, explicitCategory) {
  const VALID = new Set([
    'docs', 'dev', 'git', 'testing', 'debug', 'security', 'browser',
    'data', 'ai', 'workflow', 'ui', 'devops', 'research', 'automation', 'media', 'other',
  ]);
  if (explicitCategory && VALID.has(explicitCategory.toLowerCase())) {
    return explicitCategory.toLowerCase();
  }
  const text = `${name} ${desc}`;
  for (const [cat, regex] of CATEGORY_KEYWORDS) {
    if (regex.test(text)) return cat;
  }
  return 'other';
}

function scanSkillCapabilities(skillDir, mdContent) {
  const caps = new Set();
  const stack = [skillDir];
  const textCorpus = [mdContent];

  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'scripts' || entry.name === 'bin') caps.add('shell-exec');
        if (!entry.name.startsWith('.')) stack.push(full);
      } else if (/\.(sh|bash|py|js|mjs|ts|ps1)$/i.test(entry.name)) {
        caps.add('shell-exec');
        try {
          if (statSync(full).size <= 256 * 1024) {
            textCorpus.push(readFileSync(full, 'utf8'));
          }
        } catch {}
      }
    }
  }

  const joined = textCorpus.join('\n');
  if (/\b(fetch|curl|wget|axios|http:\/\/|https:\/\/)\b/i.test(joined)) caps.add('network');
  if (/\b(writeFile|fs\.write|mkdir|rm\s+-rf|unlink)\b/i.test(joined)) caps.add('fs-write');
  if (/\b(readFile|fs\.read|cat\s+)\b/i.test(joined)) caps.add('fs-read');
  if (/\b(process\.env|GITHUB_TOKEN|API_KEY|SECRET)\b/.test(joined)) caps.add('env-secrets');

  return Array.from(caps).sort(); // [] = 已扫描且未检出高风险能力
}

function findSkillFiles(repoDir) {
  const results = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'SKILL.md') {
        const rel = relative(repoDir, full).replace(/\\/g, '/');
        if (/(?:^|\/)skills\/[^/]+\/SKILL\.md$/i.test(rel)) {
          results.push({ full, rel, dir });
        }
      }
    }
  };
  walk(repoDir);
  return results.sort((a, b) => a.rel.localeCompare(b.rel));
}

function main() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const sourcesMeta = [];
  const allItems = [];
  const seenIds = new Set();

  for (const src of SOURCES) {
    const ref = resolveRef(src);
    const repoDir = join(WORK_DIR, src.id.replace('/', '__'));
    console.log(`[clone] ${src.repo} @ ${ref}`);

    try {
      git(['clone', '--depth', '1', '--branch', ref, src.url, repoDir]);
    } catch (err) {
      console.error(`[error] failed cloning ${src.repo}: ${err.message}`);
      sourcesMeta.push({ id: src.id, repo: src.repo, ref, status: 'broken' });
      continue;
    }

    const headSha = git(['rev-parse', '--short', 'HEAD'], repoDir);
    const lastPushAt = git(['log', '-1', '--format=%cI'], repoDir);
    const version = /^v?\d+\.\d+/.test(ref) ? (ref.startsWith('v') ? ref : `v${ref}`) : `0.0.0-${headSha}`;
    const skillFiles = findSkillFiles(repoDir);
    const limit = src.maxItems ? skillFiles.slice(0, src.maxItems) : skillFiles;

    sourcesMeta.push({ id: src.id, repo: src.repo, ref, commit: headSha, lastPushAt, status: 'active' });

    for (const sf of limit) {
      const rawMd = readFileSync(sf.full, 'utf8');
      const { meta, body } = parseFrontmatter(rawMd);
      const folderName = sf.rel.split('/').slice(-2, -1)[0];
      const name = String(meta.name || folderName).trim();
      const id = `${src.id}/skill/${name}`;
      if (!name || seenIds.has(id)) continue;
      seenIds.add(id);

      const enDesc = String(meta.description || body.split('\n')[0] || `${name} skill`).slice(0, 280);
      const skillRelDir = sf.rel.replace(/\/SKILL\.md$/i, '');

      allItems.push({
        id,
        sourceId: src.id,
        kind: 'skill',
        format: 'skill-folder',
        name,
        displayName: meta.displayName || name,
        description: { en: enDesc },
        category: inferCategory(name, enDesc, meta.category),
        version,
        updatedAt: lastPushAt,
        license: meta.license || src.defaultLicense || null,
        capabilities: scanSkillCapabilities(sf.dir, rawMd),
        installTarget: `gh:${src.repo}@${ref}#${skillRelDir}`,
        rawUrl: `https://raw.githubusercontent.com/${src.repo}/${encodeURIComponent(ref)}/${sf.rel}`,
        sourceUrl: `https://github.com/${src.repo}/blob/${encodeURIComponent(ref)}/${sf.rel}`,
        status: 'active',
      });
    }
  }

  const bodyForHash = JSON.stringify({ sources: sourcesMeta, items: allItems });
  const shortHash = createHash('sha256').update(bodyForHash).digest('hex').slice(0, 8);
  const now = new Date();
  const dateTag = now.toISOString().slice(0, 10).replace(/-/g, '.');

  const registry = {
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    catalogVersion: `${dateTag}-${shortHash}`,
    sources: sourcesMeta,
    items: allItems,
  };

  writeFileSync(join(OUT_DIR, 'registry.json'), JSON.stringify(registry, null, 2));
  writeFileSync(join(OUT_DIR, 'count.json'), JSON.stringify({
    count: allItems.length,
    catalogVersion: registry.catalogVersion,
    generatedAt: registry.generatedAt,
  }, null, 2));

  rmSync(WORK_DIR, { recursive: true, force: true });
  console.log(`[done] generated ${allItems.length} items (${registry.catalogVersion})`);
}

main();