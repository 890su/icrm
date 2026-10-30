# iCRM

@CONTEXT.md
@PLAN.md

## Agent Rules

- `CONTEXT.md` is the canonical AI entrypoint.
- `PLAN.md` is the active task state.
- `decisions.md` stores durable decisions and reasons.
- Respect `.aiignore` and `.rai.yaml` exclusions.
- Do not read `.library/`, `.chroma/`, `.git/`, `node_modules/`, generated
  builds, or local secret files unless explicitly instructed and safe.
- Do not store credentials in project files; use `secrets_ref`.
