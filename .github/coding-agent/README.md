# Coding Agent のセットアップ手順

このテンプレートから作ったリポジトリで、Coding Agent による開発フロー (README の「開発フロー」) を動かすための手順です。仕組みの詳しい仕様は [specification.md](specification.md) にあります。

テンプレート自体では仕組みは動きません。Variables の `CODING_AGENT_ENABLED` を `true` にしたリポジトリだけで動きます。

## 0. 前提

- GitHub の Organization を使う。リポジトリは、Organization が所有する **public** リポジトリにする (Merge Queue を使うため)
- 作業する人は、Organization のオーナーか、リポジトリの管理者であること (ルールセットや Secrets を設定するため)
- 手元に、次のものを用意する
  - [GitHub CLI](https://cli.github.com/) (`gh`)。`gh auth login` でログインしておく
  - Node.js 22 以降
- 使うエージェントの API キー (Claude は Anthropic、Codex は OpenAI)

## 1. リポジトリを作る

1. テンプレートのリポジトリで「Use this template」を選び、Organization の下に **public** で作る
2. 作ったリポジトリを手元に clone する

```bash
gh repo clone <owner>/<name>
```

## 2. GitHub App を作る

GitHub App を 3 つ作ります。進行役 (coordinator) と、エージェントごとに 1 つずつ (Claude 用、Codex 用) です。エージェントの App を分けるのは、PR を作った App は自分の PR を Approve できないためです。

Organization の「Settings」→「Developer settings」→「GitHub Apps」→「New GitHub App」で、App ごとに次のように作ります。

- 「Webhook」の「Active」は外す (使わないため)
- 「Where can this GitHub App be installed?」は「Only on this account」にする
- 「Repository permissions」は、次の表のとおりにする。ほかの権限は付けない

| App | Contents | Issues | Pull requests |
| --- | --- | --- | --- |
| 進行役 | Read-only | Read and write | Read and write |
| Claude 用 | Read and write | Read and write | Read and write |
| Codex 用 | Read and write | Read and write | Read and write |

- **Workflows の権限は、どの App にも付けない**。エージェントが `.github/workflows/` を書き換えられないようにするため
- 作ったら、App の設定の画面で、次の 2 つを控える
  - **Client ID** (`Iv23li...` の形)
  - **Bot 名**。App の名前 (slug) に `[bot]` を付けたもの (例: App の名前が `my-claude` なら `my-claude[bot]`)
- 「Private keys」→「Generate a private key」で秘密鍵 (`.pem`) を作り、ダウンロードしておく
- 「Install App」で、Organization にインストールする。「Only select repositories」で、1 で作ったリポジトリを選ぶ

権限を後から変えた場合は、Organization にインストールした App の画面で、新しい権限を承認する必要があります。

## 3. マシンユーザーを用意する

エージェントごとに、Issue に Assign するための GitHub のアカウント (マシンユーザー) を 1 つずつ用意します。GitHub App の Bot は Issue の Assignee にできないためです。段階の Issue は、このアカウントが Assign されていることを条件に起動します。

1. エージェントごとに GitHub のアカウントを作る (例: `<あなたの名前>-claude`、`<あなたの名前>-codex`)
2. リポジトリの「Settings」→「Collaborators」で、それぞれを **Write** の権限で招待する
3. それぞれのアカウントで招待を承認する

## 4. Secrets を登録する

Organization の「Settings」→「Secrets and variables」→「Actions」で、次の Secrets を登録します。「Repository access」で、1 で作ったリポジトリを選びます。名前はワークフローに書いてあるため、このとおりにしてください。

| 名前 | 値 |
| --- | --- |
| `CODING_AGENT_COORDINATOR_PRIVATE_KEY` | 進行役の App の秘密鍵 (`.pem` の中身をそのまま) |
| `CODING_AGENT_CLAUDE_PRIVATE_KEY` | Claude 用の App の秘密鍵 |
| `CODING_AGENT_CODEX_PRIVATE_KEY` | Codex 用の App の秘密鍵 |
| `ANTHROPIC_API_KEY` | Anthropic の API キー |
| `OPENAI_API_KEY` | OpenAI の API キー |

### API キーについての注意

- 実装タスクでは、エージェントがビルドやテストのコマンドを実行します。**API キーは、エージェントが実行するコマンドから読める**状態です (仕様の 6.3)
- そのため、この仕組みには**専用の API キー**を作り、**使える金額に上限を設けて**ください。漏れたときの被害を、上限の金額までに抑えるためです
- 上限や自動のチャージ (Auto Renewal など) の設定が、意図せず外れていることがあります。上限が外れていないか、クレジットが残っているかを、ときどき確かめてください。クレジットが無くなると、エージェントのワークフローが `Quota exceeded` などで失敗します

## 5. `agents.json` を編集する

[agents.json](agents.json) に、2〜3 で用意したものを書きます。

| 項目 | 書くもの |
| --- | --- |
| `coordinator.bot`、`coordinator.appClientId` | 進行役の App の Bot 名と Client ID |
| `agents.<識別子>.bot`、`agents.<識別子>.appClientId` | エージェントの App の Bot 名と Client ID |
| `agents.<識別子>.assignee` | エージェントのマシンユーザーのアカウント名 |

`roles` には、段階ごとに、担当のエージェントと、使うモデルと effort が書いてあります。テンプレートの値のままでも動きます。変えるときは、次の点に気を付けてください。

- 段階ごとに、作成担当とレビュー担当は**別のエージェント**にする (PR を作った App は、自分の PR を Approve できないため)
- `model` と `effort` を省略するか `null` にすると、エージェントのツールの既定を使う。指定できる値は、エージェントのツールとモデルによる
- エージェントごとの `fix` は、そのエージェントが作った PR を修正するときのモデルと effort
- Codex による実装タスクには、まだ対応していない。`roles.implementation.implementers` には Claude を指定する

書き終えたら、設定の形式と関係を確かめます。

```bash
npm ci --ignore-scripts
```

```bash
npm test
```

確かめたら、`main` にコミットして push します。次の 6 でルールセットを設定すると、`develop` には PR を通さないと変更を入れられなくなるため、`agents.json` はこの時点で入れておきます。

## 6. セットアップのスクリプトを実行する

手元で、セットアップのスクリプトを実行します。次のことを行います。何度実行しても同じ状態になります。

- `main` から `develop` を作り、既定のブランチにする
- リポジトリの設定 (自動マージ、squash のコミットメッセージを PR のタイトルだけにする、マージしたブランチの削除)
- ラベルの作成 (`feature`、`stage:*`、`needs-human`)
- `develop` と `main` のルールセット (PR と承認の必須、Merge Queue、`main` を更新できる人の制限)

まず `--dry-run` で、変更の内容を確かめます。

```bash
node .github/scripts/coding-agent/setup-repository.mjs --repo <owner>/<name> --dry-run
```

問題が無ければ、`--dry-run` を外して実行します。

```bash
node .github/scripts/coding-agent/setup-repository.mjs --repo <owner>/<name>
```

| オプション | 内容 |
| --- | --- |
| `--required-check <名前>` | `develop` で必須にするステータスチェック。複数指定できる。省略すると `commitlint` だけを必須にする |
| `--main-bypass-team <slug>` | `main` を更新できる Team。複数指定できる。Organization のオーナーは、指定しなくても PR を通して更新できる |

## 7. Variables を設定する

リポジトリの「Settings」→「Secrets and variables」→「Actions」→「Variables」で、次の値を設定します。`CODING_AGENT_ENABLED` を設定した時点で、仕組みが動き始めます。

| 名前 | 値 | 既定値 |
| --- | --- | --- |
| `CODING_AGENT_ENABLED` | `true` (必須) | (未設定のあいだは、どのワークフローも何もしない) |
| `REVIEW_MAX_FIX_ROUNDS` | エージェントが 1 つの PR を修正する回数の上限 | 3 |
| `PLANNER_MAX_TASKS` | 1 回の実装計画で作成できる実装タスクの上限 | 30 |

## 8. 動作を確かめる

1. Issue の「New issue」で「新規機能」のフォームを選び、機能の親 Issue を作る。機能名は、英小文字・数字とハイフンにする
2. 数十秒で、要件定義・仕様書・概念モデル・アーキテクチャ設計・実装計画の段階の Issue が、Sub Issue として作られることを確かめる
3. 要件定義の Issue に従って、要件定義書 (`docs/features/<番号>-<機能名>/requirements.md`) を書き、その Issue を Close する PR (本文に `Closes #<番号>`) を作る。Ready for review にすると、レビュー担当のレビューが始まる

最初は、範囲の小さい機能で試すことをおすすめします。要件定義書の PR を Ready for review にした後は、実装まで自動で進み、API の料金がかかります。

## 運用

### 人が対応すること

- 要件定義書を書き、レビューの指摘を直す
- 修正の回数が上限に達して、`needs-human` ラベルが付いた PR に対応する。対応したら `needs-human` ラベルを外すと、改めてレビューされる
- 実装計画で、担当が人になった実装タスクに対応して、Issue を Close する
- `develop` から `main` へマージする

### 振り分けをやり直す

段階や実装タスクを起動し直すときや、PR の修正を依頼し直すときは、振り分け用のワークフローを、Issue か PR の番号を指定して手動実行します。起動済みや依頼済みのものをやり直すときは、`force` を付けます。

```bash
gh workflow run coding-agent-router.yml -R <owner>/<name> -f issue-number=<番号> -f force=true
```

レビューをやり直すときは、PR を一度 Close して Reopen します。

### `develop` の設定ファイルを変えるとき

`agents.json` などを変えるときは、`develop` に向けた PR を作ります。`develop` のルールセットは承認を必須にしていて、段階の Issue に紐づかない PR はエージェントがレビューしないため、**ほかの人の承認**が要ります。1 人で運用している場合は、リポジトリの管理者が、ルールセットを一時的に無効にしてマージし、必ず有効に戻してください。

### エージェントを止める

すべてを止めるときは、Variables の `CODING_AGENT_ENABLED` を `true` 以外にします。実装タスクの一部だけを止めるときは、まだ起動していないタスクの Issue から、エージェントのマシンユーザーの Assign を外します。Assign し直すと、依存先が解決していれば起動します。
