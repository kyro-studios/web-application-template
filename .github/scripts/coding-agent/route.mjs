/**
 * 振り分け用のワークフローの入口。イベントを受けて、どのエージェントに何を依頼するかを決める。
 *
 * 振り分けは 2 つの段階で行う。
 * 1. match: 読み取り専用の GITHUB_TOKEN で、イベントを処理するハンドラーがあるか判定し、
 *    あれば進行役の GitHub App の Client ID を出力する。ハンドラーが無ければ、App のトークンを発行せずに終われる
 * 2. route: 進行役の GitHub App のトークンで、ハンドラーを実行する。ハンドラーは、Issue の作成などを行い、
 *    エージェントへの依頼と、振り分けをやり直す Issue の一覧を返す
 *
 * 依頼の全体は REQUEST_DIR に保存して Artifact としてアップロードし、エージェントのワークフローの呼び出し方を
 * dispatches として出力する。実際の呼び出しは、actions: write の権限を持つ別のジョブ (dispatch-agents.mjs) が行う。
 *
 * 仕組みの停止中 (halt.mjs) は、停止中も動かすハンドラー (PR を通らない変更の検知) だけを実行する。
 * ほかのハンドラーは実行せず、処理しなかったことを停止中の Issue にコメントで残す。
 *
 * 1 つのイベントで複数の Issue を処理する必要がある場合 (Close された Issue を待っていた Issue の起動など) は、
 * Issue ごとに振り分け用のワークフローを手動実行し直す。同じ Issue の処理を、Issue ごとの concurrency で 1 つずつに絞るため。
 *
 * 環境変数:
 * - GITHUB_WORKSPACE: リポジトリのルート (設定ファイルの読み込みに使う)
 * - REQUEST_DIR: 依頼を保存するディレクトリ (route のみ)
 *
 * 出力 (match):
 * - handled: 処理するハンドラーがあれば 'true'
 * - coordinator-client-id: 進行役の GitHub App の Client ID (秘密鍵は、ワークフローが Secrets から固定の名前で読む)
 *
 * 出力 (route):
 * - dispatches: エージェントのワークフローの呼び出し方 (AgentDispatch) の JSON 配列
 * - redispatch-issues: 振り分けをやり直す Issue の番号の JSON 配列
 */

import { toDispatch, validateRequest, writeRequest } from './agent-request.mjs';
import { ConfigError, getAgent, loadConfig } from './config.mjs';
import { closeParent } from './handlers/close-parent.mjs';
import { findHaltIssue } from './halt.mjs';
import { detectConflicts } from './handlers/detect-conflicts.mjs';
import { detectUntrackedChanges } from './handlers/detect-untracked-changes.mjs';
import { launchStage, wakeWaitingStages } from './handlers/launch-stage.mjs';
import { requestFix } from './handlers/request-fix.mjs';
import { requestReview } from './handlers/request-review.mjs';
import { startFeature } from './handlers/start-feature.mjs';

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
 * イベントごとの処理
 * @typedef {object} Handler
 * @property {string} name ログに表示する名前
 * @property {string[]} events 処理するイベント (`<イベント名>.<アクション>`。アクションの無いイベントはイベント名だけ)
 * @property {(args: HandlerArgs) => Promise<boolean>} [matches] イベントを処理するか判定する (読み取り専用のトークンで呼ばれる)。省略すると常に処理する
 * @property {(args: HandlerArgs) => Promise<HandlerResult>} run 処理を行い、結果を返す (進行役の GitHub App のトークンで呼ばれる)
 * @property {boolean} [runsWhileHalted] 仕組みの停止中 (halt.mjs) も実行する。省略すると、停止中は実行しない
 */

/**
 * イベントごとの処理の結果
 * @typedef {object} HandlerResult
 * @property {import('./agent-request.mjs').AgentRequest[]} [requests] エージェントへの依頼
 * @property {number[]} [redispatch] 振り分けをやり直す Issue の番号
 */

/**
 * イベントごとの処理。作る順番に沿って追加していく。
 * @type {readonly Handler[]}
 */
export const HANDLERS = [startFeature, closeParent, wakeWaitingStages, launchStage, requestReview, requestFix, detectUntrackedChanges, detectConflicts];

/**
 * 停止中の Issue に残すための、イベントの説明を作る。
 *
 * @param {Pick<AsyncFunctionArguments['context'], 'eventName' | 'payload'>} context
 * @returns {string}
 */
