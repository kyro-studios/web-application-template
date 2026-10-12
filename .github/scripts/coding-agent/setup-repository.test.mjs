import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import {
  DEFAULT_REQUIRED_CHECKS,
  LABELS,
  REPOSITORY_SETTINGS,
  developRuleset,
  mainRuleset,
  parseOptions,
} from './setup-repository.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * @param {{ rules: { type: string, parameters?: any }[] }} ruleset
 * @param {string} type
 */
function findRule(ruleset, type) {
  const rule = ruleset.rules.find((candidate) => candidate.type === type);
  assert.ok(rule, `${type} のルールがありません`);
  return rule;
}

describe('parseOptions', () => {
  it('必須のチェックを省略すると commitlint を必須にする', () => {
    assert.deepEqual(parseOptions(['--repo', 'kyro-studios/sandbox']), {
      owner: 'kyro-studios',
      repo: 'sandbox',
      requiredChecks: DEFAULT_REQUIRED_CHECKS,
      mainBypassTeams: [],
      dryRun: false,
    });
  });

  it('複数指定できるオプションの重複を取り除く', () => {
    const options = parseOptions([
      '--repo=kyro-studios/sandbox',
      '--required-check=build',
      '--required-check=test',
      '--required-check=build',
      '--main-bypass-team=maintainers',
      '--dry-run',
    ]);
    assert.deepEqual(options.requiredChecks, ['build', 'test']);
    assert.deepEqual(options.mainBypassTeams, ['maintainers']);
    assert.equal(options.dryRun, true);
  });

  it('リポジトリの指定が無いか、形式が正しくなければ失敗する', () => {
    assert.throws(() => parseOptions([]), /--repo/);
    assert.throws(() => parseOptions(['--repo', 'sandbox']), /--repo/);
    assert.throws(() => parseOptions(['--repo', 'a/b', '--required-check', ' ']), /空の名前/);
    assert.throws(() => parseOptions(['--repo', 'a/b', '--unknown']));
  });
});

describe('ラベル', () => {
  it('段階の Issue に付けるラベルが、すべての段階についてそろっている', async () => {
    const config = await loadConfig(ROOT_DIR);
    const stages = new Set([...Object.keys(config.stages.stages), ...Object.keys(config.agents.roles)]);
    const labels = new Set(LABELS.map((label) => label.name));
    for (const stage of stages) {
      assert.ok(labels.has(`stage:${stage}`), `stage:${stage} のラベルがありません`);
    }
    assert.ok(labels.has('feature'));
    assert.ok(labels.has('needs-human'));
  });

  it('色は # を付けない 6 桁の 16 進数にする', () => {
    for (const label of LABELS) {
      assert.match(label.color, /^[0-9a-f]{6}$/, label.name);
    }
  });
});

describe('リポジトリの設定', () => {
  it('develop を既定ブランチにし、自動マージを有効にして、squash のコミットメッセージを PR のタイトルだけにする', () => {
    assert.equal(REPOSITORY_SETTINGS.default_branch, 'develop');
    assert.equal(REPOSITORY_SETTINGS.allow_auto_merge, true);
    assert.equal(REPOSITORY_SETTINGS.squash_merge_commit_title, 'PR_TITLE');
    assert.equal(REPOSITORY_SETTINGS.squash_merge_commit_message, 'BLANK');
  });
});

describe('develop のルールセット', () => {
  const ruleset = developRuleset(['commitlint', 'build']);

  it('承認を必須にし、新しい push で承認を取り消す', () => {
    const { parameters } = findRule(ruleset, 'pull_request');
    assert.equal(parameters.required_approving_review_count, 1);
    assert.equal(parameters.dismiss_stale_reviews_on_push, true);
    assert.deepEqual(parameters.allowed_merge_methods, ['squash']);
  });

  it('指定したチェックを必須にし、ブランチを最新にすることは求めない', () => {
    const { parameters } = findRule(ruleset, 'required_status_checks');
    assert.deepEqual(parameters.required_status_checks, [{ context: 'commitlint' }, { context: 'build' }]);
    assert.equal(parameters.strict_required_status_checks_policy, false);
  });

  it('Merge Queue で squash してマージする', () => {
    assert.equal(findRule(ruleset, 'merge_queue').parameters.merge_method, 'SQUASH');
  });

  it('例外を設けない', () => {
    assert.deepEqual(ruleset.bypass_actors, []);
  });
});

describe('main のルールセット', () => {
  it('更新を制限し、Organization のオーナーと指定した Team だけが PR を通して更新できる', () => {
    const ruleset = mainRuleset([42]);
    findRule(ruleset, 'update');
    assert.deepEqual(ruleset.bypass_actors, [
      { actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' },
      { actor_id: 42, actor_type: 'Team', bypass_mode: 'pull_request' },
    ]);
  });
});
