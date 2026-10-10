/**
 * 振り分け用のワークフローの入口。イベントを受けて、どのエージェントに何を依頼するかを決める。
 *
 * イベントごとの処理 (ハンドラー) は、エージェントへの依頼の一覧を返す。依頼の全体は REQUEST_DIR に保存して
 * Artifact としてアップロードし、エージェントのワークフローの呼び出し方を dispatches として出力する。
 * 実際の呼び出しは、actions: write の権限を持つ別のジョブ (dispatch-agents.mjs) が行う。
 *
 * 環境変数:
 * - GITHUB_WORKSPACE: リポジトリのルート (設定ファイルの読み込みに使う)
 * - REQUEST_DIR: 依頼を保存するディレクトリ
 *
 * 出力:
 * - dispatches: エージェントのワークフローの呼び出し方 (AgentDispatch) の JSON 配列
 */

import { toDispatch, validateRequest, writeRequest } from './agent-request.mjs';
import { ConfigError, getAgent, loadConfig } from './config.mjs';

/**
 * actions/github-script がスクリプトに渡す引数
 * @typedef {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 */

/**
 * @typedef {object} HandlerArgs
 * @property {AsyncFunctionArguments['github']} github
 * @property {AsyncFunctionArguments['context']} context
 * @property {AsyncFunctionArguments['core']} core
 * @property {import('./config.mjs').CodingAgentConfig} config
 */

/**
 * イベントごとの処理。エージェントへの依頼の一覧を返す
 * @typedef {(args: HandlerArgs) => Promise<import('./agent-request.mjs').AgentRequest[]>} Handler
 */

/**
 * イベントごとの処理。キーは `<イベント名>.<アクション>` (アクションの無いイベントはイベント名だけ)。
 * 機能の開始やレビューなどの処理は、作る順番に沿って追加していく。
 * @type {Readonly<Record<string, Handler>>}
 */
export const HANDLERS = {};

/**
 * イベントから、ハンドラーを探すためのキーを作る。
 *
 * @param {Pick<AsyncFunctionArguments['context'], 'eventName' | 'payload'>} context
 * @returns {string}
 */
export function eventKey(context) {
  const action = context.payload.action;
  return typeof action === 'string' && action !== '' ? `${context.eventName}.${action}` : context.eventName;
}

/**
 * ハンドラーの一覧から、振り分けの処理を作る。
 *
 * @param {Readonly<Record<string, Handler>>} handlers
 * @returns {(args: AsyncFunctionArguments) => Promise<void>}
 */
export function createRouter(handlers) {
  return async function route({ github, context, core }) {
    core.setOutput('dispatches', '[]');

    const key = eventKey(context);
    const handler = Object.hasOwn(handlers, key) ? handlers[key] : undefined;
    if (handler === undefined) {
      core.info(`${key} は振り分けの対象外です`);
      return;
    }

    /** @type {import('./config.mjs').CodingAgentConfig} */
    let config;
    try {
      config = await loadConfig(process.env.GITHUB_WORKSPACE ?? process.cwd());
    } catch (error) {
      if (error instanceof ConfigError) {
        core.setFailed(error.message);
        return;
      }
      throw error;
    }

    const requests = await handler({ github, context, core, config });

    // 1 件でも問題があれば、どのエージェントも呼び出さない
    /** @type {string[]} */
    const errors = [];
    const requestIds = new Set();
    for (const request of requests) {
      errors.push(...validateRequest(request).map((error) => `${request.id}: ${error}`));
      if (requestIds.has(request.id)) {
        errors.push(`${request.id}: 依頼の識別子が重複しています`);
      }
      requestIds.add(request.id);
      if (!Object.hasOwn(config.agents.agents, request.agent)) {
        errors.push(`${request.id}: エージェント "${request.agent}" は登録されていません`);
      }
    }
    if (errors.length > 0) {
      core.setFailed(`エージェントへの依頼に問題があります:\n${errors.map((error) => `- ${error}`).join('\n')}`);
      return;
    }
    if (requests.length === 0) {
      core.info(`${key} では、エージェントに依頼することはありません`);
      return;
    }

    const requestDir = process.env.REQUEST_DIR;
    if (!requestDir) {
      core.setFailed('環境変数 REQUEST_DIR を設定してください');
      return;
    }

    const dispatches = [];
    for (const request of requests) {
      await writeRequest(requestDir, request);
      dispatches.push(toDispatch(request, getAgent(config.agents, request.agent).workflow, String(context.runId)));
      core.info(`${request.agent} に依頼します: ${request.mode} ${request.stage} (Issue #${request.issueNumber})`);
    }
    core.setOutput('dispatches', JSON.stringify(dispatches));
  };
}

export default createRouter(HANDLERS);
