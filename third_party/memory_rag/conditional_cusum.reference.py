"""Empirically calibrated case-mix monitoring prototype for V15.

Both global and conditional methods use the same normal-only probability
estimator, likelihood family and calibration target. Estimated probabilities
do not establish a conditional null or a theoretical e-process guarantee.
"""
import numpy as np

from change_detection.baselines import calibration_threshold, window_count

VERSION = "v15_task_background_risk_1"
TYPES = ["direct_fact", "ratio", "filtered_max"]
METHODS = ["window5", "global_cusum", "conditional_cusum", "global_mixture_sr", "conditional_mixture_sr"]
NAMES = dict(window5="滑窗", global_cusum="全局 CUSUM", conditional_cusum="条件 CUSUM",
             global_mixture_sr="全局混合 SR", conditional_mixture_sr="条件混合 SR")
ETA_GRID = np.geomspace(.05, .95, 7)
ALTERNATIVE_FRACTION = .2


def feature(task, context):
    if task not in TYPES or context not in {"target_only", "target_first", "background_first"}:
        raise ValueError("unsupported public request feature")
    return task + ":" + ("target_only" if context == "target_only" else "background")


def fit_risk(mean_rows):
    if len(mean_rows) != 162 or any(r["phase"] != "mean" or r["condition"] != "normal" for r in mean_rows):
        raise ValueError("risk fit requires 162 mean-phase normal observations")
    cells = {t+":"+c: dict(n=0, positives=0) for t in TYPES for c in ["target_only", "background"]}
    for row in mean_rows:
        if row["coverage_flag"] not in (0, 1):
            raise ValueError("binary monitoring observations required")
        cell = cells[feature(row["task_type"], row["context_variant"])]
        cell["n"] += 1
        cell["positives"] += row["coverage_flag"]
    if any(c["n"] == 0 for c in cells.values()):
        raise ValueError("all six strata require calibration observations")
    for cell in cells.values():
        cell["p0"] = float(np.clip((cell["positives"] + .5) / (cell["n"] + 1), .01, .99))
    global_p0 = sum(c["n"] * c["p0"] for c in cells.values()) / 162
    return dict(version=VERSION, estimator="Jeffreys_smoothed_clipped_point_estimate",
                cells=cells, global_p0=global_p0, fit_rows=162,
                global_matches_training_weighted_conditional_average=True,
                features=["public_task_type", "background_presence"],
                theoretical_conditional_validity_claimed=False)


def likelihood(x, p0, eta):
    p1 = p0 + eta * (1-p0)
    return np.where(x == 1, p1/p0, (1-p1)/(1-p0))


def cusum(x, p0):
    factors = likelihood(x, p0, ALTERNATIVE_FRACTION)
    log_factors = np.log(factors)
    out = np.zeros_like(x, dtype=float)
    state = np.zeros(x.shape[0])
    for i in range(x.shape[1]):
        state = np.maximum(0., state + log_factors[:, i])
        out[:, i] = state
    return out


def mixture_sr(x, p0):
    states = np.zeros((len(ETA_GRID), x.shape[0]))
    out = np.zeros_like(x, dtype=float)
    for i in range(x.shape[1]):
        factors = likelihood(x[None, :, i], p0[None, :, i], ETA_GRID[:, None])
        states = (states + 1) * factors
        out[:, i] = states.mean(axis=0)
    return out


def scores(x, tasks, contexts, risk):
    x = np.atleast_2d(np.asarray(x, dtype=float))
    tasks, contexts = np.asarray(tasks), np.asarray(contexts)
    if tasks.shape != x.shape or contexts.shape != x.shape or not np.all((x == 0) | (x == 1)):
        raise ValueError("aligned binary signal and public metadata required")
    conditional = np.empty_like(x)
    for index in np.ndindex(x.shape):
        conditional[index] = risk["cells"][feature(str(tasks[index]), str(contexts[index]))]["p0"]
    global_p = np.full_like(x, risk["global_p0"])
    if not np.all((conditional > 0) & (conditional < 1)) or not 0 < risk["global_p0"] < 1:
        raise ValueError("probabilities must lie strictly between zero and one")
    result = dict(window5=window_count(x, 5), global_cusum=cusum(x, global_p),
                  conditional_cusum=cusum(x, conditional), global_mixture_sr=mixture_sr(x, global_p),
                  conditional_mixture_sr=mixture_sr(x, conditional))
    if not all(np.all(np.isfinite(value)) and np.all(value >= 0) for value in result.values()):
        raise ValueError("invalid monitoring statistic")
    return result


def calibrate(score_map, target=.1):
    if list(score_map) != METHODS or any(s.shape != (20, 60) for s in score_map.values()):
        raise ValueError("twenty 60-step calibration streams required")
    thresholds = {}
    for name, score in score_map.items():
        threshold = calibration_threshold(score, target)
        if name.endswith("mixture_sr"):
            threshold = max(1+1e-9, threshold)
        thresholds[name] = threshold
    alarms = {name: int(np.any(score >= thresholds[name], axis=1).sum()) for name, score in score_map.items()}
    return dict(thresholds=thresholds, calibration_alarm_streams=alarms,
                achieved_calibration_far={name: count/20 for name, count in alarms.items()},
                maxima={name: score.max(axis=1).tolist() for name, score in score_map.items()},
                threshold_rank=19, target_far_60=target, parameter_selection_uses_test=False)
