/**
 * テンプレートから作ったリポジトリを、Coding Agent の仕組みが動く状態にする。
 * テンプレートから作ったときに引き継がれないもの (ブランチ、リポジトリの設定、ラベル、ルールセット) を用意する。
 *
 * ルールセットや既定ブランチの変更には管理者の権限が必要なため、ワークフローではなく、
 * リポジトリの管理者が手元で gh コマンドにログインした状態で実行する。何度実行しても同じ状態になる。
 *
 * 使い方:
 *   node .github/scripts/coding-agent/setup-repository.mjs --repo <owner>/<name> [オプション]
 *
 * オプション:
 *   --required-check <名前>     develop で必須にするステータスチェック (複数指定できる。既定は commitlint)
 *   --main-bypass-team <slug>   main を更新できる Team (複数指定できる。Organization のオーナーは常に更新できる)
 *   --dry-run                   変更の内容を表示するだけで、変更しない
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** エージェントが扱うブランチ (既定ブランチにする) */
export const DEVELOP_BRANCH = 'develop';

/** 人がマージするブランチ */
export const MAIN_BRANCH = 'main';

/** 必須のステータスチェックの既定値 (テンプレートに含まれる commitlint のジョブ) */
export const DEFAULT_REQUIRED_CHECKS = ['commitlint'];

/** ルールセットの名前 (同じ名前のルールセットがあれば更新する) */
export const RULESET_NAMES = {
  develop: 'Coding Agent: develop',
  main: 'Coding Agent: main',
};

/**
 * @typedef {object} Label
 * @property {string} name
 * @property {string} color 16 進数の色 (# を付けない)
 * @property {string} description
 */

/** @type {readonly Label[]} */
export const LABELS = [
  { name: 'feature', color: '1d76db', description: '新規機能の親 Issue' },
  { name: 'stage:requirements', color: 'c5def5', description: '段階: 要件定義' },
  { name: 'stage:specification', color: 'c5def5', description: '段階: 仕様書' },
  { name: 'stage:domain-model', color: 'c5def5', description: '段階: 概念モデル' },
  { name: 'stage:architecture', color: 'c5def5', description: '段階: アーキテクチャ設計' },
  { name: 'stage:project', color: 'c5def5', description: '段階: プロジェクトの作成' },
  { name: 'stage:planning', color: 'c5def5', description: '段階: 実装計画' },
  { name: 'stage:implementation', color: 'bfdadc', description: '段階: 実装タスク' },
  { name: 'needs-human', color: 'd93f0b', description: 'エージェントの修正が上限に達し、人の対応が必要' },
];

/**
 * リポジトリの設定。Merge Queue は squash でマージし、コミットメッセージを PR のタイトルだけにする
 * (PR の説明は 1 行が長く、commitlint の本文の行の長さの上限を超えることがあるため)。
 */
export const REPOSITORY_SETTINGS = {
  default_branch: DEVELOP_BRANCH,
  allow_auto_merge: true,
  allow_squash_merge: true,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'BLANK',
  delete_branch_on_merge: true,
};

/**
 * @typedef {object} BypassActor
 * @property {number | null} actor_id
 * @property {'OrganizationAdmin' | 'Team'} actor_type
 * @property {'always' | 'pull_request'} bypass_mode
 */

/**
 * develop のルールセット。エージェントの PR は承認と必須のチェックを通ったうえで、Merge Queue でマージする。
 *
 * @param {string[]} requiredChecks 必須にするステータスチェックの名前
 * @returns {object}
 */
export function developRuleset(requiredChecks) {
  return {
    name: RULESET_NAMES.develop,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: [`refs/heads/${DEVELOP_BRANCH}`], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          allowed_merge_methods: ['squash'],
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 1,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          // Merge Queue が他の PR とあわせてテストするため、ブランチを最新にすることは求めない
          strict_required_status_checks_policy: false,
          required_status_checks: requiredChecks.map((context) => ({ context })),
        },
      },
      {
        type: 'merge_queue',
        parameters: {
          check_response_timeout_minutes: 60,
          grouping_strategy: 'ALLGREEN',
          max_entries_to_build: 5,
          max_entries_to_merge: 5,
          merge_method: 'SQUASH',
          min_entries_to_merge: 1,
          min_entries_to_merge_wait_minutes: 5,
        },
      },
    ],
  };
}

/**
 * main のルールセット。例外として指定した人だけが、PR を通して更新できる。
 * エージェントの GitHub App は書き込み権限を持つため、誤って main を更新しないよう仕組みで防ぐ。
 *
 * @param {number[]} bypassTeamIds main を更新できる Team の ID
 * @returns {object}
 */
export function mainRuleset(bypassTeamIds) {
  /** @type {BypassActor[]} */
  const bypassActors = [
    { actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'pull_request' },
    ...bypassTeamIds.map((id) => /** @type {BypassActor} */ ({ actor_id: id, actor_type: 'Team', bypass_mode: 'pull_request' })),
  ];
  return {
    name: RULESET_NAMES.main,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: [`refs/heads/${MAIN_BRANCH}`], exclude: [] } },
    bypass_actors: bypassActors,
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'update', parameters: { update_allows_fetch_and_merge: false } },
      {
        type: 'pull_request',
        parameters: {
          allowed_merge_methods: ['merge', 'squash', 'rebase'],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
        },
      },
    ],
  };
}

