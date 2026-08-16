# Discord Watch Bot v4 — Codex Implementation Specification

## 0. この文書の扱い

この文書は、このリポジトリにおける最上位の実装仕様である。
実装と本文が矛盾する場合、Codexはこの文書の意図を優先し、既存コードを修正すること。
ただしCloudflare Workers / Durable Objects / Discord APIの現行公式仕様と矛盾する場合は、公式仕様を確認し、安全かつ無料枠消費の少ない方向に修正したうえで、その差分を報告すること。

このBotは一般的な高頻度uptime monitorではない。
目的は「登録したHTTP/HTTPS監視先が長期間停止したまま誰も気付かない」ことを、予算0円かつ極小のプラットフォーム消費で防ぐことである。

最上位の優先順位は以下。

1. 課金を発生させない。
2. Cloudflare Free枠の消費を最小化する。
3. 正常時はDiscord上で完全に無音にする。
4. 各登録先を通常時おおむね22時間周期で確認し、少なくとも1日1回程度の確認を維持する。
5. 異常時のみ、登録名と監視URLをDiscordへ通知する。
6. 誤検知を減らすため、失敗時のみ追加確認を行う。
7. 固定件数batchではなく、1 Durable Object Alarm invocationに許された外部subrequest 50件を状態に応じて動的に利用する。
8. 履歴・成功率・latency履歴・incident履歴など、本目的に不要なデータを保存しない。
9. 構成要素を増やさない。Cron / D1 / Queues / Workflows / Agents / VPS /外部SaaSは使用しない。

---

# 1. 固定要件

## 1.1 予算

予算は0円。

「Free tierを使い切ったらPaidへ自動移行する」「枠超過時は従量課金で吸収する」といった設計は禁止。
有料サービスへのfallbackも禁止。

Cloudflare Workers Free + SQLite-backed Durable Objectsの範囲に限定する。

コード側にも以下の思想を反映すること。

- Wranglerのsubrequest limitを50に固定する。
- 無限retryをしない。
- 平常時DB writeを極力行わない。
- monitorが0件ならAlarmを保持しない。
- monitor数に比例しない固定Cronを作らない。
- 正常チェック結果を履歴保存しない。

## 1.2 Discord Botの公開範囲

Discord Developer PortalでPublic BotをOFFにする。
Botをサーバーへ追加できるのはアプリ所有者側だけとする。

ただしBot自体は最初から複数Guild対応とする。
特定Guild IDをコードへ固定しない。
Guildごとに独立して監視先を登録できる。

## 1.3 Guildごとの上限

1 Guildにつき最大10 monitor。

```text
MAX_PER_GUILD = 10
```

Bot全体の安全弁として以下も設ける。

```text
MAX_GLOBAL_MONITORS = 1000
```

この上限はFree枠を使い切るための目標値ではなく、設定ミスや意図しない大量登録に対するhard capである。

## 1.4 interval

ユーザーがintervalを指定する機能は禁止。

以下は作らない。

- 1分/5分/1時間/24時間などのinterval choice
- cron expression入力
- check frequency編集
- Guildごとのfrequency

Botが内部scheduleを管理する。

## 1.5 平常時

正常ならDiscord通知は0件。

以下も送らない。

- 「正常でした」
- 日次レポート
- 復旧通知
- uptime統計
- latency統計
- scheduler正常通知

`/monitor add`, `/monitor list`, `/monitor remove`へのephemeral応答はユーザー操作に対する返答なので許可する。

## 1.6 DOWN通知

新しいDOWNを確認した場合のみ、登録時のチャンネルへ通常メッセージを1回送る。

最低限の表示内容は以下。

```text
🔴 DOWN
<name>
<url>
```

名前とURLが明確に分かればよい。
余計なuptime率、時系列、latency、障害原因推測は表示しない。

同じ障害が継続している間は再通知しない。
復旧したら内部フラグだけ解除し、通知しない。
その後再度DOWNになれば再通知する。

---

# 2. 採用アーキテクチャ

## 2.1 全体

```text
Discord
  |
  | HTTPS Interaction
  v
Cloudflare Worker
  |
  | internal Durable Object stub
  v
MonitorScheduler (singleton Durable Object)
  |
  +-- SQLite-backed DO storage
  |     +-- monitors
  |     +-- scheduler_state
  |
  +-- Alarm API
         |
         +-- monitored endpoint fetch
         +-- Discord REST alert only on new DOWN
```

