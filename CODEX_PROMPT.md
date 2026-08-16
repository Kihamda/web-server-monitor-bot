# Codexへの開始指示

このリポジトリを実装・検証してください。

最初に `CODEX_SPEC.md` を全文読み、これを最上位仕様として扱ってください。
既存コードは参考実装であり、仕様と矛盾する場合はコードを修正してください。

特に今回の最重要条件は以下です。

- 予算0円。
- Cloudflare Workers Free + SQLite-backed Durable Objectのみ。
- Cron / D1 / Queues / Workflows / Agents / VPS /外部SaaSは禁止。
- Discord Gatewayを使わずHTTP Interactionsのみ。
- Public BotはOFFにする前提で、複数Guild対応。
- 1 Guild最大10 monitor、global hard cap 1000。
- interval設定は存在しない。
- 正常時はDiscord完全無音。
- DBにチェック履歴を一切残さない。
- 正常時はmonitor行を書き換えない。
- DOWN時だけ名前とURLをDiscordへ通知。
- DOWN継続中は再通知しない。
- recovery通知はしないが、内部フラグは解除して次のDOWNを再通知可能にする。
- 固定16件batchは禁止。
- 1 Alarm invocationのexternal subrequest budgetを50として動的に使う。
- 正常HEAD=1、HEAD失敗時GET=+1、新規DOWN alert=+1。
- 50件目でmonitor処理途中になったらscheduler_stateへcontinuationだけ保存して次Alarmで続ける。
- redirectはmanual。
- 1xx〜4xxはalive、5xx/network/timeoutはfailure candidate。
- TypeScript strictを維持。

作業順：

1. `CODEX_SPEC.md`を全文読む。
2. Cloudflare Workers / Durable Objects / Discord Interactionsの現行公式ドキュメントを確認する。
3. `npm install`。
4. `npm run typecheck`。
5. コードと仕様の矛盾を列挙。
6. dynamic 50-subrequest budget schedulerを重点的にレビュー。
7. continuation boundaryのテストを追加。
8. Discord署名検証、権限、rate limit処理を検証。
9. Wranglerのlocal Durable Object Alarmテストを追加・実行。
10. READMEのセットアップ手順を実装と一致させる。
11. `CODEX_SPEC.md`のDefinition of Doneを1項目ずつ判定する。

最優先で確認する境界条件：

- 50件すべて成功 = 50 HEADで1 Alarm完了
- 49成功 + 50番目HEAD失敗 = pending confirm
- 48成功 + 次monitor HEAD/GET失敗 = pending notify
- Discord 429 = notify continuation
- monitorがpending中にremoveされた場合に通知しない

大規模なリファクタリングや機能追加は不要です。
「無料枠消費を減らす」「監視漏れを防ぐ」「DOWN通知を1回だけ届ける」の3点に直接関係しない変更は避けてください。

最後に、実行できたテスト、実credentialsが必要で実行できなかったテスト、残るリスクを分けて報告してください。
