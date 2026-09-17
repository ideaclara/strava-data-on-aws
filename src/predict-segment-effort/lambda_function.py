import json
import math
import os
from typing import Any, Dict, Optional, Tuple
import boto3
from botocore.exceptions import ClientError

# ==============================================================================
# ENVIRONMENT VARIABLES & DYNAMODB TABLES
# ==============================================================================
DYNAMODB_TABLE_SEGMENTS = os.environ.get("SEGMENTS_TABLE_NAME", "StravaSegments")
DYNAMODB_TABLE_ATHLETES = os.environ.get("ATHLETES_TABLE_NAME", "AthleteDetails")

dynamodb = boto3.resource("dynamodb")
segments_table = dynamodb.Table(DYNAMODB_TABLE_SEGMENTS)
athletes_table = dynamodb.Table(DYNAMODB_TABLE_ATHLETES)

# ==============================================================================
# ALLOWED DEFAULTS & PHYSICAL CONSTANTS
# ==============================================================================
DEFAULT_BIKE_KIT_MASS_KG: float = 9.0
DEFAULT_CONFIDENCE: float = 0.90

# Reference constants for anthropometric scaling
REFERENCE_RIDER_MASS_KG: float = 75.0
REFERENCE_RIDER_HEIGHT_M: float = 1.80
REFERENCE_CDA: float = 0.320  # Baseline CdA on brake hoods (m^2)

# Calibrated physics constants
GRAVITY_ACCEL: float = 9.81  # m/s^2
ROLLING_RESISTANCE_CRR: float = 0.0040  # Rolling resistance coefficient
AIR_DENSITY_RHO: float = 1.225  # Air density at sea level, 15°C (kg/m^3)
DRIVETRAIN_EFFICIENCY: float = 0.975  # ~2.5% frictional loss

# Empirical noise / confidence model
SIGMA_FLAT_NOISE_WATTS: float = 55.0  # Max residual error on flats
R2_Y0: float = 0.22
R2_L: float = 0.74
R2_K: float = 0.39
R2_G0: float = -0.70

# Reliability warning & confidence thresholds
MIN_RELIABLE_TIME_SEC: float = 120.0
MIN_RELIABLE_GRADIENT_PCT: float = 1.5
HIGH_CONFIDENCE_GRADIENT_PCT: float = 5.0

# Critical z-values for normal distribution
Z_CRITICAL = {
    0.80: 1.282,
    0.85: 1.440,
    0.90: 1.645,
    0.95: 1.960,
    0.99: 2.576,
}


def build_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
        "body": json.dumps(body, indent=2),
    }


# ==============================================================================
# SCIENTIFIC & ROOT-FINDING ROUTINES
# ==============================================================================
def estimate_cda(
    rider_mass_kg: float,
    rider_height_m: Optional[float] = None,
    reference_cda: float = REFERENCE_CDA,
) -> float:
    """Estimates effective CdA using Martin/Du Bois allometric scaling."""
    if rider_height_m and rider_height_m > 0:
        mass_factor = (rider_mass_kg / REFERENCE_RIDER_MASS_KG) ** 0.425
        height_factor = (rider_height_m / REFERENCE_RIDER_HEIGHT_M) ** 0.725
        return float(reference_cda * mass_factor * height_factor)
    return float(
        reference_cda * (rider_mass_kg / REFERENCE_RIDER_MASS_KG) ** (2.0 / 3.0)
    )


def solve_bisection(
    func, a: float = 1.0, b: float = 14400.0, tol: float = 1e-4, max_iter: int = 80
) -> float:
    """Robust 1D bisection root-finder requiring zero external libraries."""
    fa = func(a)
    fb = func(b)
    if fa * fb > 0:
        raise ValueError(
            f"Equilibrium root not bracketed between {a}s and {b}s."
        )

    for _ in range(max_iter):
        mid = 0.5 * (a + b)
        if (b - a) < tol:
            return mid
        fmid = func(mid)
        if abs(fmid) < 1e-7:
            return mid
        if fa * fmid < 0:
            b = mid
            fb = fmid
        else:
            a = mid
            fa = fmid
    return 0.5 * (a + b)


