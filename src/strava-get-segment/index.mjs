import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { stravaFetch } from "/opt/nodejs/stravaAuth.mjs";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "eu-west-2" }),
  {
    marshallOptions: {
      removeUndefinedValues: true, // Auto-strips undefined fields so DynamoDB never throws
      convertEmptyValues: false,
    },
  },
);

// Serializer replacer to safely handle 64-bit integers and SDK NumberValues
const serializeWithBigInt = (data) =>
  JSON.stringify(data, (key, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value && typeof value === "object" && value.constructor?.name === "NumberValue") {
      return value.value;
    }
    return value;
  });

export const handler = async (event) => {
  console.log("Received invocation event:", JSON.stringify(event));

  // 1. Resolve parameters from API Gateway (Query / Body) or direct CLI / test invoke
  let rawSegmentId =
    event?.pathParameters?.segmentId ||
    event?.queryStringParameters?.segmentId ||
    event?.segmentId;

  let rawAthleteId =
    event?.queryStringParameters?.athleteId || 
    event?.athleteId;

  if (event?.queryStringParameters) {
    rawAthleteId = rawAthleteId || event.queryStringParameters.athleteId;
    rawSegmentId = rawSegmentId || event.queryStringParameters.segmentId;
  }

  if (event?.body) {
    try {
      const parsedBody =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      rawAthleteId = rawAthleteId || parsedBody.athleteId;
      rawSegmentId = rawSegmentId || parsedBody.segmentId;
    } catch {
      // Body was not JSON; let validation handle missing fields
    }
  }

  // 2. Enforce strict input validation
  const missing = [];
  if (!rawAthleteId) missing.push("athleteId");
  if (!rawSegmentId) missing.push("segmentId");

  if (missing.length > 0) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Bad Request",
        message: `Missing required parameter(s): ${missing.join(", ")}`,
      }),
    };
  }

  const athleteId = String(rawAthleteId).trim();
  const segmentId = String(rawSegmentId).trim();

  if (!/^\d+$/.test(athleteId) || !/^\d+$/.test(segmentId)) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Bad Request",
        message: "athleteId and segmentId must be positive numeric strings.",
      }),
    };
  }

  try {
    // 3. Fetch from Strava via Layer (transparent token check & refresh)
    console.log(`Fetching segment ${segmentId} for athlete ${athleteId}...`);
    const res = await stravaFetch(athleteId, `segments/${segmentId}`);

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Strava API returned ${res.status}: ${errorBody}`);
      return {
        statusCode: res.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
          error: "Strava API Error",
          statusCode: res.status,
          details: errorBody,
        }),
      };
    }

    const segmentData = await res.json();
    console.log(
      `Successfully retrieved "${segmentData.name}" (ID: ${segmentData.id})`,
    );

    // 4. Ingest the entire JSON response into DynamoDB
    const item = {
      ...segmentData,
      segmentId: String(segmentData.id), // Matches table's S partition key
      athleteId: athleteId,              // Retains context of requesting athlete
      last_synced_at: new Date().toISOString(),
    };

    await ddb.send(
      new PutCommand({
        TableName: "StravaSegments",
        Item: item,
      }),
    );

    console.log(`Stored complete segment ${segmentId} in StravaSegments.`);

    // 5. Return the full item payload directly at root level
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: serializeWithBigInt(item),
    };
  } catch (err) {
    console.error("Execution error:", err);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Internal Server Error",
        message: err.message,
      }),
    };
  }
};