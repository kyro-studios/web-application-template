/**
 * 振り分け用のワークフローが決めた依頼ごとに、担当エージェントのワークフローを手動実行 (workflow_dispatch) する。
 *
 * GITHUB_TOKEN が起こしたイベントでは原則としてワークフローが起動しないが、
 * workflow_dispatch は例外として起動する。
 *
 * 環境変数:
 * - DISPATCHES: エージェントのワークフローの呼び出し方 (AgentDispatch) の JSON 配列
 */

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 */

/**
 * @param {AsyncFunctionArguments} args
 * @returns {Promise<void>}
 */
export default async function dispatchAgents({ github, context, core }) {
  /** @type {import('./agent-request.mjs').AgentDispatch[]} */
  const dispatches = JSON.parse(process.env.DISPATCHES ?? '[]');
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
}
