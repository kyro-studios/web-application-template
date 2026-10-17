import { defineConfig, devices } from '@playwright/test';

/**
 * 受け入れテストを実行する設定 (仕様の 10.3)。テンプレートが固定で持ち、どのエージェントも変更できない。
 *
 * - アプリケーションは、scripts/start-app.sh が、環境変数 PORT のポートで、画面と API を 1 つのオリジンで提供する
 * - smoke: 仕組みが持つ起動の確認。scripts/start-app.sh が動くことを、受け入れテストが無いときも確かめる
 * - acceptance: 実装タスクが書く受け入れテスト (tests/)。起動の確認が通ってから実行する
 * - 結果は、JSON のレポートとして決まった場所に出す。仕組みが、受け入れ基準の確認に使う
 */

/** アプリケーションのポート。今の土台が使うポート (バックエンドの 8080、Vite の 5173) とぶつからないようにする */
const PORT = 4000;

const BASE_URL = `http://127.0.0.1:${PORT}`;

/** JSON のレポートの出力先 (この設定のディレクトリからの相対パス) */
const REPORT_FILE = 'reports/acceptance-report.json';

export default defineConfig({
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: REPORT_FILE }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'smoke',
      testDir: './smoke',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'acceptance',
      testDir: './tests',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['smoke'],
    },
  ],
  webServer: {
    // リポジトリのルートで実行する
    command: 'bash scripts/start-app.sh',
    cwd: '..',
    env: { PORT: String(PORT) },
    // / が 2xx、3xx、400〜403 のどれかを返したら、起動したとみなす
    url: BASE_URL,
    reuseExistingServer: false,
    // ビルドや DB の起動を含めて待つ
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // scripts/start-app.sh が、起動した DB などを止められるよう、SIGTERM で止める
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
