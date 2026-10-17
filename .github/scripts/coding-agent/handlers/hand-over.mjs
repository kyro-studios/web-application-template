/**
 * 人への引き継ぎ: エージェントのワークフローから、人に引き継ぐよう依頼されたら、Issue か PR に needs-human ラベルを付け、
 * 機能の親 Issue の作成者を Assign して、理由をコメントする (仕様の 6.4)。
 *
 * エージェントのワークフローは、進行役の App の秘密鍵を持たないため、振り分け用のワークフローを、
 * 引き継ぐ理由 (hand-over) を指定して手動実行する。理由が指定された手動実行は、このハンドラーだけが扱う
 * (段階の起動と修正の依頼は扱わない)。
 *
 * 引き継ぐ理由:
 * - test-failure: テストの機械的な実行で、決めた回数まで直させても失敗した。作成のときは段階の Issue に、
 *   修正のときは PR に引き継ぐ (変更は取り込まれていない)
 */

import { isTrustedActor } from '../actors.mjs';
import { findAgentByBot, isCoordinator } from '../config.mjs';
import { findLabeledAncestor } from '../github-issues.mjs';
import { NEEDS_HUMAN_LABEL, resolveStageContext } from '../stage-context.mjs';
import { FEATURE_LABEL, stageOf } from '../stages.mjs';

/**
 * @typedef {import('../route.mjs').Handler} Handler
 * @typedef {import('../route.mjs').HandlerArgs} HandlerArgs
 */

/** 引き継ぐ理由ごとの説明 */
export const HAND_OVER_REASONS = {
  'test-failure': 'テストの機械的な実行で、決めた回数まで直させてもテストが通りませんでした。変更は取り込んでいません。',
};

/**
 * 振り分け用のワークフローの手動実行で、引き継ぐ理由が指定されているか。
 *
 * @param {HandlerArgs['context']} context
 * @returns {boolean}
 */
export function isHandOverRequested(context) {
  return context.eventName === 'workflow_dispatch' && String(context.payload.inputs?.['hand-over'] ?? '').trim() !== '';
}

/** @type {Handler} */
export const handOver = {
  name: '人への引き継ぎ',
  events: ['workflow_dispatch'],
  matches: async ({ context }) => isHandOverRequested(context),
  run: async (args) => {
    const { github, context, core, config } = args;
    const repository = context.repo;
    const inputs = context.payload.inputs ?? {};
    const reason = String(inputs['hand-over']);
    const number = Number.parseInt(String(inputs['issue-number'] ?? ''), 10);
    const sourceRunId = String(inputs['source-run-id'] ?? '');
    if (!Object.hasOwn(HAND_OVER_REASONS, reason)) {
      core.setFailed(`引き継ぐ理由が正しくありません: ${reason}`);
      return {};
    }
    if (!Number.isSafeInteger(number) || number <= 0) {
      core.setFailed(`Issue か PR の番号が正しくありません: ${inputs['issue-number']}`);
      return {};
    }
    if (sourceRunId !== '' && !/^\d+$/.test(sourceRunId)) {
      core.setFailed(`ワークフローの実行の ID が正しくありません: ${sourceRunId}`);
      return {};
    }
    if (!(await isTrustedActor(args))) {
      core.notice(`${context.actor} は書き込み権限を持たないため、#${number} を人に引き継ぎません`);
      return {};
    }

    // 引き継ぐのは、仕組みで扱う Issue か PR に限る (段階の Issue か、登録済みのエージェントが作った PR)
    const { data: issueOrPull } = await github.rest.issues.get({ ...repository, issue_number: number });
    /** @type {string | undefined} */
    let owner;
    if (issueOrPull.pull_request === undefined || issueOrPull.pull_request === null) {
      if (!isCoordinator(config.agents, issueOrPull.user?.login) || stageOf(issueOrPull.labels) === undefined) {
        core.info(`#${number} は段階の Issue ではないため、人に引き継ぎません`);
        return {};
      }
      owner = (await findLabeledAncestor(github, repository, number, FEATURE_LABEL))?.user?.login;
    } else {
      if (findAgentByBot(config.agents, issueOrPull.user?.login) === undefined) {
        core.info(`#${number} は登録済みのエージェントが作った PR ではないため、人に引き継ぎません`);
        return {};
      }
      const resolved = await resolveStageContext({ github, repository, config, pullRequestNumber: number });
      owner = 'context' in resolved ? resolved.context.feature.user?.login : undefined;
    }

    await github.rest.issues.addLabels({ ...repository, issue_number: number, labels: [NEEDS_HUMAN_LABEL] });
    if (owner !== undefined) {
      await github.rest.issues.addAssignees({ ...repository, issue_number: number, assignees: [owner] });
    }
    const runUrl = sourceRunId === '' ? '' : `${context.serverUrl ?? 'https://github.com'}/${repository.owner}/${repository.repo}/actions/runs/${sourceRunId}`;
    const resume =
      issueOrPull.pull_request === undefined || issueOrPull.pull_request === null
        ? `原因 (テストの誤り、前の段階の成果物の誤りなど) を直したら、\`${NEEDS_HUMAN_LABEL}\` ラベルを外し、振り分け用のワークフローを、この Issue の番号と \`force\` を指定して手動実行してください。`
        : `原因を直したら、\`${NEEDS_HUMAN_LABEL}\` ラベルを外してください。外すと、改めてレビューします。`;
    await github.rest.issues.createComment({
      ...repository,
      issue_number: number,
      body: [
        `🤖 ${HAND_OVER_REASONS[/** @type {keyof typeof HAND_OVER_REASONS} */ (reason)]}自動の作業を止めて、人に引き継ぎます。`,
        '',
        ...(runUrl === '' ? [] : [`失敗したログは、[ワークフロー](${runUrl}) で確かめられます。`, '']),
        `${owner === undefined ? '' : `@${owner} `}${resume}`,
      ].join('\n'),
    });
    core.notice(`#${number} を人に引き継ぎました (${reason})`);
    return {};
  },
};
