# Turnstile localhostブラウザテスト環境

この環境は公開画面だけを一時ディレクトリへコピーし、合成の講習会・クラスと申込モックを提供します。通常のNext.js起動とは別プロセスです。ブラウザ操作とCloudflareへのアクセスは別途承認後に行ってください。

## 起動と終了

プロジェクトのルートから、目的のシナリオを1つ起動します。

```bash
node scripts/turnstile-browser/start.mjs --start --official-test-sitekey --scenario success --port 3100
```

`ready: true` の表示後、`http://localhost:3100/events` を使用します。127.0.0.1をURLに指定したアクセスや外部ホストからのアクセスは受け付けません。通常のlocalhost:3000ではテストモックは動作しません。

シナリオ別の起動例（同時起動は不要）：

```bash
node scripts/turnstile-browser/start.mjs --start --official-test-sitekey --scenario slow-success --port 3101
node scripts/turnstile-browser/start.mjs --start --official-test-sitekey --scenario full --port 3102
node scripts/turnstile-browser/start.mjs --start --official-test-sitekey --scenario unknown-retry --port 3103
```

Ctrl+Cで終了します。今回生成した一時ディレクトリと子Nextプロセスだけを片付けます。通常のアプリの設定・`.next`・`.env.local`は変更しません。終了後は通常どおり`npm run dev`を使えます。強制終了やPC停止の場合は一時ディレクトリが残る可能性があります。モック確認後、`/_next/hmr`だけを今回の隔離Next内部ポートへWebSocket中継します。ほかのUpgrade要求は拒否します。画面ソースは起動時のコピーなので、元ファイル変更の反映にはテスト環境の再起動が必要です。

## Site Keyと秘密情報の分離

- 子プロセスにだけ公式成功固定Site Key `1x00000000000000000000AA` を設定します。
- `.env.local`を読み込まず、コピーもしません。親の環境変数も許可したOS基本設定以外は継承しません。
- Secret Key、Redis、Supabase、Siteverifyを使用しません。actionは既存画面の`registration`のままです。
- 公式テストウィジェット自体の表示には、後日のブラウザからCloudflareへの実通信が必要です。この準備・単体テストでは行いません。
- 本番のAPI、認証条件、フォームにテスト用分岐は追加していません。テスト用コードは`scripts/`に隔離しています。

## 実APIの遮断

入口のloopbackプロキシが`POST /api/registrations`を終端します。講習会・クラスGETも合成データです。未定義APIは503で拒否し、Nextへ転送しません。

さらに、一時Nextには実API・サーバー接続モジュール・秘密情報をコピーしません。内部ポートの申込POSTも常に503です。モックの有無にかかわらず実申込を実行する経路はありません。

起動前セルフチェックと自動テストで、モックマーカー欠落を失敗にします。起動時にも`/__test/status`のマーカーを確認します。後日のブラウザテストではNetworkで申込応答の`x-shinseikai-browser-test: mock-only-v1`を確認し、欠落したらテストを中止してください。

## ブラウザでの確認手順（今回は未実施）

各シナリオで異なるポート、または専用ブラウザプロファイルを使ってください。結果不明の既存セッションを消して新しい申込に切り替える運用は避けます。入力には合成の氏名・連絡先・備考だけを使います。

1. 講習会の申込フォームを開き、合成クラス1・2を選択する。満員の合成クラス3は選択できないことを確認する。
2. 氏名・連絡先・備考を入力し確認画面へ進む。内容、Turnstile表示、認証前後の送信ボタンを確認する。
3. `success`で送信し、完了表示を確認する。
4. `slow-success`では約2.5秒の待機中に連打し、申込POSTが1回であることを確認する。
5. `full`では満員メッセージが表示され、成功扱いにならないことを確認する。
6. `unknown-retry`では初回に結果不明の503応答を返す。同じ入力・申込キーを保持したまま再認証して再送し、成功することを確認する。これは通信結果不明のアプリ状態を再現するモックであり、実際のネットワーク切断ではない。
7. 再送前のウィジェット再生成・再認証を確認する。公式テストキーのダミートークンは文字列が同じ場合があるため、文字列の違いを新しい認証の条件にしない。異なる合成トークンでの同一キー再送は自動テストで検証する。
8. Applicationのストレージで、氏名・連絡先・備考・トークンが保存されていないことを確認する。既存実装はsessionStorageへ申込キーと段階だけを保存し、結果不明時の再読込後は新規申込を遮断する。入力内容は復旧しない。localStorageへの個人情報保存は行わない。

`http://localhost:<port>/__test/status`は安全な集計値だけを返します。成功はPOST1回、満員は1回、結果不明からの再送は2回・`distinct_attempts: 1`・`replay_matches: 1`が目安です。`forwarded_api_requests`は常に0です。表示更新GETはこのPOST回数に含みません。Ctrl+C時にも集計を表示します。生の本文、トークン、申込キー、個人情報をログ・HAR・スクリーンショットへ保存しないでください。

## 自動テスト

```bash
node --check scripts/turnstile-browser/start.mjs
node --check scripts/turnstile-browser/mock-server.mjs
node --test tests/turnstile-browser-environment.test.mjs
```

HTTPサーバー・Next・ブラウザ・Cloudflareを起動せず、純粋なRequest/Responseと注入した転送関数で遮断・呼出回数を検証します。一時画面コピーの構成も検証します。実画面のウィジェット表示・クリック・ストレージ目視確認・Next起動の実確認は、次回のブラウザテストに残ります。

## 起動診断

CLIは標準エラーへJSONの診断行を出力します。Nextの標準出力・標準エラー原文、例外メッセージ、スタック、HTTP本文は表示・保存しません。