## 2.2 禁止構成

以下は使用しない。

- Discord Gateway常時接続
- discord.js
- HonoなどのWeb framework
- D1
- KV
- R2
- Cloudflare Cron Trigger
- Queues
- Workflows
- Agents SDK
- 外部DB
- 外部monitoring SaaS
- VPS

理由は依存・ジョブ・保存先・枠消費を最小化するため。

## 2.3 Singleton Durable Object

Durable Object namespace `MONITOR_SCHEDULER` に対し、固定名 `global` から得た1 instanceのみ使う。

全monitorをこの1 DO内のSQLiteへ保存する。

monitorごとにDurable Objectを作らない。

monitorごとにDOを作るとmonitor数とAlarm invocation数がほぼ比例するため、本用途の「ジョブ数を減らす」という目的に反する。

---

# 3. SQLite設計

## 3.1 monitors

```sql
CREATE TABLE monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  down_notified INTEGER NOT NULL DEFAULT 0 CHECK (down_notified IN (0, 1)),
  UNIQUE(guild_id, name),
  UNIQUE(guild_id, url)
);
```

必要ならGuild listを効率化するため次のindexを持つ。

```sql
CREATE INDEX monitors_guild_id_idx ON monitors(guild_id, id);
```

### 保存しないもの

以下の列・tableを追加してはならない。

- check_results
- incidents
- last_checked_at
- last_success_at
- last_failure_at
- latency
- average_latency
- HTTP response history
- success_rate
- uptime_percentage
- created_at（本目的では不要）
- updated_at
- per-monitor interval
- next_check_at

履歴は0件とする。

## 3.2 down_notified

これはhealth historyではない。

意味はただ1つ。

```text
0 = 現在の障害についてDiscord通知をまだ送っていない
1 = 現在の障害についてDiscord通知をすでに送った
```

正常チェックで0ならwriteしない。

DOWN確定 + Discord通知成功時のみ0 -> 1。

その後aliveを確認した場合のみ1 -> 0。

復旧メッセージは送らない。

## 3.3 scheduler_state

```sql
CREATE TABLE scheduler_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor_id INTEGER NOT NULL DEFAULT 0,
  pending_monitor_id INTEGER,
  pending_stage TEXT CHECK (pending_stage IN ('confirm', 'notify') OR pending_stage IS NULL),
  cycle_started_at INTEGER NOT NULL DEFAULT 0
);
```

これは履歴ではない。
1 invocationの外部subrequest予算を使い切った場合に、次のAlarmが正確な地点から処理を続行するためだけのcontinuation stateである。

### cursor_id

最後まで処理完了したmonitor ID。

keyset paginationに使用する。

```sql
WHERE id > ?
ORDER BY id
LIMIT 51
```

OFFSETは禁止。

### pending_monitor_id / pending_stage

50個目のexternal requestをmonitor処理の途中で使った場合に使う。

例：

```text
49 monitors = success
budget used = 49

monitor 50
HEAD = failure
budget used = 50

GET confirmation cannot run
```

この場合：

```text
cursor_id = monitor 49
pending_monitor_id = monitor 50
pending_stage = confirm
```

次のAlarmはmonitor 50のGET確認から始める。
HEADをもう一度無駄に送らない。

同様に、confirmation failureで50件目を使い切りDiscord通知枠が無ければ：

```text
pending_stage = notify
```

とする。

### cycle_started_at

複数Alarmに分割されたcycleの開始時刻。

大量monitorやtimeoutが多い場合でも、次cycleを「最終batch終了から22時間後」にして24時間以上の間隔が生じないよう、cycle開始を基準に次回Alarmを決める。

小規模で1 Alarm内に全件収まる場合、scheduler_stateのcycle_started_atを書き込む必要はない。in-memoryの開始時刻だけで次Alarmを設定する。

---

# 4. Schedulerの最重要仕様：dynamic subrequest budget

## 4.1 固定BATCH_SIZEは禁止

以下のような実装は禁止。

```ts
const BATCH_SIZE = 16;
```

16という数値は「全monitorが新規DOWNで3 external requestsを使う場合の最悪値」にすぎない。
平常時は大部分が1 requestで完了する。

したがってmonitor数ではなく外部subrequest数をbudgetとする。

```ts
MAX_EXTERNAL_SUBREQUESTS = 50
```

## 4.2 1 monitorあたりのcost

### 正常

