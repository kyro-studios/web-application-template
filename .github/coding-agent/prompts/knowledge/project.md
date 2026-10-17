## 置き場所

- アプリケーションのコードとビルドの設定は、すべて `app/` の下に、全体の構成のとおりに置いてください
- リポジトリのルートのファイル (`package.json`、`.gitignore`、`README.md` など) は、開発の仕組みのファイルのため、変更しないでください
  - 除外するファイル (`node_modules/`、`build/` など) は、`app/.gitignore` に書いてください。除外されていないファイルは、すべて変更内容に含まれます
  - アプリケーションの説明は、`app/README.md` に書いてください
- 受け入れテストを実行する設定 (`acceptance/` の `package.json`、`playwright.config.ts` など) は、仕組みが用意しています。変更しないでください。`acceptance/tests/` のテストのファイルも、作らないでください (実装タスクで書きます)

## テストを実行するスクリプト (`scripts/test.sh`)

次の約束を守ってください。テストは、このスクリプトだけを通して実行されます。

- 引数を取らず、リポジトリのルートで、テストを実行する環境のコンテナの中で実行される
- アプリケーションのビルドと、単体テストのすべてを実行する
- アーキテクチャのルールを、`architecture-rules/` の設定で直接実行する
- 受け入れテストは実行しない。仕組みが、`scripts/test.sh` の後に、同じコンテナの中で実行します
- すべて成功したら終了コード 0、どれかが失敗したら 0 以外で終わる

## アプリケーションを起動するスクリプト (`scripts/start-app.sh`)

受け入れテストのために、仕組みがこのスクリプトでアプリケーションを起動します。次の約束を守ってください。

- 引数を取らず、リポジトリのルートで、`scripts/test.sh` を実行した後の同じコンテナの中で実行される。ビルドの結果は、そのまま使ってよい
- 環境変数 `PORT` のポート (4000) で、画面と API を 1 つのオリジン (`http://127.0.0.1:<PORT>`) で提供する。全体の構成に書かれた方法 (開発用のサーバーが API を中継するなど) で、1 つのオリジンにまとめる
- `/` に、2xx、3xx、400〜403 のどれかで応答する。仕組みは、`/` が応答するまで待ってから、テストを始める
- 止められるまで、前面で動き続ける。テストが終わると、SIGTERM で止められる。止められたら、このスクリプトが起動したほかのプロセス (バックエンドとフロントエンドなど) も止める
- アプリケーションが DB を使う場合は、このスクリプトが Docker で起動し、止められたときに止める (ホストの Docker のソケットを使える)
- 本番のサービスや、秘密の値には頼らない

## テストを実行する環境のコンテナ (`scripts/test.Dockerfile`)

- ツール (JDK、Node.js、Docker の CLI など) だけを入れてください。リポジトリは、実行するときにマウントされます
- 受け入れテストを同じコンテナで実行するため、Node.js 22 以降を必ず入れてください。Playwright のブラウザは、仕組みが実行のたびにインストールするため、入れなくてかまいません
- 仕組みがブラウザと、それに要るパッケージを `apt` でインストールするため、Debian か Ubuntu を元にしたイメージにし、root で実行してください
- ツールのメジャーバージョン (Node.js の LTS、JDK 21 など) は、この定義で固定してください
- テストで使う PostgreSQL は、Testcontainers で起動してください。本番のサービス (Neon) には接続しないでください。テストには、秘密の値は渡されません
- コンテナは、次のように実行されます。作業の最後に、同じ方法で実行して確かめてください

```bash
docker build -f scripts/test.Dockerfile -t coding-agent-test .
docker run --rm --network host \
  -v "$PWD:/workspace" -w /workspace \
  -v /var/run/docker.sock:/var/run/docker.sock \
  coding-agent-test scripts/test.sh
```

- `scripts/start-app.sh` は、同じコンテナの中で、仕組みが持つ起動の確認で確かめてください

```bash
docker run --rm --network host \
  -v "$PWD:/workspace" -w /workspace \
  -v /var/run/docker.sock:/var/run/docker.sock \
  coding-agent-test bash -c 'bash scripts/test.sh && cd acceptance && npm ci && npx playwright install --with-deps chromium && npx playwright test --project=smoke'
```
