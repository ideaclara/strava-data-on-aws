import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { stravaFetch } from "/opt/nodejs/stravaAuth.mjs";

const SEGMENTS_TABLE = process.env.SEGMENTS_TABLE || "StravaSegments";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "eu-west-2" }),
  {
    marshallOptions: {
      removeUndefinedValues: true,
      convertEmptyValues: false,
    },
  },
);

// Serializer replacer to safely handle 64-bit integers and SDK NumberValues
const serializeWithBigInt = (data) =>
  JSON.stringify(data, (key, value) => {
    if (typeof value === "bigint") {
      return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
    }
    if (value && typeof value === "object" && value.constructor?.name === "NumberValue") {
      return value.value;
    }
    return value;
  });

export const handler = async (event) => {
  console.log("Received invocation event:", JSON.stringify(event));

  // 1. Resolve segmentId (Path parameter, Query string, or Body)
  let rawSegmentId =
    event?.pathParameters?.segmentId ||
    event?.queryStringParameters?.segmentId ||
    event?.segmentId;

  // athleteId is now completely optional
  let rawAthleteId =
    event?.queryStringParameters?.athleteId ||
    event?.athleteId ||
    process.env.DEFAULT_ATHLETE_ID;

  if (event?.body) {
    try {
      const parsedBody =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      rawSegmentId = rawSegmentId || parsedBody.segmentId;
      rawAthleteId = rawAthleteId || parsedBody.athleteId;
    } catch {
      // Body not JSON; continue with extracted params
    }
  }

  // 2. Validate segmentId
  if (!rawSegmentId) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Bad Request",
        message: "Missing required parameter: segmentId",
      }),
    };
  }

  const segmentId = String(rawSegmentId).trim();
  if (!/^\d+$/.test(segmentId)) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Bad Request",
        message: "segmentId must be a positive numeric string.",
      }),
    };
  }

  const athleteId = rawAthleteId ? String(rawAthleteId).trim() : null;
  const refresh = event?.queryStringParameters?.refresh === "true";

  try {
    let item = null;

    // 3. Check DynamoDB cache first unless refresh=true is explicitly requested
    if (!refresh) {
      const getRes = await ddb.send(
        new GetCommand({
          TableName: SEGMENTS_TABLE,
          Key: { segmentId },
        }),
      );
      if (getRes.Item) {
        item = getRes.Item;
      }
    }

    // 4. Cache miss or forced refresh: fetch from Strava API if athlete credentials exist
    if (!item) {
      if (!athleteId) {
        if (refresh) {
          return {
            statusCode: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
            body: JSON.stringify({
              error: "Bad Request",
              message: "athleteId is required to refresh segment data from Strava.",
            }),
          };
        }

        return {
          statusCode: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({
            error: "Not Found",
            message: `Segment ${segmentId} not found in cache. Provide athleteId to fetch from Strava.`,
          }),
        };
      }

      console.log(`Fetching segment ${segmentId} from Strava API for athlete ${athleteId}...`);
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
      console.log(`Successfully retrieved "${segmentData.name}" from Strava.`);

      item = {
        ...segmentData,
        segmentId: String(segmentData.id),
        athleteId,
        last_synced_at: new Date().toISOString(),
      };

      // Persist complete upstream record to cache
      await ddb.send(
        new PutCommand({
          TableName: SEGMENTS_TABLE,
          Item: item,
        }),
      );
    }

    // 5. Project only the required segment attributes
    const responsePayload = {
      segmentId: item.id ? Number(item.id) : (isNaN(Number(item.segmentId)) ? item.segmentId : Number(item.segmentId)),
      name: item.name ?? null,
      activity_type: item.activity_type ?? null,
      distance: item.distance ?? null,
      average_grade: item.average_grade ?? null,
      maximum_grade: item.maximum_grade ?? null,
      elevation_high: item.elevation_high ?? null,
      elevation_low: item.elevation_low ?? null,
      start_latlng: item.start_latlng ?? null,
      end_latlng: item.end_latlng ?? null,
      climb_category: item.climb_category ?? 0,
      city: item.city ?? null,
      state: item.state ?? null,
      country: item.country ?? null,
      starred: item.starred ?? false,
      total_elevation_gain: item.total_elevation_gain ?? null,
      effort_count: item.effort_count ?? null,
      athlete_count: item.athlete_count ?? null,
      kom: item.xoms?.kom ?? item.xom?.kom ?? item.kom ?? null,
      qom: item.xoms?.qom ?? item.xom?.qom ?? item.qom ?? null,
      last_synced_at: item.last_synced_at ?? null,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: serializeWithBigInt(responsePayload),
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