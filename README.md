# Discord Watch Bot v4

予算0円・低消費を最優先した、Cloudflare Workers上のDiscord URL生存確認Bot。

## 挙動

- BotはPrivate運用前提。
- 複数Discordサーバー対応。
- 1サーバー最大10 URL。
- interval設定なし。
- 正常時はDiscordへ何も送らない。
- URLは通常おおむね22時間周期で確認。
- HEADが失敗した場合だけGETで再確認。
- HEAD/GETの両方が失敗した新規DOWNだけ通知。
- DOWN継続中は再通知しない。
- 復旧通知もしない。
- 復旧後に再度DOWNした場合は再通知。
- チェック履歴は保存しない。

## Architecture

```text
Discord HTTP Interactions
        |
        v
Cloudflare Worker
        |
        v
singleton SQLite-backed Durable Object
        |
        +-- monitors table
        +-- scheduler continuation state
        +-- Alarm
              |
              +-- monitored URL
              +-- Discord REST only on DOWN
```

Cron、D1、Queues、Gatewayは使わない。

## dynamic 50-request scheduler

Cloudflare Workers Freeのexternal subrequest上限を1 Alarmあたり50のbudgetとして扱う。

```text
normal:       HEAD                 = 1
HEAD failure: HEAD + GET           = 2
new DOWN:     HEAD + GET + Discord = 3
```

固定16件batchではない。

例：

```text
3件すべて正常   -> 3 external requests / Alarm
50件すべて正常  -> 50 / Alarm
25件すべて再確認 -> 50 / Alarm
```

budgetの途中でmonitor処理が止まった場合だけ、SQLiteへ`confirm`または`notify` continuationを保存し、数秒後の次Alarmでその地点から再開する。

## Commands

```text
/monitor add name:<name> url:<url>
/monitor list
/monitor remove name:<name>
```

`add`したチャンネルがDOWN通知先になる。
管理コマンドはManage Guild権限を持つユーザー向け。

## Discord setup

1. Discord Developer PortalでApplicationを作成。
2. Botを作成。
3. **Public BotをOFF**にする。
4. Guild Installで `bot` と `applications.commands` を有効にする。
5. Botに少なくとも通知先チャンネルのSend Messages権限を与える。
6. Application ID、Public Key、Bot Tokenを控える。

Botを追加できる人をDeveloper Portal側で制限しつつ、インストール先Guildは複数対応する。

## Cloudflare setup

```bash
npm install
npx wrangler login
```

Secrets:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_TOKEN
```

Deploy:

```bash
npm run deploy
```

Worker URLが例として：

```text
https://discord-watch-bot.<account>.workers.dev
```

ならDiscord Developer PortalのInteractions Endpoint URLへ：

```text
https://discord-watch-bot.<account>.workers.dev/interactions
```

を設定する。

Discordはendpoint保存時にPINGを送る。Workerは署名検証後PONGを返す。

## Register Slash Command

```bash
export DISCORD_APPLICATION_ID="..."
export DISCORD_TOKEN="..."
npm run register
```

登録scriptはglobal commandをbulk overwriteする。
command contextはGuildのみ。

## Typecheck

```bash
npm run typecheck
```

## Local test

実クレデンシャルなしで、Workers runtime上のDurable Object SQLiteとAlarmを含むテストを実行できる。

```bash
npm test
```

型検査とテストをまとめて実行する場合：

```bash
npm run check
```

ローカル開発用の値が必要になった場合だけ `.dev.vars.example` を `.dev.vars` へコピーして値を設定する。
`.dev.vars`、`.env`、実際のDiscord token/public keyはGitへ追加しない。
deploy時のsecretは前述の `wrangler secret put` で後から設定できる。

## Database

Durable Object内蔵SQLiteのみ。

### monitors

保存するのは：

```text
id
guild_id
channel_id
name
url
down_notified
```

成功履歴、確認時刻、latency、uptime率は保存しない。

### scheduler_state

50 external request boundaryをまたいだときだけ使うcontinuation state。
health historyではない。

## Normal-state cost characteristics

3 monitorsが全て正常なら1cycleで概ね：

```text
Alarm invocation     1
URL fetch            3
Discord message      0
monitor UPDATE       0
history INSERT       0
setAlarm write       1
```

monitorが0件ならAlarmを削除する。

## Alert

例：

```text
🔴 DOWN
API Server
https://example.com/health
```

正常時・復旧時は通知しない。

## Important behavior

このBotは「HTTP endpointが応答しているか」を確認する。

```text
100-499 -> alive
500-599 -> failure candidate
timeout/network failure -> failure candidate
```

404や401でもWebサーバーから応答があるためalive扱い。
ページ内容の正しさを監視するBotではない。

詳細仕様は `CODEX_SPEC.md` を参照。
