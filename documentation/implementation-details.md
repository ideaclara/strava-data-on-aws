# Strava Telemetry & Ingestion Architecture
**Production Design, System Inventory & Asynchronous Telemetry Ingestion Specification**

* **AWS Region:** `eu-west-2` (London)
* **AWS Account:** `022074716478`
* **API ID:** `chd10yvm86`
* **Runtime:** Node.js 24.x (ESM)

---

## 1. Executive Summary & Inventory of Live Cloud Resources

The ingestion architecture is a fully managed, serverless ingestion, prediction, and hydration pipeline on AWS. It decouples synchronous API interactions from heavy background enrichment. The system synchronizes starred segments, hydrates rich route metadata (polylines, charts, community benchmarks), ingests historical effort telemetry into DynamoDB with Standard Competition Ranking, and executes physics-based climb effort predictions, all while dynamically managing Strava's rate limits (200 requests / 15 minutes, 2,000 requests / day). It also exposes an in-memory fuzzy search endpoint over the segment catalog and a sanitized profile and fitness signature endpoint.

| Resource Category | Resource Identifier | Configuration & Specifications | Status / Architectural Role |
| :--- | :--- | :--- | :--- |
| **DynamoDB Table** | `AthleteDetails` | PK: `athleteId` (S) • Billing: `PAY_PER_REQUEST` | Stores OAuth token bundles (access, refresh, expiry, scopes), athlete profile metadata, and fitness signature parameters. |
| **DynamoDB Table** | `StravaSegments` | PK: `segmentId` (S) • Billing: `PAY_PER_REQUEST` | Canonical segment catalog (`resource_state: 3`). Stores polyline maps, elevation profiles, and climb stats. |
| **DynamoDB Table** | `StravaSegmentEfforts` | PK: `segmentId` (S) • SK: `start_date_effortId` (S) | Granular effort telemetry (elapsed/moving time, watts, heart rate, cadence, `personal_pr_rank`). |
| **Amazon SQS Queue** | `strava-segment-enrichment-queue` | VisibilityTimeout: `90s` • DLQ Attached | Decoupled buffer for segment hydration jobs. Configured with a redrive policy (`maxReceiveCount: 5`). |
| **Amazon SQS DLQ** | `strava-segment-enrichment-dlq` | Retention: `14 days` (`1209600s`) | Dead-letter quarantine for failed messages or segments with persistent schema/API anomalies. |
| **HTTP API Gateway** | `chd10yvm86` | Protocol: HTTP (Payload v2.0) • Auto-deploy: `$default` | Unified front door for OAuth redirects, asynchronous triggers, catalog search, telemetry queries, and effort prediction. |
| **Lambda Function** | `strava-auth-callback` | Node.js 24.x • 128 MB • Timeout: 10s | Exchanges OAuth authorization code with Strava; persists initial token bundle to DynamoDB. |
| **Lambda Function** | `strava-get-athlete` | Node.js 24.x • 256 MB • Timeout: 10s | Read-only endpoint returning sanitized athlete profile and fitness signature data from `AthleteDetails`. |
| **Lambda Function** | `strava-get-segment` | Node.js 24.x • 256 MB • Timeout: 30s | Returns hydrated segment metadata from `StravaSegments` cache. Supports `?refresh=true`. |
| **Lambda Function** | `strava-sync-starred` | Node.js 24.x • 256 MB • Timeout: 30s | Ingests starred catalog summary, batch-queues IDs into SQS, and returns immediate HTTP 202 Accepted. |
| **Lambda Function** | `strava-enrich-segment-worker` | Node.js 24.x • 256 MB • Timeout: 60s | Consumes SQS messages, fetches detail (`resource_state: 3`) and efforts, computes PR ladder on `elapsed_time`, handles 429 back-off. |
| **Lambda Function** | `strava-get-segment-efforts` | Node.js 24.x • 256 MB • Timeout: 10s | Read-only DynamoDB query endpoint serving historical efforts and rankings with BigInt serialization. |
| **Lambda Function** | `strava-search-segments` | Node.js 24.x • 256 MB • Timeout: 10s | Fuzzy search endpoint with Fuse.js, in-memory catalog caching (10m TTL), and threshold scoring. |
| **Lambda Function** | `strava-predict-segment-effort` | Node.js 24.x • 256 MB • Timeout: 10s | Predicts climb power, duration, and confidence bands using physics modeling and athlete fitness parameters. |

