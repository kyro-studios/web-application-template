/**
 * 振り分け用のワークフローが決めた結果に沿って、ワークフローを手動実行 (workflow_dispatch) する。
 *
 * - 依頼ごとに、担当エージェントのワークフローを手動実行する
 * - 振り分けをやり直す Issue ごとに、振り分け用のワークフローを手動実行する
 *
 * GITHUB_TOKEN が起こしたイベントでは原則としてワークフローが起動しないが、
 * workflow_dispatch は例外として起動する。
 *
 * 環境変数:
 * - DISPATCHES: エージェントのワークフローの呼び出し方 (AgentDispatch) の JSON 配列
 * - REDISPATCH_ISSUES: 振り分けをやり直す Issue の番号の JSON 配列
 */

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 */

/** 振り分け用のワークフローのファイル名 */
export const ROUTER_WORKFLOW = 'coding-agent-router.yml';

/**
 * @param {AsyncFunctionArguments} args
 * @returns {Promise<void>}
 */
export default async function dispatchAgents({ github, context, core }) {
  /** @type {import('./agent-request.mjs').AgentDispatch[]} */
  const dispatches = JSON.parse(process.env.DISPATCHES || '[]');
  /** @type {number[]} */
  const redispatchIssues = JSON.parse(process.env.REDISPATCH_ISSUES || '[]');
  /** @type {string | undefined} */
  const ref = context.payload.repository?.default_branch;
  if (ref === undefined) {
    core.setFailed('イベントからデフォルトブランチを特定できません');
    return;
  }

  for (const dispatch of dispatches) {
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: dispatch.workflow,
      ref,
      inputs: dispatch.inputs,
    });
    core.info(`依頼 ${dispatch.requestId} のため、${dispatch.agent} の ${dispatch.workflow} を起動しました`);
  }

  for (const issueNumber of redispatchIssues) {
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: ROUTER_WORKFLOW,
      ref,
      // 自動でやり直す場合は、二重起動の防止を有効なままにする
      inputs: { 'issue-number': String(issueNumber), force: 'false' },
    });
    core.info(`#${issueNumber} の振り分けをやり直すため、${ROUTER_WORKFLOW} を起動しました`);
  }
}
