/**
 * 起動条件を満たした Issue ごとに、呼び出し元のワークフローを手動実行 (workflow_dispatch) し直す。
 * 1 回の Close で複数の Issue が起動条件を満たすことがあるため、Issue ごとに別の実行に分ける。
 *
 * GITHUB_TOKEN が起こしたイベントでは原則としてワークフローが起動しないが、
 * workflow_dispatch は例外として起動する。
 *
 * 環境変数:
 * - WORKFLOW_FILE: 手動実行するワークフローのファイル名
 * - ISSUE_NUMBERS: 対象の Issue 番号の JSON 配列
 */

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 */

/**
 * @param {AsyncFunctionArguments} args
 * @returns {Promise<void>}
 */
export default async function dispatchIssues({ github, context, core }) {
  const workflowFile = process.env.WORKFLOW_FILE ?? '';
  /** @type {number[]} */
  const issueNumbers = JSON.parse(process.env.ISSUE_NUMBERS ?? '[]');
  /** @type {string | undefined} */
  const ref = context.payload.repository?.default_branch;
  if (ref === undefined) {
    core.setFailed('イベントからデフォルトブランチを特定できません');
    return;
  }

  for (const issueNumber of issueNumbers) {
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: workflowFile,
      ref,
      // 自動で起動し直す場合は、二重起動の防止を有効なままにする
      inputs: { 'issue-number': String(issueNumber), force: 'false' },
    });
    core.info(`Issue #${issueNumber} に対して ${workflowFile} を起動しました`);
  }
}