```text
HEAD -> alive
cost = 1
```

### HEADのみ失敗、GETでalive

```text
HEAD -> failure
GET  -> alive
cost = 2
```

### 既にDOWN通知済みで停止継続

```text
HEAD -> failure
GET  -> failure
down_notified = 1
cost = 2
Discord request = 0
```

### 新規DOWN

```text
HEAD -> failure
GET  -> failure
Discord alert -> success
cost = 3
```

## 4.3 例

### 3 monitorすべて正常

```text
Alarm #1
HEAD A = success
HEAD B = success
HEAD C = success

external requests = 3
monitor writes = 0
Discord alerts = 0
next Alarm ~= cycleStart + 22h
```

残り47枠を無意味に使わない。

### 50 monitorすべて正常

```text
50 x HEAD = 50
```

1 Alarmで50 monitor完了。

### 25 monitorすべて二重確認まで必要、通知済みDOWN

```text
25 x (HEAD + GET) = 50
```

1 Alarmで25 monitor完了。

### 新規DOWNのみ

```text
16 x (HEAD + GET + Discord) = 48
```

17件目のHEADまでなら49、GETまで行けば50、必要ならcontinuationを保存する。

重要：最初から3枠reserveしないこと。

## 4.4 budgetの取り方

external fetchを開始する直前にtokenを1個取得する。

```ts
if (!budget.tryTake()) {
  // continuationを保存
}
await fetch(...)
```

以下はexternal budgetを1消費する。

- monitored endpointへのHEAD
- monitored endpointへのGET
- Discord REST APIへのPOST

以下はexternal 50枠として数えない前提でよい。

- DO SQLite SQL
- Alarm set/delete
- Durable Object内部状態操作

ただしCloudflareの公式仕様が変わった場合は現行仕様を優先する。

## 4.5 redirect

監視fetchは必ず：

```ts
redirect: "manual"
```

とする。

redirect chainをfollowすると1回のコード上のfetchが複数subrequestsへ増える可能性があり、budget accountingが壊れる。

301/302/307/308はHTTPサーバーから応答があったのでaliveとしてよい。

## 4.6 並列化しない

v4ではmonitor probeを原則逐次処理する。

理由：

- ジョブ数の最小化が目的であり、1cycleの数秒短縮は重要ではない。
- shared budgetとcontinuation cursorを単純に保てる。
- 50件目で切れたmonitorが最大1件になる。
- pending actionを1件だけ保存すればよい。
- Durable Objectの同時outgoing connection制約を意識しなくてよい。

1 Alarm handlerのwall-clock上限内で1000 monitorを1 invocationに詰めるわけではない。50 external requestsごとにAlarmを分割するため、逐次処理でよい。

---

# 5. Alarm cycle

## 5.1 monitor 0件

Alarmを保持しない。

```text
monitor count = 0
-> deleteAlarm()
```

定期実行0回/dayを目指す。

## 5.2 最初のmonitor追加

Alarmが無い場合のみ、約60秒後へ最初のAlarmを設定する。

```text
/monitor add
-> INSERT
-> getAlarm() == null
-> setAlarm(now + 60 sec)
```

登録時に監視URLへ即fetchしない。
ユーザー操作ごとに外部監視requestを増やさないため。

## 5.3 通常cycle

cycle開始時刻をTとする。

全monitorが1 invocationで終われば：

```text
next alarm = max(now + 1min, T + 22h)
```

22時間なのはCloudflare側の遅延・大量monitor処理時間への余裕を取り、24時間超を避けやすくするため。

## 5.4 continuation

50 external budgetを使い切り、まだmonitorが残る場合：

```text
persist scheduler_state
setAlarm(now + 5 sec)
```

次Alarmはcursor/pendingから再開。

## 5.5 Discord alert retry時

Discord APIが429、5xx、network errorの場合、通知を優先する。

この場合だけ、remaining budgetがあってもAlarm処理を終了してよい。

理由：

- pending alertを複数持つqueueを作らない。
- Queue等の別サービスを導入しない。
- 「監視を50件まで埋める」より「確認済みDOWNの通知を届ける」を優先する。

429なら`Retry-After`またはJSON `retry_after`を読む。
retry値を1秒〜15分程度へclampして次Alarmを設定する。

5xx/network failureなら60秒後程度。

この例外を除き、backlogが存在する限り50 external budgetをできるだけ使う。

---

# 6. HTTP生存判定

