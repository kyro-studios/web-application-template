/**
 * レビューの依頼: 段階の Issue を Close する PR が作られたり更新されたりしたら、レビュー担当にレビューを依頼する。
 *
 * PR のイベントは pull_request_target で受け、振り分けの処理は既定ブランチのものを使う。PR のコードは実行しない。
 *
 * 次の順に確認し、1 つでも満たさなければ何もしない。
 * 1. Draft でなく、needs-human ラベルが付いておらず、既定ブランチに向けた、このリポジトリのブランチからの PR である
 * 2. PR の作成者が、書き込み権限を持つ人か、登録済みのエージェント (レビュー担当を除く) の GitHub App である
 * 3. PR が Close する Issue がちょうど 1 件で、それが進行役の App の作った段階の Issue である
 *
 * 変更されたファイルが段階ごとに決めた範囲に収まっていなければ、範囲外のファイルを依頼に含める。
 * レビュー担当のワークフローは、範囲外のファイルがあればレビュー担当を呼ばずに差し戻す。
 */

import { expandStageFiles, featureDirectory, findAgentByBot, getAgent, isCoordinator, isValidFeatureName } from '../config.mjs';
import { findViolations } from '../changed-files.mjs';
import { findLabeledAncestor, hasLabel, hasWritePermission } from '../github-issues.mjs';
import { getClosingIssueNumbers, listChangedFiles, listReviewsBy } from '../github-pulls.mjs';
import { FEATURE_NAME_FIELD, parseIssueForm } from '../issue-form.mjs';
import { artifactPath, FEATURE_LABEL, reviewDocuments, stageOf } from '../stages.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../github-issues.mjs').RestIssue} RestIssue
 */

/** 人の対応が必要なことを表すラベル。付いている間はレビューしない */
export const NEEDS_HUMAN_LABEL = 'needs-human';

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
    if (pullRequest === undefined || pullRequest.state !== 'open' || pullRequest.draft) {
      return false;
    }
    // フォークからの PR は対象にしない (Secrets を使うワークフローを、外部の変更に対して動かさないため)
    if (pullRequest.head.repo?.full_name !== pullRequest.base.repo.full_name) {
      return false;
    }
    if (pullRequest.base.ref !== context.payload.repository?.default_branch) {
      return false;
    }
    if (hasLabel(pullRequest.labels ?? [], NEEDS_HUMAN_LABEL)) {
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
    const reviewer = getAgent(config.agents, config.agents.roles.reviewer);

    // PR の作成者を確かめる
    const author = pullRequest.user?.login ?? '';
    const agent = findAgentByBot(config.agents, author);
    if (agent !== undefined) {
      if (agent.id === reviewer.id) {
        core.notice(`#${pullRequest.number} はレビュー担当 (${agent.name}) が作った PR のため、レビューしません`);
        return {};
      }
    } else if (pullRequest.user?.type === 'Bot' || !(await hasWritePermission(github, repository, author))) {
      core.notice(`#${pullRequest.number} の作成者 ${author} は、書き込み権限を持つ人か登録済みのエージェントではないため、レビューしません`);
      return {};
    }

    // PR が Close する段階の Issue を確かめる
    const closing = await getClosingIssueNumbers(github, repository, pullRequest.number);
    if (closing.length === 0) {
      core.info(`#${pullRequest.number} は Issue を Close しない PR のため、レビューしません`);
      return {};
    }
    if (closing.length > 1) {
      if (notify) {
        await github.rest.issues.createComment({
          ...repository,
          issue_number: pullRequest.number,
          body: `🤖 この PR は複数の Issue (${closing.map((number) => `#${number}`).join('、')}) を Close するため、レビューの対象にしていません。1 つの PR で Close する Issue は 1 つにしてください。`,
        });
      }
      core.notice(`#${pullRequest.number} は複数の Issue を Close するため、レビューしません`);
      return {};
    }
    const { data } = await github.rest.issues.get({ ...repository, issue_number: closing[0] });
    const issue = /** @type {RestIssue & { body?: string | null }} */ (data);
    const stage = stageOf(issue.labels);
    if (!isCoordinator(config.agents, issue.user?.login) || stage === undefined || stage === 'planning') {
      core.info(`#${pullRequest.number} が Close する #${issue.number} は段階の Issue ではないため、レビューしません`);
      return {};
    }

    // 機能ごとのディレクトリを、機能の親 Issue の機能名から決める
    const feature = await findLabeledAncestor(github, repository, issue.number, FEATURE_LABEL);
    const featureName = feature === undefined ? '' : (parseIssueForm(feature.body).get(FEATURE_NAME_FIELD) ?? '');
    if (feature === undefined || !isValidFeatureName(featureName)) {
      core.warning(`#${issue.number} の機能の親 Issue か、その機能名が見つからないため、レビューしません`);
      return {};
    }
    const featureDir = featureDirectory(config.stages, feature.number, featureName);
    const range = expandStageFiles(config.stages, /** @type {import('../config.mjs').ReviewedStage} */ (stage), featureDir);

    const files = await listChangedFiles(github, repository, pullRequest.number);
    const violations = findViolations(files, range);
    const previousReviews = await listReviewsBy(github, repository, pullRequest.number, reviewer.bot);

    /** @type {import('../agent-request.mjs').AgentRequest} */
    const request = {
      id: `review-pr-${pullRequest.number}-${pullRequest.head.sha.slice(0, 7)}`,
      agent: reviewer.id,
      mode: 'review',
      stage: /** @type {import('../agent-request.mjs').AgentStage} */ (stage),
      issueNumber: issue.number,
      pullRequestNumber: pullRequest.number,
      targetSha: pullRequest.head.sha,
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
        artifact: artifactPath(stage, featureDir),
        documents: reviewDocuments(stage, featureDir),
        allowedFiles: range,
        violations,
        previousReviews,
      },
    };
    core.info(`#${pullRequest.number} (${stage}) のレビューを ${reviewer.name} に依頼します`);
    return { requests: [request] };
  },
};
