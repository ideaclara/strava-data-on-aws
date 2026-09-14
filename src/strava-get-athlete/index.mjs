import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-west-2" }));
const ATHLETE_DETAILS_TABLE = process.env.ATHLETE_DETAILS_TABLE || "AthleteDetails";

const SENSITIVE_KEYS = new Set([
  "access_token",
  "refresh_token",
  "client_secret",
  "token_type"
]);

function sanitizeAthlete(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeAthlete);

  const sanitized = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    sanitized[key] = sanitizeAthlete(val);
  }
  return sanitized;
}

export const handler = async (event) => {
  try {
    const athleteId = event?.pathParameters?.athleteId;
    if (!athleteId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing athleteId in path parameter" })
      };
    }

    const result = await ddb.send(new GetCommand({
      TableName: ATHLETE_DETAILS_TABLE,
      Key: { athleteId }
    }));

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `Athlete ${athleteId} not found` })
      };
    }

    const sanitizedData = sanitizeAthlete(result.Item);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(sanitizedData, (key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    };
  } catch (err) {
    console.error("Failed to retrieve athlete details:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message })
    };
  }
};