- `stage`: `FIXTURE_CREATE`（一時環境作成）、`NEXT_START`（子プロセス起動）、`PROXY_LISTEN`（指定ポート待受）、`EVENTS_HTTP`（画面応答）、`MOCK_CHECK`（事前・待受前・起動後の遮断確認）、`CLEANUP`（後片付け失敗）。
- `outcome`: `passed`／`observed`／`failed`。
- `classification`: `PORT_IN_USE`、`DEPENDENCY_ERROR`、`COMPILE_ERROR`、`NEXT_STARTUP_ERROR`、`STARTUP_TIMEOUT`、`CHILD_EARLY_EXIT`、`MOCK_NOT_APPLIED`、`HTTP_ERROR`、`CLEANUP_FAILED`、`UNKNOWN_STARTUP_FAILURE`。
- `child_exit_code`／`child_exit_signal`: 自然終了時のコード・許可したシグナル。後片付けのために送ったシグナルで原因を上書きしません。
- `http_status`: 本文を読まずに取得した応答ステータス。
- `communication_code`: 許可したOS／通信エラーコードのみ。未知の値は`null`。
- `next_error`: Next出力の既知パターンで識別した起動・コンパイル・依存エラー分類のみ。推測による分類はしません。

初回の事前モック確認が失敗した場合はNextを起動しません。今回作ったプロキシの遮断確認にも成功してから待ち受けを開始します。HTTP 400以上は再試行せず停止します。接続待ちは最大80回、各HTTP確認は1秒のタイムアウトで、間隔は250msです。失敗時は自動で起動をやり直さず、一時プロキシ・子プロセス・ディレクトリのみ片付けます。通常の3000番や既存Supabaseを終了する処理はありません。

診断が`UNKNOWN_STARTUP_FAILURE`の場合も、秘密情報が含まれる可能性のある原文出力へ切り替えないでください。分類は安全な粒度に留まるため、具体的な依存ファイルやコンパイル箇所は未特定になる場合があります。

診断の単体テスト（実サーバー・ソケット・外部接続なし）：

```bash
node --test tests/turnstile-browser-startup.test.mjs
```

## Hostを固定した起動後の遮断確認

自己診断には`fetch`を使わず、Node標準の`http.request()`を使います。接続先は`127.0.0.1`と起動時指定ポート、Hostは`localhost:<port>`に固定します。診断はGETのみで、申込POSTは送信しません。リダイレクト追従・自動再送・3000番へのフォールバックはありません。

各通信は接続開始から5秒の絶対タイムアウト、応答本文は8KiBまでです。タイムアウトは`ETIMEDOUT`、上限超過は`PROBE_RESPONSE_TOO_LARGE`、不正な診断本文は`PROBE_RESPONSE_INVALID`として安全な診断へ変換します。例外・本文原文は記録しません。

起動後に、次の4通信を順番に確認します。

| GET先 | Host | 必須条件 |
|---|---|---|
| `/__test/status` | `localhost:<port>` | 200、正しいモックマーカー、テストモード、API転送件数0 |
| `/api/registrations` | `localhost:<port>` | 405、正しいモックマーカー |
| `/api/unconfigured-browser-test` | `localhost:<port>` | 503、正しいモックマーカー |
| `/__test/status` | `127.0.0.1:<port>`（不正Hostの負例） | 403、モックマーカーなし |

マーカーはレスポンスの検査だけに使い、リクエストの認可に使用しません。全確認が成功するまで画面・静的ファイル・申込POSTは503で止めます。失敗した場合はreadyを出さず、一時環境だけを片付けます。起動完了後も申込POSTはモックで終端し、未定義APIは転送しません。

追加の通信単体テスト（ソケット・実サーバーなし）：

```bash
node --test tests/turnstile-browser-probe.test.mjs
```


## 開発用WebSocketの制限

Next.js 16.3.5の`onHMR`は`/_next/hmr`のUpgradeと`id`クエリを使用し、Reactのデバッグデータも同じ接続で送ります。今回はこの経路だけを維持し、Reactのデバッグ設定や本番認証条件を変更しません。

- モック確認完了前・終了開始後のUpgradeは拒否。
- メソッドGET、パス`/_next/hmr`（任意で英数字・`_`・`-`の`id`1個）、Host`localhost:<指定ポート>`、Origin`http://localhost:<指定ポート>`を厳密検証。
- WebSocket version 13、正しい16バイトのハンドシェイクキー、Upgrade／Connectionを検証。
- 中継先は`127.0.0.1:<今回の隔離内部ポート>`固定。外部URLや3000番へ転送・再試行しない。
- 転送ヘッダーはHost、Origin、Connection、Upgrade、Sec-WebSocket-Key／Versionのみ。Cookie・Authorization・転送先指定ヘッダーは送らない。
- Nextの`allowedDevOrigins`にあるlocalhostのOriginを維持。上流101とSec-WebSocket-Acceptを検証し、未要求の圧縮・サブプロトコルは拒否。
- ハンドシェイクは5秒で打ち切り。接続後のバイナリデータは解釈・記録せず双方向中継する。
- 終了時は、この中継で追跡した接続中・接続待ちソケットを破棄してからHTTPサーバーを閉じる。

APIパスのUpgradeは認めず、通常HTTPの申込POST・未定義APIは引き続きモック／拒否で終端します。WebSocketのフレームは隔離NextのHMR処理に渡し、HTTP申込APIとして再解釈しません。

追加単体テスト（実ソケット・サーバーなし）：

```bash
node --test tests/turnstile-browser-hmr.test.mjs
```

実ブラウザでの101確立、デバッグデータ受信、Reactのマウント完了と講習会GET開始、終了時の実ソケット解放は未確認です。既存サーバーはそのままで、承認後の起動し直しで確認してください。
