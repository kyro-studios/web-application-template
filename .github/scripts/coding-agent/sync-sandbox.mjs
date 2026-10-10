/**
 * テンプレートの変更を、動作確認用のリポジトリの develop に取り込む。テンプレートで仕組みを開発する人が使う。
 *
 * テンプレートから作ったリポジトリは、テンプレートの後の変更を自動では受け取らない。また、Issue のイベントで
 * 動くワークフローは既定ブランチ (develop) のものが使われるため、動作確認の前に develop へ反映する必要がある。
 * develop はルールセットで保護されているため、取り込みを push する間だけルールセットを無効にし、必ず有効に戻す。
 * 確認用のリポジトリに固有の設定 (KEPT_PATHS) は、テンプレートの内容で置き換えずに残す。--agents を指定すると、
 * 手元のファイルで agents.json を置き換える。push する前に、取り込んだ後の設定ファイルを検証する。
 *
 * 確認用のリポジトリの管理者が、gh コマンドにログインした状態で実行する。
 *
 * 使い方:
 *   node .github/scripts/coding-agent/sync-sandbox.mjs --template <owner>/<name> --sandbox <owner>/<name> [--ref <ブランチ>] [--agents <ファイル>]
 *
 * オプション:
 *   --template  取り込み元のテンプレートのリポジトリ
 *   --sandbox   取り込み先の確認用のリポジトリ
 *   --ref       取り込むテンプレートのブランチ (既定は main)
 *   --agents    確認用のリポジトリの agents.json にする手元のファイル (省略すると確認用のリポジトリの内容を残す)
 */

import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIG_DIR, loadConfig } from './config.mjs';
import { DEVELOP_BRANCH, RULESET_NAMES } from './setup-repository.mjs';

const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** 確認用のリポジトリに固有の設定のため、テンプレートの内容で置き換えずに残すファイル */
export const KEPT_PATHS = [`${CONFIG_DIR}/agents.json`];

/**
 * @typedef {object} SyncOptions
 * @property {string} template 取り込み元のテンプレートのリポジトリ (<owner>/<name>)
 * @property {string} sandbox 取り込み先の確認用のリポジトリ (<owner>/<name>)
 * @property {string} ref 取り込むテンプレートのブランチ
 * @property {string | undefined} agents 確認用のリポジトリの agents.json にする手元のファイル
 */

/**
 * コマンドライン引数を解釈する。
 *
 * @param {string[]} args
 * @returns {SyncOptions}
 * @throws {Error} 引数が正しくない場合
 */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      template: { type: 'string' },
      sandbox: { type: 'string' },
      ref: { type: 'string', default: 'main' },
      agents: { type: 'string' },
    },
    strict: true,
  });

  for (const name of /** @type {const} */ (['template', 'sandbox'])) {
    if (!REPOSITORY_PATTERN.test(values[name] ?? '')) {
      throw new Error(`--${name} には <owner>/<name> の形式でリポジトリを指定してください`);
    }
  }
  const template = /** @type {string} */ (values.template);
  const sandbox = /** @type {string} */ (values.sandbox);
  if (template.toLowerCase() === sandbox.toLowerCase()) {
    throw new Error('--template と --sandbox には別のリポジトリを指定してください');
  }
  const ref = values.ref ?? 'main';
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-')) {
    throw new Error(`--ref のブランチ名が正しくありません: ${ref}`);
  }

  return { template, sandbox, ref, agents: values.agents === undefined ? undefined : resolve(values.agents) };
}

/**
 * 取り込みのコミットメッセージを作る。
 *
 * @param {string} template 取り込み元のテンプレートのリポジトリ
 * @param {string} sha 取り込むテンプレートのコミット
 * @returns {string}
 */
export function syncCommitMessage(template, sha) {
  return `chore: sync with template\n\nBring in ${template}@${sha}.\n`;
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string }} [options]
 * @returns {string}
 */
function git(args, options = {}) {
  return execFileSync('git', args, { cwd: options.cwd, input: options.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
}

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {any}
 */
function ghApi(method, path, body) {
  const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', path];
  if (body !== undefined) {
    args.push('--input', '-');
  }
  const output = execFileSync('gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return output.trim() === '' ? null : JSON.parse(output);
}

/**
 * @param {SyncOptions} options
 */
async function sync(options) {
  const workDir = await mkdtemp(join(tmpdir(), 'coding-agent-sync-'));
  try {
    const cwd = join(workDir, 'sandbox');
    git(['clone', '--quiet', '--branch', DEVELOP_BRANCH, `https://github.com/${options.sandbox}.git`, cwd]);
    git(['fetch', '--quiet', `https://github.com/${options.template}.git`, options.ref], { cwd });
    const sha = git(['rev-parse', 'FETCH_HEAD'], { cwd });

    // ファイルの中身をテンプレートと同じにする (テンプレートで削除したファイルも削除する)
    git(['rm', '-r', '--quiet', '--ignore-unmatch', '.'], { cwd });
    git(['checkout', 'FETCH_HEAD', '--', '.'], { cwd });
    for (const path of KEPT_PATHS) {
      if (git(['ls-tree', '--name-only', 'HEAD', '--', path], { cwd }) !== '') {
        git(['checkout', 'HEAD', '--', path], { cwd });
      }
    }
    if (options.agents !== undefined) {
      await copyFile(options.agents, join(cwd, CONFIG_DIR, 'agents.json'));
      git(['add', '--', `${CONFIG_DIR}/agents.json`], { cwd });
    }
    // テンプレートで設定の形式が変わっていても気づけるよう、取り込んだ後の設定を検証する (問題があれば ConfigError)
    await loadConfig(cwd);
    if (git(['diff', '--cached', '--name-only'], { cwd }) === '') {
      console.log(`${options.sandbox} の ${DEVELOP_BRANCH} は、${options.template}@${sha.slice(0, 7)} と同じ内容です (固有の設定を除く)`);
      return;
    }
    git(['commit', '--quiet', '--no-verify', '--file', '-'], { cwd, input: syncCommitMessage(options.template, sha) });

    const base = `repos/${options.sandbox}`;
    const ruleset = ghApi('GET', `${base}/rulesets?includes_parents=false&per_page=100`).find(
      (/** @type {{ name: string }} */ candidate) => candidate.name === RULESET_NAMES.develop,
    );
    if (ruleset === undefined) {
      throw new Error(`${options.sandbox} に ${RULESET_NAMES.develop} のルールセットがありません。先にセットアップのスクリプトを実行してください`);
    }

    ghApi('PUT', `${base}/rulesets/${ruleset.id}`, { enforcement: 'disabled' });
    console.log(`✔ ${RULESET_NAMES.develop} のルールセットを一時的に無効にしました`);
    try {
      git(['push', '--quiet', 'origin', DEVELOP_BRANCH], { cwd });
      console.log(`✔ ${options.template}@${sha.slice(0, 7)} の内容を ${options.sandbox} の ${DEVELOP_BRANCH} に push しました`);
    } finally {
      ghApi('PUT', `${base}/rulesets/${ruleset.id}`, { enforcement: 'active' });
      console.log(`✔ ${RULESET_NAMES.develop} のルールセットを有効に戻しました`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await sync(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
