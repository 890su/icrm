# Решения исполнителя плана 2026-10-31-record-rows

Формат: решение — почему — цена ошибки. Собрано из журнала исполнения (subagent-driven development).

- T1 `createIn(tx, i)` without `owner`; T4 adds the owner parameter once T3's insertRecord(owner) exists — cost: none.
- T4 implements the full RowOp union parse; `delete` ops reach a stub that throws Error('row delete is Task 5'); T5 replaces it — keeps T4 scope — cost: none.
- the `includeRows` assertion in T5's owner-archive test moves to T6 (T6 adds a test that archived rows stay hidden with includeRows) — cost: none.
- T4 fixture rows.yaml also has owned `primary_expense` (cardinality one → expense) on task, and a manual set `budget` with owned `budget_lines` → expense (task lacks it) for the unknown_field test — cost: none.
- accept create's unreachable race → SaveFailed(version_conflict) — single failure mode of persist — cost: none.
- `links` on create targeting an owned field → link_owned; carried into Task 5 (owned-field adoption rules live there) — spec §1.12 item 1 — cost: none.
- owner-input structural errors before row checks accepted (row errors are all collected) — cost: client may need two rounds in rare cases.
- fix round 1 anyway (approved task, controller choice): (a) insert all new rows and write the owned link BEFORE evaluating them, so rows see the owner's stored values; (b) link_target also checked for changed rows' final sets; (c) NO_ROWS not shared (fresh/frozen); (d) lock query filters workspace; (e) rename the misleading test and add an owner evaluation-error-after-rows-written rollback test. Documented limitation: a row rule depending on an owner value changed in the SAME save is checked against the owner's previous value; owner rollups over owner-dependent row formulas get corrected by the cascade (extra version bump) — spec §1.8 cascade semantics — cost: rare second save.
- accept strict owner re-evaluation on delete (consistent with batch) — cost: a delete can be refused by an owner rule; cascadeLimit option accepted (test seam, default unchanged).
- row op ids validated as uuid in the HTTP schema (Task 4 concern: non-uuid ids reach Postgres) — cost: none.
- I2 rule written to spec §1.12 item 3 + decisions.md before code: readonly on an owned field (owner's stored state) freezes row membership (batch new/delete, PUT-links exclusion, direct archive(row) → readonly; row values follow row rules; owner archive allowed; create unchecked); a live row keeps a target set on ANY save (batch or direct PATCH) — also resolves M2 — cost: a direct PATCH removing a row's target set is now refused.
- fix wave = I1, I2, M1 (row saves lock owner first via shared lockOwnerOf), M2 (via I2 ruling), M3 (RecordView/RowView expose ownerId/ownerField), M4 (rowsOf filters row.ownerId === rec.id && ownerField; owned-toggle migration → backlog), M5 docs + T8 README polish, M6 test. Backlog additions done by controller in PLAN.md.
