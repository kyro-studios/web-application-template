## 置き場所と書き方

- 受け入れテストは、アプリケーションの技術スタックによらず、Playwright (TypeScript) で書き、`acceptance/tests/` の下に置いてください。受け入れテストを実行する設定 (`acceptance/` の `package.json`、`playwright.config.ts` など) は、仕組みが用意しています。変更しないでください
- 並行して進むほかのタスクとコンフリクトしないよう、`acceptance/tests/<機能名>/` の下に、受け入れ基準ごと、またはタスクごとにファイルを分けてください (例: `acceptance/tests/greeting/ac42-3.spec.ts`)。ほかのタスクが書いたテストのファイルは、変更しないでください
- アプリケーションは、仕組みが起動します (`scripts/start-app.sh`)。テストからは、`baseURL` (`http://127.0.0.1:4000`) に向けて、相対パスで接続してください。テストの中で、アプリケーションを起動しないでください
- 画面のテストは、`page` で画面を操作して確かめます。API のテストは、`request` で HTTP のリクエストを送って確かめます
- 画面の要素は、ロールとアクセシブルな名前 (`getByRole` など) で見つけてください。画面に表示する文言は、仕様書と受け入れ基準のとおりにしてください。URL や要素のロールなど、文言以外の部分は、アーキテクチャ設計に沿って決めてください
- テストは、外から観察できる振る舞い (画面の表示、API の応答) だけを確かめてください。実装の内部 (関数や状態) には触れないでください

## 受け入れ基準の識別子のタグ

- 各テストには、確かめる受け入れ基準の識別子を、Playwright のタグでちょうど 1 つ付けてください。1 つの基準に、複数のテストがあってもかまいません

```ts
import { expect, test } from '@playwright/test';

test('名前を入力して挨拶を表示する', { tag: '@AC42-3' }, async ({ page }) => {
  await page.goto('/greeting');
  // ...
});
```

- タスクに割り当てられた受け入れ基準は、タスクの Issue の本文の「受け入れ基準」に書かれています。割り当てられた基準ごとに、そのタグの付いたテストを書き、すべて通るようにしてください

## 実行のしかた

受け入れテストは、`scripts/test.sh` と同じテストを実行する環境のコンテナの中で、次のように実行してください。

```bash
docker build -f scripts/test.Dockerfile -t coding-agent-test .
docker run --rm --network host \
  -v "$PWD:/workspace" -w /workspace \
  -v /var/run/docker.sock:/var/run/docker.sock \
  coding-agent-test bash -c 'bash scripts/test.sh && cd acceptance && npm ci && npx playwright install --with-deps chromium && npx playwright test'
```

- 特定のテストだけを実行するときは、最後のコマンドに `--grep @AC42-3` のようにタグを指定してください
