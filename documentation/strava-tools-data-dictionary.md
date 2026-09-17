### Telemetry Interpretation Guidelines

* **Biometrics, Fitness Signature & Curation Lists (`AthleteDetails`):**
  * `weight`: Body mass in kilograms (kg)[cite: 4].
  * `xert_fitness_signature.pp`: Peak Power in Watts (W)[cite: 4].
  * `xert_fitness_signature.ftp`: Threshold Power in Watts (W)[cite: 4].
  * `xert_fitness_signature.ltp`: Lower Threshold Power in Watts (W)[cite: 4].
  * `xert_fitness_signature.hie`: High Intensity Energy in kilojoules (kJ)[cite: 4].
  * `starred_segment_list`: Array of numeric segment ID strings populated by syncing the athlete's starred segments from Strava (`POST /segments/sync-starred`).
  * `additional_segment_list`: Curated array of numeric segment ID strings managed via append (`POST`) or replacement (`PUT`) calls to `/athlete/{athleteId}/additional-segments`.
  * `last_starred_synced_at`, `additional_segments_updated_at`: ISO 8601 timestamps of the most recent catalog list modifications.

* **Segment Metadata (`StravaSegments`):**
  * `segmentId`: Primary identifier (Number or numeric String).
  * `name`: Segment title string.
  * `activity_type`: Default `"Ride"`.
  * `distance`: Length measured along the corridor in meters (m)[cite: 4].
  * `elevation_high`, `elevation_low`, `total_elevation_gain`: Altitudes in meters (m)[cite: 4].
  * `average_grade`, `maximum_grade`: Slope in percent (%)[cite: 4].
  * `climb_category`: `0` = uncategorized/minor incline; `1` = Cat 4 up to `5` = Hors Catégorie (HC)[cite: 4].
  * `start_latlng`, `end_latlng`: Two-element arrays `[latitude, longitude]` denoting entry and exit GPS coordinates.
  * `city`, `state`, `country`: Geographical location strings.
  * `starred`: Boolean flag indicating if starred by the syncing athlete.
  * `effort_count`, `athlete_count`: All-time community participation metrics.
  * `kom`, `qom`: King/Queen of the Mountain leaderboard benchmark strings (formatted as `"ss"`, `"m:ss"`, or `"h:mm:ss"`). Convert into integer seconds before performing mathematical comparisons against effort times.
  * `last_synced_at`: ISO 8601 timestamp representing cache freshness in DynamoDB.

* **Effort Telemetry & Rankings (`StravaSegmentEfforts`):**
  * `activityId`: Canonical Strava activity ID linking to the parent ride.
  * `effortId`: Canonical Strava segment effort ID (large 64-bit integer serialized safely as a string or number).
  * `start_date_local`: Local timestamp of the attempt in ISO 8601 format.
  * `start_index`: Polyline stream start index.
  * `moving_time`: Net moving duration in seconds[cite: 4].
  * `elapsed_time`: Total duration from segment entry to exit in seconds[cite: 4].
  * `average_watts`: Mean power output in Watts (W)[cite: 4].
  * `device_watts`: Boolean flag; `true` indicates direct on-bike power meter measurement, `false` indicates Strava algorithm estimation[cite: 4].
  * `average_heartrate`, `max_heartrate`: Heart rate in beats per minute (BPM)[cite: 4].
  * `average_cadence`: Pedaling cadence in revolutions per minute (RPM)[cite: 4].
  * `pr_rank`: Native Strava rank badge (`1`, `2`, `3`, or `null`)[cite: 2, 4].
  * `kom_rank`: Native Strava all-time segment leaderboard rank or `null`.
  * `personal_pr_rank`: All-time Standard Competition Rank ("1224" rank) evaluated across all athlete attempts on `elapsed_time` (1 = fastest lifetime attempt)[cite: 2, 4]. Tied times share the same rank and skip subsequent ladder places[cite: 2, 4].

* **Effort Prediction Model (`predict-segment-effort`):**
  * `mid_prediction`: Expected performance outcome (`power` in Watts, `time` in seconds)[cite: 4].
  * `lower_prediction`: Optimistic lower duration bound / lower power demand (`power` in Watts, `time` in seconds)[cite: 4].
  * `upper_prediction`: Conservative upper duration bound / upper pacing target (`power` in Watts, `time` in seconds)[cite: 4].
  * `certainty`: Numeric confidence metric bounded from `0.0` (unreliable) to `1.0` (highly certain)[cite: 4]. Steeper gradients ($\ge 5.0\%$) produce higher certainty scores ($> 0.90$) due to diminished aerodynamic variability[cite: 4].
  * `message`: Qualitative model explanation detailing slope stability and confidence grading[cite: 4].
  * `basis`: Physical parameters and model coefficients[cite: 4]:
    * `total_weight_kg`: Combined system mass (rider mass + bike and kit allowance)[cite: 4].
    * `total_cda_m2`: Total aerodynamic drag area ($C_d A$) in square meters[cite: 4].
    * `confidence_interval`: Statistical interval applied to predictions (e.g., `"90%"`)[cite: 4].
    * `power_margin_delta_watts`: Sensitivity delta in Watts between prediction bounds[cite: 4].
    * `rolling_resistance_crr`: Coefficient of rolling resistance ($C_{rr}$, default `0.004`)[cite: 4].
    * `air_density_rho_kg_m3`: Ambient air density ($\rho$, default `1.225 kg/m³`)[cite: 4].
    * `drivetrain_efficiency`: Mechanical drivetrain efficiency (e.g., `0.975` for a 2.5% loss)[cite: 4].
    * `gravity_m_s2`: Gravitational acceleration ($g = 9.81\text{ m/s}^2$)[cite: 4].
    * `anaerobic_time_constant_tau_sec`: High-intensity energy discharge constant ($\tau$) in seconds[cite: 4].
    * `course_linear_work_coeff_c1`: Linear resistance work coefficient (gravity and rolling friction)[cite: 4].
    * `course_aero_work_coeff_c3`: Non-linear aerodynamic resistance work coefficient[cite: 4].
  * `input_values`: Effective inputs resolved for the calculation[cite: 4]:
    * `distance_m`: Course distance in meters[cite: 4].
    * `elevation_gain_m`: Total ascent in meters[cite: 4].
    * `gradient_pct`: Calculated average incline percentage[cite: 4].
    * `rider_weight_kg`: Rider body mass in kilograms[cite: 4].
    * `bike_and_kit_weight_kg`: Equipment allowance in kilograms (default `9.0 kg`)[cite: 4].
    * `rider_height_m`: Optional athlete stature in meters[cite: 4].
    * `fitness_profile`: Applied metabolic parameters (`threshold_power_watts`, `high_intensity_energy_kj`, `peak_power_watts`)[cite: 4].