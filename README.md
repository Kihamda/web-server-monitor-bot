# Webサーバ監視bot

<p align="center">
  <img src="assets/web-server-monitor-icon.png" alt="Webサーバ監視botのアイコン" width="192">
</p>

Webサーバ監視botは、登録したHTTP/HTTPS URLが長期間停止したまま見逃される事態を、Cloudflare Workers Freeの範囲で防ぐための個人運用Botです。
高頻度な死活監視や可用性集計ではなく、1日1回程度の確認を、平常時の通信、書き込み、通知を抑えて続けることに目的を絞っています。

## このBotが解く問題

個人開発のAPIやWebサイトでは、分単位の監視より「数日間止まっていたのに気付かなかった」を防ぐ仕組みが必要な場合があります。
そこで、通常はおおむね22時間周期でURLを確認し、新しいDOWNだけをDiscordへ通知します。

- 正常時はDiscordへ通知しません。
- HEADが失敗した場合だけGETで再確認します。
- DOWN継続中は再通知しません。
- 復旧通知は送りません。
- 復旧後に再びDOWNした場合は通知します。
- チェック時刻、成功率、応答時間、障害履歴は保存しません。
- 1 Discordサーバーにつき最大10 URL、Bot全体で最大1000 URLに制限します。

この割り切りにより、監視対象がすべて正常なら、1 URLあたり1回のHTTP requestと次回Alarmの予約だけで1周期が終わります。

## 設計上の判断

| 制約 | 実装判断 | 得られる効果 |
| --- | --- | --- |
| 予算を0円に保つ | Workers FreeとSQLite-backed Durable Objectだけを使う | 外部DBや常駐サーバーが不要になる |
| ジョブ数を増やさない | 全監視先をsingleton Durable Objectで扱う | monitorごとのCronやAlarmを作らずに済む |
| 平常時の消費を抑える | 正常時はHEADだけを送る | 外部requestを1件に抑えられる |
| 誤検知を減らす | HEAD失敗時だけRange付きGETを送る | 一時的なHEAD拒否と停止を区別しやすくなる |
| 50-request境界を守る | 件数ではなく外部request数を動的に数える | 正常なURLを固定16件で打ち切らず、1 Alarmで最大50件確認できる |
| 履歴書き込みを避ける | 現在の障害を通知済みかだけを保存する | 正常確認ごとのUPDATEや履歴INSERTが発生しない |
| Discord常時接続を避ける | HTTP Interactionsを使う | Gateway WebSocketと常駐プロセスが不要になる |

Cron、D1、Queues、Workflows、Discord Gateway、外部監視SaaSは使用しません。
機能を増やすより、無料枠の消費を予測可能にすることを優先しています。

## アーキテクチャ

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
        +-- scheduler_state table
        +-- Alarm
              |
              +-- monitored URL
              +-- Discord REST API only on a new DOWN
```

WorkerはDiscordのslash commandを受け、固定名`global`から得た1個のDurable Objectへ登録情報を集約します。
Durable ObjectはSQLiteを保存先として使い、同じインスタンスのAlarmで監視を逐次実行します。

monitorごとにDurable Objectを作らないため、監視件数が増えても定期ジョブ数はmonitor数に比例しません。
50件を超える処理だけを数秒後のAlarmへ継続します。

## 動的50-request scheduler

1 Alarm invocationで使用できる外部subrequestを50個のbudgetとして扱います。
monitor件数を固定batchへ分割するのではなく、fetch直前にbudgetを1個ずつ消費します。

```text
正常:          HEAD                 = 1 request
HEAD失敗:      HEAD + GET           = 2 requests
新しいDOWN:    HEAD + GET + Discord = 3 requests
```

この方式では、監視先の状態によって1 Alarmで処理できる件数が変わります。

```text
3件すべて正常       -> 3 requestsで周期完了
50件すべて正常      -> 50 HEADで周期完了
25件すべて二重確認  -> 25 x 2 requestsで周期完了
```

redirectは`manual`に固定しています。
redirect chainを自動追跡すると、コード上のfetch回数より実際のsubrequest数が増え、budget accountingが崩れるためです。

### Alarm境界の継続

50個目のrequestでmonitor処理が途中になった場合だけ、SQLiteへcontinuationを保存します。

- HEAD失敗後にbudgetが尽きた場合は`confirm`を保存し、次のAlarmをGETから始めます。
- GET失敗後にbudgetが尽きた場合は`notify`を保存し、次のAlarmをDiscord通知から始めます。
- Discordが429を返した場合は`Retry-After`を読み、`notify`を保持したまま再試行します。
- pending中のmonitorが削除されていた場合は通知を破棄し、次のmonitorへ進みます。

HEADやGETを最初からやり直さないため、監視漏れを防ぎながら、消費済みrequestを重複させません。

## DOWN状態の管理

SQLiteの`monitors` tableには、監視に必要な情報と`down_notified`だけを保存します。

```text
0 = 現在の障害をまだ通知していない
1 = 現在の障害をすでに通知した
```

正常時に`down_notified`が0なら、DB writeは発生しません。
HEADとGETが両方失敗し、Discord通知に成功した場合だけ0から1へ更新します。
その後にaliveを確認した場合は通知を送らず、内部フラグだけを1から0へ戻します。

この状態遷移により、障害履歴tableを作らなくても、継続障害の再通知を抑え、復旧後の再障害を通知できます。

## セキュリティ

公開HTTP endpointと任意URLへのfetchを扱うため、次の制約を実装しています。

- Discordの`X-Signature-Ed25519`と`X-Signature-Timestamp`をraw bodyに対して検証します。
- `Manage Guild`またはAdministrator権限をruntimeでも確認します。
- 登録時にBotのSend Messages権限を確認します。
- interaction応答とDOWN通知では`allowed_mentions`を空にします。
- DOWN通知のmonitor名をMarkdown escapeします。
- Discord通知にmonitor ID由来の`nonce`と`enforce_nonce`を付けます。
- 429では`Retry-After`を読み、5xxとnetwork errorは短時間後に再試行します。
- 401、403、404などのpermanent failureでは即時retry loopを作りません。
- HTTP/HTTPS以外、credential付きURL、localhost、literal private address、link-local、multicast、IPv4-mapped IPv6を拒否します。
- 監視fetchは6秒でtimeoutし、response bodyを保存しません。

DNS解決後のprivate address判定は、追加の外部requestを発生させずに実現できないため、この実装には含めていません。
この制約は`CODEX_SPEC.md`にも明記し、実装が保証する範囲を限定しています。

## 正常時の消費

3 monitorsがすべて正常なら、1周期の処理は概ね次のとおりです。

```text
Alarm invocation     1
URL fetch            3
Discord message      0
monitor UPDATE       0
history INSERT       0
setAlarm write       1
```

monitorが0件になった場合はAlarmを削除します。
監視対象がない状態では、定期実行も0回になります。

## Slash commands

```text
/monitor add name:<name> url:<url>
/monitor list
/monitor remove name:<name>
```

`add`を実行したチャンネルがDOWN通知先になります。
すべての管理commandはephemeral responseを返し、status、履歴、interval設定は提供しません。

## セットアップ

### 必要なもの

- Node.jsの現行LTS版
- Cloudflare Workers Freeを利用できるアカウント
- Discord ApplicationとBot

### Discord Application

1. [Discord Developer Portal](https://discord.com/developers/applications)でApplicationを作成します。
2. Botを作成します。
3. Public BotをOFFにします。
4. Guild Installで`bot`と`applications.commands`を有効にします。
5. Botへ通知先チャンネルのSend Messages権限を与えます。
6. Application ID、Public Key、Bot Tokenを控えます。

Public BotをOFFにすることで、Botを追加できる人をApplication所有者側へ限定します。
コードは特定Guild IDを固定せず、所有者がインストールした複数Guildを扱えます。

### 依存関係とCloudflare認証

```bash
npm install
npx wrangler login
```

### Secret

実クレデンシャルはGitへ保存しません。
deploy前にCloudflare secretとして設定します。

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_TOKEN
```