/**
 * @typedef {object} SetupOptions
 * @property {string} owner
 * @property {string} repo
 * @property {string[]} requiredChecks
 * @property {string[]} mainBypassTeams
 * @property {boolean} dryRun
 */

/**
 * コマンドライン引数を解釈する。
 *
 * @param {string[]} args
 * @returns {SetupOptions}
 * @throws {Error} 引数が正しくない場合
 */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      'required-check': { type: 'string', multiple: true },
      'main-bypass-team': { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(values.repo ?? '');
  if (match === null) {
    throw new Error('--repo には <owner>/<name> の形式でリポジトリを指定してください');
  }
  const requiredChecks = values['required-check'] ?? DEFAULT_REQUIRED_CHECKS;
  if (requiredChecks.some((check) => check.trim() === '')) {
    throw new Error('--required-check に空の名前は指定できません');
  }

  return {
    owner: match[1],
    repo: match[2],
    requiredChecks: [...new Set(requiredChecks)],
    mainBypassTeams: [...new Set(values['main-bypass-team'] ?? [])],
    dryRun: values['dry-run'] ?? false,
  };
}

/**
 * gh api を実行する。
 *
 * @param {string} method HTTP のメソッド
 * @param {string} path API のパス
 * @param {object} [body] リクエストの本文
 * @returns {any} レスポンスの JSON (本文が無い場合は null)
 */
function ghApi(method, path, body) {
  const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', path];
  if (body !== undefined) {
    args.push('--input', '-');
  }
  const output = execFileSync('gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return output.trim() === '' ? null : JSON.parse(output);
}

/**
 * ページ分けされた一覧をすべて取得する。
 *
 * @param {string} path API のパス
 * @returns {any[]}
 */
function ghApiList(path) {
  const output = execFileSync('gh', ['api', '--paginate', '--slurp', path], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return JSON.parse(output).flat();
}

/**
 * @param {SetupOptions} options
 */
function setup(options) {
  const base = `repos/${options.owner}/${options.repo}`;
  /**
   * @param {string} description
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   */
  const change = (description, method, path, body) => {
    if (options.dryRun) {
      console.log(`[dry-run] ${description}: ${method} ${path}`);
      if (body !== undefined) {
        console.log(JSON.stringify(body, null, 2));
      }
      return;
    }
    ghApi(method, path, body);
    console.log(`✔ ${description}`);
  };

  const repository = ghApi('GET', base);
  if (repository.owner.type !== 'Organization' || repository.visibility !== 'public') {
    throw new Error('Merge Queue を使うため、Organization が所有する public リポジトリで実行してください');
  }
  if (repository.permissions?.admin !== true) {
    throw new Error('リポジトリの管理者の権限が必要です');
  }

  // develop を、今の既定ブランチの先頭から作る
  const developRefs = ghApi('GET', `${base}/git/matching-refs/heads/${DEVELOP_BRANCH}`);
  if (developRefs.some((/** @type {{ ref: string }} */ ref) => ref.ref === `refs/heads/${DEVELOP_BRANCH}`)) {
    console.log(`${DEVELOP_BRANCH} ブランチは作成済みです`);
  } else {
    const head = ghApi('GET', `${base}/git/ref/heads/${repository.default_branch}`);
    change(`${repository.default_branch} から ${DEVELOP_BRANCH} ブランチを作成する`, 'POST', `${base}/git/refs`, {
      ref: `refs/heads/${DEVELOP_BRANCH}`,
      sha: head.object.sha,
    });
  }

  change('リポジトリの設定 (既定ブランチ、自動マージ、squash のコミットメッセージなど) を更新する', 'PATCH', base, REPOSITORY_SETTINGS);

  const existingLabels = new Map(
    ghApiList(`${base}/labels?per_page=100`).map((/** @type {Label} */ label) => [label.name.toLowerCase(), label]),
  );
  for (const label of LABELS) {
    const existing = existingLabels.get(label.name.toLowerCase());
    if (existing === undefined) {
      change(`ラベル ${label.name} を作成する`, 'POST', `${base}/labels`, label);
    } else if (existing.color !== label.color || existing.description !== label.description || existing.name !== label.name) {
      change(`ラベル ${label.name} を更新する`, 'PATCH', `${base}/labels/${encodeURIComponent(existing.name)}`, {
        new_name: label.name,
        color: label.color,
        description: label.description,
      });
    }
  }

  const teamIds = options.mainBypassTeams.map((slug) => ghApi('GET', `orgs/${options.owner}/teams/${slug}`).id);
  const existingRulesets = new Map(
    ghApiList(`${base}/rulesets?includes_parents=false&per_page=100`).map((/** @type {{ name: string, id: number }} */ ruleset) => [
      ruleset.name,
      ruleset.id,
    ]),
  );
  for (const ruleset of [developRuleset(options.requiredChecks), mainRuleset(teamIds)]) {
    const id = existingRulesets.get(ruleset.name);
    if (id === undefined) {
      change(`ルールセット ${ruleset.name} を作成する`, 'POST', `${base}/rulesets`, ruleset);
    } else {
      change(`ルールセット ${ruleset.name} を更新する`, 'PUT', `${base}/rulesets/${id}`, ruleset);
    }
  }

  console.log(options.dryRun ? '変更の内容を表示しました (変更はしていません)' : 'セットアップが完了しました');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    setup(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
