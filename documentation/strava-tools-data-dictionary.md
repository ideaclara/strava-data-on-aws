### Telemetry Interpretation Guidelines

* **Biometrics & Fitness Signature (`AthleteDetails`):**
  * `weight`: Body mass in kilograms (kg).
  * `xert_fitness_signature.pp`: Peak Power in Watts (W).
  * `xert_fitness_signature.ftp`: Threshold Power in Watts (W).
  * `xert_fitness_signature.ltp`: Lower Threshold Power in Watts (W).
  * `xert_fitness_signature.hie`: High Intensity Energy in kilojoules (kJ).

* **Segment Metadata (`StravaSegments`):**
  * `distance`: Length measured along the corridor in meters (m).
  * `elevation_high`, `elevation_low`, `total_elevation_gain`: Altitudes in meters (m).
  * `average_grade`, `maximum_grade`: Slope in percent (%).
  * `climb_category`: `0` = uncategorized/minor incline; `1` = Cat 4 up to `5` = Hors Catégorie (HC).
  * `xoms` (`kom`, `qom`, `overall`): Display strings formatted as `"ss"`, `"m:ss"`, or `"h:mm:ss"`. Convert into integer seconds before performing mathematical comparisons against effort times.

* **Effort Telemetry & Rankings (`StravaSegmentEfforts`):**
  * `elapsed_time`: Total duration from start trigger to finish line in seconds.
  * `moving_time`: Net moving duration in seconds.
  * `average_watts`: Mean power output in Watts (W).
  * `device_watts`: Boolean flag; `true` indicates on-bike power meter measurement, `false` indicates Strava algorithm estimation.
  * `average_heartrate`, `max_heartrate`: Heart rate in beats per minute (BPM).
  * `average_cadence`: Pedaling cadence in revolutions per minute (RPM).
  * `personal_pr_rank`: All-time Standard Competition Rank ("1224" rank) evaluated on `elapsed_time` (1 = fastest lifetime attempt). Tied times share the same rank and skip subsequent places.

* **Effort Prediction Model (`predict-segment-effort`):**
  * `mid_prediction`: Expected performance outcome (`power` in Watts, `time` in seconds).
  * `lower_prediction`: Optimistic lower duration bound / lower power demand (`power` in Watts, `time` in seconds).
  * `upper_prediction`: Conservative upper duration bound / upper pacing target (`power` in Watts, `time` in seconds).
  * `certainty`: Numeric confidence metric bounded from `0.0` (unreliable) to `1.0` (highly certain). Steeper gradients (≥ 5.0%) produce higher certainty scores (> 0.90) due to diminished aerodynamic variability.
  * `message`: Qualitative model explanation detailing slope stability and confidence grading.
  * `basis`: Physical parameters and model coefficients:
    * `total_weight_kg`: Combined system mass (rider mass + bike and kit allowance).
    * `total_cda_m2`: Total aerodynamic drag area ($C_d A$) in square meters.
    * `confidence_interval`: Statistical interval applied to predictions (e.g., `"90%"`).
    * `power_margin_delta_watts`: Sensitivity delta in Watts between prediction bounds.
    * `rolling_resistance_crr`: Coefficient of rolling resistance ($C_{rr}$, default `0.004`).
    * `air_density_rho_kg_m3`: Ambient air density ($\rho$, default `1.225 kg/m³`).
    * `drivetrain_efficiency`: Mechanical drivetrain efficiency (e.g., `0.975` for a 2.5% loss).
    * `gravity_m_s2`: Gravitational acceleration ($g = 9.81\text{ m/s}^2$).
    * `anaerobic_time_constant_tau_sec`: High-intensity energy discharge constant ($\tau$) in seconds.
    * `course_linear_work_coeff_c1`: Linear resistance work coefficient (gravity and rolling friction).
    * `course_aero_work_coeff_c3`: Non-linear aerodynamic resistance work coefficient.
  * `input_values`: Effective inputs resolved for the calculation:
    * `distance_m`: Course distance in meters.
    * `elevation_gain_m`: Total ascent in meters.
    * `gradient_pct`: Calculated average incline percentage.
    * `rider_weight_kg`: Rider body mass in kilograms.
    * `bike_and_kit_weight_kg`: Equipment allowance in kilograms (default `9.0 kg`).
    * `rider_height_m`: Optional athlete stature in meters.
    * `fitness_profile`: Applied metabolic parameters (`threshold_power_watts`, `high_intensity_energy_kj`, `peak_power_watts`).