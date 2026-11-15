"""Stand-in for `prisma validate` / `prisma migrate` where Prisma is not installed.

    python tools/prisma_check.py schema.prisma            # structural checks
    python tools/prisma_check.py schema.prisma --sql      # also print PostgreSQL DDL

Checks: every type exists, every relation has its opposite side, exactly one side
of each relation holds the foreign key, key fields exist and types match, block
attributes reference real fields, every model has a primary key.
The DDL follows Prisma's naming and default referential actions closely enough to
load the schema into PostgreSQL for testing. It is NOT a replacement for the real
migration Prisma will generate.
"""
import re
import sys

SCALARS = {"String": "TEXT", "Int": "INTEGER", "Boolean": "BOOLEAN", "DateTime": "TIMESTAMP(3)", "Json": "JSONB",
           "Float": "DOUBLE PRECISION"}


def parse(text):
    text = re.sub(r"//.*", "", text)
    enums, models = {}, {}
    for kind, name, body in re.findall(r"^(model|enum)\s+(\w+)\s*\{(.*?)^\}", text, re.S | re.M):
        lines = [l.strip() for l in body.splitlines() if l.strip()]
        if kind == "enum":
            enums[name] = lines
            continue
        fields, block = [], []
        for l in lines:
            if l.startswith("@@"):
                block.append(l)
                continue
            m = re.match(r"(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)", l)
            fields.append({"name": m[1], "type": m[2], "list": m[3] == "[]", "optional": m[3] == "?", "attrs": m[4]})
        models[name] = {"fields": fields, "block": block}
    return enums, models


def rel_info(f):
    m = re.search(r"@relation\((.*?)\)(?!\])", f["attrs"])
    if not m:
        return None, None, None, None
    a = m[1]
    name = re.match(r'\s*"(\w+)"', a)
    fk = re.search(r"fields:\s*\[([^\]]*)\]", a)
    ref = re.search(r"references:\s*\[([^\]]*)\]", a)
    od = re.search(r"onDelete:\s*(\w+)", a)
    split = lambda s: [x.strip() for x in s[1].split(",")] if s else None   # noqa: E731
    return (name[1] if name else None), split(fk), split(ref), (od[1] if od else None)


def check(enums, models):
    errs = []
    for mn, m in models.items():
        names = {f["name"] for f in m["fields"]}
        by = {f["name"]: f for f in m["fields"]}
        if not any("@id" in f["attrs"] for f in m["fields"]) and not any(b.startswith("@@id") for b in m["block"]):
            errs.append(f"{mn}: no primary key")
        for b in m["block"]:
            for fld in re.search(r"\[([^\]]*)\]", b)[1].split(","):
                if fld.strip() not in names:
                    errs.append(f"{mn}: {b} names unknown field {fld.strip()}")
        for f in m["fields"]:
            t = f["type"]
            if t not in SCALARS and t not in enums and t not in models:
                errs.append(f"{mn}.{f['name']}: unknown type {t}")
            if t not in models:
                continue
            rn, fk, ref, _ = rel_info(f)
            opp = [g for g in models[t]["fields"] if g["type"] == mn and rel_info(g)[0] == rn
                   and not (t == mn and g["name"] == f["name"])]
            if len(opp) != 1:
                errs.append(f"{mn}.{f['name']}: expected exactly one opposite field on {t}, found {len(opp)}"
                            + (" (name the relations)" if len(opp) > 1 else ""))
                continue
            ofk = rel_info(opp[0])[1]
            if bool(fk) == bool(ofk):
                errs.append(f"{mn}.{f['name']} <-> {t}.{opp[0]['name']}: exactly one side must hold the foreign key")
            if fk:
                if f["list"]:
                    errs.append(f"{mn}.{f['name']}: the side holding the key cannot be a list")
                for a, b in zip(fk, ref):
                    if a not in names:
                        errs.append(f"{mn}.{f['name']}: key field {a} missing")
                        continue
                    tgt = {g["name"]: g for g in models[t]["fields"]}
                    if b not in tgt:
                        errs.append(f"{mn}.{f['name']}: references unknown {t}.{b}")
                    elif tgt[b]["type"] != by[a]["type"]:
                        errs.append(f"{mn}.{a}: type differs from {t}.{b}")
                    if by[a]["optional"] != f["optional"]:
                        errs.append(f"{mn}.{f['name']}: optionality differs from its key field {a}")
            elif not f["list"] and not f["optional"]:
                errs.append(f"{mn}.{f['name']}: back-relation must be a list or optional")
    return errs


