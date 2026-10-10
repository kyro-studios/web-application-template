import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_DIR,
  ConfigError,
  expandStageFiles,
  featureDirectory,
  findAgentByAssignee,
  findAgentByBot,
  getAgent,
  isValidFeatureName,
  loadConfig,
  validateAgentRelations,
} from './config.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * @returns {import('./config.mjs').AgentsConfig}
 */
function createAgentsConfig() {
  /**
   * @param {string} id
   * @returns {import('./config.mjs').Agent}
   */
  const agent = (id) => ({
    name: id,
    assignee: `${id}-account`,
    bot: `${id}-app[bot]`,
    workflow: `coding-agent-${id}.yml`,
    appClientId: `${id}-client-id`,
    appPrivateKeyRef: `op://CI/${id}/private key`,
    apiKeyRef: `op://CI/${id}/credential`,
  });
  return {
    agents: { claude: agent('claude'), codex: agent('codex') },
    roles: {
      author: { specification: 'claude', 'domain-model': 'claude', architecture: 'claude', planning: 'claude' },
      implementers: ['claude'],
      reviewer: 'codex',
    },
  };
}

describe('loadConfig', () => {
  it('リポジトリの設定ファイルを読み込める', async () => {
    const config = await loadConfig(ROOT_DIR);
    assert.ok(Object.keys(config.agents.agents).length > 0);
    assert.equal(config.stages.featureRoot, 'docs/features');
  });

  describe('設定に問題がある場合', () => {
    /** @type {string} */
    let rootDir;

    before(async () => {
      rootDir = await mkdtemp(join(tmpdir(), 'coding-agent-config-'));
      await cp(join(ROOT_DIR, CONFIG_DIR), join(rootDir, CONFIG_DIR), { recursive: true });
    });

    after(async () => {
      await rm(rootDir, { recursive: true, force: true });
    });

    it('形式の誤りを、すべてまとめて ConfigError で報告する', async () => {
      const agents = createAgentsConfig();
      const invalid = {
        ...agents,
        agents: { ...agents.agents, claude: { ...agents.agents.claude, bot: 'not-a-bot', workflow: undefined } },
      };
      await writeFile(join(rootDir, CONFIG_DIR, 'agents.json'), JSON.stringify(invalid));

      await assert.rejects(loadConfig(rootDir), (error) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(error.errors.some((message) => message.includes('/agents/claude/bot')));
        assert.ok(error.errors.some((message) => message.includes('workflow')));
        return true;
      });
    });

    it('JSON として読めないファイルを ConfigError で報告する', async () => {
      await writeFile(join(rootDir, CONFIG_DIR, 'agents.json'), '{');

      await assert.rejects(loadConfig(rootDir), ConfigError);
    });
  });
});

describe('validateAgentRelations', () => {
  it('正しい設定では問題を報告しない', () => {
    assert.deepEqual(validateAgentRelations(createAgentsConfig()), []);
  });

  it('登録されていないエージェントを担当にできない', () => {
    const config = createAgentsConfig();
    config.roles.author.architecture = 'gemini';
    config.roles.implementers = ['claude', 'jules'];

    const errors = validateAgentRelations(config);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /roles\.author\.architecture の "gemini"/);
    assert.match(errors[1], /roles\.implementers の "jules"/);
  });

  it('レビュー担当を作成担当や実装担当と同じエージェントにできない', () => {
    const asAuthor = createAgentsConfig();
    asAuthor.roles.author.planning = 'codex';
    assert.match(validateAgentRelations(asAuthor).join('\n'), /roles\.reviewer の "codex"/);

    const asImplementer = createAgentsConfig();
    asImplementer.roles.implementers = ['claude', 'codex'];
    assert.match(validateAgentRelations(asImplementer).join('\n'), /roles\.reviewer の "codex"/);
  });

  it('エージェントどうしで Bot 名を重複させられない (大文字と小文字は区別しない)', () => {
    const config = createAgentsConfig();
    config.agents.codex.bot = 'Claude-App[bot]';

    assert.deepEqual(validateAgentRelations(config), ['agents.json: "claude" と "codex" の bot が同じです']);
  });
});

describe('エージェントの引き当て', () => {
  const config = createAgentsConfig();

  it('Bot 名からエージェントを探せる (大文字と小文字は区別しない)', () => {
    assert.equal(findAgentByBot(config, 'CODEX-APP[bot]')?.id, 'codex');
    assert.equal(findAgentByBot(config, 'someone'), undefined);
    assert.equal(findAgentByBot(config, null), undefined);
  });

  it('Assignee からエージェントを探せる', () => {
    assert.equal(findAgentByAssignee(config, 'claude-account')?.id, 'claude');
    assert.equal(findAgentByAssignee(config, 'claude-app[bot]'), undefined);
  });

  it('識別子からエージェントを取り出せる', () => {
    assert.equal(getAgent(config, 'claude').workflow, 'coding-agent-claude.yml');
    assert.throws(() => getAgent(config, 'toString'), /登録されていません/);
  });
});

describe('機能ごとのディレクトリ', () => {
  /** @type {import('./config.mjs').StagesConfig} */
  const stages = {
    featureRoot: 'docs/features',
    stages: {
      requirements: { allow: ['{featureDir}/requirements.md'] },
      specification: { allow: ['{featureDir}/specification.md'] },
      'domain-model': { allow: ['{featureDir}/domain-model.md'] },
      architecture: { allow: ['{featureDir}/architecture.md'] },
      implementation: { allow: ['**'], deny: ['.github/**', '{featureRoot}/**'] },
    },
  };

  it('Issue の番号と機能名からディレクトリを決める', () => {
    assert.equal(featureDirectory(stages, 12, 'user-login'), 'docs/features/12-user-login');
  });

  it('形式が正しくない機能名を受け付けない', () => {
    for (const name of ['', 'User-Login', 'user_login', '-login', 'login-', 'user--login', '../etc', 'a'.repeat(51)]) {
      assert.equal(isValidFeatureName(name), false, name);
      assert.throws(() => featureDirectory(stages, 12, name), /機能名/);
    }
    assert.throws(() => featureDirectory(stages, 0, 'login'), /Issue の番号/);
  });

  it('段階ごとの glob の {featureRoot} と {featureDir} を置き換える', () => {
    const featureDir = featureDirectory(stages, 12, 'user-login');
    assert.deepEqual(expandStageFiles(stages, 'specification', featureDir), {
      allow: ['docs/features/12-user-login/specification.md'],
      deny: [],
    });
    assert.deepEqual(expandStageFiles(stages, 'implementation', featureDir), {
      allow: ['**'],
      deny: ['.github/**', 'docs/features/**'],
    });
  });
});
