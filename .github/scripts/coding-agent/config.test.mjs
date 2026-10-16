import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixtureAgentsConfig, ROOT_DIR } from './testing/fixture-config.mjs';
import {
  CONFIG_DIR,
  ConfigError,
  expandStageFiles,
  featureDirectory,
  agentLabel,
  findAgentByBot,
  findAgentByLabel,
  fixExecution,
  getAgent,
  getAuthor,
  getImplementers,
  getReviewer,
  isCoordinator,
  isValidFeatureName,
  loadConfig,
  validateAgentRelations,
} from './config.mjs';

const createAgentsConfig = fixtureAgentsConfig;

describe('loadConfig', () => {
  it('リポジトリの設定ファイルを読み込める', async () => {
    // テンプレートから作ったリポジトリで書き換えた設定も、ここで検証される
    const config = await loadConfig(ROOT_DIR);
    assert.ok(Object.keys(config.agents.agents).length > 0);
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

    it('担当のラベルが 50 文字を超える識別子を受け付けない', async () => {
      const agents = createAgentsConfig();
      for (const [id, valid] of [['a'.repeat(44), true], ['a'.repeat(45), false]]) {
        const config = { ...agents, agents: { ...agents.agents, [id]: { ...agents.agents.claude, bot: 'other-app[bot]', workflow: 'other.yml' } } };
        await writeFile(join(rootDir, CONFIG_DIR, 'agents.json'), JSON.stringify(config));
        if (valid) {
          await loadConfig(rootDir);
        } else {
          await assert.rejects(loadConfig(rootDir), ConfigError);
        }
      }
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
    config.roles.architecture.author.agent = 'gemini';
    config.roles.implementation.implementers.push({ agent: 'jules' });
    config.roles.requirements.reviewer.agent = 'devin';

    const errors = validateAgentRelations(config);
    assert.equal(errors.length, 3);
    assert.match(errors[0], /roles\.architecture\.author の "gemini"/);
    assert.match(errors[1], /roles\.implementation\.implementers の "jules"/);
    assert.match(errors[2], /roles\.requirements\.reviewer の "devin"/);
  });

  it('同じエージェントを実装担当に重ねて登録できない', () => {
    const config = createAgentsConfig();
    config.roles.implementation.implementers.push({ agent: 'claude', model: 'other' });

    assert.match(validateAgentRelations(config).join('\n'), /implementers に同じエージェントが重複しています/);
  });

  it('レビュー担当を、その段階の作成担当や実装担当と同じエージェントにできない', () => {
    const asAuthor = createAgentsConfig();
    asAuthor.roles['domain-model'].author.agent = 'codex';
    assert.match(validateAgentRelations(asAuthor).join('\n'), /roles\.domain-model\.reviewer の "codex"/);

    const asImplementer = createAgentsConfig();
    asImplementer.roles.implementation.implementers.push({ agent: 'codex' });
    assert.match(validateAgentRelations(asImplementer).join('\n'), /roles\.implementation\.reviewer の "codex"/);
  });

  it('段階ごとに、作成担当とレビュー担当を入れ替えられる', () => {
    const config = createAgentsConfig();
    config.roles['domain-model'] = { author: { agent: 'codex' }, reviewer: { agent: 'claude' } };

    assert.deepEqual(validateAgentRelations(config), []);
  });

  it('エージェントどうしで Bot 名を重複させられない (大文字と小文字は区別しない)', () => {
    const config = createAgentsConfig();
    config.agents.codex.bot = 'Claude-App[bot]';

    assert.deepEqual(validateAgentRelations(config), ['agents.json: "claude" と "codex" の bot が同じです']);
  });

  it('進行役の Bot 名をエージェントと同じにできない', () => {
    const config = createAgentsConfig();
    config.agents.claude.bot = 'Coordinator-App[bot]';

    assert.deepEqual(validateAgentRelations(config), ['agents.json: coordinator と "claude" の bot が同じです']);
  });
});

describe('isCoordinator', () => {
  it('進行役の Bot か判定する (大文字と小文字は区別しない)', () => {
    const config = createAgentsConfig();
    assert.equal(isCoordinator(config, 'COORDINATOR-APP[bot]'), true);
    assert.equal(isCoordinator(config, 'claude-app[bot]'), false);
    assert.equal(isCoordinator(config, undefined), false);
  });
});

describe('エージェントの引き当て', () => {
  const config = createAgentsConfig();

  it('Bot 名からエージェントを探せる (大文字と小文字は区別しない)', () => {
    assert.equal(findAgentByBot(config, 'CODEX-APP[bot]')?.id, 'codex');
    assert.equal(findAgentByBot(config, 'someone'), undefined);
    assert.equal(findAgentByBot(config, null), undefined);
  });

  it('担当のラベルからエージェントを探せる (大文字と小文字は区別しない)', () => {
    assert.equal(agentLabel('claude'), 'agent:claude');
    assert.equal(findAgentByLabel(config, 'agent:claude')?.id, 'claude');
    assert.equal(findAgentByLabel(config, 'Agent:Codex')?.id, 'codex');
    for (const name of ['agent:devin', 'agent:toString', 'claude', 'stage:specification', '', undefined]) {
      assert.equal(findAgentByLabel(config, name), undefined, String(name));
    }
  });

  it('識別子からエージェントを取り出せる', () => {
    assert.equal(getAgent(config, 'claude').workflow, 'coding-agent-claude.yml');
    assert.throws(() => getAgent(config, 'toString'), /登録されていません/);
  });
});

describe('段階ごとの担当', () => {
  const config = createAgentsConfig();

  it('作成担当とレビュー担当を、モデルと effort とあわせて返す', () => {
    const author = getAuthor(config, 'specification');
    assert.equal(author.agent.id, 'claude');
    assert.deepEqual(author.execution, { model: 'claude-model', effort: 'high' });

    const reviewer = getReviewer(config, 'specification');
    assert.equal(reviewer.agent.id, 'codex');
    assert.deepEqual(reviewer.execution, { model: 'codex-model', effort: 'medium' });
  });

  it('モデルと effort を省略すると null にする (ツールの既定を使う)', () => {
    assert.deepEqual(getAuthor(config, 'planning').execution, { model: null, effort: null });
    assert.deepEqual(getReviewer(config, 'requirements').execution, { model: null, effort: null });
    assert.deepEqual(getImplementers(config).map((implementer) => implementer.agent.id), ['claude']);
  });

  it('修正のモデルと effort は、エージェントごとの設定を使う', () => {
    assert.deepEqual(fixExecution(getAgent(config, 'codex')), { model: 'codex-fix-model', effort: 'low' });
    const { fix, ...withoutFix } = getAgent(config, 'claude');
    assert.deepEqual(fixExecution(withoutFix), { model: null, effort: null });
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
      project: { allow: ['app/**'] },
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
