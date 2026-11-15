"""Exact solver back ends. Both take the same matrix-form model.

  solve(model, ...) -> (status, values, bound)
      status: "optimal" (proven), "feasible" (time limit, has a solution),
              "infeasible", "unknown"

  * highs  - HiGHS branch-and-cut, via the copy bundled inside SciPy.
  * cpsat  - Google OR-Tools CP-SAT (the engine named in the spec).
"""
from __future__ import annotations
from dataclasses import dataclass
import os
import sys
import numpy as np
from scipy import sparse


@dataclass
class Model:
    lb: np.ndarray
    ub: np.ndarray
    integ: np.ndarray           # bool
    A: sparse.csr_matrix
    rlo: np.ndarray
    rhi: np.ndarray
    cost: np.ndarray


def have_cpsat():
    try:
        import ortools  # noqa: F401
        return True
    except ImportError:
        return False


def solve_highs(m: Model, time_limit, warm=None, log=False):
    from scipy.optimize._highspy import _core as hc
    A = m.A.tocsc()
    lp = hc.HighsLp()
    lp.num_col_, lp.num_row_ = A.shape[1], A.shape[0]
    lp.a_matrix_.num_col_, lp.a_matrix_.num_row_ = A.shape[1], A.shape[0]
    lp.a_matrix_.format_ = hc.MatrixFormat.kColwise
    lp.col_cost_ = m.cost.astype(float)
    lp.col_lower_, lp.col_upper_ = m.lb.astype(float), m.ub.astype(float)
    lp.row_lower_ = np.where(np.isinf(m.rlo), -hc.kHighsInf, m.rlo)
    lp.row_upper_ = np.where(np.isinf(m.rhi), hc.kHighsInf, m.rhi)
    lp.a_matrix_.start_, lp.a_matrix_.index_, lp.a_matrix_.value_ = A.indptr, A.indices, A.data
    I, Cn = hc.HighsVarType.kInteger, hc.HighsVarType.kContinuous
    lp.integrality_ = [I if b else Cn for b in m.integ]
    h = hc._Highs()
    h.setOptionValue("output_flag", bool(log))
    h.setOptionValue("threads", 1)
    h.passModel(lp)
    if warm is not None:
        sol = hc.HighsSolution()
        sol.col_value = np.asarray(warm, dtype=float)
        h.setSolution(sol)
    h.setOptionValue("time_limit", float(time_limit))
    if log:
        h.run()
    else:                                   # HiGHS occasionally prints debug lines straight to stdout
        sys.stdout.flush()
        saved, null = os.dup(1), os.open(os.devnull, os.O_WRONLY)
        os.dup2(null, 1)
        try:
            h.run()
        finally:
            os.dup2(saved, 1); os.close(saved); os.close(null)
    status, info = h.getModelStatus(), h.getInfo()
    if status == hc.HighsModelStatus.kInfeasible:
        return "infeasible", None, None
    if info.primal_solution_status == 2:
        vals = np.array(h.getSolution().col_value)
        vals[m.integ] = np.round(vals[m.integ])
        return ("optimal" if status == hc.HighsModelStatus.kOptimal else "feasible"), vals, info.mip_dual_bound
    return "unknown", None, None


def solve_cpsat(m: Model, time_limit, warm=None, log=False, workers=8):
    """OR-Tools CP-SAT. Everything in the model is integer-valued, so it maps over
    directly. NOT exercised in the sandbox this was written in (OR-Tools could
    not be installed there)."""
    from ortools.sat.python import cp_model
    cp = cp_model.CpModel()
    v = [cp.NewIntVar(int(round(l)), int(round(u)), f"v{j}") for j, (l, u) in enumerate(zip(m.lb, m.ub))]
    A = m.A.tocsr()
    for i in range(A.shape[0]):
        a, b = A.indptr[i], A.indptr[i + 1]
        e = sum(int(round(c)) * v[j] for j, c in zip(A.indices[a:b], A.data[a:b]))
        if np.isfinite(m.rlo[i]):
            cp.Add(e >= int(np.ceil(m.rlo[i] - 1e-6)))
        if np.isfinite(m.rhi[i]):
            cp.Add(e <= int(np.floor(m.rhi[i] + 1e-6)))
    nz = np.nonzero(m.cost)[0]
    cp.Minimize(sum(int(round(m.cost[j] * 6000)) * v[j] for j in nz))   # integer objective for CP-SAT
    if warm is not None:
        for j, val in enumerate(warm):
            cp.AddHint(v[j], int(round(val)))
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = float(time_limit)
    s.parameters.num_search_workers = workers
    s.parameters.log_search_progress = bool(log)
    st = s.Solve(cp)
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return ("optimal" if st == cp_model.OPTIMAL else "feasible"), np.array([s.Value(x) for x in v], dtype=float), s.BestObjectiveBound()
    return ("infeasible" if st == cp_model.INFEASIBLE else "unknown"), None, None


def solve(m: Model, time_limit, warm=None, backend="highs", log=False):
    return (solve_cpsat if backend == "cpsat" else solve_highs)(m, time_limit, warm, log)
