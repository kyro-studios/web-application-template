/**
 * 修正の依頼: PR の今の head に修正が必要な理由があれば、PR を作ったエージェントに修正を依頼する。
 *
 * 修正が必要な理由は、次の 3 つ。今の head に対する理由をすべて集めて、1 回の修正でまとめて直させる (仕様の 9.1)。
 * - レビュー担当の差し戻し: その段階のレビュー担当の最新のレビューが、今の head に対する差し戻し (Request changes)
 * - コンフリクト: 既定ブランチとコンフリクトしている。修正では、既定ブランチの最新のコミットを取り込んで解消させる
 * - CI の失敗: 今の head の PR の CI が再実行しても失敗したか、Merge Queue の CI が失敗して外された (仕様の 9.2)。
 *   修正では、既定ブランチの最新のコミットを取り込み、失敗した CI のログを渡す
 *
 * レビュー担当のワークフローは差し戻しを投稿したら、コンフリクトの検知 (detect-conflicts.mjs) はコンフリクトを
 * 見つけたら、PR の番号を指定して振り分け用のワークフローを手動実行する。CI の失敗の検知 (detect-ci-failure.mjs) は、
 * PR の番号を指定して振り分けをやり直す。pull_request_review イベントを使わないのは、
 * そのイベントでは PR のブランチのワークフローとスクリプトが動き、PR の変更で振り分けの処理を書き換えられてしまうため。
 * 人が PR の番号を指定して手動実行しても、同じように処理する。
 *
 * 次のすべてを満たすときに、修正を依頼する。
 * - 仕組みで扱う PR (Draft でなく、needs-human ラベルが無いなど) で、その段階のレビュー担当以外の登録済みのエージェントが作った
 * - 修正が必要な理由があり、その理由 (レビュー、取り込む既定ブランチのコミット、または失敗した CI の実行) について、まだ修正を依頼していない
 *   (force を指定した手動実行では依頼し直す)
 *
 * 修正は、PR を作ったエージェントが、エージェントごとの修正のモデルと effort (agents.json の agents.<id>.fix) で行う。
 * エージェントが修正した回数が上限に達していたら、修正を依頼せずに、needs-human ラベルを付けて人に引き継ぐ。
 * コンフリクトの修正も、修正の回数に数える。
 */

import { fetchCriteriaFile, readAssignment } from '../acceptance-criteria.mjs';
import { isTrustedActor } from '../actors.mjs';
import { ciFailureReason, FAILURE_CONCLUSION, findMergeQueueFailure, latestPullRequestRun } from '../ci-runs.mjs';
import { findAgentByBot, fixExecution, getReviewer, isCoordinator } from '../config.mjs';
import { getMergeableState, listReviewsBy } from '../github-pulls.mjs';
import { AUTO_RERUN_ATTEMPTS } from './detect-ci-failure.mjs';
import { CONFLICTING_STATE, mergeableStateOptions } from './detect-conflicts.mjs';
import { NEEDS_HUMAN_LABEL, resolveStageContext, unhandledReason } from '../stage-context.mjs';
import { isHandOverRequested } from './hand-over.mjs';
import { IMPLEMENTATION_STAGE } from '../stages.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../route.mjs').HandlerArgs} HandlerArgs
 */

/** エージェントの App が修正を push したときに、PR のコメントに埋め込む印 */
export const FIX_MARKER = '<!-- coding-agent-fix -->';

/** CI の失敗で修正を依頼する段階 (コードを変える段階。仕様の 9.2) */
const CI_FIX_STAGES = new Set(['project', IMPLEMENTATION_STAGE]);

/** 修正の回数の上限の既定値 */
export const DEFAULT_MAX_FIX_ROUNDS = 3;

/**
 * レビューについて修正を依頼したときに、進行役の App が PR のコメントに埋め込む印を返す。
 *
 * @param {number} reviewId
 * @returns {string}
 */
export function fixRequestMarker(reviewId) {
  return `<!-- coding-agent-fix-request:${reviewId} -->`;
}

/**
 * 既定ブランチのコミットを取り込んでコンフリクトの解消を依頼したときに、進行役の App が PR のコメントに埋め込む印を返す。
 *
 * @param {string} baseSha 取り込む既定ブランチのコミット
 * @returns {string}
 */
export function conflictFixRequestMarker(baseSha) {
  return `<!-- coding-agent-conflict-fix-request:${baseSha} -->`;
}

