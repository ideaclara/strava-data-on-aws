import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, BatchWriteCommand, NumberValue } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { SQSClient, ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-west-2" }));
const ssm = new SSMClient({ region: "eu-west-2" });
const sqs = new SQSClient({ region: "eu-west-2" });

const ATHLETE_DETAILS_TABLE = process.env.ATHLETE_DETAILS_TABLE || "AthleteDetails";
const SEGMENTS_TABLE = process.env.SEGMENTS_TABLE || "StravaSegments";
const EFFORTS_TABLE = process.env.EFFORTS_TABLE || "StravaSegmentEfforts";
const QUEUE_URL = process.env.QUEUE_URL || "https://sqs.eu-west-2.amazonaws.com/022074716478/strava-segment-enrichment-queue";

function sanitizeForDynamo(obj) {
  if (obj === null || typeof obj !== "object") {
    if (typeof obj === "number" && (obj > Number.MAX_SAFE_INTEGER || obj < Number.MIN_SAFE_INTEGER)) {
      return NumberValue.from(String(obj));
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(sanitizeForDynamo);
  const clean = {};
  for (const [key, val] of Object.entries(obj)) {
    clean[key] = sanitizeForDynamo(val);
  }
  return clean;
}

function logRateLimits(res) {
  const usage = res.headers.get("x-ratelimit-usage");
  const limit = res.headers.get("x-ratelimit-limit");
  if (usage && limit) {
    console.log(`[Strava Rate Limits] Usage: ${usage} (15m, daily) | Limits: ${limit}`);
  }
}

async function deferMessage(receiptHandle, segmentId, reason) {
  console.warn(`[${segmentId}] Rate limit hit (${reason}). Deferring SQS visibility by 15 minutes (900s)...`);
  try {
    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: 900 // Defer for 15 minutes
    }));
  } catch (err) {
    console.error(`Failed to change message visibility:`, err);
  }
  throw new Error(`Rate limited (429) on ${reason} for segment ${segmentId}. Deferred 15m.`);
}

async function getSSMCredentials() {
  const cmd = new GetParametersCommand({
    Names: ["/strava/client_id", "/strava/client_secret"],
    WithDecryption: true,
  });
  const res = await ssm.send(cmd);
  const creds = {};
  for (const p of res.Parameters) {
    if (p.Name === "/strava/client_id") creds.clientId = p.Value;
    if (p.Name === "/strava/client_secret") creds.clientSecret = p.Value;
  }
  return creds;
}

async function getValidToken(athleteId) {
  const result = await ddb.send(new GetCommand({
    TableName: ATHLETE_DETAILS_TABLE,
    Key: { athleteId }
  }));
  if (!result.Item) throw new Error(`Athlete ${athleteId} not found`);

  let { access_token, refresh_token, expires_at } = result.Item;
  if (Math.floor(Date.now() / 1000) >= expires_at - 300) {
    const { clientId, clientSecret } = await getSSMCredentials();
    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token,
      }),
    });
    if (!res.ok) throw new Error(`Refresh failed: ${await res.text()}`);
    const refreshed = await res.json();
    access_token = refreshed.access_token;
    refresh_token = refreshed.refresh_token;
    expires_at = refreshed.expires_at;

    await ddb.send(new PutCommand({
      TableName: ATHLETE_DETAILS_TABLE,
      Item: {
        ...result.Item,
        access_token,
        refresh_token,
        expires_at,
        updated_at: new Date().toISOString()
      }
    }));
  }
  return access_token;
}

export const handler = async (event) => {
  for (const record of event.Records) {
    const { segmentId, athleteId } = JSON.parse(record.body);
    const token = await getValidToken(athleteId || "3634905");

    // --- 1. Fetch Segment Details ---
    console.log(`[${segmentId}] Fetching segment details...`);
    const segRes = await fetch(`https://www.strava.com/api/v3/segments/${segmentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    logRateLimits(segRes);

    if (segRes.status === 429) {
      await deferMessage(record.receiptHandle, segmentId, "segment metadata");
    }

    if (!segRes.ok) {
      console.error(`Strava error for segment ${segmentId}: ${segRes.status}`);
      throw new Error(`Failed segment ${segmentId}`);
    }

    const detail = await segRes.json();
    await ddb.send(new PutCommand({
      TableName: SEGMENTS_TABLE,
      Item: {
        ...sanitizeForDynamo(detail),
        segmentId: String(detail.id),
        starred: true,
        last_synced_at: new Date().toISOString()
      }
    }));

    // --- 2. Conditionally Fetch Efforts & Rank ---
    const userEffortCount = detail.athlete_segment_stats?.effort_count || 0;
    if (userEffortCount > 0) {
      console.log(`[${segmentId}] Athlete has ${userEffortCount} efforts. Fetching efforts list...`);

      const effortsRes = await fetch(
        `https://www.strava.com/api/v3/segment_efforts?segment_id=${segmentId}&per_page=200`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      logRateLimits(effortsRes);

      if (effortsRes.status === 429) {
        await deferMessage(record.receiptHandle, segmentId, "segment efforts");
      }

      if (effortsRes.ok) {
        const efforts = await effortsRes.json();
        console.log(`[${segmentId}] Ranking and storing ${efforts.length} efforts in DynamoDB...`);

        // Sort: moving_time -> elapsed_time -> start_date (oldest benchmark first)
        const sortedEfforts = [...efforts].sort((a, b) => {
          const movA = a.moving_time ?? a.elapsed_time;
          const movB = b.moving_time ?? b.elapsed_time;
          if (movA !== movB) return movA - movB;

          const elapA = a.elapsed_time ?? movA;
          const elapB = b.elapsed_time ?? movB;
          if (elapA !== elapB) return elapA - elapB;

          return new Date(a.start_date) - new Date(b.start_date);
        });

        // Standard Competition Ranking (1, 2, 3, 4, 4, 6, 7)
        const rankMap = new Map();
        let currentRank = 1;

        for (let i = 0; i < sortedEfforts.length; i++) {
          if (i > 0) {
            const prev = sortedEfforts[i - 1];
            const curr = sortedEfforts[i];

            const prevMov = prev.moving_time ?? prev.elapsed_time;
            const currMov = curr.moving_time ?? curr.elapsed_time;
            const prevElap = prev.elapsed_time ?? prevMov;
            const currElap = curr.elapsed_time ?? currMov;

            // Step rank to current array position + 1 only if times differ
            if (currMov !== prevMov || currElap !== prevElap) {
              currentRank = i + 1;
            }
          }
          rankMap.set(sortedEfforts[i].id, currentRank);
        }

        const rankedEfforts = efforts.map((eff) => ({
          ...eff,
          personal_pr_rank: rankMap.get(eff.id),
          total_segment_efforts: efforts.length
        }));

        for (let i = 0; i < rankedEfforts.length; i += 25) {
          const chunk = rankedEfforts.slice(i, i + 25).map((eff) => ({
            PutRequest: {
              Item: {
                ...sanitizeForDynamo(eff),
                segmentId: String(segmentId),
                start_date_effortId: `${eff.start_date}#${eff.id}`,
                last_synced_at: new Date().toISOString()
              }
            }
          }));

          await ddb.send(new BatchWriteCommand({
            RequestItems: {
              [EFFORTS_TABLE]: chunk
            }
          }));
        }
      } else {
        console.warn(`[${segmentId}] Non-critical: Failed to fetch efforts (${effortsRes.status})`);
      }
    } else {
      console.log(`[${segmentId}] 0 personal efforts recorded. Skipping efforts call.`);
    }

    // Pacing delay between records
    await new Promise((r) => setTimeout(r, 1000));
  }
};