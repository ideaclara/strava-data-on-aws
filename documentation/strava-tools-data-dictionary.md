### Telemetry Interpretation Guidelines

* **Biometrics & Fitness Signature (`AthleteDetails`):**
  * `weight`: Body mass in kilograms ($\text{kg}$).
  * `xert_fitness_signature.pp`: Peak Power in Watts ($\text{W}$).
  * `xert_fitness_signature.ftp`: Threshold Power in Watts ($\text{W}$).
  * `xert_fitness_signature.ltp`: Lower Threshold Power in Watts ($\text{W}$).
  * `xert_fitness_signature.hie`: High Intensity Energy in kilojoules ($\text{kJ}$).

* **Segment Metadata (`StravaSegments`):**
  * `distance`: Length measured along the corridor in meters ($\text{m}$).
  * `elevation_high`, `elevation_low`, `total_elevation_gain`: Altitudes in meters ($\text{m}$).
  * `average_grade`, `maximum_grade`: Slope in percent ($\%$).
  * `climb_category`: `0` = uncategorized/minor incline; `1` = Cat 4 up to `5` = Hors Catégorie (HC).
  * `xoms` (`kom`, `qom`, `overall`): Display strings formatted as `"ss"`, `"m:ss"`, or `"h:mm:ss"`. Convert into integer seconds before performing mathematical comparisons against effort times.

* **Effort Telemetry & Rankings (`StravaSegmentEfforts`):**
  * `elapsed_time`: Total duration from start trigger to finish line in seconds.
  * `moving_time`: Net moving duration in seconds.
  * `average_watts`: Mean power output in Watts ($\text{W}$).
  * `device_watts`: Boolean flag; `true` indicates on-bike power meter measurement, `false` indicates Strava algorithm estimation.
  * `average_heartrate`, `max_heartrate`: Heart rate in beats per minute ($\text{BPM}$).
  * `average_cadence`: Pedaling cadence in revolutions per minute ($\text{RPM}$).
  * `personal_pr_rank`: All-time Standard Competition Rank ("1224" rank) evaluated on `elapsed_time` (1 = fastest lifetime attempt). Tied times share the same rank and skip subsequent places.