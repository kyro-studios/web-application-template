import { execSync } from 'node:child_process';

// 公式のコマンドを実行するために バックスラッシュ2つで$をエスケープしている
const commands = [
    'npx husky init',
    'echo "npx --no -- commitlint --edit \\$1" > .husky/commit-msg'
];

// 公式のコマンドを実行するために バックスラッシュ2つで改行文字をエスケープしている

const commandsWindows = [
    'npx husky init',
    "node -e \"fs.writeFileSync('.husky/commit-msg', 'npx --no -- commitlint --edit $'+'1\\n')\""
]

for (const cmd of (process.platform === "win32" ? commandsWindows : commands)) {
    try {
        console.log(`[postinstall] 実行中: ${cmd}`);

        execSync(cmd, { stdio: 'inherit' });
    } catch (error) {
        console.error(`[postinstall] 実行失敗: ${cmd}`);

        process.exit(1);
    }
}

console.log('[postinstall] 全ての実行が完了しました.');