/**
 * 失敗した CI の実行について修正を依頼したときに、進行役の App が PR のコメントに埋め込む印を返す。
 * 人が再実行して、また失敗したときにも依頼できるよう、実行の回数も含める。
 *
 * @param {number} runId
 * @param {number} attempt
 * @returns {string}
 */
export function ciFixRequestMarker(runId, attempt) {
  return `<!-- coding-agent-ci-fix-request:${runId}-${attempt} -->`;
}

/**
 * 修正の回数の上限を返す。Variables の REVIEW_MAX_FIX_ROUNDS が正しくなければ、既定値を使う。
 *
 * @param {string | undefined} value
 * @returns {number}
 */
export function maxFixRounds(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === value?.trim() ? parsed : DEFAULT_MAX_FIX_ROUNDS;
}

/**
 * エージェントが PR を修正した回数を数える。最後に needs-human ラベルが外された (人が解決した) 後の修正だけを数える。
 *
 * @param {HandlerArgs} args
 * @param {number} pullRequestNumber
 * @returns {Promise<number>}
 */
export async function countFixRounds({ github, context, config }, pullRequestNumber) {
  const repository = context.repo;
  /** @type {{ event: string, label?: { name: string }, created_at: string }[]} */
  const events = await github.paginate(github.rest.issues.listEvents, { ...repository, issue_number: pullRequestNumber, per_page: 100 });
  const resetAt = events
    .filter((event) => event.event === 'unlabeled' && event.label?.name === NEEDS_HUMAN_LABEL)
    .map((event) => event.created_at)
    .sort()
    .at(-1);

  /** @type {{ user: { login: string } | null, body?: string, created_at: string }[]} */
  const comments = await github.paginate(github.rest.issues.listComments, { ...repository, issue_number: pullRequestNumber, per_page: 100 });
  return comments.filter(
    (comment) =>
      findAgentByBot(config.agents, comment.user?.login) !== undefined &&
      comment.body?.includes(FIX_MARKER) &&
      (resetAt === undefined || comment.created_at > resetAt),
  ).length;
}

