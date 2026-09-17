#!/usr/bin/env python3
import json
import sys
import urllib.parse
import urllib.request


def search_segments():
    search_string = input("Enter search term: ").strip()
    if not search_string:
        print("Error: Search string cannot be empty.", file=sys.stderr)
        sys.exit(1)

    encoded_query = urllib.parse.quote(search_string)
    url = f"https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments?q={encoded_query}"

    req = urllib.request.Request(
        url,
        headers={"Content-Type": "application/json"},
        method="GET",
    )

    try:
        with urllib.request.urlopen(req) as response:
            raw_body = response.read().decode("utf-8")
            data = json.loads(raw_body)
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"URL Error: {e.reason}", file=sys.stderr)
        sys.exit(1)

    if isinstance(data, dict):
        segments = (
            data.get("segments")
            or data.get("items")
            or data.get("data")
            or [data]
        )
    elif isinstance(data, list):
        segments = data
    else:
        segments = []

    results = []
    for item in segments:
        stats = item.get("athlete_segment_stats") or {}

        segment_id = item.get("segmentId") or item.get("id")

        efforts = (
            item.get("number_of_efforts")
            if item.get("number_of_efforts") is not None
            else stats.get("effort_count")
            if stats.get("effort_count") is not None
            else item.get("effort_count")
        )

        pr = (
            item.get("pr")
            if item.get("pr") is not None
            else stats.get("pr_elapsed_time")
            if stats.get("pr_elapsed_time") is not None
            else item.get("pr_elapsed_time")
        )

        results.append({
            "segmentId": segment_id,
            "name": item.get("name"),
            "number_of_efforts": efforts,
            "pr": pr,
        })

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    search_segments()