## 6.1 目的

このBotはcontent correctness monitorではない。
HTTP endpointが応答しているかを見る。

## 6.2 primary

```text
HEAD <url>
```

timeoutは6秒程度。

```ts
redirect: "manual"
```

## 6.3 alive判定

```text
HTTP 100-499 = alive
HTTP 500-599 = failure candidate
network failure = failure candidate
timeout = failure candidate
```

404、401、403、429でもHTTPサーバーが応答しているためalive。

## 6.4 confirmation

primaryがfailure candidateの場合のみ：

```text
GET <url>
Range: bytes=0-0
```

を行う。

GETが100-499ならalive。
GETも500-599 / timeout / network failureならDOWN確定候補。

この二段階により、平常時は1request、異常候補時だけ2requestにする。

response bodyは不要。
可能なら`response.body?.cancel()`する。

---

# 7. DOWN状態遷移

## 7.1 通常

```text
down_notified=0
HEAD alive
-> nothing
```

DB write 0。

## 7.2 一時的HEAD失敗

```text
HEAD failure
GET alive
-> nothing
```

DB write 0。
Discord 0。

## 7.3 新規DOWN

```text
down_notified=0
HEAD failure
GET failure
Discord POST success
-> down_notified=1
```

monitor table writeはここで初めて発生。

## 7.4 DOWN継続

```text
down_notified=1
HEAD failure
GET failure
-> nothing
```

Discord 0。
DB write 0。

## 7.5 復旧

```text
down_notified=1
HEAD or confirmation GET alive
-> down_notified=0
```

Discord 0。
DB write 1。

## 7.6 再障害

復旧で0へ戻った後に再び二重failureした場合、新規DOWNとして通知する。

---

# 8. Discord Integration

## 8.1 Gateway禁止

Gateway websocket接続は使用しない。

Discord HTTP Interactions Endpointを使う。

Worker endpoint：

```text
POST /interactions
```

## 8.2 署名検証

必須。

ヘッダー：

- X-Signature-Ed25519
- X-Signature-Timestamp

`timestamp + rawBody`をDiscord public keyでEd25519 verifyする。

署名NGなら401。

PINGにはPONGを返す。

## 8.3 Slash commands

提供するのは3つのみ。

```text
/monitor add name:<string> url:<string>
/monitor list
/monitor remove name:<string>
```

interval/status/check-now/stats/history/settings/pause/resume等は作らない。

## 8.4 Guild-only

Application CommandはGuild contextだけで利用可能にする。

global command registration自体は可。
Botがinstallされた複数Guildで同一commandが利用できる。

## 8.5 実行権限

`Manage Guild`またはAdministratorを持つユーザーだけ管理commandを実行可能とする。

Discord command registrationの`default_member_permissions`でもManage Guildを指定し、runtimeでも再確認する。

## 8.6 通知channel

`/monitor add`を実行したchannel IDを保存する。

DOWN通知はそのchannelへ送る。

add時点でInteractionの`app_permissions`を確認し、BotにSend Messages相当の権限が無い場合は登録を拒否する。

これにより後日の403を減らす。

## 8.7 Interaction応答

add/list/removeはephemeral。

`allowed_mentions: { parse: [] }`を必ず指定する。
monitor nameからmentionを発生させない。

## 8.8 DOWN通知

Discord REST：

```text
POST /api/v10/channels/{channel_id}/messages
Authorization: Bot <token>
```

本文の例：

```text
🔴 DOWN
API Server
https://example.com/health
```

URL previewは抑制する。
allowed_mentionsは空。
nameはMarkdown escapeする。

Discord Create Messageではmonitor ID由来の短い`nonce`と`enforce_nonce: true`を指定し、通知POST成功直後の通信断などによる短時間のretryで同一DOWNメッセージが重複しにくいようにする。nonceは秘密情報を含めない。

---

# 9. Discord rate limit

Discord APIのrate limit値をhard-codeしない。

429時はRetry-Afterを読む。

このBotのAlarm 1 invocationでは、endpoint二重確認も含め50 external subrequests以内なので、全monitorが新規DOWNでもDiscord通知だけが50回送られることはない。

それでも429は正常に処理する。

401/403/404等のpermanent failureはalarm retry loopを作らない。
console.errorへ最小限記録し、down_notifiedは0のままとする。
まだDOWNなら次cycleに通知を再試行する。

---

# 10. URL安全性

登録可能なのはHTTP/HTTPSのみ。