export function describeEvent(context) {
  const key = eventKey(context);
  const number = context.payload.issue?.number ?? context.payload.pull_request?.number ?? context.payload.inputs?.['issue-number'];
  if (number !== undefined && number !== '') {
    return `\`${key}\` (#${number})`;
  }
  const sha = context.payload.after;
  return typeof sha === 'string' ? `\`${key}\` (${sha.slice(0, 7)})` : `\`${key}\``;
}

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
 * @param {readonly Handler[]} handlers
 * @returns {{ match: (args: AsyncFunctionArguments) => Promise<void>, route: (args: AsyncFunctionArguments) => Promise<void> }}
 */
export function createRouter(handlers) {
  /**
   * イベントを処理するハンドラーを探す。
   *
   * @param {HandlerArgs} args
   * @returns {Promise<Handler[]>}
   */
  const findHandlers = async (args) => {
    const key = eventKey(args.context);
    /** @type {Handler[]} */
    const matched = [];
    for (const handler of handlers) {
      if (handler.events.includes(key) && (handler.matches === undefined || (await handler.matches(args)))) {
        matched.push(handler);
      }
    }
    return matched;
  };

  /**
   * 設定を読み込む。問題があればワークフローを失敗させ、undefined を返す。
   *
   * @param {AsyncFunctionArguments['core']} core
   * @returns {Promise<import('./config.mjs').CodingAgentConfig | undefined>}
   */
  const readConfig = async (core) => {
    try {
      return await loadConfig(process.env.GITHUB_WORKSPACE ?? process.cwd());
    } catch (error) {
      if (error instanceof ConfigError) {
        core.setFailed(error.message);
        return undefined;
      }
      throw error;
    }
  };

  return {
    async match({ github, context, core }) {
      core.setOutput('handled', 'false');

      const key = eventKey(context);
      if (!handlers.some((handler) => handler.events.includes(key))) {
        core.info(`${key} は振り分けの対象外です`);
        return;
      }
      const config = await readConfig(core);
      if (config === undefined) {
        return;
      }

      const matched = await findHandlers({ github, context, core, config });
      if (matched.length === 0) {
        core.info(`${key} を処理するハンドラーはありません`);
        return;
      }
      core.info(`${key} を処理します: ${matched.map((handler) => handler.name).join('、')}`);
      core.setOutput('handled', 'true');
      core.setOutput('coordinator-client-id', config.agents.coordinator.appClientId);
    },

    async route({ github, context, core }) {
      core.setOutput('dispatches', '[]');
      core.setOutput('redispatch-issues', '[]');

      const config = await readConfig(core);
      if (config === undefined) {
        return;
      }
      const args = { github, context, core, config };

      /** @type {import('./agent-request.mjs').AgentRequest[]} */
      const requests = [];
      /** @type {Set<number>} */
      const redispatch = new Set();
      const handlersToRun = await findHandlers(args);

      // 停止中は、停止中も動かすハンドラー (PR を通らない変更の検知) だけを実行し、ほかは処理しなかったことを残す
      const haltIssue = handlersToRun.some((handler) => !handler.runsWhileHalted) ? await findHaltIssue(github, context.repo, config) : undefined;
      if (haltIssue !== undefined) {
        const skipped = handlersToRun.filter((handler) => !handler.runsWhileHalted).map((handler) => handler.name);
        core.notice(`停止中 (#${haltIssue.number}) のため、処理しません: ${skipped.join('、')}`);
        await github.rest.issues.createComment({
          ...context.repo,
          issue_number: haltIssue.number,
          body: `🤖 停止中のため、${describeEvent(context)} の「${skipped.join('」「')}」を処理しませんでした。`,
        });
      }

      for (const handler of handlersToRun.filter((candidate) => haltIssue === undefined || candidate.runsWhileHalted)) {
        core.info(`${handler.name} を実行します`);
        const result = await handler.run(args);
        requests.push(...(result.requests ?? []));
        for (const issueNumber of result.redispatch ?? []) {
          redispatch.add(issueNumber);
        }
      }
      if (redispatch.size > 0) {
        core.info(`振り分けをやり直します: ${[...redispatch].map((number) => `#${number}`).join('、')}`);
        core.setOutput('redispatch-issues', JSON.stringify([...redispatch]));
      }

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
        core.info('エージェントに依頼することはありません');
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
    },
  };
}

const router = createRouter(HANDLERS);

/** イベントを処理するハンドラーがあるか判定する (読み取り専用の GITHUB_TOKEN で実行する) */
export const match = router.match;

/** ハンドラーを実行する (進行役の GitHub App のトークンで実行する) */
export const route = router.route;
