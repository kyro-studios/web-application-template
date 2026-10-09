# Coding Agent の自動起動

Issue の Assignee に Coding Agent 用のアカウントが指定されると、依存する Sub Issue がすべて解決したタイミングで、そのエージェントを GitHub Actions から起動します。

| エージェント | ワークフロー | PR の作成者 |
| --- | --- | --- |
| Claude Code | [coding-agent-claude-code.yml](../workflows/coding-agent-claude-code.yml) | 自作の GitHub App |
| Codex | [coding-agent-codex.yml](../workflows/coding-agent-codex.yml) | 自作の GitHub App |
| Jules | [coding-agent-jules.yml](../workflows/coding-agent-jules.yml) | Jules の GitHub App |

共通の処理は、次の Reusable Workflow にまとめています。

- [coding-agent-gate.yml](../workflows/coding-agent-gate.yml): 起動条件の判定と二重起動の防止
- [coding-agent-publish.yml](../workflows/coding-agent-publish.yml): Claude Code と Codex の変更を push し、PR を作成する

## 起動条件

次の条件をすべて満たしたときに起動します。

- Issue が Open で、エージェントのアカウントが Assignee に含まれている
- すべての Sub Issue が Close されている (Completed / Not planned などの理由は問わない)
- Sub Issue に紐づく PR に、Open のまま残っているものが無い
  - マージされずに Close された PR は、破棄されたものとして無視します
- Sub Issue を持たない Issue は、Assign された時点で起動します

判定は次のイベントで行います。

- `issues.assigned`: Assign された Issue 自身を判定する
- `issues.closed`: Close された Issue の親 Issue を判定する

Sub Issue にもエージェントを Assign しておけば、子から順に実装が進み、最後の子の PR がマージされた時点で親のエージェントが起動します。

### 注意点

- 起動したエージェントは Issue に印となるコメントを残し、同じ Issue では二度と自動起動しません。再実行したい場合は、ワークフローを手動実行 (`workflow_dispatch`) して Issue 番号を指定してください。手動実行でも起動条件は判定します
- 書き込み権限を持たないユーザーの操作 (自分の Issue を Close したなど) では起動しません
- Sub Issue を Close した後に、紐づく PR をマージした場合はイベントが発生しないため、手動実行してください
- Issue の本文はそのままプロンプトに含まれます。エージェントを Assign する前に、本文に不審な指示が無いか確認してください

## セットアップ

### 1. Assignee 用のアカウント

各エージェントに対応する GitHub アカウント (マシンユーザーなど) を用意し、リポジトリに Assign できる状態にしてください。

### 2. 1Password

1Password のサービスアカウントを作成し、次のアイテムを読み取れるようにしてください。

- Anthropic API キー
- OpenAI API キー
- Jules API キー
- PR 作成用 GitHub App の秘密鍵

### 3. GitHub App (Claude Code / Codex 用)

GITHUB_TOKEN で作成した PR では CI が起動しないため、PR の作成には GitHub App を使います。App が未設定の場合、publish ジョブは失敗します。

- Repository permissions: Contents (Read and write)、Issues (Read and write)、Pull requests (Read and write)
- このリポジトリにインストールし、秘密鍵を 1Password に保存する
- エージェントが `.github/workflows` 配下を変更した場合は push に失敗します (Workflows 権限は意図的に付与していません)

### 4. Jules

[Jules](https://jules.google.com) でこのリポジトリを接続し、API キーを発行してください。

### 5. GitHub の Secrets と Variables

Secrets:

| 名前 | 内容 |
| --- | --- |
| `OP_SERVICE_ACCOUNT_TOKEN` | 1Password のサービスアカウントトークン |

Variables:

| 名前 | 内容 |
| --- | --- |
| `CLAUDE_CODE_ASSIGNEE` | Claude Code 用アカウントのログイン名 |
| `CODEX_ASSIGNEE` | Codex 用アカウントのログイン名 |
| `JULES_ASSIGNEE` | Jules 用アカウントのログイン名 |
| `OP_ANTHROPIC_API_KEY_REF` | Anthropic API キーの参照 (例: `op://CI/Anthropic/credential`) |
| `OP_OPENAI_API_KEY_REF` | OpenAI API キーの参照 |
| `OP_JULES_API_KEY_REF` | Jules API キーの参照 |
| `CODING_AGENT_APP_CLIENT_ID` | PR 作成用 GitHub App の Client ID |
| `OP_CODING_AGENT_APP_PRIVATE_KEY_REF` | PR 作成用 GitHub App の秘密鍵の参照 |

`*_ASSIGNEE` が未設定のエージェントは起動しません。使わないエージェントは未設定のままにしてください。

## エージェントの出力

Claude Code と Codex は [result-schema.json](result-schema.json) の形式で、コミットメッセージと PR の説明を出力します。出力が得られなかった場合は、既定のコミットメッセージで PR を作成します。
