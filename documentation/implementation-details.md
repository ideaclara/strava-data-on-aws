# Strava Telemetry & Ingestion Architecture
**Production Design, System Inventory & Asynchronous Telemetry Ingestion Specification**

* **AWS Region:** `eu-west-2` (London)
* **AWS Account:** `022074716478`
* **API ID:** `chd10yvm86`
* **Runtime:** Node.js 24.x (ESM)

---

## 1. Executive Summary & Inventory of Live Cloud Resources

The ingestion architecture is a fully managed, serverless ingestion and hydration pipeline on AWS[cite: 2]. It decouples synchronous API interactions from heavy background enrichment[cite: 2]. The system synchronizes starred segments, hydrates rich route metadata (polylines, charts, community benchmarks), and ingests historical effort telemetry into DynamoDB with Standard Competition Ranking while dynamically managing Strava's rate limits (200 requests / 15 minutes, 2,000 requests / day)[cite: 2]. Additionally, it exposes an in-memory fuzzy search endpoint over the segment catalog[cite: 2].

| Resource Category | Resource Identifier | Configuration & Specifications | Status / Architectural Role |
| :--- | :--- | :--- | :--- |
| **DynamoDB Table** | `AthleteDetails` | PK: `athleteId` (S) • Billing: `PAY_PER_REQUEST` | Stores OAuth token bundles (access, refresh, expiry, scopes) & athlete profiles[cite: 2]. |
| **DynamoDB Table** | `StravaSegments` | PK: `segmentId` (S) • Billing: `PAY_PER_REQUEST` | Canonical segment catalog (`resource_state: 3`). Stores polyline maps, elevation profiles, and climb stats[cite: 2]. |
| **DynamoDB Table** | `StravaSegmentEfforts` | PK: `segmentId` (S) • SK: `start_date_effortId` (S) | Granular effort telemetry (elapsed/moving time, watts, heart rate, cadence, `personal_pr_rank`)[cite: 2]. |
| **Amazon SQS Queue** | `strava-segment-enrichment-queue` | VisibilityTimeout: `90s` • DLQ Attached | Decoupled buffer for segment hydration jobs. Configured with a redrive policy (`maxReceiveCount: 5`)[cite: 2]. |
| **Amazon SQS DLQ** | `strava-segment-enrichment-dlq` | Retention: `14 days` (`1209600s`) | Dead-letter quarantine for failed messages or segments with persistent schema/API anomalies[cite: 2]. |
| **HTTP API Gateway** | `chd10yvm86` | Protocol: HTTP (Payload v2.0) • Auto-deploy: `$default` | Unified front door for OAuth redirects, asynchronous triggers, and read-only telemetry queries[cite: 2]. |
| **Lambda Function** | `strava-auth-callback` | Node.js 24.x • 128 MB • Timeout: 10s | Exchanges OAuth authorization code with Strava; persists initial token bundle to DynamoDB[cite: 2]. |
| **Lambda Function** | `strava-get-segment` | Node.js 24.x • 256 MB • Timeout: 30s | Returns hydrated segment metadata from `StravaSegments` cache. Supports `?refresh=true`[cite: 2]. |
| **Lambda Function** | `strava-sync-starred` | Node.js 24.x • 256 MB • Timeout: 30s | Ingests starred catalog summary, batch-queues IDs into SQS, and returns immediate HTTP 202 Accepted[cite: 2]. |
| **Lambda Function** | `strava-enrich-segment-worker` | Node.js 24.x • 256 MB • Timeout: 60s | Consumes SQS messages, fetches detail (`resource_state: 3`) and efforts, computes PR ladder, handles 429 back-off[cite: 2]. |
| **Lambda Function** | `strava-get-segment-efforts` | Node.js 24.x • 256 MB • Timeout: 10s | Read-only DynamoDB query endpoint serving historical efforts and rankings with BigInt serialization[cite: 2]. |
| **Lambda Function** | `strava-search-segments` | Node.js 24.x • 256 MB • Timeout: 10s | Fuzzy search endpoint with Fuse.js, in-memory catalog caching (10m TTL), and threshold scoring[cite: 2]. |

