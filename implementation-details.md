# Strava Telemetry & Ingestion Architecture
**Production Design, System Inventory & Starred Segment Synchronisation Specification**[cite: 1, 2]

* **AWS Region:** `eu-west-2` (London)[cite: 1, 2]
* **AWS Account:** `022074716478`[cite: 1, 2]
* **API ID:** `chd10yvm86`[cite: 1, 2]
* **Runtime:** Node.js 24.x (ESM)[cite: 1, 2]

---

## 1. Executive Summary & Inventory of Live Cloud Resources[cite: 1, 2]

The ingestion architecture transitions from standalone client scripts to a fully managed, serverless ingestion plane on AWS[cite: 1, 2]. It ingests cyclist profile metadata, starred route segments, and high-frequency effort telemetry while respecting upstream Strava rate limits (200 req / 15 min, 2,000 req / day)[cite: 1, 2].

| Resource Category | Resource Identifier | Configuration & Specifications | Status / Architectural Role |
| :--- | :--- | :--- | :--- |
| **DynamoDB Table**[cite: 1, 2] | `AthleteDetails`[cite: 1, 2] | PK: `athleteId` (S) • Billing: `PAY_PER_REQUEST`[cite: 1, 2] | Stores OAuth token bundles (access, refresh, expiry, scopes) & athlete profile[cite: 1, 2]. |
| **DynamoDB Table**[cite: 1, 2] | `StravaSegments`[cite: 1, 2] | PK: `segmentId` (S) • Billing: `PAY_PER_REQUEST`[cite: 1, 2] | Canonical segment catalog (starred + manual interest). Caches polyline & specs[cite: 1, 2]. |
| **DynamoDB Table**[cite: 1, 2] | `StravaSegmentEfforts`[cite: 1, 2] | PK: `segmentId` (S) • SK: `start_date_effortId` (S)[cite: 1, 2] | Granular telemetry storage for efforts, watts, cadence, and PR achievements[cite: 1, 2]. |
| **HTTP API Gateway**[cite: 1, 2] | `chd10yvm86`[cite: 1, 2] | Protocol: HTTP (Payload v2.0) • Auto-deploy: `$default`[cite: 1, 2] | Unified front door for webhooks, user requests, and OAuth authorization flows[cite: 1, 2]. |
| **Lambda Function**[cite: 1, 2] | `strava-auth-callback`[cite: 1, 2] | Node.js 24.x • 128 MB • Timeout 10s • Role: `CyclingAnalytics...`[cite: 1, 2] | Exchanges OAuth authorization code with Strava; persists tokens to DynamoDB[cite: 1, 2]. |
| **Lambda Function**[cite: 1, 2] | `strava-get-segment`[cite: 1, 2] | Node.js 24.x • Timeout 30s • Integrated via `/segments/{segmentId}`[cite: 1, 2] | Retrieves segment metadata with cache-first logic and token layer support[cite: 1, 2]. |

---

## 2. Unified HTTP API Route Topology (API: `chd10yvm86`)[cite: 1, 2]

All Strava integration endpoints run through this centralized Gateway instance[cite: 1, 2]:

| HTTP Method & Route | Route ID | Integration Target | Operational Behavior & Data Flow |
| :--- | :--- | :--- | :--- |
| `GET /callback`[cite: 1, 2] | `djc9rtq`[cite: 1, 2] | `strava-auth-callback`[cite: 1, 2] | OAuth redirect handler from Strava consent screen[cite: 1, 2]. Stores tokens in `AthleteDetails`[cite: 1, 2]. |
| `GET /segments/{segmentId}`[cite: 1, 2] | `amplomh`[cite: 1, 2] | `strava-get-segment`[cite: 1, 2] | Reads metadata from `StravaSegments` cache[cite: 1, 2]. Supports `?refresh=true` for live upstream sync[cite: 1, 2]. |
| `POST /segments/sync-starred`[cite: 1, 2] | *Provisioning*[cite: 1, 2] | `strava-sync-starred`[cite: 1, 2] | Paginates `GET /segments/starred` (`per_page=200`), auto-refreshes expired tokens, upserts catalog[cite: 1, 2]. |

---

## 3. Token Synchronization & Security Boundary[cite: 1, 2]

* **Client Credentials:** `/strava/client_id` and `/strava/client_secret` stored encrypted in AWS Systems Manager (SSM) Parameter Store[cite: 1, 2].
* **Zero Token Drift:** When tokens are refreshed via OAuth refresh grant, the Lambda function writes updated `access_token`, `refresh_token`, and `expires_at` directly into DynamoDB `AthleteDetails`[cite: 1, 2].
* **Auto-Refresh Ingestion:** The synchronization worker checks the token's remaining TTL against current epoch time (`Date.now() / 1000 + 300`)[cite: 1, 2]. If expired or within a 5-minute safety margin, it performs an in-memory refresh and updates DynamoDB prior to calling Strava endpoints[cite: 1, 2].

---

## 4. Rate Limiting & Capacity Management[cite: 1, 2]

Strava enforces strict rate limits across two sliding windows[cite: 1, 2]:
* **15-Minute Burst:** 200 API requests[cite: 1, 2]
* **Daily Quota:** 2,000 API requests[cite: 1, 2]

By implementing `per_page=200` on starred segment synchronization, a complete catalog of 100–350 starred routes requires only **1 to 2 API requests total**[cite: 1, 2]. Subsequent segment lookups hit DynamoDB in ~15ms with zero consumption of Strava quota[cite: 1, 2].