import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, NumberValue } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-west-2" }));
const ssm = new SSMClient({ region: "eu-west-2" });
const sqs = new SQSClient({ region: "eu-west-2" });

const ATHLETE_DETAILS_TABLE = process.env.ATHLETE_DETAILS_TABLE || "AthleteDetails";
const SEGMENTS_TABLE = process.env.SEGMENTS_TABLE || "StravaSegments";
const ENRICHMENT_QUEUE_URL = process.env.ENRICHMENT_QUEUE_URL || "https://sqs.eu-west-2.amazonaws.com/022074716478/strava-segment-enrichment-queue";

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
  if (!result.Item) throw new Error(`No athlete record found for ID: ${athleteId}`);

  let { access_token, refresh_token, expires_at } = result.Item;
  if (Math.floor(Date.now() / 1000) >= expires_at - 300) {
    const { clientId, clientSecret } = await getSSMCredentials();
    const refreshRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token,
      }),
    });
    if (!refreshRes.ok) throw new Error(`Token refresh failed: ${await refreshRes.text()}`);
    const refreshed = await refreshRes.json();
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
  try {
    let body = {};
    if (event?.body) {
      try { body = JSON.parse(event.body); } catch (_) {}
    }

    const athleteId = 
      event?.queryStringParameters?.athleteId || 
      body?.athleteId || 
      "3634905";

    const token = await getValidToken(athleteId);

    let page = 1;
    let totalSynced = 0;
    const allSegmentIds = [];

    while (true) {
      const res = await fetch(`https://www.strava.com/api/v3/segments/starred?page=${page}&per_page=200`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`Strava API error (${res.status}): ${await res.text()}`);

      const segments = await res.json();
      if (!Array.isArray(segments) || segments.length === 0) break;

      for (const seg of segments) {
        const item = {
          ...sanitizeForDynamo(seg),
          segmentId: String(seg.id),
          starred: true,
          last_synced_at: new Date().toISOString()
        };

        await ddb.send(new PutCommand({
          TableName: SEGMENTS_TABLE,
          Item: item
        }));

        totalSynced++;
        allSegmentIds.push(item.segmentId);
      }

      if (segments.length < 200) break;
      page++;
    }

    // Push IDs to SQS in batches of 10
    for (let i = 0; i < allSegmentIds.length; i += 10) {
      const batch = allSegmentIds.slice(i, i + 10).map((id, idx) => ({
        Id: `msg_${i + idx}`,
        MessageBody: JSON.stringify({ segmentId: id, athleteId })
      }));

      await sqs.send(new SendMessageBatchCommand({
        QueueUrl: ENRICHMENT_QUEUE_URL,
        Entries: batch
      }));
    }

    return {
      statusCode: 202,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Starred catalog synced; background detail enrichment queued",
        athleteId,
        totalSynced,
        queuedForEnrichment: allSegmentIds.length
      })
    };
  } catch (err) {
    console.error("Sync error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message })
    };
  }
};