import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-west-2" }));
const EFFORTS_TABLE = process.env.EFFORTS_TABLE || "StravaSegmentEfforts";

// Serializer replacer that safely handles BigInt and NumberValue instances
function jsonReplacer(key, value) {
  if (typeof value === "bigint") {
    // If it fits safely in a JS Number, convert to Number; otherwise preserve precision as String
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

    const payload = {
      segmentId,
      count: result.Items?.length || 0,
      efforts: result.Items || []
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