---

## 2. Unified HTTP API Route Topology (API: `chd10yvm86`)

All Strava integration endpoints run through this centralized Gateway instance[cite: 2]:

| HTTP Method & Route | Integration Target | Operational Behavior & Data Flow |
| :--- | :--- | :--- |
| `GET /callback` | `strava-auth-callback` | OAuth redirect handler from Strava consent screen. Stores tokens in `AthleteDetails`[cite: 2]. |
| `GET /segments` | `strava-search-segments` | Full catalog dump or fuzzy search via query parameter `?q=...` using in-memory Fuse.js index. |
| `GET /segments/{segmentId}` | `strava-get-segment` | Reads metadata from `StravaSegments` cache. Low latency (~15ms), zero Strava quota consumption[cite: 2]. |
| `POST /segments/sync-starred` | `strava-sync-starred` | Paginates `GET /segments/starred`, writes base items, queues segment IDs to SQS, returns HTTP 202[cite: 2]. |
| `GET /segments/{segmentId}/efforts` | `strava-get-segment-efforts` | Pure read-only query against `StravaSegmentEfforts`. Supports `?order=asc\|desc` and `?limit=N`[cite: 2]. |

---

## 3. Decoupled Ingestion & Hydration Architecture

To prevent API Gateway 30-second timeouts and protect Strava API budgets, catalog discovery is decoupled from deep hydration and effort telemetry processing[cite: 2]:
[ POST /segments/sync-starred ]
│
▼
[ Lambda: strava-sync-starred ]
├─► 1. Fetches starred segments (1-2 Strava calls: /segments/starred?per_page=200)
├─► 2. Upserts summary items (resource_state: 2) to DynamoDB (StravaSegments)
├─► 3. Publishes segment IDs to SQS in batches of 10
└─► 4. Returns HTTP 202 Accepted immediately (< 3s total latency)
│
▼
[ SQS: strava-segment-enrichment-queue ]
│  BatchSize: 1, MaximumConcurrency: 2
▼
[ Lambda: strava-enrich-segment-worker ]
├─► 1. GET /segments/{segmentId} -> Upserts resource_state: 3 (polyline, charts, stats)
├─► 2. Checks detail.athlete_segment_stats.effort_count:
│        ├─► If 0: Skips efforts API call (saves 1 Strava call)
│        └─► If > 0: GET /segment_efforts?segment_id={id}&per_page=200
├─► 3. Computes Standard Competition Ranking (1224 ranking) on moving_time
└─► 4. Batch writes ranked efforts to StravaSegmentEfforts (chunks of 25)
│
▼ (On HTTP 429 Too Many Requests)
Calls sqs:ChangeMessageVisibility (VisibilityTimeout: 900s) & defers retry by 15 mins
│
▼ (If failed > 5 times)
[ SQS DLQ: strava-segment-enrichment-dlq ] (14-day quarantine retention)
[cite: 2]

---

## 4. Rate Limiting, Deferral & Dead-Letter Safety

Strava enforces strict rate limits across two sliding windows[cite: 2]:
* **15-Minute Burst:** 200 API requests (resets on :00, :15, :30, and :45 minute boundaries)[cite: 2]
* **Daily Quota:** 2,000 API requests[cite: 2]

### SQS Rate Pacing & Targeted 15-Minute Deferral
1. **Concurrency Throttling:** The SQS event source mapping enforces `MaximumConcurrency=2` and `BatchSize=1` with an in-code 1,000ms delay between segments[cite: 2].
2. **Dynamic 429 Interception (`ChangeMessageVisibility`):** If upstream returns HTTP `429 Too Many Requests`, the worker[cite: 2]:
   * Logs `x-ratelimit-usage` and `x-ratelimit-limit` response headers[cite: 2].
   * Invokes AWS SDK SQS `ChangeMessageVisibilityCommand` with `VisibilityTimeout: 900` (15 minutes)[cite: 2].
   * Throws an error to abort execution[cite: 2]. SQS hides the message for 15 minutes, allowing Strava's quarter-hour quota bucket to reset cleanly without burning retry attempts[cite: 2].