---

## 2. Unified HTTP API Route Topology (API: `chd10yvm86`)

All Strava integration and analytics endpoints run through this centralized Gateway instance:

| HTTP Method & Route | Integration Target | Operational Behavior & Data Flow |
| :--- | :--- | :--- |
| `GET /callback` | `strava-auth-callback` | OAuth redirect handler from Strava consent screen. Stores tokens in `AthleteDetails`. |
| `GET /athlete/{athleteId}` | `strava-get-athlete` | Retrieves athlete profile, body weight, and Xert fitness signature with sensitive OAuth tokens stripped. |
| `GET /segments` | `strava-search-segments` | Full catalog dump or fuzzy search via query parameter `?q=...` using in-memory Fuse.js index. |
| `GET /segments/{segmentId}` | `strava-get-segment` | Reads metadata from `StravaSegments` cache. Low latency (~15ms), zero Strava quota consumption. |
| `POST /segments/sync-starred` | `strava-sync-starred` | Paginates `GET /segments/starred`, writes base items, queues segment IDs to SQS, returns HTTP 202. |
| `GET /segments/{segmentId}/efforts` | `strava-get-segment-efforts` | Pure read-only query against `StravaSegmentEfforts`. Supports `?order=asc\|desc` and `?limit=N`. |
| `GET /predict-segment-effort/{segmentId}` | `strava-predict-segment-effort` | Predicts power and completion duration for a known segment using stored athlete fitness and segment telemetry. |
| `GET /predict-segment-effort` | `strava-predict-segment-effort` | Predicts power and completion duration using an ad-hoc course profile and explicit athlete parameters. |

### Example: Fuzzy search for segments

curl -i -X GET "[https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments?q=headcorn](https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments?q=headcorn)" \
  -H "Content-Type: application/json"

Example: Get data on a specific segment

curl -s -X GET "[https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments/16716897](https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments/16716897)" \
  -H "Content-Type: application/json" \
  -d '{"athleteId": "3634905"}' | jq -C

curl -s -X GET "[https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments/6807785](https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments/6807785)" \
  -H "Content-Type: application/json" \
  -d '{"athleteId": "3634905"}' | jq -C
Example: Get all segment efforts for a specific segment

curl -s -X GET "[https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments/16716897/efforts](https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments/16716897/efforts)" \
  -H "Content-Type: application/json" \
  -d '{"athleteId": "3634905"}' | jq -C
Example: Triggering Starred Segment Synchronization

curl -i -X POST "[https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments/sync-starred](https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments/sync-starred)" \
  -H "Content-Type: application/json" \
  -d '{"athleteId": "3634905"}'
Expected Response (HTTP 202 Accepted):

HTTP
HTTP/2 202 
content-type: application/json
content-length: 74

{"message":"Sync started. Fetched and enqueued starred segments for worker."}
Example: Predict Effort for Known Segment & Stored Athlete Profile

curl -X GET "[https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/predict-segment-effort/6807785](https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/predict-segment-effort/6807785)" \
  -H "Content-Type: application/json" \
  -d '{"athleteId": "3634905"}'
Example: Predict Effort with Custom Course & Explicit Fitness Parameters

curl -X GET "[https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/predict-segment-effort](https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/predict-segment-effort)" \
  -H "Content-Type: application/json" \
  -d '{
    "distance_m": 1280.0,
    "elevation_gain_m": 77.0,
    "rider_mass_kg": 80.0,
    "fitness_profile": {
      "threshold_power_watts": 271.0,
      "high_intensity_energy_kj": 17.2,
      "peak_power_watts": 876.0
    }
  }'


  3. Decoupled Ingestion & Hydration Architecture
