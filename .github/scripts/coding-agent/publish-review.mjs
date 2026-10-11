/**
 * レビュー担当の出力を、レビュー担当の GitHub App で PR に投稿する。Approve した場合は、自動マージを有効にする。
 *
 * - 合否はレビュー担当に出力させず、must の指摘が 1 件でもあれば差し戻し (Request changes)、無ければ Approve する
 * - レビューしたコミットから head が進んでいれば、投稿しない (新しい push で起動したレビューに任せる)
 * - Approve はレビューしたコミットを commit_id に指定し、自動マージは expectedHeadOid を指定して有効にする
 * - must と should の指摘のうち、PR の差分に含まれる行のものは行へのコメントにし、それ以外はレビューの本文に載せる
 *
 * 環境変数:
 * - GITHUB_WORKSPACE: リポジトリのルート (review-schema.json の読み込みに使う)
 * - REVIEW_FILE: レビュー担当の出力 (review-schema.json の形式)
 * - PULL_REQUEST_NUMBER: レビューした PR の番号
 * - TARGET_SHA: レビューしたコミット
 * - STAGE: 段階
 * - REVIEWER_NAME: レビュー担当の表示名
 * - RUN_URL: ワークフローの実行の URL
 *
 * 出力:
 * - event: 投稿したレビューの種類 (APPROVE か REQUEST_CHANGES)。投稿しなかった場合は空
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR, validateWithSchema } from './config.mjs';
import { listChangedFiles } from './github-pulls.mjs';
import { stageName } from './prompt-format.mjs';

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 * @typedef {import('./review-prompt.mjs').ReviewResult} ReviewResult
 */

/**
 * GitHub に投稿するレビュー
 * @typedef {object} ReviewSubmission
 * @property {'APPROVE' | 'REQUEST_CHANGES'} event
 * @property {string} body
 * @property {{ path: string, line: number, side: 'RIGHT', body: string }[]} comments
 */

/** 重要度の表示 */
const SEVERITY_LABELS = { must: 'must', should: 'should', nit: 'nit' };

/**
 * 差分 (unified diff の patch) から、変更後のファイルでコメントできる行 (追加した行と前後の行) の番号を求める。
 *
 * @param {string | undefined} patch
 * @returns {Set<number>}
 */
export function commentableLines(patch) {
  /** @type {Set<number>} */
  const lines = new Set();
  let line = 0;
  for (const text of (patch ?? '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk !== null) {
      line = Number(hunk[1]);
    } else if (text.startsWith('+') || text.startsWith(' ')) {
      lines.add(line);
      line++;
    }
    // 削除した行 (-) と "\ No newline at end of file" は、変更後の行の番号を進めない
  }
  return lines;
}

/**
 * レビュー担当の出力から、GitHub に投稿するレビューを作る。
 *
 * @param {object} args
 * @param {ReviewResult} args.review レビュー担当の出力
 * @param {Map<string, Set<number>>} args.commentable ファイルごとの、コメントできる行
 * @param {string} args.stage 段階
 * @param {string} args.reviewerName レビュー担当の表示名
 * @param {string} args.runUrl ワークフローの実行の URL
 * @returns {ReviewSubmission}
 */
export function buildSubmission({ review, commentable, stage, reviewerName, runUrl }) {
  const event = review.findings.some((finding) => finding.severity === 'must') ? 'REQUEST_CHANGES' : 'APPROVE';

  /** @type {ReviewSubmission['comments']} */
  const comments = [];
  /** @type {ReviewResult['findings']} */
  const unplaced = [];
  for (const finding of review.findings) {
    const { path, line } = finding;
    if (finding.severity !== 'nit' && path !== null && line !== null && commentable.get(path)?.has(line)) {
      comments.push({ path, line, side: 'RIGHT', body: `**[${SEVERITY_LABELS[finding.severity]}]** ${finding.body}` });
    } else {
      unplaced.push(finding);
    }
  }

  const sections = [
    event === 'APPROVE'
      ? `🤖 「${stageName(stage)}」のレビューで、must の指摘はありませんでした。承認し、Merge Queue でマージします。`
      : `🤖 「${stageName(stage)}」のレビューで、must の指摘があるため差し戻します。must の指摘を直してください。`,
    '',
    '## 所見',
    '',
    review.summary.trim(),
  ];
  for (const severity of /** @type {const} */ (['must', 'should', 'nit'])) {
    const findings = unplaced.filter((finding) => finding.severity === severity);
    if (findings.length === 0) {
      continue;
    }
    sections.push('', `## ${SEVERITY_LABELS[severity]}`, '');
    for (const finding of findings) {
      const location = finding.path === null ? '' : `\`${finding.path}\`${finding.line === null ? '' : ` の ${finding.line} 行目`}: `;
      sections.push(`- ${location}${finding.body.trim().replaceAll('\n', '\n  ')}`);
    }
  }
  sections.push('', '---', `${reviewerName} によるレビューです ([ワークフロー](${runUrl}))`);

  return { event, body: sections.join('\n'), comments };
}

