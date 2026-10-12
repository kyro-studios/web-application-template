/**
 * 修正の依頼: レビュー担当が差し戻した PR の修正を、PR を作ったエージェントに依頼する。
 *
 * レビュー担当のワークフローは、差し戻しを投稿したら、PR の番号を指定して振り分け用のワークフローを手動実行する。
 * pull_request_review イベントを使わないのは、そのイベントでは PR のブランチのワークフローとスクリプトが動き、
 * PR の変更で振り分けの処理を書き換えられてしまうため。人が PR の番号を指定して手動実行しても、同じように処理する。
 *
 * 次のすべてを満たすときに、修正を依頼する。
 * - 仕組みで扱う PR (Draft でなく、needs-human ラベルが無いなど) で、その段階のレビュー担当以外の登録済みのエージェントが作った
 * - レビュー担当の最新のレビューが差し戻し (Request changes) で、今の head に対するもの
 * - そのレビューについて、まだ修正を依頼していない (force を指定した手動実行では依頼し直す)
 *
 * 修正は、PR を作ったエージェントが、エージェントごとの修正のモデルと effort (agents.json の agents.<id>.fix) で行う。
 * エージェントが修正した回数が上限に達していたら、修正を依頼せずに、needs-human ラベルを付けて人に引き継ぐ。
 */

import { isTrustedActor } from '../actors.mjs';
import { findAgentByBot, fixExecution, getReviewer, isCoordinator } from '../config.mjs';
import { listReviewsBy } from '../github-pulls.mjs';
import { NEEDS_HUMAN_LABEL, resolveStageContext, unhandledReason } from '../stage-context.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../route.mjs').HandlerArgs} HandlerArgs
 */

/** エージェントの App が修正を push したときに、PR のコメントに埋め込む印 */
export const FIX_MARKER = '<!-- coding-agent-fix -->';

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
    const { issue, stage, feature, featureDir, artifact, documents, allowedFiles } = resolved.context;
    const { agent: reviewer } = getReviewer(config.agents, stage);
    if (author.id === reviewer.id) {
      core.info(`#${number} は「${stage}」のレビュー担当が作った PR のため、修正を依頼しません`);
      return {};
    }

    // レビュー担当の最新のレビューが、今の head に対する差し戻しのときだけ修正する
    const latest = (await listReviewsBy(github, repository, number, reviewer.bot)).at(-1);
    if (latest === undefined || latest.state !== 'CHANGES_REQUESTED') {
      core.info(`#${number} はレビュー担当に差し戻されていないため、修正を依頼しません`);
      return {};
    }
    if (latest.commitId !== pullRequest.head.sha) {
      core.info(`#${number} は差し戻しの後に更新されているため、修正を依頼しません (新しいコミットのレビューを待ちます)`);
      return {};
    }

    /** @type {{ user: { login: string } | null, body?: string }[]} */
    const comments = await github.paginate(github.rest.issues.listComments, { ...repository, issue_number: number, per_page: 100 });
    const marker = fixRequestMarker(latest.id);
    if (!force && comments.some((comment) => isCoordinator(config.agents, comment.user?.login) && comment.body?.includes(marker))) {
      core.notice(`#${number} のこのレビューについては、修正を依頼済みです (依頼し直す場合は、force を有効にして手動実行してください)`);
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
          `${owner === undefined ? '' : `@${owner} `}レビューの指摘を確認して対応してください。対応が終わったら \`${NEEDS_HUMAN_LABEL}\` ラベルを外してください。外すと、改めてレビューし、修正の回数を数え直します。`,
        ].join('\n'),
      });
      core.notice(`#${number} の修正の回数が上限 (${max} 回) に達したため、人に引き継ぎました`);
      return {};
    }

    await github.rest.issues.createComment({
      ...repository,
      issue_number: number,
      body: `🤖 ${author.name} に、レビューの指摘の修正を依頼しました (${rounds + 1} 回目 / 上限 ${max} 回)。\n\n${marker}`,
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
            documents,
            allowedFiles,
            review: { id: latest.id, body: latest.body, comments: latest.comments },
            fixRound: rounds + 1,
            maxFixRounds: max,
          },
        },
      ],
    };
  },
};
