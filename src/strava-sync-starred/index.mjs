import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-west-2" }));
const ssm = new SSMClient({ region: "eu-west-2" });

const ATHLETE_DETAILS_TABLE = process.env.ATHLETE_DETAILS_TABLE || "AthleteDetails";
const SEGMENTS_TABLE = process.env.SEGMENTS_TABLE || "StravaSegments";

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

  if (!result.Item) {
    throw new Error(`No athlete record found for ID: ${athleteId}`);
  }

  let { access_token, refresh_token, expires_at } = result.Item;
  const nowInSeconds = Math.floor(Date.now() / 1000);

  // Refresh if expired or expiring within 5 minutes (300 seconds)
  if (nowInSeconds >= expires_at - 300) {
    console.log("Access token expiring or expired. Refreshing with Strava...");
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

    if (!refreshRes.ok) {
      throw new Error(`Token refresh failed: ${await refreshRes.text()}`);
    }

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
    console.log("Tokens successfully refreshed and persisted to DynamoDB.");
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
    const syncedSegments = [];

    while (true) {
      console.log(`Querying Strava starred segments: page ${page} (per_page=200)...`);
      const res = await fetch(`https://www.strava.com/api/v3/segments/starred?page=${page}&per_page=200`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) {
        throw new Error(`Strava API error (${res.status}): ${await res.text()}`);
      }

      const segments = await res.json();
      if (!Array.isArray(segments) || segments.length === 0) break;

      for (const seg of segments) {
        const item = {
          ...seg,
          segmentId: String(seg.id),
          starred: true,
          last_synced_at: new Date().toISOString()
        };

        await ddb.send(new PutCommand({
          TableName: SEGMENTS_TABLE,
          Item: item
        }));

        totalSynced++;
        syncedSegments.push({
          segmentId: item.segmentId,
          name: item.name,
          climb_category: item.climb_category,
          distance: item.distance
        });
      }

      if (segments.length < 200) break;
      page++;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Starred segments synchronization complete",
        athleteId,
        totalSynced,
        segments: syncedSegments
      })
    };
  } catch (err) {
    console.error("Sync handler failure:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message })
    };
  }
};