def calculate_prediction(
    distance_m: float,
    elevation_gain_m: Optional[float],
    gradient_pct: Optional[float],
    tp_watts: float,
    hie_kj: float,
    pp_watts: Optional[float],
    rider_mass_kg: float,
    bike_and_kit_mass_kg: float = DEFAULT_BIKE_KIT_MASS_KG,
    rider_height_m: Optional[float] = None,
    confidence: float = DEFAULT_CONFIDENCE,
) -> Dict[str, Any]:
    """Calculates maximal performance equilibrium and formats JSON response."""
    hie_joules = hie_kj * 1000.0
    total_mass_kg = rider_mass_kg + bike_and_kit_mass_kg
    cda = estimate_cda(rider_mass_kg, rider_height_m)

    # Resolve gradient & elevation gain
    if gradient_pct is None:
        if elevation_gain_m is None:
            raise ValueError(
                "Either elevation_gain_m or gradient_pct must be provided."
            )
        gradient_pct = (elevation_gain_m / distance_m) * 100.0
    else:
        if elevation_gain_m is None:
            elevation_gain_m = distance_m * (gradient_pct / 100.0)

    g_dec = gradient_pct / 100.0

    # Road resistance work coefficients: P_req(t) = c1/t + c3/t^3
    c1 = (
        total_mass_kg
        * GRAVITY_ACCEL
        * (g_dec + ROLLING_RESISTANCE_CRR)
        * distance_m
        / DRIVETRAIN_EFFICIENCY
    )
    c3 = (
        0.5
        * AIR_DENSITY_RHO
        * cda
        * (distance_m**3)
        / DRIVETRAIN_EFFICIENCY
    )

    # Predictability (R^2) and standard error
    r2_calc = R2_Y0 + R2_L / (1.0 + math.exp(-R2_K * (gradient_pct - R2_G0)))
    r2_est = max(0.10, min(0.96, r2_calc))
    sigma_g = SIGMA_FLAT_NOISE_WATTS * math.sqrt(max(0.0, 1.0 - r2_est))

    z_score = Z_CRITICAL.get(round(confidence, 2), 1.645)
    delta_p = z_score * sigma_g

    # Athlete capacity model
    if pp_watts and pp_watts > tp_watts:
        tau = hie_joules / (pp_watts - tp_watts)

        def p_rider(t: float) -> float:
            p = tp_watts + (hie_joules / t) * (1.0 - math.exp(-t / tau))
            return min(p, pp_watts)

    else:
        tau = None

        def p_rider(t: float) -> float:
            p = tp_watts + (hie_joules / t)
            return min(p, pp_watts) if pp_watts else p

    def p_course(t: float, offset: float = 0.0) -> float:
        return (c1 / t) + (c3 / (t**3)) + offset

    def solve_equilibrium(offset: float) -> Tuple[float, float]:
        t_sol = solve_bisection(lambda t: p_rider(t) - p_course(t, offset))
        return float(t_sol), float(p_rider(t_sol))

    t_mid, p_mid = solve_equilibrium(0.0)
    t_fast, p_high = solve_equilibrium(-delta_p)
    t_slow, p_low = solve_equilibrium(+delta_p)

    warnings = []
    if t_mid < MIN_RELIABLE_TIME_SEC:
        warnings.append(
            f"CAUTION (Short Effort): Predicted time ({t_mid:.1f}s < {MIN_RELIABLE_TIME_SEC:.0f}s). "
            "The model may be poor at judging short efforts."
        )

    if gradient_pct < MIN_RELIABLE_GRADIENT_PCT:
        warnings.append(
            f"CAUTION (Low Gradient): Segment gradient ({gradient_pct:.1f}%) is less than {MIN_RELIABLE_GRADIENT_PCT:.1f}%, "
            "and factors such as wind direction and group drafting significantly affect overall speed. "
            f"Certainty is estimated as {r2_est:.2f} on a scale of 0 to 1, where 1 is very certain."
        )
    elif gradient_pct >= HIGH_CONFIDENCE_GRADIENT_PCT:
        warnings.append(
            f"HIGH CONFIDENCE: Steeper gradient ({gradient_pct:.1f}%) is at least {HIGH_CONFIDENCE_GRADIENT_PCT:.1f}%, "
            "and the model tends to provide more consistent results. "
            f"Certainty is estimated as {r2_est:.2f} on a scale of 0 to 1, where 1 is very certain."
        )
    else:
        warnings.append(
            f"MODERATE CONFIDENCE: Medium gradient ({gradient_pct:.1f}%) provides good results, but may not be highly consistent. "
            f"Certainty is estimated as {r2_est:.2f} on a scale of 0 to 1, where 1 is very certain."
        )

    return {
        "mid_prediction": {
            "power": round(p_mid, 1),
            "time": round(t_mid, 1),
        },
        "upper_prediction": {
            "power": round(p_high, 1),
            "time": round(t_slow, 1),
        },
        "lower_prediction": {
            "power": round(p_low, 1),
            "time": round(t_fast, 1),
        },
        "message": " | ".join(warnings),
        "certainty": round(r2_est, 3),
        "basis": {
            "total_weight_kg": round(total_mass_kg, 2),
            "total_cda_m2": round(cda, 4),
            "confidence_interval": f"{int(confidence * 100)}%",
            "power_margin_delta_watts": round(delta_p, 1),
            "rolling_resistance_crr": ROLLING_RESISTANCE_CRR,
            "air_density_rho_kg_m3": AIR_DENSITY_RHO,
            "drivetrain_efficiency": DRIVETRAIN_EFFICIENCY,
            "gravity_m_s2": GRAVITY_ACCEL,
            "anaerobic_time_constant_tau_sec": round(tau, 2) if tau else None,
            "course_linear_work_coeff_c1": round(c1, 1),
            "course_aero_work_coeff_c3": round(c3, 1),
        },
        "input_values": {
            "distance_m": round(distance_m, 1),
            "elevation_gain_m": round(elevation_gain_m, 1),
            "gradient_pct": round(gradient_pct, 2),
            "rider_weight_kg": round(rider_mass_kg, 1),
            "bike_and_kit_weight_kg": round(bike_and_kit_mass_kg, 1),
            "rider_height_m": (
                round(rider_height_m, 2) if rider_height_m else None
            ),
            "fitness_profile": {
                "threshold_power_watts": round(tp_watts, 1),
                "high_intensity_energy_kj": round(hie_kj, 2),
                "peak_power_watts": round(pp_watts, 1) if pp_watts else None,
            },
        },
    }


