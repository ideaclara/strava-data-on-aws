import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, NumberValue } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-west-2" }));
const ssm = new SSMClient({ region: "eu-west-2" });

const ATHLETE_DETAILS_TABLE = process.env.ATHLETE_DETAILS_TABLE || "AthleteDetails";
const SEGMENTS_TABLE = process.env.SEGMENTS_TABLE || "StravaSegments";

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
    console.log(`Processing enrichment for segment: ${segmentId}`);

    const token = await getValidToken(athleteId || "3634905");
    const res = await fetch(`https://www.strava.com/api/v3/segments/${segmentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      console.error(`Strava error for segment ${segmentId}: ${res.status}`);
      throw new Error(`Failed to enrich segment ${segmentId}`);
    }

    const detail = await res.json();
    const sanitized = sanitizeForDynamo(detail);

    await ddb.send(new PutCommand({
      TableName: SEGMENTS_TABLE,
      Item: {
        ...sanitized,
        segmentId: String(detail.id),
        starred: true,
        last_synced_at: new Date().toISOString()
      }
    }));

    console.log(`Successfully upgraded segment ${segmentId} to resource_state: ${detail.resource_state}`);
    // Throttle slightly between queue iterations
    await new Promise((r) => setTimeout(r, 600));
  }
};