3. **Dead-Letter Queue (DLQ):** Messages that fail 5 times (`maxReceiveCount: 5`) due to non-rate-limit issues (e.g., deleted upstream segments or unparseable payloads) are moved to `strava-segment-enrichment-dlq`[cite: 2].

---

## 5. Telemetry Modeling & Standard Competition Ranking

### `StravaSegmentEfforts` Schema
* **Partition Key (PK):** `segmentId` (String, e.g., `"6691062"`)[cite: 2]
* **Sort Key (SK):** `start_date_effortId` (String, e.g., `"2020-07-22T18:00:53Z#2721096992015100000"`)[cite: 2]

### Standard Competition Ranking Algorithm ("1224" Ranking)
Strava's native `pr_rank` only flags an athlete's top 3 performances (1, 2, 3), leaving all other historical efforts as `null`[cite: 2]. The ingestion worker evaluates all attempts for a segment and writes a computed `personal_pr_rank` (1 to $n$) into DynamoDB[cite: 2]:
1. **Sort Hierarchy:** `moving_time` (ASC) $\rightarrow$ `elapsed_time` (ASC) $\rightarrow$ `start_date` (ASC, older benchmark first)[cite: 2].
2. **Tie-Handling:** If two efforts have identical `moving_time` and `elapsed_time`, they share the same rank (e.g., two tied 4th-place efforts both receive rank `4`)[cite: 2].
3. **Rank Step:** The subsequent slower effort increments to the absolute index ladder position (e.g., `1, 2, 3, 4, 4, 6, 7`), matching Olympic and official sports timing rules[cite: 2].
4. **Metadata:** Each effort record also stores `total_segment_efforts` ($n$) for contextual display[cite: 2].

---

## 6. Catalog Fuzzy Search & In-Memory Caching (`GET /segments`)

To query segments without knowing numerical IDs, `strava-search-segments` exposes `GET /segments?q=...`:
* **Zero External Search Cluster:** Uses the client library `Fuse.js` embedded in Lambda, eliminating OpenSearch or Elasticsearch infrastructure costs.
* **In-Memory Global Cache:** Preloads segment projections (`segmentId`, `name`, `distance`, `climb_category`, `average_grade`, `total_elevation_gain`) on the initial scan and caches them in execution memory for 10 minutes (`CACHE_TTL_MS = 600000`).
* **Sub-5ms Execution:** Warm invocations run in 2–5 ms with 0 DynamoDB Read Capacity Units (RCU).
* **Fuzzy Sensitivity & Strict Filter:** Configured with `threshold: 0.2` and explicit post-filtering (`match_score <= 0.2`) to suppress false positives while accepting minor typos, spacing variances, and missing punctuation (e.g., `toys` matches `Toy's Hill`).

---

## 7. Token Synchronization & BigInt Serialization

* **Credential Management:** `/strava/client_id` and `/strava/client_secret` are stored as encrypted SecureStrings in SSM Parameter Store[cite: 2].
* **Proactive Token Refresh:** Lambdas inspect `expires_at` in DynamoDB `AthleteDetails`[cite: 2]. If within 300 seconds of expiry, tokens are refreshed against `https://www.strava.com/oauth/token` and saved back to DynamoDB before issuing upstream requests[cite: 2].
* **64-bit ID Precision:** Large 64-bit integer values (e.g., Strava effort IDs exceeding $2^{53} - 1$) are handled safely during ingestion with `NumberValue.from(String(val))`[cite: 2]. When reading via `strava-get-segment-efforts`, a custom serializer replacer prevents `TypeError: Do not know how to serialize a BigInt` by converting values safely into native JavaScript Numbers or preserving strings[cite: 2].