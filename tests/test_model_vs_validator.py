"""Randomised cross-check of the exact model against the independent validator.

For thousands of random (mostly rule-breaking) personal schedules, the model and
the plain-code validator must agree on whether the schedule is legal, and on
every soft-goal score.

    python -m tests.test_model_vs_validator
"""
import random
import numpy as np
from cadence.problem import Problem, STAGES
from cadence.generate import make_config
from cadence.model import Block
from cadence import validator

rng = random.Random(7)
configs = {
    "8h+12h, protected academic time": make_config((8, 12), 12, seed=11),
    "8h+10h, overnights starting at midnight": make_config((8, 10), 12, seed=21, late_nights=True),
    "8h+10h+12h, late overnights, excused academic time": make_config((8, 10, 12), 12, seed=22, late_nights=True,
                                                                         academic_policy="excused"),
}
for name, cfg in configs.items():
    P = Problem(cfg)
    share = P.balance_share()
    legal = illegal = 0
    for r in P.residents:
        b = Block(P, r, share)
        by_day = {}
        for k in b.keys:
            by_day.setdefault(P.slots[k].day, []).append(k)
        days = sorted(by_day)
        for trial in range(80):
            if trial % 2:      # a plausible stretch pattern: work a few, rest a few
                pick, d = [], rng.randrange(3)
                while d < len(days):
                    run = rng.randint(1, 6)
                    pick += days[d:d + run]; d += run + rng.randint(1, 3)
                pick = pick[:rng.randint(1, r.shifts_max + 1)]
                cat = rng.choice(list(P.cat_order))
                chosen = [rng.choice([k for k in by_day[d] if P.slots[k].cat == cat] or by_day[d]) for d in pick]
            else:              # anything goes
                chosen = [rng.choice(by_day[d]) for d in rng.sample(days, rng.randint(1, min(22, len(days))))]
                if rng.random() < 0.15:
                    d = P.slots[chosen[0]].day
                    extra = [k for k in by_day[d] if k != chosen[0]]
                    if extra:
                        chosen.append(rng.choice(extra))
            x = np.zeros(b.nx)
            for k in chosen:
                x[b.xpos[k]] = 1
            v = b.complete(x)
            model_ok = b.broken_rows(v) == 0
            shifts = P.hist[r.id] + [P.slots[k] for k in chosen]
            viol = validator.check_resident(P, r, shifts, check_min=False)
            assert model_ok == (not viol), (name, r.name, sorted(chosen), model_ok, viol[:3])
            if model_ok:
                legal += 1
                soft = validator.soft_resident(P, r, shifts, share)
                for st in STAGES[1:]:
                    assert abs(b.value(v, st) - soft[st]) < 1e-6, (name, r.name, st, b.value(v, st), soft[st])
            else:
                illegal += 1
    print(f"{name}: model and validator agree on {legal + illegal} random schedules "
          f"({legal} legal with identical soft scores, {illegal} illegal)")
print("MODEL AND VALIDATOR AGREE")
