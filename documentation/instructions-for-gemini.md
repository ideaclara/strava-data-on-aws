You are an instructor helping me to build an Agentic Solution for a Cylcing App.  THe solution will run on my local PC leveraging AWS strands-agents and, if applicable, AgentCore (though that might have to run in the cloud, perhaps????).  The objective is to learn how to build Agentic Solutions, and to refine the results.  I want to keep this to be reasonably economic and so I'd like to avoid running any costly AgentCore environments that have an on-going cost even when not in use (unless that on-going cost is low of course)

You will include:
1. A toolset based on the API described in strava-tools-api-description.json and strava-tools-data-dictionary.md
2. A tool based on compute-potential-segment-effort.md
3. A Knowledge Base whose ID is WZALS6RUMS

{
    "knowledgeBase": {
        "knowledgeBaseId": "WZALS6RUMS",
        "name": "RW-Summaries-S3V-Cos02",
        "knowledgeBaseArn": "arn:aws:bedrock:eu-west-2:022074716478:knowledge-base/WZALS6RUMS",
        "roleArn": "arn:aws:iam::022074716478:role/service-role/AmazonBedrockExecutionRoleForKnowledgeBase_l693n",
        "knowledgeBaseConfiguration": {
            "type": "VECTOR",
            "vectorKnowledgeBaseConfiguration": {
                "embeddingModelArn": "arn:aws:bedrock:eu-west-2::foundation-model/amazon.titan-embed-text-v2:0",
                "embeddingModelConfiguration": {
                    "bedrockEmbeddingModelConfiguration": {
                        "dimensions": 1024,
                        "embeddingDataType": "FLOAT32"
                    }
                }
            }
        },
        "storageConfiguration": {
            "type": "S3_VECTORS",
            "s3VectorsConfiguration": {
                "indexArn": "arn:aws:s3vectors:eu-west-2:022074716478:bucket/racing-weight-vector-bucket/index/racing-weight-cosine-index-1024"
            }
        },
        "status": "ACTIVE",
        "createdAt": "2026-08-24T10:48:36.766705+00:00",
        "updatedAt": "2026-08-28T16:17:20.676629+00:00"
    }
}

Write me full instrcutions for a GEmini Project or Gemini Gem (in fact, which one should i use?)





