## 変更してよい範囲

- 変更してよいのは、`app/` の下だけです。受け入れテスト、`scripts/`、アーキテクチャのルール、リポジトリのルートのファイルは変更しないでください
- 除外するファイル (`node_modules/`、`build/` など) は、`app/.gitignore` に書いてください。除外されていないファイルは、すべて変更内容に含まれます

## 構成と契約

- 全体の構成 (`docs/architecture.md`) に書かれたディレクトリとモジュールの分け方、モジュール間の依存の向きに従ってください。構成を変える必要があると考えた場合は、変えずに、その理由を PR の説明に書いてください
- モジュール間の依存の向きは、アーキテクチャのルールとして機械的に確かめられます。ルールに違反すると、テストが失敗します
- API は、API の契約 (`docs/api/openapi.yaml`) のとおりに実装してください

## テスト

- 単体テストは、フロントエンドは Vitest、バックエンドは JUnit で書いてください
- テストで使う PostgreSQL は、Testcontainers で起動してください。本番のサービスには接続しないでください
- テストは、`scripts/test.sh` を通して実行されます。`scripts/test.sh` がある場合は、作業の最後に、次のようにテストを実行する環境のコンテナの中で実行し、通ることを確かめてください

```bash
docker build -f scripts/test.Dockerfile -t coding-agent-test .
docker run --rm --network host \
  -v "$PWD:/workspace" -w /workspace \
  -v /var/run/docker.sock:/var/run/docker.sock \
  coding-agent-test scripts/test.sh
```
