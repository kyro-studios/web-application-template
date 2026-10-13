/**
 * PR を通らない変更の検知: 既定ブランチが PR を通らずに変わったら、仕組みを止める (halt.mjs)。
 *
 * 既定ブランチはルールセットで保護され、変更は PR と Merge Queue を通る。PR を通らない変更 (ルールセットを外した
 * 直接の push など) で、成果物やアプリケーションのコードが消えたり書き換わったりすると、エージェントはそれに気づかず、
 * 壊れた状態の上に作業を積み重ねてしまう。そのため、次の場合に止める。
 * - force push (履歴の書き換え)
 * - PR がひも付かないコミットが、仕組みのファイル (mechanism-files.mjs) の外のファイルを変えている
 *
 * 仕組みのファイルだけを変える直接の push (確認用のリポジトリへのテンプレートの取り込みなど) では止めない。
 */

import { haltCodingAgent } from '../halt.mjs';
import { isMechanismFile } from '../mechanism-files.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../github-issues.mjs').GitHub} GitHub
 * @typedef {import('../github-issues.mjs').Repository} Repository
 */

/**
 * コミットにひも付く PR を取得し直す設定 (テストで間隔を短くするために変えられるようにする)。
 * マージの直後に、ひも付きがまだ反映されていない場合に備えて、間を空けて取得し直す
 * @type {{ attempts?: number, intervalMs?: number }}
 */
export const associationOptions = {};

/** 停止中の Issue に載せる、コミットごとのファイルの数の上限 */
const MAX_LISTED_FILES = 30;

/** getCommit の 1 ページのファイルの数 */
const FILES_PER_PAGE = 100;

/** ファイルの変更の種類の表示 */
const STATUS_NAMES = /** @type {Record<string, string>} */ ({ added: '追加', removed: '削除', modified: '変更', changed: '変更', renamed: '名前の変更', copied: 'コピー' });

/**
 * @typedef {object} UntrackedCommit
 * @property {string} sha
 * @property {string} message コミットメッセージの 1 行目
 * @property {{ filename: string, status: string, previous_filename?: string }[]} files 仕組みのファイルの外の変更
 */

/**
 * コミットで変わったファイルをすべて取得する。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {string} sha
 * @returns {Promise<{ filename: string, status: string, previous_filename?: string }[]>}
 */
async function listCommitFiles(github, repository, sha) {
  /** @type {{ filename: string, status: string, previous_filename?: string }[]} */
  const files = [];
  for (let page = 1; ; page++) {
    const { data } = await github.rest.repos.getCommit({ ...repository, ref: sha, per_page: FILES_PER_PAGE, page });
    const pageFiles = data.files ?? [];
    files.push(...pageFiles);
    if (pageFiles.length < FILES_PER_PAGE) {
      return files;
    }
  }
}

/**
 * コミットが、マージされた PR から入ったものか確かめる。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {string} sha
 * @returns {Promise<boolean>}
 */
async function isMergedFromPullRequest(github, repository, sha) {
  const { attempts = 3, intervalMs = 10_000 } = associationOptions;
  for (let attempt = 1; ; attempt++) {
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...repository, commit_sha: sha });
    if (data.some((pullRequest) => pullRequest.merged_at)) {
      return true;
    }
    if (attempt >= attempts) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * push に含まれるコミットのうち、PR がひも付かず、仕組みのファイルの外を変えているものを探す。
 *
 * @param {GitHub} github
 * @param {Repository} repository
 * @param {string} before
 * @param {string} after
 * @returns {Promise<UntrackedCommit[] | { reason: string }>}
 */
export async function findUntrackedCommits(github, repository, before, after) {
  const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...repository, basehead: `${before}...${after}`, per_page: 100 });
  // 1 回の push で 100 を超えるコミットが入ることは、通常の運用 (Merge Queue でのマージ) では無い
  if (data.commits.length < data.total_commits) {
    return { reason: `1 回の push に ${data.total_commits} 件のコミットが含まれ、すべてを確かめられませんでした` };
  }
  /** @type {UntrackedCommit[]} */
  const untracked = [];
  for (const commit of data.commits) {
    // 先にファイルを確かめ、仕組みのファイルだけの変更では、PR のひも付きを待たない
    const files = (await listCommitFiles(github, repository, commit.sha)).filter(
      (file) => !isMechanismFile(file.filename) || (file.previous_filename !== undefined && !isMechanismFile(file.previous_filename)),
    );
    if (files.length > 0 && !(await isMergedFromPullRequest(github, repository, commit.sha))) {
      untracked.push({ sha: commit.sha, message: commit.commit.message.split('\n')[0], files });
    }
  }
  return untracked;
}

/**
 * 停止中の Issue に書く、PR を通らないコミットの一覧を作る。
 *
 * @param {UntrackedCommit[]} commits
 * @returns {string[]}
 */
function formatCommits(commits) {
  return commits.flatMap((commit) => [
    `- ${commit.sha.slice(0, 7)} ${commit.message}`,
    ...commit.files.slice(0, MAX_LISTED_FILES).map((file) => {
      const path = file.previous_filename === undefined ? `\`${file.filename}\`` : `\`${file.previous_filename}\` → \`${file.filename}\``;
      return `  - ${STATUS_NAMES[file.status] ?? file.status}: ${path}`;
    }),
    ...(commit.files.length > MAX_LISTED_FILES ? [`  - ほか ${commit.files.length - MAX_LISTED_FILES} 件`] : []),
  ]);
}

/** @type {Handler} */
export const detectUntrackedChanges = {
  name: 'PR を通らない変更の検知',
  events: ['push'],
  runsWhileHalted: true,
  // 既定ブランチへの push だけを処理する
  matches: async ({ context }) => {
    const defaultBranch = context.payload.repository?.default_branch;
    return defaultBranch !== undefined && context.payload.ref === `refs/heads/${defaultBranch}`;
  },
  run: async ({ github, context, core, config }) => {
    const repository = context.repo;
    const { before, after, forced } = context.payload;
    const defaultBranch = context.payload.repository?.default_branch;
    const range = `${String(before).slice(0, 7)}...${String(after).slice(0, 7)}`;

    /** @type {string[]} */
    let details;
    if (forced) {
      details = [`force push で、\`${defaultBranch}\` の履歴が書き換えられました (${range})。`];
    } else if (/^0+$/.test(String(before))) {
      // ブランチの作成 (セットアップ) では、比べる前のコミットが無い
      core.info(`${defaultBranch} が作成されました`);
      return {};
    } else {
      const result = await findUntrackedCommits(github, repository, before, after);
      if ('reason' in result) {
        details = [`${result.reason} (${range})。`];
      } else if (result.length === 0) {
        core.info(`${range} の変更は、すべて PR を通っているか、仕組みのファイルだけの変更です`);
        return {};
      } else {
        details = ['次のコミットが PR を通らずに入り、仕組みのファイルの外を変えました。', '', ...formatCommits(result)];
      }
    }

    const number = await haltCodingAgent(github, repository, config, {
      title: `Coding Agent を停止しました: ${defaultBranch} が PR を通さずに変更されました`,
      reason: [
        `\`${defaultBranch}\` が PR を通さずに変更されたため、Coding Agent を止めました。成果物やアプリケーションのコードが消えたり書き換わったりしていると、エージェントがそれに気づかず、壊れた状態の上に作業を積み重ねてしまうためです。`,
        '',
        ...details,
      ].join('\n'),
    });
    core.warning(`${defaultBranch} が PR を通さずに変更されたため、Coding Agent を止めました (#${number})`);
    return {};
  },
};