禁止：

- username/password付きURL
- localhost
- .localhost
- .local
- .internal
- literal private IPv4 ranges
- loopback
- link-local
- CGNAT range
- multicast/reserved ranges
- obvious literal private IPv6/loopback

URL fragmentは削除して保存する。

DNS解決を行うために追加の外部requestを入れない。
Free枠消費を増やすSSR F検証サービス等も使わない。

セキュリティと無料枠の両立上、追加の名前解決が必要な対策を入れる場合は、まずCloudflare Workers内で外部subrequestなしに実現できるか確認すること。

---

# 11. Free枠最適化

## 11.1 正常3件の理想値

1 cycleあたり：

```text
Alarm invocation: 1
endpoint fetch: 3
Discord fetch: 0
monitor UPDATE: 0
history INSERT: 0
scheduler_state UPDATE: 0
setAlarm: 1 write
```

## 11.2 正常50件

```text
Alarm invocation: 1
endpoint fetch: 50
monitor UPDATE: 0
Discord fetch: 0
setAlarm: 1 write
```

## 11.3 正常1000件

理論上おおむね20 Alarm/cycle。

```text
1000 / 50 = 20
```

continuation state writeはAlarm境界ごとにのみ行う。
monitorごとにcursorを書かない。

## 11.4 禁止されるwrite-heavy実装

以下は禁止。

```text
成功のたびに last_checked_at UPDATE
成功のたびに check_results INSERT
monitorごとに next_check_at UPDATE
monitorごとに scheduler cursor UPDATE
```

---

# 12. continuationの正確性

以下を満たすこと。

### ケースA：50件すべて成功

- ID 1..50を確認
- cursor stateを永続化せずcycle completeしてよい
- ID 51が存在する場合のみcursor=50を保存しcontinuation

### ケースB：49件成功、50件目HEAD failure

- external budget=50
- pending_monitor_id=50
- pending_stage=confirm
- cursor_id=49
- 次AlarmはGETから開始

### ケースC：48件成功、49件目HEAD failure + GET failure

budget：

```text
48 success = 48
HEAD = 49
GET = 50
```

Discord通知は次Alarm。

state：

```text
cursor_id=48
pending_monitor_id=49
pending_stage=notify
```

### ケースD：通知retryable failure

- pending_stage=notifyを保持
- Discord retry-afterに合わせてAlarm
- endpointのHEAD/GETを再実行しない

### ケースE：pending monitorがremove済み

- そのpending actionを破棄
- cursorをそのIDまで進める
- 次monitorへ進む

---

# 13. Database concurrency / race

Singleton Durable Object内でSQLiteを扱うため、D1ベースの分散leaseは不要。

monitor add/remove interactionとalarmが同じDO instanceへ到達する。

ただしnetwork `await fetch()`中にはinterleavingが起こり得る前提で実装する。

DOWN通知直前にmonitorがremoveされている可能性を考慮し、Discord POST直前にmonitor IDの存在をSQLiteで再確認する。

削除済みなら通知しない。

---

# 14. Command UX

## /monitor add

入力：

```text
name
url
```

成功：

```text
✅ API Server を登録しました。
https://example.com/health
正常時は通知しません。
```

ephemeral。

11件目：

```text
このサーバーでは最大10件まで登録できます。
```

同じGuild内のnameまたはURL重複を拒否。

## /monitor list

登録順に：

```text
1. API — https://...
2. Website — https://...

2/10件
```

statusは表示しない。
「現在UPかDOWNか」をDBに履歴として保持しないため。

## /monitor remove

name完全一致で削除。

成功：

```text
🗑️ API を削除しました。
```

最後のmonitorが消えたらAlarmも削除する。

---

# 15. Private Bot setup

READMEに以下を明記する。

1. Discord Developer PortalでApplication作成
2. Bot作成
3. Public BotをOFF
4. Guild Installで`bot` + `applications.commands`
5. Botに少なくともSend Messages権限
6. Cloudflare Worker deploy
7. `DISCORD_PUBLIC_KEY` secret
8. `DISCORD_TOKEN` secret
9. Worker `/interactions`をInteractions Endpoint URLに設定
10. global application commandを登録

Botを追加できる範囲をコード側のGuild allowlistで制限する必要はない。
Public Bot OFFが主制御。

---

# 16. Logging

正常checkはconsole.logしない。

ログ対象：