# ==============================================================================
# DYNAMODB HELPERS
# ==============================================================================
def get_athlete_from_db(athlete_id: str) -> Dict[str, Any]:
    try:
        response = athletes_table.get_item(Key={"athleteId": str(athlete_id)})
        return response.get("Item") or {}
    except ClientError as e:
        print(f"DynamoDB Athlete Lookup Error: {e}")
        return {}


def get_segment_from_db(segment_id: str) -> Dict[str, Any]:
    try:
        response = segments_table.get_item(Key={"segmentId": str(segment_id)})
        return response.get("Item") or {}
    except ClientError as e:
        print(f"DynamoDB Segment Lookup Error: {e}")
        return {}


# ==============================================================================
# AWS LAMBDA ENTRY POINT
# ==============================================================================
def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Handles GET /predict-segment-effort/{segmentId} and GET /predict-segment-effort."""
    try:
        path_params = event.get("pathParameters") or {}
        query_params = event.get("queryStringParameters") or {}

        # Safely parse JSON body if present
        body_data = {}
        raw_body = event.get("body")
        if raw_body:
            try:
                body_data = (
                    json.loads(raw_body)
                    if isinstance(raw_body, str)
                    else raw_body
                )
            except Exception:
                body_data = {}

        inputs = {**query_params, **body_data}

        # ----------------------------------------------------------------------
        # 1. Resolve Segment Geometry (DynamoDB or Direct Input)
        # ----------------------------------------------------------------------
        segment_id = path_params.get("segmentId") or inputs.get("segmentId")

        distance_m: Optional[float] = None
        elevation_gain_m: Optional[float] = None
        gradient_pct: Optional[float] = None

        if segment_id:
            segment_item = get_segment_from_db(str(segment_id))
            if not segment_item:
                return build_response(
                    404,
                    {
                        "error": f"Segment '{segment_id}' not found in StravaSegments table."
                    },
                )

            if "distance" in segment_item:
                distance_m = float(segment_item["distance"])
            elif "distance_m" in segment_item:
                distance_m = float(segment_item["distance_m"])

            if "average_grade" in segment_item:
                gradient_pct = float(segment_item["average_grade"])
            elif "total_elevation_gain" in segment_item:
                elevation_gain_m = float(segment_item["total_elevation_gain"])

        # Check explicit inputs if not resolved from DB
        if distance_m is None:
            val = inputs.get("distance_m") or inputs.get("distance")
            if val is not None:
                distance_m = float(val)

        if gradient_pct is None:
            val = inputs.get("gradient_pct") or inputs.get("gradient")
            if val is not None:
                gradient_pct = float(val)

        if elevation_gain_m is None:
            val = inputs.get("elevation_gain_m") or inputs.get("elevation")
            if val is not None:
                elevation_gain_m = float(val)

        # Validation: Distance and Grade
        if distance_m is None or distance_m <= 0:
            return build_response(
                400,
                {
                    "error": "Missing required segment distance. Provide 'distance_m' (or valid segmentId)."
                },
            )

        if gradient_pct is None and elevation_gain_m is None:
            return build_response(
                400,
                {
                    "error": "Missing required grade. Provide either 'gradient_pct' or 'elevation_gain_m' (or valid segmentId)."
                },
            )

        # ----------------------------------------------------------------------
        # 2. Resolve Athlete Profile & Biometrics (DynamoDB or Direct Input)
        # ----------------------------------------------------------------------
        athlete_id = inputs.get("athleteId")
        athlete_db_item = (
            get_athlete_from_db(str(athlete_id)) if athlete_id else {}
        )

        if athlete_id and not athlete_db_item:
            return build_response(
                404,
                {
                    "error": f"Athlete '{athlete_id}' not found in AthleteDetails table."
                },
            )

        # Helper to unwrap values from nested dicts, flat dicts, or DynamoDB {'N': ...} maps
        def get_val(keys, *sources) -> Optional[float]:
            for src in sources:
                if not isinstance(src, dict):
                    continue
                for k in keys:
                    if k in src and src[k] is not None:
                        val = src[k]
                        if isinstance(val, dict) and "N" in val:
                            return float(val["N"])
                        try:
                            return float(val)
                        except (ValueError, TypeError):
                            continue
            return None

        # Unpack xert_fitness_signature (handles native Python maps & raw DynamoDB {'M': ...})
        raw_xert = athlete_db_item.get("xert_fitness_signature", {})
        if isinstance(raw_xert, dict) and "M" in raw_xert:
            xert_sig = {
                k: (v.get("N") or v.get("S") or v)
                for k, v in raw_xert["M"].items()
                if isinstance(v, dict)
            }
        else:
            xert_sig = raw_xert if isinstance(raw_xert, dict) else {}

        # Direct input fitness profile / signature
        fit_profile = (
            inputs.get("fitness_profile")
            or inputs.get("xert_signature")
            or inputs.get("fitnessSignature")
            or inputs.get("xert_fitness_signature")
            or {}
        )

        # Athlete weight / mass
        rider_mass_kg = get_val(
            ["rider_mass_kg", "rider_weight", "weight"],
            inputs,
            athlete_db_item,
        )
        if rider_mass_kg is None or rider_mass_kg <= 0:
            return build_response(
                400,
                {
                    "error": "Missing required rider mass. Provide 'rider_mass_kg' (or valid athleteId)."
                },
            )

        # Athlete height (optional)
        rider_height_m = get_val(
            ["rider_height_m", "rider_height", "height"],
            inputs,
            athlete_db_item,
        )
        if rider_height_m is not None and rider_height_m > 3.0:
            rider_height_m /= 100.0  # Convert cm to meters

        # Threshold Power (TP / FTP)
        tp_watts = get_val(
            [
                "ftp",
                "tp",
                "tp_watts",
                "threshold_power_watts",
                "threshold_power",
                "thresholdPower",
                "FTP",
                "TP",
            ],
            inputs,
            fit_profile,
            xert_sig,
            athlete_db_item,
        )
        if tp_watts is None or tp_watts <= 0:
            return build_response(
                400,
                {
                    "error": "Missing required fitness parameter: Threshold Power (TP/FTP).",
                    "available_athlete_keys": list(athlete_db_item.keys()),
                    "xert_signature_keys": list(xert_sig.keys()),
                },
            )

        # High Intensity Energy (HIE)
        hie_raw = get_val(
            [
                "hie",
                "hie_kj",
                "high_intensity_energy_kj",
                "high_intensity_energy",
                "HIE",
                "w_prime",
                "wPrime",
            ],
            inputs,
            fit_profile,
            xert_sig,
            athlete_db_item,
        )
        if hie_raw is not None:
            # Converts Joules to kJ if stored as e.g. 17200 instead of 17.2
            hie_kj = hie_raw / 1000.0 if hie_raw > 100.0 else hie_raw
        else:
            hie_j = get_val(
                ["hie_joules"],
                inputs,
                fit_profile,
                xert_sig,
                athlete_db_item,
            )
            hie_kj = hie_j / 1000.0 if hie_j is not None else None

        if hie_kj is None or hie_kj <= 0:
            return build_response(
                400,
                {
                    "error": "Missing required fitness parameter: High Intensity Energy (HIE).",
                    "available_athlete_keys": list(athlete_db_item.keys()),
                    "xert_signature_keys": list(xert_sig.keys()),
                },
            )

        # Peak Power (PP) - Optional
        pp_watts = get_val(
            [
                "pp",
                "pp_watts",
                "peak_power_watts",
                "peak_power",
                "peakPower",
                "PP",
                "pMax",
            ],
            inputs,
            fit_profile,
            xert_sig,
            athlete_db_item,
        )

        # ----------------------------------------------------------------------
        # 3. Optional Bike Mass & Confidence (using allowed defaults)
        # ----------------------------------------------------------------------
        bike_mass_raw = inputs.get("bike_and_kit_mass_kg")
        bike_and_kit_mass_kg = (
            float(bike_mass_raw)
            if bike_mass_raw is not None
            else DEFAULT_BIKE_KIT_MASS_KG
        )

        confidence_raw = inputs.get("confidence")
        confidence = (
            float(confidence_raw)
            if confidence_raw is not None
            else DEFAULT_CONFIDENCE
        )

        # ----------------------------------------------------------------------
        # 4. Execute Prediction
        # ----------------------------------------------------------------------
        prediction_result = calculate_prediction(
            distance_m=distance_m,
            elevation_gain_m=elevation_gain_m,
            gradient_pct=gradient_pct,
            tp_watts=tp_watts,
            hie_kj=hie_kj,
            pp_watts=pp_watts,
            rider_mass_kg=rider_mass_kg,
            bike_and_kit_mass_kg=bike_and_kit_mass_kg,
            rider_height_m=rider_height_m,
            confidence=confidence,
        )

        return build_response(200, prediction_result)

    except Exception as e:
        print(f"Handler Exception: {str(e)}")
        return build_response(
            500, {"error": "Internal computation error", "details": str(e)}
        )