STRICT = "--strict" in sys.argv      # strict = exactly what Prisma would emit (no test-only defaults)


def default_sql(f):
    m = re.search(r"@default\((.*?)\)(?:\s|$)", f["attrs"] + " ")
    if "@updatedAt" in f["attrs"]:
        return "" if STRICT else " DEFAULT CURRENT_TIMESTAMP"        # Prisma sets this in the client
    if not m:
        return ""
    v = m[1]
    if v == "now()":
        return " DEFAULT CURRENT_TIMESTAMP"
    if v == "cuid()":
        return "" if STRICT else " DEFAULT replace(gen_random_uuid()::text, '-', '')"   # Prisma generates ids in the client
    if v in ("true", "false") or re.fullmatch(r"-?\d+", v):
        return f" DEFAULT {v}"
    if v.startswith('"'):
        return " DEFAULT '" + v.strip('"') + "'"
    return f" DEFAULT '{v}'"                           # enum value


def to_sql(enums, models):
    out, later = [], []
    for en, vals in enums.items():
        out.append(f'CREATE TYPE "{en}" AS ENUM (' + ", ".join(f"'{v}'" for v in vals) + ");")
    for mn, m in models.items():
        cols = []
        for f in m["fields"]:
            if f["type"] in models:
                rn, fk, ref, od = rel_info(f)
                if fk:
                    act = od or ("SET NULL" if f["optional"] else "RESTRICT")
                    act = {"Cascade": "CASCADE", "Restrict": "RESTRICT", "SetNull": "SET NULL"}.get(act, act)
                    later.append(f'ALTER TABLE "{mn}" ADD CONSTRAINT "{mn}_{"_".join(fk)}_fkey" FOREIGN KEY ('
                                 + ", ".join(f'"{a}"' for a in fk) + f') REFERENCES "{f["type"]}" ('
                                 + ", ".join(f'"{b}"' for b in ref) + f") ON DELETE {act} ON UPDATE CASCADE;")
                continue
            t = "DATE" if "@db.Date" in f["attrs"] else SCALARS.get(f["type"], f'"{f["type"]}"')
            cols.append(f'  "{f["name"]}" {t}{"[]" if f["list"] else ""}'
                        + ("" if f["optional"] or f["list"] else " NOT NULL") + default_sql(f))
            if re.search(r"@id\b", f["attrs"]):
                cols.append(f'  CONSTRAINT "{mn}_pkey" PRIMARY KEY ("{f["name"]}")')
            if "@unique" in f["attrs"]:
                later.append(f'CREATE UNIQUE INDEX "{mn}_{f["name"]}_key" ON "{mn}" ("{f["name"]}");')
        for b in m["block"]:
            fl = [x.strip() for x in re.search(r"\[([^\]]*)\]", b)[1].split(",")]
            q = ", ".join(f'"{x}"' for x in fl)
            if b.startswith("@@id"):
                cols.append(f'  CONSTRAINT "{mn}_pkey" PRIMARY KEY ({q})')
            elif b.startswith("@@unique"):
                later.append(f'CREATE UNIQUE INDEX "{mn}_{"_".join(fl)}_key" ON "{mn}" ({q});')
            else:
                later.append(f'CREATE INDEX "{mn}_{"_".join(fl)}_idx" ON "{mn}" ({q});')
        out.append(f'CREATE TABLE "{mn}" (\n' + ",\n".join(cols) + "\n);")
    return "\n".join(out + later) + "\n"


if __name__ == "__main__":
    enums, models = parse(open(sys.argv[1]).read())
    errs = check(enums, models)
    for e in errs:
        print("ERROR:", e, file=sys.stderr)
    if "--sql" in sys.argv:
        print(to_sql(enums, models))
    else:
        nrel = sum(1 for m in models.values() for f in m["fields"] if f["type"] in models and rel_info(f)[1])
        print(f"{len(models)} models, {len(enums)} enums, {nrel} foreign keys, {len(errs)} problems")
    sys.exit(1 if errs else 0)