/**
 * @param {AsyncFunctionArguments} args
 * @returns {Promise<void>}
 */
export default async function publishReview({ github, context, core }) {
  core.setOutput('event', '');
  const repository = context.repo;
  const pullRequestNumber = Number.parseInt(process.env.PULL_REQUEST_NUMBER ?? '', 10);
  const targetSha = process.env.TARGET_SHA ?? '';
  const stage = process.env.STAGE ?? '';

  /** @type {ReviewResult} */
  let review;
  try {
    review = JSON.parse(await readFile(process.env.REVIEW_FILE ?? '', 'utf8'));
  } catch (error) {
    core.setFailed(`レビュー担当の出力を読み込めません: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const schema = JSON.parse(await readFile(join(process.env.GITHUB_WORKSPACE ?? process.cwd(), CONFIG_DIR, 'review-schema.json'), 'utf8'));
  const errors = validateWithSchema('レビュー担当の出力', schema, review);
  if (errors.length > 0) {
    core.setFailed(`レビュー担当の出力が形式に合いません:\n${errors.join('\n')}`);
    return;
  }

  // レビューしたコミットから head が進んでいれば、新しい push で起動したレビューに任せる
  const { data: pullRequest } = await github.rest.pulls.get({ ...repository, pull_number: pullRequestNumber });
  if (pullRequest.state !== 'open' || pullRequest.head.sha !== targetSha) {
    core.notice(`#${pullRequestNumber} はレビューした後に更新されたか Close されたため、レビューを投稿しません`);
    return;
  }

  const files = await listChangedFiles(github, repository, pullRequestNumber);
  const commentable = new Map(files.map((file) => [file.filename, commentableLines(file.patch)]));
  const submission = buildSubmission({
    review,
    commentable,
    stage,
    reviewerName: process.env.REVIEWER_NAME ?? 'レビュー担当',
    runUrl: process.env.RUN_URL ?? '',
  });

  await github.rest.pulls.createReview({
    ...repository,
    pull_number: pullRequestNumber,
    commit_id: targetSha,
    event: submission.event,
    body: submission.body,
    comments: submission.comments,
  });
  core.info(`#${pullRequestNumber} に ${submission.event} のレビューを投稿しました (行へのコメント ${submission.comments.length} 件)`);
  core.setOutput('event', submission.event);

  if (submission.event === 'APPROVE') {
    await enableAutoMerge({ github, core, pullRequestId: pullRequest.node_id, targetSha, pullRequestNumber });
  }
}

/**
 * 自動マージを有効にする。Merge Queue を必須にしたブランチでは、必要な条件がそろうと GitHub が Merge Queue に入れる。
 * レビューしたコミットから head が進んでいれば、GitHub が拒否する (expectedHeadOid)。
 *
 * @param {object} args
 * @param {AsyncFunctionArguments['github']} args.github
 * @param {AsyncFunctionArguments['core']} args.core
 * @param {string} args.pullRequestId
 * @param {string} args.targetSha
 * @param {number} args.pullRequestNumber
 */
async function enableAutoMerge({ github, core, pullRequestId, targetSha, pullRequestNumber }) {
  try {
    await github.graphql(
      `mutation ($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) {
          clientMutationId
        }
      }`,
      { pullRequestId, expectedHeadOid: targetSha },
    );
    core.info(`#${pullRequestNumber} の自動マージを有効にしました`);
    return;
  } catch (error) {
    // 必要な条件がすでにそろっている PR では、自動マージを有効にできないため、直接 Merge Queue に入れる
    if (!(error instanceof Error && /clean status/i.test(error.message))) {
      core.warning(`#${pullRequestNumber} の自動マージを有効にできませんでした: ${error instanceof Error ? error.message : error}`);
      return;
    }
  }
  try {
    await github.graphql(
      `mutation ($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
        enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) {
          clientMutationId
        }
      }`,
      { pullRequestId, expectedHeadOid: targetSha },
    );
    core.info(`#${pullRequestNumber} を Merge Queue に入れました`);
  } catch (error) {
    core.warning(`#${pullRequestNumber} を Merge Queue に入れられませんでした: ${error instanceof Error ? error.message : error}`);
  }
}
