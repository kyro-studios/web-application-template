/**
 * テスト用の設定。
 *
 * リポジトリの agents.json と stages.json は、テンプレートから作ったリポジトリで実際の値に書き換えられる。
 * テストがそれらの値に左右されないよう、値を確かめるテストでは、この設定を使う。
 */

import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from '../config.mjs';

/** リポジトリのルート */
export const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * @param {string} id エージェントの識別子
 * @returns {import('../config.mjs').Agent}
 */
function fixtureAgent(id) {
  return {
    name: id,
    assignee: `${id}-account`,
    bot: `${id}-app[bot]`,
    workflow: `coding-agent-${id}.yml`,
    appClientId: `${id}-client-id`,
  };
}

/**
 * テスト用の agents.json の内容を返す。呼び出すたびに新しいオブジェクトを返す。
 *
 * @returns {import('../config.mjs').AgentsConfig}
 */
export function fixtureAgentsConfig() {
  return {
    coordinator: { bot: 'coordinator-app[bot]', appClientId: 'coordinator-client-id' },
    agents: { claude: fixtureAgent('claude'), codex: fixtureAgent('codex') },
    roles: {
      author: { specification: 'claude', 'domain-model': 'claude', architecture: 'claude', planning: 'claude' },
      implementers: ['claude'],
      reviewer: 'codex',
    },
  };
}

/**
 * テスト用の stages.json の内容を返す。呼び出すたびに新しいオブジェクトを返す。
 *
 * @returns {import('../config.mjs').StagesConfig}
 */
export function fixtureStagesConfig() {
  return {
    featureRoot: 'docs/features',
    stages: {
      requirements: { allow: ['{featureDir}/requirements.md'] },
      specification: { allow: ['{featureDir}/specification.md'] },
      'domain-model': { allow: ['{featureDir}/domain-model.md'] },
      architecture: { allow: ['{featureDir}/architecture.md'] },
      implementation: { allow: ['**'], deny: ['.github/**', '{featureRoot}/**'] },
    },
  };
}

/**
 * テスト用の設定を返す。
 *
 * @returns {import('../config.mjs').CodingAgentConfig}
 */
export function fixtureConfig() {
  return { agents: fixtureAgentsConfig(), stages: fixtureStagesConfig() };
}

/**
 * テスト用の設定ファイルを置いた、リポジトリのルートに見立てたディレクトリを作る。
 * Schema はリポジトリのものを使う。
 *
 * @returns {Promise<string>} 作ったディレクトリ
 */
export async function createFixtureRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), 'coding-agent-fixture-'));
  const configDir = join(rootDir, CONFIG_DIR);
  await mkdir(configDir, { recursive: true });
  for (const schema of ['agents-schema.json', 'stages-schema.json']) {
    await copyFile(join(ROOT_DIR, CONFIG_DIR, schema), join(configDir, schema));
  }
  await writeFile(join(configDir, 'agents.json'), JSON.stringify(fixtureAgentsConfig()));
  await writeFile(join(configDir, 'stages.json'), JSON.stringify(fixtureStagesConfig()));
  return rootDir;
}
