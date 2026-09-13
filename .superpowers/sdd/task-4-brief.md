### Task 4: 鏂囨。鏀跺彛

**Files:**
- Modify: `docs/specs/2026-09-09-trader-director-design.md` 鈥?鐘舵€佽鏀逛负 `proposed锛堣鍒掑凡灏辩华锛塦锛浡?.1 鏃佹敞 `run` 鍚?stub
- Modify: `.agents/notes/proposed/architecture/2026-09-09-trader-director.md` 鈥?Proposal 鏈姞璁″垝閾炬帴

- [ ] **Step 1: 瑙勬牸鐘舵€佷笌 stub 婢勬竻**

鍦ㄨ璁℃枃妗ｅご閮ㄧ姸鎬佹敼涓猴細

```markdown
- 鐘舵€侊細proposed锛堣鍒掑凡灏辩华 鈫?[plan](./2026-09-09-trader-director-plan.md)锛?```

鍦?搂2.1銆屼粎瀵?`launch` 璋?`run`銆嶆敼涓猴細

```markdown
- 瀵?`launch` 涓?`stub` 璋?`run`锛堟満浼氬啓妗╂垨鍚細璇濓級锛沗idle` 涓嶈皟锛沗launch` 鍚庢埅鏂悗缁溅閬?```

- [ ] **Step 2: Note 鍔犺鍒掗摼鎺?*

鍦?Proposal 鏈拷鍔狅細

```markdown
瀹炵幇璁″垝锛歔docs/specs/2026-09-09-trader-director-plan.md](../../../../docs/specs/2026-09-09-trader-director-plan.md)銆?```

- [ ] **Step 3: Commit**锛堜粎褰撶敤鎴锋槑纭姹傛椂锛?
```bash
git add docs/specs/2026-09-09-trader-director-design.md docs/specs/2026-09-09-trader-director-plan.md .agents/notes/proposed/architecture/2026-09-09-trader-director.md
git commit -m "docs: add TraderDirector implementation plan"
```

---

## Spec coverage锛堣嚜妫€锛?
| 瑙勬牸瑕佹眰 | 浠诲姟 |
|---|---|
| TraderDirector + 涓夌鍙?| Task 1鈥? |
| Opportunity = option-bar | Task 2鈥? |
| Risk/Behavior no-op | Task 1 `createIdleLane` + Task 3 |
| 琛屼负绛変环锛堟椂娈?妗?澶嶇洏锛?| Task 2鈥? 鍥炲綊娴?|
| 鏃犱簨浠舵€荤嚎 / 鏃犱笅鍗?/ 鏃?master | Global Constraints |
| launch 鎴柇鍚庣画杞﹂亾 | Task 1 鍗曟祴 |
| llmBusy 鈫?overlap | Task 1 |
| 鏂囨。鍐欐竻 B/C 杈圭晫 | Task 4 + 宸叉湁 design 搂9 |

## Placeholder scan

鏃?TBD /銆岀◢鍚庡疄鐜般€嶆楠わ紱B/C 鐨?Phase 2/3 浠呭湪 design 搂9锛屾湰璁″垝涓嶅疄鐜般€?