- Interaction署名エラーはHTTP statusのみでよい
- internal unexpected error
- Discord permanent notification error
- Alarm unexpected exception

監視URLのresponse bodyをログへ出さない。
Discord token/public keyをログへ出さない。
Authorization headerをログへ出さない。

---

# 17. Error handling

## endpoint failure

監視対象のfailure。
HEAD + GETの両方がfailureならDOWN扱い。

## Cloudflare/Discord infrastructure failure

監視対象のDOWNとは区別する。

以下をendpoint DOWNとして記録してはならない。

- SQLite query failure
- Worker resource error
- Alarm runtime failure
- Discord API failure

Discord notification failureでdown_notifiedを1へしてはならない。
通知成功した場合のみ1。

---

# 18. Test requirements

Codexは最低限以下をテストする。

## Budget

- limit=50
- 50回tryTake成功
- 51回目false
- remainingが負にならない

## HTTP classification

- 200 alive
- 204 alive
- 301 alive
- 401 alive
- 403 alive
- 404 alive
- 429 alive
- 500 failure
- 503 failure
- network error failure
- timeout failure
- redirectをfollowしない

## Scheduler

1. monitor 0件 -> Alarm削除
2. 3件全成功 -> external=3
3. 50件全成功 -> external=50, 1 invocation
4. 51件全成功 -> 50件後continuation
5. 25件二重probe -> external=50
6. 49成功 + 50番目HEAD failure -> pending confirm
7. 48成功 + 49番目HEAD/GET failure -> pending notify
8. 新規DOWN通知成功 -> down_notified=1
9. DOWN継続 -> Discord再通知なし
10. 復旧 -> down_notified=0, Discord通知なし
11. 復旧後再DOWN -> Discord通知1回
12. Discord 429 -> pending notify + Retry-After Alarm
13. Discord 500/network -> pending notify + retry Alarm
14. Discord 403 -> infinite immediate retryしない
15. pending monitor remove -> obsolete alertを送らない
16. Guild 11件目拒否
17. global 1001件目拒否
18. duplicate name拒否
19. duplicate URL拒否
20. last monitor remove -> deleteAlarm

## Discord

- invalid signature 401
- PING -> PONG
- DM command拒否
- Manage Guild無し拒否
- add時Send Messages権限無し拒否
- allowed_mentions empty

---

# 19. Definition of Done

以下すべてを満たしたら完成。

- [ ] Workers + SQLite-backed Durable Objectだけで動く
- [ ] Cronなし
- [ ] D1なし
- [ ] Queueなし
- [ ] Gatewayなし
- [ ] 0 monitor時Alarmなし
- [ ] 1 Guild最大10
- [ ] global hard cap 1000
- [ ] interval設定なし
- [ ] 正常時Discord 0 messages
- [ ] 正常時monitor table write 0
- [ ] 履歴tableなし
- [ ] external subrequest budget 50
- [ ] 固定BATCH_SIZEなし
- [ ] success=1, confirm=+1, new DOWN alert=+1の動的cost
- [ ] 50件目途中で切れてもcontinuationから正確に再開
- [ ] manual redirect
- [ ] 1xx-4xx alive, 5xx/network/timeout failure candidate
- [ ] HEAD failure時だけGET confirmation
- [ ] DOWN通知はname + URL
- [ ] DOWN継続再通知なし
- [ ] recovery通知なし
- [ ] recovery後再障害は再通知
- [ ] Discord署名検証
- [ ] Public Bot OFF手順記載
- [ ] multi-Guild
- [ ] TypeScript strict
- [ ] secretsをログへ出さない
- [ ] `npm run typecheck`成功
- [ ] Wrangler local / remoteでAlarm test可能

---

# 20. Codexへの実装判断ルール

仕様に書かれていない便利機能を勝手に追加しない。

特に以下は「便利そう」でも追加禁止。

- dashboard
- Web UI
- uptime percentage
- check history
- recovery message
- embeds with rich stats
- per-monitor frequency
- retriesを増やす
- body content assertion
- TLS certificate expiry monitoring
- DNS monitoring
- ping/ICMP
- email notification
- webhook notification

このBotは機能数ではなく、少ないCloudflare使用量で「死んでいるURLに気付く」ことが成功条件である。

変更を提案する場合、必ず次の3点を説明すること。

1. Free枠のどの消費を増減させるか
2. external subrequest budgetにどう影響するか
3. 本来の目的に本当に必要か
