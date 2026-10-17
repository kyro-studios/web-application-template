#!/usr/bin/env bash
# テストを実行する環境のコンテナの中で、リポジトリの scripts/test.sh と、受け入れテストを実行する (仕様の 6.4、10.3、11.1)。
# 作成担当のワークフローの機械的な実行と、アプリケーションの CI の両方が使う。手順をそろえ、結果が一致するようにするため。
#
# 使い方:
#   bash run-tests.sh <リポジトリのディレクトリ> <ログの出力先>
#
# - scripts/test.sh が無ければ、何もせずに成功する (プロジェクトの作成の前や、新しい流れを入れる前に始めた機能)。
#   ただし、環境変数 REQUIRE_TEST_SCRIPT が true (プロジェクトの作成) なら、失敗にする
# - 受け入れテストは、テンプレートが持つ設定 (acceptance/) と、このスクリプトに書いた固定のコマンドで実行する。
#   エージェントが書いた scripts/test.sh には任せない。scripts/start-app.sh が無ければ、受け入れテストは飛ばす
#   (REQUIRE_TEST_SCRIPT が true なら、失敗にする)
# - acceptance/tests/ にテストのファイルが無ければ、仕組みが持つ起動の確認 (smoke) だけを実行する
# - 環境変数 ACCEPTANCE_REPORT を指定すると、受け入れテストの JSON のレポートを、そのパスに書き出す
# - 環境変数 ACCEPTANCE_CHECK が true (実装タスク) なら、テストが通った後に、受け入れ基準の確認 (check-acceptance.mjs) を行う。
#   割り当てた識別子は、環境変数 ACCEPTANCE_CRITERIA に空白で区切って渡す
# - リポジトリを一時的なディレクトリにコピーしてから実行する。テストの出力物 (node_modules やビルドの結果) が、
#   エージェントの変更に混ざらないようにするため
# - コンテナには、ジョブの環境変数を渡さない (秘密の値をテストのコードから読めないようにするため)。
#   Testcontainers が DB のコンテナを起動できるよう、ホストの Docker のソケットを渡す
set -uo pipefail

repo_dir="$1"
log_file="$2"
require="${REQUIRE_TEST_SCRIPT:-false}"

if [ ! -f "$repo_dir/scripts/test.sh" ]; then
  # プロジェクトの作成では、テストを実行するスクリプトを作る段階のため、無ければ失敗にする
  if [ "$require" = 'true' ]; then
    echo "テストを実行するスクリプト (scripts/test.sh) がありません。プロジェクトの作成では、scripts/test.sh、scripts/start-app.sh、scripts/test.Dockerfile を作ってください" | tee "$log_file"
    exit 1
  fi
  echo "scripts/test.sh が無いため、テストを実行しません" | tee "$log_file"
  exit 0
fi
if [ ! -f "$repo_dir/scripts/test.Dockerfile" ]; then
  echo "scripts/test.sh はありますが、テストを実行する環境のコンテナの定義 (scripts/test.Dockerfile) がありません" | tee "$log_file"
  exit 1
fi
if [ "$require" = 'true' ] && [ ! -f "$repo_dir/scripts/start-app.sh" ]; then
  echo "アプリケーションを起動するスクリプト (scripts/start-app.sh) がありません。プロジェクトの作成では、scripts/start-app.sh も作ってください" | tee "$log_file"
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir" 2>/dev/null || sudo rm -rf "$work_dir" 2>/dev/null || true' EXIT
rsync -a --exclude .git --exclude node_modules "$repo_dir/" "$work_dir/"

# コンテナの中で実行する手順。受け入れテストのコマンドは、ここに固定で書く
read -r -d '' container_script <<'SCRIPT'
set -euo pipefail
echo "== scripts/test.sh を実行する =="
bash scripts/test.sh
if [ ! -f scripts/start-app.sh ]; then
  echo "scripts/start-app.sh が無いため、受け入れテストは実行しません"
  exit 0
fi
if [ ! -f acceptance/playwright.config.ts ]; then
  echo "受け入れテストの設定 (acceptance/playwright.config.ts) がありません"
  exit 1
fi
cd acceptance
echo "== 受け入れテストの依存関係をインストールする =="
npm ci --no-audit --no-fund
echo "== 受け入れテストのブラウザーをインストールする =="
npx playwright install --with-deps chromium
if [ -n "$(find tests -type f 2>/dev/null | head -n 1)" ]; then
  echo "== 受け入れテストを実行する =="
  npx playwright test
else
  echo "== acceptance/tests/ にテストが無いため、起動の確認だけを実行する =="
  npx playwright test --project=smoke
fi
SCRIPT

image="coding-agent-test:$$"
{
  echo "== テストを実行する環境のコンテナを作る =="
  docker build -f "$work_dir/scripts/test.Dockerfile" -t "$image" "$work_dir" &&
    docker run --rm -i --network host \
      -v "$work_dir:/workspace" -w /workspace \
      -v /var/run/docker.sock:/var/run/docker.sock \
      "$image" bash -s <<< "$container_script"
} 2>&1 | tee "$log_file"
status="${PIPESTATUS[0]}"

report="$work_dir/acceptance/reports/acceptance-report.json"
if [ -n "${ACCEPTANCE_REPORT:-}" ] && [ -f "$report" ]; then
  cp "$report" "$ACCEPTANCE_REPORT"
fi

# 実装タスクでは、テストが通った後に、受け入れ基準の確認を行う (仕様の 10.5)。満たさなければ、テストの失敗として扱う。
# 満たさなかった内容はログの最後に書き、直させる指示に渡るようにする
if [ "${ACCEPTANCE_CHECK:-false}" = 'true' ] && [ "$status" -eq 0 ]; then
  {
    echo "== 受け入れ基準を確かめる =="
    node "$(dirname "$0")/check-acceptance.mjs" --criteria "${ACCEPTANCE_CRITERIA:-}" --report "$report"
  } 2>&1 | tee -a "$log_file"
  status="${PIPESTATUS[0]}"
fi

docker image rm "$image" > /dev/null 2>&1 || true
if [ "$status" -eq 0 ]; then
  echo "テストが通りました"
else
  echo "テストが失敗しました (終了コード $status)"
fi
exit "$status"
