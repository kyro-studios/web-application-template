/**
 * レビューの依頼: 段階の Issue を Close する PR が作られたり更新されたりしたら、レビュー担当にレビューを依頼する。
 *
 * PR のイベントは pull_request_target で受け、振り分けの処理は既定ブランチのものを使う。PR のコードは実行しない。
 *
 * 次の順に確認し、1 つでも満たさなければ何もしない。
 * 1. Draft でなく、needs-human ラベルが付いておらず、既定ブランチに向けた、このリポジトリのブランチからの PR である
 * 2. PR の作成者が、書き込み権限を持つ人か、登録済みのエージェントの GitHub App である
 * 3. PR が Close する Issue がちょうど 1 件で、それが進行役の App の作った段階の Issue である
 * 4. PR の作成者が、その段階のレビュー担当 (agents.json の roles.<段階>.reviewer) ではない
 *
 * 変更されたファイルが段階ごとに決めた範囲に収まっていなければ、範囲外のファイルを依頼に含める。
 * レビュー担当のワークフローは、範囲外のファイルがあればレビュー担当を呼ばずに差し戻す。
 */

import { findAgentByBot, getReviewer } from '../config.mjs';
import { findViolations } from '../changed-files.mjs';
import { hasWritePermission } from '../github-issues.mjs';
import { listChangedFiles, listReviewsBy } from '../github-pulls.mjs';
import { NEEDS_HUMAN_LABEL, resolveStageContext, unhandledReason } from '../stage-context.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../github-issues.mjs').RestIssue} RestIssue
 */

/** レビューを依頼する PR のイベント */
export const REVIEW_EVENTS = ['opened', 'reopened', 'ready_for_review', 'synchronize', 'unlabeled'].map(
  (action) => `pull_request_target.${action}`,
);

/** PR のイベントのうち、問題を PR にコメントで知らせるもの (push のたびに同じコメントを繰り返さないため) */
const NOTIFYING_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review']);

/** @type {Handler} */
export const requestReview = {
  name: 'レビューの依頼',
  events: REVIEW_EVENTS,
  matches: async ({ context }) => {
    const pullRequest = context.payload.pull_request;
    if (pullRequest === undefined || unhandledReason(pullRequest, context.payload.repository?.default_branch) !== undefined) {
      return false;
    }
    // ラベルが外されたときは、needs-human が外されたとき (人が解決したとき) だけレビューする
    if (context.payload.action === 'unlabeled') {
      return context.payload.label?.name === NEEDS_HUMAN_LABEL;
    }
    return true;
  },
  run: async ({ github, context, core, config }) => {
    const repository = context.repo;
    const pullRequest = context.payload.pull_request;
    const notify = NOTIFYING_ACTIONS.has(context.payload.action ?? '');

    // PR の作成者を確かめる
    const author = pullRequest.user?.login ?? '';
    const agent = findAgentByBot(config.agents, author);
    if (agent === undefined && (pullRequest.user?.type === 'Bot' || !(await hasWritePermission(github, repository, author)))) {
      core.notice(`#${pullRequest.number} の作成者 ${author} は、書き込み権限を持つ人か登録済みのエージェントではないため、レビューしません`);
      return {};
    }

    // PR が Close する段階の Issue を確かめる
    const resolved = await resolveStageContext({ github, repository, config, pullRequestNumber: pullRequest.number });
    if ('reason' in resolved) {
      if (resolved.closing.length > 1 && notify) {
        await github.rest.issues.createComment({
          ...repository,
          issue_number: pullRequest.number,
          body: `🤖 この PR は複数の Issue (${resolved.closing.map((number) => `#${number}`).join('、')}) を Close するため、レビューの対象にしていません。1 つの PR で Close する Issue は 1 つにしてください。`,
        });
      }
      core.info(`#${pullRequest.number} はレビューしません: ${resolved.reason}`);
      return {};
    }
    const { issue, stage, feature, featureDir, artifact, sharedArtifacts, documents, allowedFiles } = resolved.context;

    // レビュー担当は段階ごとに決まる。PR の作成者は自分の PR を Approve できないため、レビュー担当が作った PR はレビューしない
    const { agent: reviewer, execution } = getReviewer(config.agents, stage);
    if (agent?.id === reviewer.id) {
      core.notice(`#${pullRequest.number} は「${stage}」のレビュー担当 (${agent.name}) が作った PR のため、レビューしません`);
      return {};
    }

    const files = await listChangedFiles(github, repository, pullRequest.number);
    const violations = findViolations(files, allowedFiles);
    const previousReviews = await listReviewsBy(github, repository, pullRequest.number, reviewer.bot);

    /** @type {import('../agent-request.mjs').AgentRequest} */
    const request = {
      id: `review-pr-${pullRequest.number}-${pullRequest.head.sha.slice(0, 7)}`,
      agent: reviewer.id,
      mode: 'review',
      stage,
      issueNumber: issue.number,
      pullRequestNumber: pullRequest.number,
      targetSha: pullRequest.head.sha,
      execution,
      materials: {
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          body: pullRequest.body ?? '',
          author,
          baseSha: pullRequest.base.sha,
          headSha: pullRequest.head.sha,
        },
        issue: { number: issue.number, title: issue.title, body: issue.body ?? '' },
        feature: { number: feature.number, title: feature.title, body: feature.body ?? '' },
        featureDir,
        artifact,
        sharedArtifacts,
        documents,
        allowedFiles,
        violations,
        previousReviews,
      },
    };
    core.info(`#${pullRequest.number} (${stage}) のレビューを ${reviewer.name} に依頼します`);
    return { requests: [request] };
  },
};
