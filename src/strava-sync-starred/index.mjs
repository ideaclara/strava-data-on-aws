import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { stravaFetch } from "/opt/nodejs/stravaAuth.mjs";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "eu-west-2" }),
  { marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false } }
);

const ATHLETE_TABLE = process.env.ATHLETE_TABLE || "AthleteDetails";

export const handler = async (event) => {
  console.log("Sync Starred invocation event:", JSON.stringify(event));

  // 1. Resolve athleteId
  let rawAthleteId =
    event?.queryStringParameters?.athleteId ||
    event?.athleteId;

  if (event?.body) {
    try {
      const parsed = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      rawAthleteId = rawAthleteId || parsed?.athleteId;
    } catch {
      // Body not JSON
    }
  }

  if (!rawAthleteId || !/^\d+$/.test(String(rawAthleteId).trim())) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Bad Request", message: "athleteId must be a positive numeric string." }),
    };
  }

  const athleteId = String(rawAthleteId).trim();

  try {
    // 2. Fetch starred segments from Strava (paginating up to 200 per page)
    let page = 1;
    const starredSegmentIds = [];

    while (true) {
      console.log(`Fetching starred segments page ${page} for athlete ${athleteId}...`);
      const res = await stravaFetch(athleteId, `segments/starred?page=${page}&per_page=200`);

      if (!res.ok) {
        const errText = await res.text();
        console.error(`Strava API error (${res.status}): ${errText}`);
        return {
          statusCode: res.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "Strava API Error", statusCode: res.status, details: errText }),
        };
      }

      const segments = await res.json();
      if (!Array.isArray(segments) || segments.length === 0) break;

      for (const seg of segments) {
        if (seg.id) starredSegmentIds.push(String(seg.id));
      }

      if (segments.length < 200) break;
      page++;
    }

    // 3. Overwrite starred_segment_list in AthleteDetails
    const now = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: ATHLETE_TABLE,
        Key: { athleteId },
        UpdateExpression: "SET starred_segment_list = :list, last_starred_synced_at = :syncedAt",
        ExpressionAttributeValues: {
          ":list": starredSegmentIds,
          ":syncedAt": now,
        },
      })
    );

    console.log(`Updated starred_segment_list with ${starredSegmentIds.length} segments.`);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        message: "Starred segments list refreshed successfully.",
        athleteId,
        count: starredSegmentIds.length,
        starred_segment_list: starredSegmentIds,
        last_starred_synced_at: now,
      }),
    };
  } catch (err) {
    console.error("Execution error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Internal Server Error", message: err.message }),
    };
  }
};