ローカル開発で値が必要な場合だけ、`.dev.vars.example`を`.dev.vars`へコピーして設定します。
`.dev.vars`、`.env`、実際のtokenとpublic keyは`.gitignore`で除外しています。

### Deploy

```bash
npm run deploy
```

Worker URLが次の形式だったとします。

```text
https://discord-watch-bot.<account>.workers.dev
```

Discord Developer PortalのInteractions Endpoint URLには、次のURLを設定します。

```text
https://discord-watch-bot.<account>.workers.dev/interactions
```

Discordは保存時に署名付きPINGを送り、Workerは検証成功後にPONGを返します。

### Slash command登録

PowerShellでは、Application IDとBot Tokenをprocess environmentへ設定して登録します。

```powershell
$env:DISCORD_APPLICATION_ID = "..."
$env:DISCORD_TOKEN = "..."
npm run register
```

Bashでは次のように設定します。

```bash
export DISCORD_APPLICATION_ID="..."
export DISCORD_TOKEN="..."
npm run register
```

登録scriptは`/monitor`のglobal application commandをbulk overwriteします。
command contextはGuildのみに制限しています。

## 検証

実クレデンシャルなしで、Workers runtime上のSQLite-backed Durable ObjectとAlarmを検証できます。

```bash
npm run check
```

このcommandは本体とテストコードのstrict型検査を行った後、Workers Vitest integrationで45 test casesを実行します。

検証対象には次の境界を含みます。

- 50回目まではbudgetを取得でき、51回目は取得できないこと
- 50件すべて正常なら1 Alarmで完了すること
- 51件目がある場合だけcontinuationを保存すること
- 49件成功後のHEAD失敗を`confirm`から再開すること
- 48件成功後のHEADとGET失敗を`notify`から再開すること
- DOWN継続、復旧、復旧後の再DOWNが正しく遷移すること
- Discord 429、500、network error、403を区別すること
- pending monitorの削除後に古い通知を送らないこと
- Guild上限、global上限、重複登録、最後のmonitor削除を処理すること
- Discord署名、PING、権限、URL制限を検証すること

Cloudflareへ接続せずdeploy bundleを確認する場合は、次のcommandを使えます。

```bash
npx wrangler deploy --dry-run
```

## 生存判定の範囲

このBotは、HTTP endpointから応答が返るかを確認します。
ページ内容、JSON schema、TLS証明書期限、DNS、応答時間は監視しません。

```text
HTTP 100-499       -> alive
HTTP 500-599       -> failure candidate
timeout/network    -> failure candidate
```

404、401、403、429でもHTTP serverが応答しているためaliveとして扱います。
HEADとGETが両方failure candidateになった場合だけ、新しいDOWNとして通知します。

## 仕様書

- `CODEX_SPEC.md`：実装要件、状態遷移、境界条件、Definition of Done
- `RESEARCH_NOTES.md`：設計判断に使用した公式資料の要点
- `CODEX_PROMPT.md`：初回実装と検証に使用した作業指示

READMEだけで運用を始められますが、schedulerの境界条件を変更する場合は`CODEX_SPEC.md`を先に確認してください。

## License

このリポジトリは技術的な参照のために公開していますが、オープンソースとして利用を許諾するものではありません。
[GitHub利用規約](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)と適用法令が認める範囲を除き、第三者による複製、改変、再配布、実行、deploy、運用を許諾しません。

詳細は[LICENSE](LICENSE)を参照してください。
