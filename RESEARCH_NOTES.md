# Research Notes — 2026-08-17

設計判断に使用した一次情報の要点。
実装時はCodexが現行公式ドキュメントを再確認すること。

## Cloudflare Workers limits

Cloudflare Workers Freeは2026-08時点でexternal subrequestsが1 invocationあたり50。
Cloudflare services向けinternal subrequestsは別枠で1000。
同時outgoing connectionsは6。
Durable Object Alarm handlerのwall timeは15分。

Official docs:
- Cloudflare Workers Platform Limits
- Cloudflare changelog: Workers are no longer limited to 1000 subrequests (2026-02-11)

設計への反映：

- Wrangler `limits.subrequests = 50`
- 監視件数を16固定にしない
- external `fetch()`直前にbudget tokenを1消費
- redirect manual
- sequential schedulerでcontinuationを1件に限定

## SQLite-backed Durable Objects / Free

Workers FreeではSQLite-backed Durable Objectsを利用可能。
Cloudflareは新規DOにSQLite backendを推奨。
SQLite storageのFree枠はD1と同等のrows read/write limit体系。
`setAlarm()`は1 row writtenとして数えられる。

Official docs:
- Durable Objects Pricing
- Durable Objects Overview
- SQLite-backed Durable Object Storage

設計への反映：

- D1を使わずsingleton DOをDB兼schedulerにする
- 正常時monitor UPDATEなし
- monitor 0件ではAlarm削除
- small installではscheduler_state UPDATEすら不要

## Durable Object Alarms

Cloudflare公式best practiceでは、Alarmは仕事がある場合のみ設定する。
Alarmは自動repeatではないため、handler内で次Alarmを設定する。

Official docs:
- Rules of Durable Objects / Scheduling and lifecycle
- Alarms API

設計への反映：

- fixed Cron 0本
- 0 monitor = 0 scheduled work
- backlogがあれば数秒後continuation
- cycle完了ならcycle start + 約22hへ次Alarm

## Discord Interactions

DiscordはGateway以外にoutgoing webhook方式のHTTP Interactionsを正式サポート。
HTTP endpointではEd25519署名検証が必須。
Interactionにはguild_id、channel_id、member permissions、app_permissions等が含まれる。

Official docs:
- Discord Receiving and Responding to Interactions
- Discord Application Commands

設計への反映：

- Gatewayなし
- `/interactions`
- raw body + timestampの署名検証
- Guild-only command
- addを実行したchannelをalert destinationとして保存
- app_permissionsから投稿権限を事前確認

## Discord REST rate limits

Discordはrate-limit値をhard-codeせずresponse headersを利用するよう推奨。
429にはRetry-Afterがある。
Bot global API limitも存在する。

Official docs:
- Discord Rate Limits

設計への反映：

- Discord POSTもexternal request budgetを1消費
- 429時pending notifyとしてRetry-After後Alarm
- 5xx/networkも短時間retry
- 401/403/404等でimmediate infinite retryしない

## Discord message deduplication

Discord Create Messageは`nonce`と`enforce_nonce`をサポートし、同じauthor/nonceの短時間の重複作成を抑制できる。

Official docs:
- Discord Message Resource / Create Message

設計への反映：

- DOWN通知に`dw-<monitorId>`形式のnonceを付ける
- `enforce_nonce: true`
- retryable network ambiguity時のduplicate alert確率を追加DBなしで下げる
