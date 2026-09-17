import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-west-2" }));
const EFFORTS_TABLE = process.env.EFFORTS_TABLE || "StravaSegmentEfforts";

// Serializer replacer that safely handles BigInt and NumberValue instances
function jsonReplacer(key, value) {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value;
}

export const handler = async (event) => {
  try {
    const segmentId = event?.pathParameters?.segmentId;

    if (!segmentId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing required path parameter: segmentId" })
      };
    }

    const scanIndexForward = event?.queryStringParameters?.order === "asc";
    const limit = event?.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit, 10) : undefined;

    const queryParams = {
      TableName: EFFORTS_TABLE,
      KeyConditionExpression: "segmentId = :s",
      ExpressionAttributeValues: {
        ":s": String(segmentId)
      },
      ScanIndexForward: scanIndexForward
    };

    if (limit && !isNaN(limit)) {
      queryParams.Limit = limit;
    }

    const result = await ddb.send(new QueryCommand(queryParams));

    const efforts = (result.Items || []).map((eff) => ({
      activityId: eff.activity?.id ?? null,
      start_date_local: eff.start_date_local ?? null,
      kom_rank: eff.kom_rank ?? null,
      max_heartrate: eff.max_heartrate ?? null,
      start_index: eff.start_index ?? null,
      average_cadence: eff.average_cadence ?? null,
      device_watts: eff.device_watts ?? null,
      moving_time: eff.moving_time ?? null,
      elapsed_time: eff.elapsed_time ?? null,
      effortId: eff.id ?? null,
      average_watts: eff.average_watts ?? null,
      average_heartrate: eff.average_heartrate ?? null,
      pr_rank: eff.pr_rank ?? null,
      personal_pr_rank: eff.personal_pr_rank ?? null
    }));

    const payload = {
      segmentId,
      count: efforts.length,
      efforts
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(payload, jsonReplacer)
    };
  } catch (err) {
    console.error("Error querying segment efforts:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message })
    };
  }
};