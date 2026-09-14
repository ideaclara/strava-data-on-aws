#!/usr/bin/env bash
set -euo pipefail

REGION="eu-west-2"
API_ID="chd10yvm86"
ROLE_NAME="CyclingAnalyticsLambdaExecutionRole"

mkdir -p live-config src/strava-auth-callback src/strava-get-segment

echo "==> 1. Exporting DynamoDB table schemas..."
for TABLE in AthleteDetails StravaSegments StravaSegmentEfforts; do
  if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" > /dev/null 2>&1; then
    aws dynamodb describe-table \
      --table-name "$TABLE" \
      --region "$REGION" \
      --query "Table.{TableName:TableName,KeySchema:KeySchema,AttributeDefinitions:AttributeDefinitions,BillingModeSummary:BillingModeSummary}" \
      --output json > "live-config/dynamodb-${TABLE}.json"
    echo "    - Exported ${TABLE}"
  fi
done

echo "==> 2. Exporting HTTP API Gateway configuration..."
aws apigatewayv2 get-api \
  --api-id "$API_ID" \
  --region "$REGION" \
  --output json > "live-config/apigateway-${API_ID}.json"

# Export the live OpenAPI 3.0 specification from API Gateway
aws apigatewayv2 export-api \
  --api-id "$API_ID" \
  --specification OAS30 \
  --output-type JSON \
  --region "$REGION" \
  live-config/openapi-spec.json
echo "    - Exported OpenAPI spec to live-config/openapi-spec.json"

echo "==> 3. Exporting IAM Execution Role & Policies..."
aws iam get-role \
  --role-name "$ROLE_NAME" \
  --output json > "live-config/iam-role-${ROLE_NAME}.json"

aws iam list-attached-role-policies \
  --role-name "$ROLE_NAME" \
  --output json > "live-config/iam-role-attached-policies.json"

echo "==> 4. Exporting Lambda functions..."
for FN in strava-auth-callback strava-get-segment; do
  echo "    - Processing ${FN}..."
  aws lambda get-function \
    --function-name "$FN" \
    --region "$REGION" \
    --query "Configuration" \
    --output json > "live-config/lambda-${FN}-config.json"

  # Download and extract the code snapshot
  CODE_URL=$(aws lambda get-function --function-name "$FN" --region "$REGION" --query "Code.Location" --output text)
  curl -s "$CODE_URL" -o /tmp/code.zip
  unzip -qo /tmp/code.zip -d "src/${FN}/"
  rm -f /tmp/code.zip
done

echo "==> AWS configuration export complete."