To prevent API Gateway 30-second timeouts and protect Strava API budgets, catalog discovery is decoupled from deep hydration and effort telemetry processing:

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
├─► 3. Computes Standard Competition Ranking (1224 ranking) on elapsed_time
└─► 4. Batch writes ranked efforts to StravaSegmentEfforts (chunks of 25)
│
▼ (On HTTP 429 Too Many Requests)
Calls sqs:ChangeMessageVisibility (VisibilityTimeout: 900s) & defers retry by 15 mins
│
▼ (If failed > 5 times)
[ SQS DLQ: strava-segment-enrichment-dlq ] (14-day quarantine retention)

## 4. Rate Limiting, Deferral & Dead-Letter Safety

Strava enforces strict rate limits across two sliding windows:
* **15-Minute Burst:** 200 API requests (resets on :00, :15, :30, and :45 minute boundaries)
* **Daily Quota:** 2,000 API requests

### SQS Rate Pacing & Targeted 15-Minute Deferral
1. **Concurrency Throttling:** The SQS event source mapping enforces `MaximumConcurrency=2` and `BatchSize=1` with an in-code 1,000ms delay between segments.
2. **Dynamic 429 Interception (`ChangeMessageVisibility`):** If upstream returns HTTP 429 Too Many Requests, the worker:
   * Logs `x-ratelimit-usage` and `x-ratelimit-limit` response headers.
   * Invokes AWS SDK SQS `ChangeMessageVisibilityCommand` with `VisibilityTimeout: 900` (15 minutes).
   * Throws an error to abort execution. SQS hides the message for 15 minutes, allowing Strava's quarter-hour quota bucket to reset cleanly without burning retry attempts.
3. **Dead-Letter Queue (DLQ):** Messages that fail 5 times (`maxReceiveCount: 5`) due to non-rate-limit issues (e.g., deleted upstream segments or unparseable payloads) are moved to `strava-segment-enrichment-dlq`.

---

## 5. Telemetry Modeling & Standard Competition Ranking

### `StravaSegmentEfforts` Schema
* **Partition Key (PK):** `segmentId` (String, e.g., `"6691062"`)
* **Sort Key (SK):** `start_date_effortId` (String, e.g., `"2020-07-22T18:00:53Z#2721096992015100000"`)

### Standard Competition Ranking Algorithm ("1224" Ranking)
Strava's native `pr_rank` only flags an athlete's top 3 performances (1, 2, 3), leaving all other historical efforts as null. The ingestion worker evaluates all attempts for a segment and writes a computed `personal_pr_rank` (1 to $n$) into DynamoDB:
1. **Sort Hierarchy:** `elapsed_time` (ASC) $\rightarrow$ `moving_time` (ASC) $\rightarrow$ `start_date` (ASC, older benchmark first).
2. **Tie-Handling:** If two efforts have identical `elapsed_time` and `moving_time`, they share the same rank (e.g., two tied 4th-place efforts both receive rank 4).
3. **Rank Step:** The subsequent slower effort increments to the absolute index ladder position (e.g., 1, 2, 3, 4, 4, 6, 7), matching Olympic and official sports timing rules.
4. **Metadata:** Each effort record also stores `total_segment_efforts` ($n$) for contextual display.

---

## 6. Catalog Fuzzy Search & In-Memory Caching (`GET /segments`)

To query segments without knowing numerical IDs, `strava-search-segments` exposes `GET /segments?q=...`:
* **Zero External Search Cluster:** Uses the client library `Fuse.js` embedded in Lambda, eliminating OpenSearch or Elasticsearch infrastructure costs.
* **In-Memory Global Cache:** Preloads segment projections (`segmentId`, `name`, `distance`, `climb_category`, `average_grade`, `total_elevation_gain`, `athlete_segment_stats.pr_elapsed_time`) on the initial scan and caches them in execution memory for 10 minutes (`CACHE_TTL_MS = 600000`).
* **Sub-5ms Execution:** Warm invocations run in 2–5 ms with 0 DynamoDB Read Capacity Units (RCU).
* **Fuzzy Sensitivity & Strict Filter:** Configured with `threshold: 0.2` and explicit post-filtering (`match_score <= 0.2`) to suppress false positives while accepting minor typos, spacing variances, and missing punctuation (e.g., `toys` matches `Toy's Hill`).

