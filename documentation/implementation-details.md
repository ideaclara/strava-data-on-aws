# Strava Telemetry & Ingestion Architecture
**Production Design, System Inventory & Starred Segment Synchronisation Specification**

* **AWS Region:** `eu-west-2` (London)
* **AWS Account:** `022074716478`
* **API ID:** `chd10yvm86`
* **Runtime:** Node.js 24.x (ESM)

---

## 1. Executive Summary & Inventory of Live Cloud Resources

The ingestion architecture transitions from standalone client scripts to a fully managed, serverless ingestion plane on AWS. It ingests cyclist profile metadata, starred route segments, and high-frequency effort telemetry while respecting upstream Strava rate limits (200 req / 15 min, 2,000 req / day).

| Resource Category | Resource Identifier | Configuration & Specifications | Status / Architectural Role |
| :--- | :--- | :--- | :--- |
| **DynamoDB Table** | `AthleteDetails` | PK: `athleteId` (S) • Billing: `PAY_PER_REQUEST` | Stores OAuth token bundles (access, refresh, expiry, scopes) & athlete profile. |
| **DynamoDB Table** | `StravaSegments` | PK: `segmentId` (S) • Billing: `PAY_PER_REQUEST` | Canonical segment catalog (starred + manual interest). Caches polyline & specs. |
| **DynamoDB Table** | `StravaSegmentEfforts` | PK: `segmentId` (S) • SK: `start_date_effortId` (S) | Granular telemetry storage for efforts, watts, cadence, and PR achievements. |
| **HTTP API Gateway** | `chd10yvm86` | Protocol: HTTP (Payload v2.0) • Auto-deploy: `$default` | Unified front door for webhooks, user requests, and OAuth authorization flows. |
| **Lambda Function** | `strava-auth-callback` | Node.js 24.x • 128 MB • Timeout 10s • Role: `CyclingAnalytics...` | Exchanges OAuth authorization code with Strava; persists tokens to DynamoDB. |
| **Lambda Function** | `strava-get-segment` | Node.js 24.x • Timeout 30s • Integrated via `/segments/{segmentId}` | Retrieves segment metadata with cache-first logic and token layer support. |
| **Lambda Function** | `strava-sync-starred` | Node.js 24.x • Timeout 30s • Integrated via `/segments/sync-starred` | Ingests starred segments with token auto-refresh and writes to `StravaSegments`. |

---

## 2. Unified HTTP API Route Topology (API: `chd10yvm86`)

All Strava integration endpoints run through this centralized Gateway instance:

| HTTP Method & Route | Integration Target | Operational Behavior & Data Flow |
| :--- | :--- | :--- |
| `GET /callback` | `strava-auth-callback` | OAuth redirect handler from Strava consent screen. Stores tokens in `AthleteDetails`. |
| `GET /segments/{segmentId}` | `strava-get-segment` | Reads metadata from `StravaSegments` cache. Supports `?refresh=true` for live upstream sync. |
| `POST /segments/sync-starred` | `strava-sync-starred` | Paginates `GET /segments/starred` (`per_page=200`), auto-refreshes expired tokens, upserts catalog. |

---

## 3. Token Synchronization & Security Boundary

* **Client Credentials:** `/strava/client_id` and `/strava/client_secret` stored encrypted in AWS Systems Manager (SSM) Parameter Store.
* **Zero Token Drift:** When tokens are refreshed via OAuth refresh grant, the Lambda function writes updated `access_token`, `refresh_token`, and `expires_at` directly into DynamoDB `AthleteDetails`.
* **Auto-Refresh Ingestion:** The synchronization worker checks the token's remaining TTL against current epoch time (`Date.now() / 1000 + 300`). If expired or within a 5-minute safety margin, it performs an in-memory refresh and updates DynamoDB prior to calling Strava endpoints.

---

## 4. Rate Limiting & Capacity Management

Strava enforces strict rate limits across two sliding windows:
* **15-Minute Burst:** 200 API requests
* **Daily Quota:** 2,000 API requests

By implementing `per_page=200` on starred segment synchronization, a complete catalog of 100–350 starred routes requires only **1 to 2 API requests total**. Subsequent segment lookups hit DynamoDB in ~15ms with zero consumption of Strava quota.

Notes for Decoupled updating of POST /segments/sync-starred

[ POST /segments/sync-starred ]
         │
         ▼
[ Lambda: strava-sync-starred ]
   ├─► 1. Fetches starred segments (1-2 Strava calls)
   ├─► 2. Writes summary items to DynamoDB (StravaSegments)
   ├─► 3. Pushes 101 message IDs to SQS: strava-segment-enrichment-queue
   └─► 4. Returns HTTP 202 Accepted immediately (< 3s total runtime)
               │
               ▼
   [ SQS: strava-segment-enrichment-queue ]
               │  BatchSize: 1, MaximumConcurrency: 2
               ▼
[ Lambda: strava-enrich-segment-worker ]
   ├─► Checks token & queries GET /segments/{segmentId}
   └─► Upserts resource_state: 3 (polylines, stats, charts) to StravaSegments