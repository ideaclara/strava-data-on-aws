import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import Fuse from "fuse.js";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "eu-west-2" }),
  {
    marshallOptions: {
      removeUndefinedValues: true,
      convertEmptyValues: false,
    },
  },
);

const SEGMENTS_TABLE = process.env.SEGMENTS_TABLE || "StravaSegments";

let cachedSegments = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Serializer replacer that safely handles BigInt and NumberValue instances
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

// Format an item to match the canonical segment schema
function formatSegment(item, score = null) {
  const formatted = {
    segmentId: item.id ? Number(item.id) : (isNaN(Number(item.segmentId)) ? item.segmentId : Number(item.segmentId)),
    name: item.name ?? null,
    activity_type: item.activity_type ?? "Ride",
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

  if (score !== null) {
    formatted.match_score = score;
  }

  return formatted;
}

async function getSegmentCatalog() {
  const now = Date.now();
  if (cachedSegments && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedSegments;
  }

  // Scan without restrictive projections so full route and climb attributes are available
  const result = await ddb.send(
    new ScanCommand({
      TableName: SEGMENTS_TABLE,
    }),
  );

  cachedSegments = result.Items || [];
  lastCacheTime = now;
  return cachedSegments;
}

export const handler = async (event) => {
  try {
    const query = event?.queryStringParameters?.q?.trim();
    const segments = await getSegmentCatalog();

    if (!query) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: serializeWithBigInt({
          total: segments.length,
          segments: segments.map((item) => formatSegment(item)),
        }),
      };
    }

    const fuse = new Fuse(segments, {
      keys: ["name"],
      threshold: 0.2,
      ignoreLocation: true,
      includeScore: true,
      minMatchCharLength: 2,
    });

    const searchResults = fuse.search(query);
    const filteredResults = searchResults.filter((result) => result.score <= 0.2);

    const formatted = filteredResults.map((result) =>
      formatSegment(result.item, result.score),
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: serializeWithBigInt(formatted),
    };
  } catch (err) {
    console.error("Search error:", err);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};