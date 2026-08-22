@AGENTS.md

## Autonomous Workflow

This project uses Next.js, TypeScript, Tailwind CSS, Prisma, PostgreSQL, Supabase, and Vercel.

For every task, work autonomously end-to-end following this sequence:

1. **Analyze the root cause** before editing any code — do not patch symptoms.
2. **Implement the complete solution** — no partial or half-finished changes.
3. **Run checks**: `npm run lint`, `npx tsc --noEmit`, and `npm run build`.
4. **Fix all issues and rerun checks** until lint, type-check, and build all pass cleanly.
5. **Review `git diff`** before committing — confirm only the intended changes are present.
6. **Never commit**: secrets, `.env` files, API keys, tokens, passwords, debug code (`console.log`, debugger statements, commented-out code), or unrelated/out-of-scope changes.
7. **Commit the completed work** with a meaningful, descriptive commit message.
8. **Push the commit to the current branch** — except when the current branch is `main`. If the current branch is `main`, stop after committing and ask for confirmation before pushing.
9. Do not ask for permission to run `git add`, `git commit`, or `git push` (branches other than `main`) — these are pre-authorized as part of this workflow.

### Stop and ask instead of proceeding when:

- Credentials, API keys, or environment variables are missing or required.
- A change would involve a destructive or irreversible database operation (e.g. dropping tables/columns, deleting data, destructive migrations).
- A product or design decision is ambiguous and not resolvable from existing code, docs, or conventions.
- An issue cannot be resolved safely or checks cannot be made to pass without a decision only the user can make.
- The current branch is `main` and the work is ready to push.

### Completion report

After finishing (or stopping), report:

- **Root cause**: what was actually wrong and why.
- **Files changed**: list of modified/added/removed files.
- **Checks**: lint / type-check / build results.
- **Commit hash**: the SHA of the commit created.
- **Push status**: pushed, or awaiting confirmation (and why, if withheld).
- **What to verify in production**: concrete steps to confirm the fix/feature works after deploy.
