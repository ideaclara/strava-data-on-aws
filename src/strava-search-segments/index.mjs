import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import Fuse from "fuse.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-west-2" }));
const SEGMENTS_TABLE = process.env.SEGMENTS_TABLE || "StravaSegments";

let cachedSegments = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getSegmentCatalog() {
  const now = Date.now();
  if (cachedSegments && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedSegments;
  }

const result = await ddb.send(
  new ScanCommand({
    TableName: SEGMENTS_TABLE,
    ProjectionExpression:
      "segmentId, #nm, climb_category, distance, total_elevation_gain, average_grade, #stats.#pr_time",
    ExpressionAttributeNames: {
      "#nm": "name",
      "#stats": "athlete_segment_stats",
      "#pr_time": "pr_elapsed_time",
    },
  })
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
        body: JSON.stringify({
          total: segments.length,
          segments,
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

    const formatted = filteredResults.map((result) => ({
      id: Number(result.item.segmentId),
      name: result.item.name,
      pr_elapsed_time: result.item.athlete_segment_stats?.pr_elapsed_time,
      distance: result.item.distance,
      average_grade: result.item.average_grade,
      climb_category: result.item.climb_category,
      match_score: result.score,
    }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(formatted),
    };
  } catch (err) {
    console.error("Search error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