---

## 7. Physics-Based Effort & Power Prediction (`GET /predict-segment-effort`)

The `strava-predict-segment-effort` Lambda models expected completion time and power required to ascend a given course profile:
* **Dual Operation Modes:**
  * **Known Segment Mode (`/{segmentId}`):** Automatically resolves climb distance and elevation gain from `StravaSegments` and pulls the athlete's mass and Xert fitness signature from `AthleteDetails`.
  * **Custom Course Mode (Standalone):** Accepts arbitrary `distance_m`, `elevation_gain_m`, `rider_mass_kg`, and `fitness_profile` directly within the JSON request body.
* **Physics & Pacing Engine:** Integrates gravity ($g = 9.81\text{ m/s}^2$), air density ($\rho = 1.225\text{ kg/m}^3$), rolling resistance ($C_{rr} = 0.004$), drivetrain efficiency ($\eta = 0.975$), and aerodynamic drag area ($C_d A$) derived from rider mass and baseline bike/kit weight ($9.0\text{ kg}$).
* **Anaerobic & Aerobic Work Capacity:** Balances continuous mechanical course resistance ($C_1 v + C_3 v^3$) against the athlete's aerobic ceiling (Threshold Power), anaerobic work capacity (High Intensity Energy, $HIE$), and neuromuscular peak power ($PP$) via exponential decay time constants ($\tau$).
* **Confidence & Uncertainty Modeling:** Generates a tripartite prediction (`mid_prediction`, `upper_prediction`, `lower_prediction`) mapping a 90% confidence interval. Returns an explicit certainty score ($0$ to $1$) where steeper segments ($\ge 5.0\%$) yield higher consistency and lower aerodynamic variance than shallow or rolling terrain.

---

## 8. Athlete Profile & Fitness Signature Sanitization (`GET /athlete/{athleteId}`)

The `strava-get-athlete` Lambda exposes athlete metadata, biometric attributes, and fitness parameters for pacing analysis while safeguarding authentication material:
* **Credential Scrubbing:** Recursively strips sensitive fields (`access_token`, `refresh_token`, `client_secret`, `token_type`) prior to serializing the HTTP response payload.
* **Fitness Signature Attributes:** Stores and exposes the athlete's current mass (`weight` in kg) and Xert 4-parameter fitness signature:
  * `pp` (Peak Power in Watts)
  * `ftp` (Threshold Power in Watts)
  * `ltp` (Lower Threshold Power in Watts)
  * `hie` (High Intensity Energy in kJ)
* **BigInt-Safe JSON Serialization:** Custom serializer ensures large integers or high-precision numbers serialize without raising `TypeError: Do not know how to serialize a BigInt`.

---

## 9. Token Synchronization & BigInt Serialization

* **Credential Management:** `/strava/client_id` and `/strava/client_secret` are stored as encrypted SecureStrings in SSM Parameter Store.
* **Proactive Token Refresh:** Lambdas inspect `expires_at` in DynamoDB `AthleteDetails`. If within 300 seconds of expiry, tokens are refreshed against `https://www.strava.com/oauth/token` and saved back to DynamoDB before issuing upstream requests.
* **64-bit ID Precision:** Large 64-bit integer values (e.g., Strava effort IDs exceeding $2^{53} - 1$) are handled safely during ingestion with `NumberValue.from(String(val))`. When reading via `strava-get-segment-efforts`, `strava-get-athlete`, and `strava-get-segment`, custom JSON stringify replacers prevent unhandled exceptions by safely converting values into numbers or string representations.