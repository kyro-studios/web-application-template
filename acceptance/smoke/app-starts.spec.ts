import { expect, test } from '@playwright/test';

// 仕組みが持つ起動の確認 (仕様の 10.3)。scripts/start-app.sh が起動したアプリケーションに、
// ブラウザーで接続できることを確かめる。受け入れ基準の確認では数えない
test('アプリケーションが起動し、/ に応答する', async ({ page }) => {
  const response = await page.goto('/');
  expect(response, '/ に接続できませんでした').not.toBeNull();
  expect(response?.status(), '/ がサーバーの誤り (5xx) を返しました').toBeLessThan(500);
});
