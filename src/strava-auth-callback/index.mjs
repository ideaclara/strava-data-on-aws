import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssmClient = new SSMClient({});

async function getCredentials() {
  const cmd = new GetParametersCommand({
    Names: ["/strava/client_id", "/strava/client_secret"],
    WithDecryption: true,
  });
  const res = await ssmClient.send(cmd);
  const creds = {};
  for (const p of res.Parameters) {
    if (p.Name === "/strava/client_id") creds.clientId = p.Value;
    if (p.Name === "/strava/client_secret") creds.clientSecret = p.Value;
  }
  return creds;
}

export const handler = async (event) => {
  // Support both HTTP API (event.queryStringParameters) and REST API formats
  const params = event.queryStringParameters || {};
  const code = params.code;
  const error = params.error;

  if (error || !code) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/html" },
      body: `<h1>Authorization Failed</h1><p>${error || "No code provided"}</p>`,
    };
  }

  try {
    const { clientId, clientSecret } = await getCredentials();

    // Exchange auth code for initial token bundle
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Strava token exchange failed: ${errText}`);
    }

    const tokens = await tokenRes.json();

    // Save tokens into DynamoDB
    await ddbDocClient.send(
      new PutCommand({
        TableName: "AthleteDetails",
        Item: {
          athleteId: String(tokens.athlete.id),
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
          scope: tokens.scope,
          firstname: tokens.athlete.firstname,
          lastname: tokens.athlete.lastname,
          updated_at: new Date().toISOString(),
        },
      })
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html" },
      body: `<h1>Success!!</h1><p>Athlete ${tokens.athlete.firstname} ${tokens.athlete.lastname} (ID: ${tokens.athlete.id}) authorized and tokens stored in DynamoDB.</p>`,
    };
  } catch (err) {
    console.error("Error during auth exchange:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/html" },
      body: `<h1>Internal Error</h1><p>${err.message}</p>`,
    };
  }
};