/** @type {Handler} */
export const requestFix = {
  name: '修正の依頼',
  events: ['workflow_dispatch'],
  // 人への引き継ぎを依頼する手動実行は、人への引き継ぎ (hand-over.mjs) だけが扱う
  matches: async ({ context }) => !isHandOverRequested(context),
  run: async (args) => {
    const { github, context, core, config } = args;
    const repository = context.repo;
    const number = Number.parseInt(String(context.payload.inputs?.['issue-number'] ?? ''), 10);
    const force = String(context.payload.inputs?.force) === 'true';
    if (!Number.isSafeInteger(number) || number <= 0) {
      return {};
    }
    // 指定された番号が PR でなければ、段階の起動で扱う
    const { data: issueOrPull } = await github.rest.issues.get({ ...repository, issue_number: number });
    if (issueOrPull.pull_request === undefined || issueOrPull.pull_request === null) {
      return {};
    }
    if (!(await isTrustedActor(args))) {
      core.notice(`${context.actor} は書き込み権限を持たないため、#${number} の修正を依頼しません`);
      return {};
    }

    const { data: pullRequest } = await github.rest.pulls.get({ ...repository, pull_number: number });
    const unhandled = unhandledReason(pullRequest, context.payload.repository?.default_branch);
    if (unhandled !== undefined) {
      core.info(`#${number} の修正は依頼しません: ${unhandled}`);
      return {};
    }
    const author = findAgentByBot(config.agents, pullRequest.user?.login);
    if (author === undefined) {
      core.info(`#${number} は登録済みのエージェントが作った PR ではないため、修正を依頼しません (人が作った PR は、作った人が直します)`);
      return {};
    }

    // レビュー担当は段階ごとに決まるため、PR が Close する段階の Issue から割り出す
    const resolved = await resolveStageContext({ github, repository, config, pullRequestNumber: number });
    if ('reason' in resolved) {
      core.info(`#${number} の修正は依頼しません: ${resolved.reason}`);
      return {};
    }
    const { issue, stage, feature, featureDir, artifact, sharedArtifacts, documents, allowedFiles } = resolved.context;
    const { agent: reviewer } = getReviewer(config.agents, stage);
    if (author.id === reviewer.id) {
      core.info(`#${number} は「${stage}」のレビュー担当が作った PR のため、修正を依頼しません`);
      return {};
    }

    /** @type {{ user: { login: string } | null, body?: string }[]} */
    const comments = await github.paginate(github.rest.issues.listComments, { ...repository, issue_number: number, per_page: 100 });
    /** @param {string} marker */
    const requested = (marker) => !force && comments.some((comment) => isCoordinator(config.agents, comment.user?.login) && comment.body?.includes(marker));

    // 理由 1: レビュー担当の最新のレビューが、今の head に対する差し戻し (差し戻しの後に更新されていれば、新しいコミットのレビューを待つ)
    const latest = (await listReviewsBy(github, repository, number, reviewer.bot)).at(-1);
    const review = latest !== undefined && latest.state === 'CHANGES_REQUESTED' && latest.commitId === pullRequest.head.sha ? latest : undefined;
    if (review !== undefined && requested(fixRequestMarker(review.id))) {
      core.notice(`#${number} のこのレビューについては、修正を依頼済みです (依頼し直す場合は、force を有効にして手動実行してください)`);
    }
    const reviewToFix = review !== undefined && !requested(fixRequestMarker(review.id)) ? review : undefined;

    const defaultBranch = /** @type {string} */ (context.payload.repository?.default_branch);
    /** @type {string | undefined} */
    let defaultBranchSha;
    // 取り込む既定ブランチのコミット (コンフリクトと CI の失敗の修正で使う)。どちらの理由でも同じコミットにする
    const getDefaultBranchSha = async () => {
      if (defaultBranchSha === undefined) {
        const { data: branch } = await github.rest.repos.getBranch({ ...repository, branch: defaultBranch });
        defaultBranchSha = /** @type {string} */ (branch.commit.sha);
      }
      return defaultBranchSha;
    };

    // 理由 2: 既定ブランチとのコンフリクト。取り込む既定ブランチのコミットごとに、一度だけ依頼する
    /** @type {{ baseSha: string } | undefined} */
    let conflict;
    if ((await getMergeableState(github, repository, number, mergeableStateOptions)) === CONFLICTING_STATE) {
      const baseSha = await getDefaultBranchSha();
      if (requested(conflictFixRequestMarker(baseSha))) {
        core.notice(`#${number} は、${defaultBranch} のこのコミットとのコンフリクトの解消を依頼済みです (依頼し直す場合は、force を有効にして手動実行してください)`);
      } else {
        conflict = { baseSha };
      }
    }

    // 理由 3: 今の head の CI の失敗 (仕様の 9.2)。失敗した CI の実行ごとに、一度だけ依頼する。
    // PR の CI は、自動の再実行でも失敗したものだけを扱う。Merge Queue の CI は、今の head が Approve されてから
    // Merge Queue に入り、CI の失敗で外されたものだけを扱う。
    // 文書の段階の PR は、テストの対象のコードを変えないため、CI が失敗しても原因は PR の外にあり、エージェントには直せない
    const pullRequestRun = CI_FIX_STAGES.has(stage) ? await latestPullRequestRun(github, repository, pullRequest) : undefined;
    const failedRun = !CI_FIX_STAGES.has(stage)
      ? undefined
      : pullRequestRun !== undefined && pullRequestRun.conclusion === FAILURE_CONCLUSION && pullRequestRun.attempt > AUTO_RERUN_ATTEMPTS
        ? pullRequestRun
        : latest !== undefined && latest.state === 'APPROVED' && latest.commitId === pullRequest.head.sha
          ? await findMergeQueueFailure(github, repository, { pullRequestNumber: number, approvedAt: latest.submittedAt, defaultBranch })
          : undefined;
    /** @type {{ event: string, runId: number, runAttempt: number, runUrl: string, baseSha: string } | undefined} */
    let ciFailure;
    if (failedRun !== undefined && requested(ciFixRequestMarker(failedRun.id, failedRun.attempt))) {
      core.notice(`#${number} は、この CI の失敗について修正を依頼済みです (依頼し直す場合は、force を有効にして手動実行してください)`);
    } else if (failedRun !== undefined) {
      ciFailure = { event: failedRun.event, runId: failedRun.id, runAttempt: failedRun.attempt, runUrl: failedRun.url, baseSha: await getDefaultBranchSha() };
    }

    if (reviewToFix === undefined && conflict === undefined && ciFailure === undefined) {
      core.info(`#${number} は、今の head に対して修正が必要な理由が無いため、修正を依頼しません (差し戻しも、コンフリクトも、CI の失敗も無いか、依頼済みです)`);
      return {};
    }

    // 修正の回数が上限に達していたら、人に引き継ぐ
    const rounds = await countFixRounds(args, number);
    const max = maxFixRounds(process.env.REVIEW_MAX_FIX_ROUNDS);
    if (rounds >= max) {
      const owner = feature.user?.login;
      await github.rest.issues.addLabels({ ...repository, issue_number: number, labels: [NEEDS_HUMAN_LABEL] });
      if (owner !== undefined) {
        await github.rest.issues.addAssignees({ ...repository, issue_number: number, assignees: [owner] });
      }
      await github.rest.issues.createComment({
        ...repository,
        issue_number: number,
        body: [
          `🤖 ${author.name} による修正が上限の ${max} 回に達したため、自動の修正を止めて人に引き継ぎます。`,
          '',
          `${owner === undefined ? '' : `@${owner} `}レビューの指摘、コンフリクト、CI の失敗を確認して対応してください。対応が終わったら \`${NEEDS_HUMAN_LABEL}\` ラベルを外してください。外すと、改めてレビューし、修正の回数を数え直します。`,
        ].join('\n'),
      });
      core.notice(`#${number} の修正の回数が上限 (${max} 回) に達したため、人に引き継ぎました`);
      return {};
    }

    // 実装タスクの修正でも、テストの機械的な実行で受け入れ基準を確かめるため、割り当てた識別子を読む (仕様の 10.5)
    /** @type {string[] | null} */
    let acceptanceCriteria = null;
    if (stage === IMPLEMENTATION_STAGE) {
      const criteria = await fetchCriteriaFile({ github, repository, ref: pullRequest.head.sha, featureDir, feature: feature.number });
      const assignment = 'errors' in criteria ? { reason: '受け入れ基準のファイルが形式を満たしていません' } : criteria.file === null ? { ids: null } : readAssignment(issue.body, criteria.file);
      if ('reason' in assignment) {
        await github.rest.issues.createComment({
          ...repository,
          issue_number: number,
          body: `🤖 修正を依頼できませんでした。#${issue.number} の${assignment.reason}。\n\n直したら、振り分け用のワークフローを、この PR の番号を指定して手動実行してください。`,
        });
        core.warning(`#${number} は、受け入れ基準に問題があるため修正を依頼しません`);
        return {};
      }
      acceptanceCriteria = assignment.ids;
    }

    const reasons = [
      ...(reviewToFix === undefined ? [] : ['レビューの指摘']),
      ...(conflict === undefined ? [] : ['既定ブランチとのコンフリクト']),
      ...(ciFailure === undefined ? [] : [ciFailureReason(ciFailure.event)]),
    ];
    const markers = [
      ...(reviewToFix === undefined ? [] : [fixRequestMarker(reviewToFix.id)]),
      ...(conflict === undefined ? [] : [conflictFixRequestMarker(conflict.baseSha)]),
      ...(ciFailure === undefined ? [] : [ciFixRequestMarker(ciFailure.runId, ciFailure.runAttempt)]),
    ];
    await github.rest.issues.createComment({
      ...repository,
      issue_number: number,
      body: `🤖 ${author.name} に、修正を依頼しました (理由: ${reasons.join('、')}。${rounds + 1} 回目 / 上限 ${max} 回)。\n\n${markers.join('\n')}`,
    });
    core.info(`#${number} の修正を ${author.name} に依頼します (${rounds + 1} 回目)`);

    return {
      requests: [
        {
          id: `fix-pr-${number}-${pullRequest.head.sha.slice(0, 7)}`,
          agent: author.id,
          mode: 'fix',
          stage,
          issueNumber: issue.number,
          pullRequestNumber: number,
          targetSha: pullRequest.head.sha,
          execution: fixExecution(author),
          materials: {
            pullRequest: { number, title: pullRequest.title, body: pullRequest.body ?? '', headRef: pullRequest.head.ref },
            issue: { number: issue.number, title: issue.title, body: issue.body ?? '' },
            feature: { number: feature.number, title: feature.title, body: feature.body ?? '' },
            featureDir,
            artifact,
            sharedArtifacts,
            documents,
            allowedFiles,
            // 受け入れ基準の識別子 (実装タスクで、受け入れ基準のファイルがある機能のみ。それ以外は null)
            acceptanceCriteria,
            review: reviewToFix === undefined ? null : { id: reviewToFix.id, body: reviewToFix.body, comments: reviewToFix.comments },
            conflict: conflict ?? null,
            ciFailure: ciFailure ?? null,
            fixRound: rounds + 1,
            maxFixRounds: max,
          },
        },
      ],
    };
  },
};
