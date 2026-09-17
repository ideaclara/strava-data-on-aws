#!/usr/bin/env python3
import json
import urllib.request

segment_id = input("Enter Strava Segment ID: ").strip()
if not segment_id:
    raise SystemExit("Error: Segment ID cannot be empty.")

base_url = f"https://chd10yvm86.execute-api.eu-west-2.amazonaws.com/segments/{segment_id}"

# 1. Fetch Segment Details
req_segment = urllib.request.Request(
    base_url,
    data=json.dumps({"athleteId": "3634905"}).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="GET",
)

print(f"Fetching segment {segment_id}...")
with urllib.request.urlopen(req_segment) as response:
    segment_data = json.loads(response.read().decode("utf-8"))

seg_filename = f"Segment_{segment_id}.json"
with open(seg_filename, "w", encoding="utf-8") as f:
    json.dump(segment_data, f, indent=2)
print(f"Saved to {seg_filename}")

# 2. Fetch Segment Efforts
req_efforts = urllib.request.Request(
    f"{base_url}/efforts",
    headers={"Content-Type": "application/json"},
    method="GET",
)

print(f"Fetching efforts for {segment_id}...")
with urllib.request.urlopen(req_efforts) as response:
    efforts_data = json.loads(response.read().decode("utf-8"))

efforts_filename = f"SegmentEfforts_{segment_id}.json"
with open(efforts_filename, "w", encoding="utf-8") as f:
    json.dump(efforts_data, f, indent=2)
print(f"Saved to {efforts_filename}")