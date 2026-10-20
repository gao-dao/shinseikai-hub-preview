# 公開申込用共有レート制限

`lib/security/registration-rate-limit.ts` はサーバー専用。
`checkRegistrationRateLimit(trustedIp)` は信頼済みの接続元IPだけを受け取る。
Requestやヘッダーを受け取らず、Supabase・申込データへアクセスしない。

## 未接続の境界

実際のVercel・前段プロキシ設定を確認できていないため、HTTPから信頼できるIPを取得する
アダプターは未実装。IP形式の妥当性は取得元の信頼性を証明しない。
`X-Forwarded-For`の先頭や`CF-Connecting-IP`をこの関数へ直接渡してはいけない。
次工程で実際の入口・ヘッダー上書き・プロキシ設定を確認し、専用アダプターを実装するまで
公開POSTには接続しない。IP不明・不正は通過させない。

## 設定（今回は値を設定しない）

| 環境変数 | 必須・既定値 |
| --- | --- |
| UPSTASH_REDIS_REST_URL | 必須。HTTPSの単一Upstash RESTエンドポイント |
| UPSTASH_REDIS_REST_TOKEN | 必須。EVALとカウンター操作が可能なサーバー用トークン |
| REGISTRATION_RATE_LIMIT_HMAC_SECRET | 必須。32文字以上、512文字以内。暗号学的にランダムな専用秘密値を用意する。Supabase秘密鍵と共用しない |
| REGISTRATION_RATE_LIMIT_NAMESPACE | 必須。小文字英数字・ハイフン・アンダースコア1〜40文字。環境ごとに分ける |
| REGISTRATION_RATE_LIMIT_IP_PER_MINUTE | 暫定5 |
| REGISTRATION_RATE_LIMIT_IP_PER_HOUR | 暫定30 |
| REGISTRATION_RATE_LIMIT_GLOBAL_PER_MINUTE | 暫定100 |

制限値は1〜1,000,000の整数。省略時だけ既定値を使い、空文字・不正値は設定エラー。
本番の全Vercelインスタンスは同じRedis・namespace・HMAC秘密値・制限値を使用する。
Preview・テストは本番と接続先またはnamespaceを必ず分離する。
HMAC秘密値やnamespaceを変更するとIPカウンターが分かれるため、運用中のローテーションは計画する。

## 判定

公式REST APIに1回だけPOSTし、1個のLua EVALでIP毎分・IP毎時・全体毎分を判定する。
すべてのカウンターに期限を設け、いずれかが上限なら加算しない。
通過時だけ3カウンターを加算する。通過後に別の検証が失敗しても枠は戻さない。
キーはHMAC済みIPと固定namespaceだけで、生IP・氏名・連絡先・備考・Turnstileトークンを保存しない。
IPv6表記とIPv4-mapped IPv6を正規化する。IPv6 /64単位の制限は今回追加していない。

初回通過から始まる固定窓方式であり、厳密なスライディング窓ではない。
境界付近には連続した短時間で上限近くの回数を2回分受け付ける可能性がある。
全体制限はこの関数を呼ぶ登録試行の負荷制御であり、DDoS・関数起動・外部通信費の上限保証ではない。
EVALは並行呼び出しを直列化するが、Redis障害・データ消失・運用設定変更まで含む絶対上限は保証しない。

拒否時は`RATE_LIMIT_EXCEEDED`と`retryAfterSeconds`を返す（ミリ秒TTLを秒へ切り上げ）。
HTTP応答はまだ作らない。将来のAPIで429とRetry-Afterへ変換する。
設定不備・IP不明・Redisエラー・不正応答・タイムアウトはすべて`ok:false`。
SDKは使用せず、timeout時に通過させるSDK既定動作や自動再試行を避ける。
通信とJSON解析全体を5秒で打ち切り、自動再試行しない。結果不明で枠が消費されても許可しない。
エラー原文・秘密値・IPは応答やログに出さない。

## 検証

```sh
node --test tests/registration-rate-limit.test.mjs
SHINSEIKAI_IDEMPOTENCY_DB_TEST=0 node --test tests/*.test.mjs
npx tsc --noEmit
npm run lint
```

通信と共有Redis状態はモック化。実際のUpstash接続、Lua実行、VercelのIP取得は未検証。
Lua実行の実環境テストは次回の承認後に別途行う。

公式資料:
- https://upstash.com/docs/redis/features/restapi
- https://upstash.com/docs/redis/sdks/ratelimit-ts/overview
- https://vercel.com/docs/headers/request-headers
