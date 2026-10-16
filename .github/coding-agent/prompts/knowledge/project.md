## 置き場所

- アプリケーションのコードとビルドの設定は、すべて `app/` の下に、全体の構成のとおりに置いてください
- リポジトリのルートのファイル (`package.json`、`.gitignore`、`README.md` など) は、開発の仕組みのファイルのため、変更しないでください
  - 除外するファイル (`node_modules/`、`build/` など) は、`app/.gitignore` (受け入れテストは `acceptance/.gitignore`) に書いてください。除外されていないファイルは、すべて変更内容に含まれます
  - アプリケーションの説明は、`app/README.md` に書いてください

## テストを実行するスクリプト (`scripts/test.sh`)

次の約束を守ってください。テストは、このスクリプトだけを通して実行されます。

- 引数を取らず、リポジトリのルートで、テストを実行する環境のコンテナの中で実行される
- アプリケーションのビルドと、単体テストのすべてを実行する
- アーキテクチャのルールを、`architecture-rules/` の設定で直接実行する
- 受け入れテストのうち、有効なテストの一覧 (`scripts/enabled-tests/*.txt`。1 行に 1 つの識別子) にある識別子のテストだけを実行する。一覧のファイルが無いか、識別子が 1 つも無ければ、受け入れテストは実行しない
  - 受け入れテストには、識別子が Playwright のタグ (例: `@T12-3`) で付いています。`--grep` で絞り込むときは、`@T12-3` が `@T12-30` に当てはまらないようにしてください
- 受け入れテストのためにアプリケーションを起動したら、終わる前に止める
- すべて成功したら終了コード 0、どれかが失敗したら 0 以外で終わる

## テストを実行する環境のコンテナ (`scripts/test.Dockerfile`)

- ツール (JDK、Node.js、Playwright のブラウザ、Docker の CLI など) だけを入れてください。リポジトリは、実行するときにマウントされます
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

## 受け入れテストの設定 (`acceptance/`)

- 受け入れテストは、Playwright (TypeScript) で書きます。`acceptance/` に、`package.json` と Playwright の設定を置いてください
- Playwright の設定で、アプリケーションを起動し (`webServer`)、その URL を `baseURL` にしてください
- テストのファイル (`acceptance/tests/`) は作らないでください。後の段階で書きます
