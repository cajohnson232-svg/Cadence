-- 18 Nov 2026: a new standard hard rule, "Max days worked in a row" (6), for every existing program.
-- New programs get it from the rule library (systemRules); it is editable like any other rule.
INSERT INTO "Rule" ("id", "programId", "scope", "template", "params", "level", "source", "updatedAt")
SELECT 'sys_days_in_a_row_' || p."id", p."id", 'PROGRAM'::"RuleScope", 'max_days_in_a_row', '{"n": 6}'::jsonb, 'HARD'::"RuleLevel", 'SYSTEM'::"RuleSource", now()
  FROM "Program" p
 WHERE NOT EXISTS (SELECT 1 FROM "Rule" r WHERE r."programId" = p."id" AND r."template" = 'max_days_in_a_row');
